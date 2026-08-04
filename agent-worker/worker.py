"""Simli Trinity receptionist — self-hosted LiveKit Agents worker.

This is the conversation loop for the lobby kiosk avatar. Simli's hosted "Auto"
API only drives Legacy faces; Trinity faces (like Mia / face 5fc23ea5) must be
rendered through a self-hosted LiveKit worker — this file. It joins the same
LiveKit room the browser joins and runs:

    Deepgram STT  ->  Gemini 2.5 Flash (LLM)  ->  Deepgram TTS  ->  Simli avatar

The Simli plugin renders the Trinity face lip-synced to the TTS audio and
publishes the video+audio into the room; the browser subscribes to it.

She is bilingual (FR/EN): the STT runs multilingual and reports the language of
each utterance, and the Aura voice is swapped to match before she replies.

Run:
    python worker.py dev      # local dev + hot reload (test via LiveKit Sandbox)
    python worker.py start    # production (under systemd on the server)

Env (see env.example): SIMLI_API_KEY, SIMLI_FACE_ID, GOOGLE_API_KEY,
DEEPGRAM_API_KEY, LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET.
The LIVEKIT_* vars are read automatically by the agents framework.
"""

import logging
import os

from dotenv import load_dotenv
from livekit.agents import (
    Agent,
    AgentSession,
    JobContext,
    StopResponse,
    WorkerOptions,
    cli,
)
from livekit.plugins import deepgram, google, simli

logger = logging.getLogger("simli-receptionist")
logger.setLevel(logging.INFO)

load_dotenv(override=True)

# Copied verbatim from src/app/api/simli/session/route.ts so the LiveKit avatar
# behaves identically to the old Simli Auto receptionist. Keep these in sync.
MIA_SYSTEM_PROMPT = " ".join(
    [
        "You are Mia, the virtual receptionist at Mobile Apps Labs, a software studio",
        "based in Montréal that builds mobile apps, web platforms, and immersive 3D",
        "experiences for clients in retail, finance, and hospitality. You speak from a",
        "touchscreen kiosk in the office lobby. The visitor in front of you is either a",
        "client, a candidate, or a guest dropping by.",
        "",
        "How to respond:",
        "- Answer in whichever language the visitor speaks. Montréal visitors",
        "  open in French as often as English; if they switch, switch with them.",
        "  Without this you would default to English no matter what you heard.",
        "- Speak warmly and concisely. 1 to 3 short sentences. No bullet lists.",
        "- Sound like a real person at a reception desk. Conversational, never robotic.",
        "- If you don't know something, offer to take a message or point them to the",
        "  right team rather than making things up.",
    ]
)

# One Aura voice speaks one language, so we swap the TTS model per turn to match
# whatever Deepgram detected. andromeda-en is the plugin's own default — keeping
# it means her English is unchanged by all this. The French voices are fr-FR
# only; Aura has no fr-CA, so expect a France accent rather than a Québec one.
VOICE_BY_LANG = {"fr": "aura-2-agathe-fr", "en": "aura-2-andromeda-en"}

# Language she opens in, before anyone has spoken. "Bonjour, hi" is the standard
# Montréal greeting and needs the French voice — "Bonjour" in an English voice
# sounds worse than "hi" in a French one.
DEFAULT_LANG = "fr"

FIRST_MESSAGE = (
    "Bonjour, hi! Bienvenue chez Mobile Apps Labs. How can I help you today?"
)

# She now listens continuously (the browser leaves the mic open), so the room's
# background noise reaches Deepgram all day. Rather than let Gemini improvise on
# a garbled transcript, bounce anything too weak to act on — in the language she
# just heard, so the apology doesn't arrive in the wrong one.
DIDNT_GET_THAT = {
    "en": "I'm sorry, I didn't get that.",
    "fr": "Désolée, je n'ai pas compris.",
}

# Deepgram's per-utterance confidence, 0..1. Below this we assume the audio was
# noise or half a word. Multilingual STT scores lower than the English-only
# models did, hence 0.5 rather than 0.6 — watch the logged values in
# `docker compose logs -f` and retune.
MIN_STT_CONFIDENCE = 0.5

# Sub-threshold transcripts are usually 1-2 stray characters or a lone filler.
MIN_TRANSCRIPT_CHARS = 3
FILLER_ONLY = {"uh", "um", "hmm", "mhm", "ah", "eh", "oh", "hm", "huh"}


def _env_int(name: str, default: int) -> int:
    """Read an int from env, ignoring blanks and junk rather than crashing."""
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        logger.warning("%s=%r is not an integer, using %s", name, raw, default)
        return default


# Simli bills for avatar render time, so the session should end when the lobby
# empties — but not while a visitor is mid-thought. The plugin defaults (30s
# idle / 600s total) are tuned for a demo, not a kiosk: 30s of silence is normal
# when someone is reading the panorama, and losing her mid-visit looks broken.
#
# 3 minutes idle keeps her through a pause without billing an empty lobby; the
# 30 minute cap is a backstop so a wedged session can't bill all night. Both are
# env-tunable so the numbers can move without an image rebuild.
MAX_IDLE_TIME = _env_int("SIMLI_MAX_IDLE_TIME", 180)
MAX_SESSION_LENGTH = _env_int("SIMLI_MAX_SESSION_LENGTH", 1800)


