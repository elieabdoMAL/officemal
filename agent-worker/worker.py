"""Simli Trinity receptionist — self-hosted LiveKit Agents worker.

This is the conversation loop for the lobby kiosk avatar. Simli's hosted "Auto"
API only drives Legacy faces; Trinity faces (like Mia / face 3d1cf1cf) must be
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
Optional: SESSION_IDLE_TIMEOUT, SESSION_MAX_LENGTH, LIVEKIT_AGENT_NAME.
The LIVEKIT_* vars are read automatically by the agents framework.
"""

import asyncio
import logging
import os
from pathlib import Path

from dotenv import load_dotenv
from livekit.agents import (
    Agent,
    AgentSession,
    JobContext,
    RunContext,
    StopResponse,
    WorkerOptions,
    cli,
    function_tool,
)
from livekit.plugins import deepgram, google, simli

from team_messages import (
    find_member,
    load_team,
    send_message_email,
    send_visitor_waiting_email,
    team_prompt_section,
)

logger = logging.getLogger("simli-receptionist")
logger.setLevel(logging.INFO)

load_dotenv(override=True)

# Mia's persona, rules and company knowledge. The worker is the only place her
# prompt lives: Simli just renders the face, so a prompt saved in the Simli
# dashboard is never used. Kept in its own file so it can be edited without
# touching code (still needs an image rebuild + push to go live). Features she
# can't do yet are listed there under COMING SOON — see docs/mia-tasks.md.
PROMPT_FILE = Path(__file__).with_name("mia_prompt.txt")
# The TEAM section is generated from team.json, so the people she names and the
# people take_message / notify_member accept can never drift apart.
TEAM = load_team()
MIA_SYSTEM_PROMPT = (
    PROMPT_FILE.read_text(encoding="utf-8").strip() + "\n\n" + team_prompt_section(TEAM)
)

# Per conversation. A kiosk is open to anyone; this stops someone filling the
# team's inboxes from it.
MAX_MESSAGES_PER_SESSION = 3
# One visitor sees one or two people; more than this is someone playing.
MAX_NOTIFICATIONS_PER_SESSION = 3

# One Aura voice speaks one language, so we swap the TTS model per turn to match
# whatever Deepgram detected. andromeda-en is the plugin's own default — keeping
# it means her English is unchanged by all this. The French voices are fr-FR
# only; Aura has no fr-CA, so expect a France accent rather than a Québec one.
VOICE_BY_LANG = {"fr": "aura-2-agathe-fr", "en": "aura-2-andromeda-en"}

# Language she opens in, before anyone has spoken: the prompt says greet in
# French by default, and she switches as soon as the visitor speaks English.
DEFAULT_LANG = "fr"

# Must match the greeting quoted at the top of mia_prompt.txt, which tells her
# it has already been said.
FIRST_MESSAGE = "Bonjour, bienvenue chez Mobile Apps Labs. Que puis-je faire pour vous ?"

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


# Session limits. LiveKit, Simli, Deepgram and Gemini all bill while a session
# is open, so every session must end on its own — the kiosk is never closed.
#
# SESSION_IDLE_TIMEOUT: nobody has spoken (visitor or Mia) for this long, so the
#   lobby is empty. 2 minutes keeps her through someone reading the panorama.
# SESSION_MAX_LENGTH: hard cap on one conversation, however lively. A lobby
#   chat rarely passes a few minutes; this stops a wedged or looping session.
#
# Either way the worker deletes the room, which disconnects the kiosk; the
# kiosk then hides her until the next visitor taps the AI button.
SESSION_IDLE_TIMEOUT = _env_int("SESSION_IDLE_TIMEOUT", 120)
SESSION_MAX_LENGTH = _env_int("SESSION_MAX_LENGTH", 600)

# Simli's own limits, kept 30s behind ours as a backstop: if this worker ever
# fails to end a session, Simli still stops rendering (and billing) by itself.
MAX_IDLE_TIME = _env_int("SIMLI_MAX_IDLE_TIME", SESSION_IDLE_TIMEOUT + 30)
MAX_SESSION_LENGTH = _env_int("SIMLI_MAX_SESSION_LENGTH", SESSION_MAX_LENGTH + 30)

# Said when the hard cap ends a conversation mid-flow, so she doesn't just vanish.
GOODBYE = {
    "en": "I have to go now. Tap the AI button any time to talk again. Goodbye!",
    "fr": "Je dois vous laisser. Touchez le bouton IA pour me reparler. Au revoir!",
}

