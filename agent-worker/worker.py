"""Simli Trinity receptionist — self-hosted LiveKit Agents worker.

This is the conversation loop for the lobby kiosk avatar. Simli's hosted "Auto"
API only drives Legacy faces; Trinity faces (like Mia / face 5fc23ea5) must be
rendered through a self-hosted LiveKit worker — this file. It joins the same
LiveKit room the browser joins and runs:

    Deepgram STT  ->  Gemini 2.5 Flash (LLM)  ->  Deepgram TTS  ->  Simli avatar

The Simli plugin renders the Trinity face lip-synced to the TTS audio and
publishes the video+audio into the room; the browser subscribes to it.

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
        "- Speak warmly and concisely. 1 to 3 short sentences. No bullet lists.",
        "- Sound like a real person at a reception desk. Conversational, never robotic.",
        "- If you don't know something, offer to take a message or point them to the",
        "  right team rather than making things up.",
    ]
)

FIRST_MESSAGE = "Hi there! Welcome to Mobile Apps Labs. How can I help you today?"

# She now listens continuously (the browser leaves the mic open), so the room's
# background noise reaches Deepgram all day. Rather than let Gemini improvise on
# a garbled transcript, bounce anything too weak to act on.
DIDNT_GET_THAT = "I'm sorry, I didn't get that."

# Deepgram's per-utterance confidence, 0..1. Below this we assume the audio was
# noise or half a word. 0.6 is a starting point — watch the logged values in
# `docker compose logs -f` and retune.
MIN_STT_CONFIDENCE = 0.6

# Sub-threshold transcripts are usually 1-2 stray characters or a lone filler.
MIN_TRANSCRIPT_CHARS = 3
FILLER_ONLY = {"uh", "um", "hmm", "mhm", "ah", "eh", "oh", "hm", "huh"}


class MiaAgent(Agent):
    """Mia, plus a gate that refuses to answer transcripts it can't trust.

    Two signals, because neither alone is enough:
      * STT confidence — captured in `stt_node`, the only place Deepgram's
        per-alternative score is still attached to the event.
      * The transcript itself — confidence can read high on a clean recording of
        someone clearing their throat.
    """

    def __init__(self) -> None:
        super().__init__(instructions=MIA_SYSTEM_PROMPT)
        self._last_confidence: float | None = None

    async def stt_node(self, audio, model_settings):
        async for event in super().stt_node(audio, model_settings):
            alternatives = getattr(event, "alternatives", None)
            if alternatives:
                confidence = getattr(alternatives[0], "confidence", None)
                if confidence is not None:
                    self._last_confidence = confidence
            yield event

    async def on_user_turn_completed(self, turn_ctx, new_message) -> None:
        text = (new_message.text_content or "").strip()
        confidence = self._last_confidence
        self._last_confidence = None  # don't carry a stale score into next turn

        stripped = text.lower().strip(".,!? ")
        too_short = len(stripped) < MIN_TRANSCRIPT_CHARS
        filler = stripped in FILLER_ONLY
        unsure = confidence is not None and confidence < MIN_STT_CONFIDENCE

        if text and not (too_short or filler or unsure):
            logger.info("heard %r (confidence=%s)", text, confidence)
            return

        logger.info(
            "rejected %r (confidence=%s, short=%s, filler=%s)",
            text,
            confidence,
            too_short,
            filler,
        )
        await self.session.say(DIDNT_GET_THAT)
        # Skip the LLM entirely for this turn — she's already answered.
        raise StopResponse()


async def entrypoint(ctx: JobContext) -> None:
    await ctx.connect()

    # STT -> LLM -> TTS. Deepgram covers both ears and voice (one API key);
    # Gemini 2.5 Flash is the brain (simple GOOGLE_API_KEY, no service account).
    # VAD: AgentSession uses the bundled Silero VAD by default (the standalone
    # livekit-plugins-silero is deprecated in 1.6.x), so no explicit vad= needed.
    session = AgentSession(
        stt=deepgram.STT(),
        llm=google.LLM(model="gemini-2.5-flash"),
        tts=deepgram.TTS(),
    )

    # Simli renders the Trinity face into the room, lip-synced to session audio.
    avatar = simli.AvatarSession(
        simli_config=simli.SimliConfig(
            api_key=os.environ["SIMLI_API_KEY"],
            face_id=os.environ["SIMLI_FACE_ID"],
        ),
    )
    await avatar.start(session, room=ctx.room)

    await session.start(
        agent=MiaAgent(),
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