def _normalize_lang(code: str | None) -> str:
    """'fr-CA' -> 'fr'. Anything we have no voice for falls back to English."""
    if not code:
        return DEFAULT_LANG
    short = code.split("-")[0].lower()
    return short if short in VOICE_BY_LANG else "en"


class MiaAgent(Agent):
    """Mia: bilingual, and unwilling to answer transcripts she can't trust.

    Both behaviours hang off `stt_node`, the one place Deepgram's per-alternative
    metadata is still attached to the event:
      * `confidence` — gates the turn. The transcript is checked too, because
        confidence reads high on a clean recording of someone clearing their
        throat.
      * `language` — Deepgram returns this per utterance when the STT runs with
        language="multi", and it picks the voice for the reply.
    """

    def __init__(self, tts: deepgram.TTS) -> None:
        super().__init__(instructions=MIA_SYSTEM_PROMPT)
        self._tts = tts  # held directly so we can swap the voice per turn
        self._last_confidence: float | None = None
        self._last_language: str = DEFAULT_LANG

    async def stt_node(self, audio, model_settings):
        async for event in super().stt_node(audio, model_settings):
            alternatives = getattr(event, "alternatives", None)
            if alternatives:
                confidence = getattr(alternatives[0], "confidence", None)
                if confidence is not None:
                    self._last_confidence = confidence
                language = getattr(alternatives[0], "language", None)
                if language:
                    self._last_language = _normalize_lang(str(language))
            yield event

    def _speak_in(self, lang: str) -> None:
        """Point the TTS at `lang`'s voice before the next thing she says."""
        self._tts.update_options(model=VOICE_BY_LANG[lang])

    async def on_user_turn_completed(self, turn_ctx, new_message) -> None:
        text = (new_message.text_content or "").strip()
        confidence = self._last_confidence
        lang = self._last_language
        self._last_confidence = None  # don't carry a stale score into next turn

        stripped = text.lower().strip(".,!? ")
        too_short = len(stripped) < MIN_TRANSCRIPT_CHARS
        filler = stripped in FILLER_ONLY
        unsure = confidence is not None and confidence < MIN_STT_CONFIDENCE

        # Set the voice before returning: the LLM reply is synthesized after
        # this hook, so this is what decides how the answer sounds.
        self._speak_in(lang)

        if text and not (too_short or filler or unsure):
            logger.info("heard %r (lang=%s, confidence=%s)", text, lang, confidence)
            return

        logger.info(
            "rejected %r (lang=%s, confidence=%s, short=%s, filler=%s)",
            text,
            lang,
            confidence,
            too_short,
            filler,
        )
        await self.session.say(DIDNT_GET_THAT[lang])
        # Skip the LLM entirely for this turn — she's already answered.
        raise StopResponse()


async def entrypoint(ctx: JobContext) -> None:
    await ctx.connect()

    # STT -> LLM -> TTS. Deepgram covers both ears and voice (one API key);
    # Gemini 2.5 Flash is the brain (simple GOOGLE_API_KEY, no service account).
    # VAD: AgentSession uses the bundled Silero VAD by default (the standalone
    # livekit-plugins-silero is deprecated in 1.6.x), so no explicit vad= needed.
    #
    # The TTS is held as a local so MiaAgent gets the same instance the session
    # speaks through — that's what lets it swap the voice per turn.
    tts = deepgram.TTS(model=VOICE_BY_LANG[DEFAULT_LANG])

    session = AgentSession(
        # language="multi" instead of the default en-US: this is a Montréal
        # lobby, so visitors open in French as often as English — and often
        # switch mid-sentence, which pinning fr-CA would break. Requires
        # nova-3; the older nova-2 models are English-only. It also makes
        # Deepgram report the language it heard, which picks the reply voice.
        stt=deepgram.STT(model="nova-3", language="multi"),
        llm=google.LLM(model="gemini-2.5-flash"),
        tts=tts,
    )

    # Simli renders the Trinity face into the room, lip-synced to session audio.
    # It renders nothing else: no prompt, no transcript, no language — the
    # persona lives entirely in MIA_SYSTEM_PROMPT above.
    avatar = simli.AvatarSession(
        simli_config=simli.SimliConfig(
            api_key=os.environ["SIMLI_API_KEY"],
            face_id=os.environ["SIMLI_FACE_ID"],
            max_idle_time=MAX_IDLE_TIME,
            max_session_length=MAX_SESSION_LENGTH,
        ),
    )
    await avatar.start(session, room=ctx.room)

    await session.start(
        agent=MiaAgent(tts=tts),
        room=ctx.room,
    )

    # Greet the visitor on her own; the browser holds its mic shut for the first
    # few seconds, so she speaks before she starts listening.
    await session.say(FIRST_MESSAGE)


if __name__ == "__main__":
    # Default WorkerType.ROOM = automatic dispatch: this worker joins every new
    # room created on the LiveKit project, so the browser only needs a join
    # token — it never has to request an agent explicitly.
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint))