# Explicit dispatch: the worker joins only rooms whose token asks for this agent
# by name (see /api/livekit/token), never every room on the LiveKit project.
# The project is shared with expo360, whose rooms she must stay out of.
# Must match LIVEKIT_AGENT_NAME on Vercel (same default on both sides).
AGENT_NAME = os.environ.get("LIVEKIT_AGENT_NAME", "").strip() or "officemal-mia"


def _normalize_lang(code: str | None) -> str:
    """'fr-CA' -> 'fr'. Anything we have no voice for falls back to English."""
    if not code:
        return DEFAULT_LANG
    short = code.split("-")[0].lower()
    return short if short in VOICE_BY_LANG else "en"


LANGUAGE_NAMES = {"fr": "French", "en": "English"}


def _reply_language_note(code: str) -> str:
    """Per-turn instruction telling Gemini which language to answer in."""
    if code in LANGUAGE_NAMES:
        name = LANGUAGE_NAMES[code]
        return f"The visitor just spoke {name}. Reply only in {name}."
    return (
        f"The visitor just spoke a language other than French or English "
        f"(language code {code}). Follow the LANGUAGE rule: say in English that "
        f"you can continue in French or English, and ask which they prefer."
    )


class MiaAgent(Agent):
    """Mia: bilingual, and unwilling to answer transcripts she can't trust.

    Both behaviours hang off `stt_node`, the one place Deepgram's per-alternative
    metadata is still attached to the event:
      * `confidence` — gates the turn. The transcript is checked too, because
        confidence reads high on a clean recording of someone clearing their
        throat.
      * `language` — Deepgram returns this per utterance when the STT runs with
        language="multi". It picks the voice for the reply, and is also handed
        to Gemini each turn: the prompt alone can't hold her to the visitor's
        language — after a French greeting she drifts into French replies to
        English questions — and the voice would then speak French text with
        an English voice.
    """

    def __init__(self, tts: deepgram.TTS) -> None:
        super().__init__(instructions=MIA_SYSTEM_PROMPT)
        self._tts = tts  # held directly so we can swap the voice per turn
        self._last_confidence: float | None = None
        self._last_language: str = DEFAULT_LANG
        # Deepgram's code before _normalize_lang folds it to fr/en: "es" etc.
        # still needs to reach Gemini, which offers French or English to them.
        self._last_raw_language: str = DEFAULT_LANG
        self._messages_sent = 0
        self._notifications_sent = 0

    @property
    def language(self) -> str:
        """The language the visitor last spoke — the one to say goodbye in."""
        return self._last_language

    async def stt_node(self, audio, model_settings):
        async for event in super().stt_node(audio, model_settings):
            alternatives = getattr(event, "alternatives", None)
            if alternatives:
                confidence = getattr(alternatives[0], "confidence", None)
                if confidence is not None:
                    self._last_confidence = confidence
                language = getattr(alternatives[0], "language", None)
                if language:
                    self._last_raw_language = str(language).split("-")[0].lower()
                    self._last_language = _normalize_lang(str(language))
            yield event

    @function_tool()
    async def take_message(
        self,
        context: RunContext,
        visitor_name: str,
        recipient: str,
        message: str,
        reply_contact: str = "",
    ) -> str:
        """Email a visitor's message to a team member listed under TEAM.

        Call this only after reading the message back to the visitor and they
        confirmed it. Tell the visitor it was sent only if this returns SENT.

        Args:
            visitor_name: The visitor's name, as they gave it.
            recipient: Who the message is for, as the visitor said it: a name or a role such as "the CEO".
            message: The message, in the visitor's own words.
            reply_contact: A phone number or email for a reply, only if the visitor wants one. Empty otherwise.
        """
        if self._messages_sent >= MAX_MESSAGES_PER_SESSION:
            return "NOT SENT: message limit for this conversation reached. Give the contact details instead."
        member = find_member(recipient, TEAM)
        if member is None:
            return (
                f"NOT SENT: no single team member matches {recipient!r}. If it is unclear, ask who "
                "they mean. Otherwise say you cannot reach that person from here and give the contact details."
            )
        if not visitor_name.strip() or not message.strip():
            return "NOT SENT: the visitor's name and the message are both required. Ask for what is missing."
        if not await send_message_email(member, visitor_name, message, reply_contact):
            return "NOT SENT: the email could not be delivered. Say so plainly and give the contact details."
        self._messages_sent += 1
        return f"SENT to {member.full_name}."

    @function_tool()
    async def notify_member(
        self,
        context: RunContext,
        visitor_name: str,
        member: str,
        note: str = "",
    ) -> str:
        """Tell a team member listed under TEAM, by email, that a visitor is waiting at reception.

        Call this once you have the visitor's name and who they came to see.
        Tell the visitor the person was notified only if this returns NOTIFIED.

        Args:
            visitor_name: The visitor's name, as they gave it.
            member: Who they came to see, as the visitor said it: a name or a role such as "the CEO".
            note: Why they came, only if the visitor said, for example "for a two o'clock meeting". Empty otherwise.
        """
        if self._notifications_sent >= MAX_NOTIFICATIONS_PER_SESSION:
            return "NOT SENT: notification limit for this conversation reached. Give the contact details instead."
        found = find_member(member, TEAM)
        if found is None:
            return (
                f"NOT SENT: no single team member matches {member!r}. If it is unclear, ask who "
                "they mean. Otherwise say you cannot reach that person from here and give the contact details."
            )
        if not visitor_name.strip():
            return "NOT SENT: the visitor's name is required. Ask for it."
        if not await send_visitor_waiting_email(found, visitor_name, note):
            return "NOT SENT: the email could not be delivered. Say so plainly and give the contact details."
        self._notifications_sent += 1
        return f"NOTIFIED {found.full_name} by email."

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
            # This turn only (turn_ctx isn't saved to the conversation history).
            turn_ctx.add_message(role="system", content=_reply_language_note(self._last_raw_language))
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
        # The default endpointing (min 0.5s / max 3.0s of silence before she
        # accepts the turn is over) reads as a long dead pause at a reception
        # desk, where turns are short and the visitor expects a near-immediate
        # reply. Tightened to 0.3/1.5.
        #
        # preemptive_tts starts synthesizing before the turn is formally closed,
        # which removes most of the remaining gap — it costs a little wasted TTS
        # when a guess is discarded, which is the right trade here.
        turn_handling={
            "endpointing": {"min_delay": 0.3, "max_delay": 1.5},
            "preemptive_generation": {"preemptive_tts": True},
        },
        # Marks the visitor "away" once neither side has spoken for this long;
        # that is the idle signal that ends the session below.
        user_away_timeout=SESSION_IDLE_TIMEOUT,
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

    agent = MiaAgent(tts=tts)

    ending = False

    async def end_session(reason: str, goodbye: bool = False) -> None:
        """Close the room for everyone and release this job. Safe to call twice.

        Deleting the room is what stops the bill: it disconnects the kiosk and
        the Simli avatar at once, instead of each lingering until a timeout.
        """
        nonlocal ending
        if ending:
            return
        ending = True
        logger.info("ending session in %s: %s", ctx.room.name, reason)
        if goodbye:
            try:
                await session.say(GOODBYE[agent.language], allow_interruptions=False)
            except Exception:
                logger.exception("goodbye failed; ending anyway")
        try:
            await ctx.delete_room()
        except Exception:
            logger.exception("delete_room failed; LiveKit's departure timeout will close it")
        ctx.shutdown(reason=reason)

    # Event callbacks are sync; hold task references so they aren't collected.
    tasks: set[asyncio.Task] = set()

    def spawn(coro) -> None:
        task = asyncio.create_task(coro)
        tasks.add(task)
        task.add_done_callback(tasks.discard)

    # Log what she says next to what she heard ("heard …" in MiaAgent), so her
    # answers can be checked in `docker compose logs` after a prompt change.
    @session.on("conversation_item_added")
    def _on_item(ev) -> None:
        item = ev.item
        if getattr(item, "role", None) == "assistant" and item.text_content:
            logger.info("said %r", item.text_content)

    @session.on("user_state_changed")
    def _on_user_state(ev) -> None:
        if ev.new_state == "away":
            spawn(end_session(f"idle {SESSION_IDLE_TIMEOUT}s"))

    # The visitor left (AI button turned off, page closed, network gone):
    # close_on_disconnect has already stopped the session; clear up the room.
    @session.on("close")
    def _on_close(_ev) -> None:
        spawn(end_session("session closed"))

    async def cap_length() -> None:
        await asyncio.sleep(SESSION_MAX_LENGTH)
        await end_session(f"max length {SESSION_MAX_LENGTH}s", goodbye=True)

    await session.start(agent=agent, room=ctx.room)
    spawn(cap_length())

    # Greet the visitor on her own; the browser holds its mic shut for the first
    # few seconds, so she speaks before she starts listening.
    await session.say(FIRST_MESSAGE)


if __name__ == "__main__":
    # agent_name switches off automatic dispatch: the worker joins only rooms
    # whose join token requests AGENT_NAME (the kiosk's token route does).
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint, agent_name=AGENT_NAME))
