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
        agent=Agent(instructions=MIA_SYSTEM_PROMPT),
        room=ctx.room,
    )

    # Greet the visitor on her own; the browser keeps its mic muted until the
    # user holds to talk, so she speaks first without listening.
    await session.say(FIRST_MESSAGE)


if __name__ == "__main__":
    # Default WorkerType.ROOM = automatic dispatch: this worker joins every new
    # room created on the LiveKit project, so the browser only needs a join
    # token — it never has to request an agent explicitly.
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint))
