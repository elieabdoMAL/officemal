"""Checks for Mia's message-taking. Run inside the worker image:

    docker run --rm --env-file .env -v "$PWD":/app simli-worker python test_team_messages.py

1. find_member — offline.
2. Resend delivery — one real email to Resend's test inbox, not to the team.
3. A text conversation with the real Gemini model, email sending replaced by a
   recorder, to check she collects, reads back, and only then calls the tool.
"""

import asyncio
import os

import team_messages
from team_messages import Member, find_member, load_team, team_prompt_section

TEAM = load_team()


def test_find_member() -> None:
    cases = {
        "Nicolas": "Nicolas Bastien",
        "nicolas bastien": "Nicolas Bastien",
        "le PDG": "Nicolas Bastien",
        "the CEO please": "Nicolas Bastien",
        "Alex": "Alexandre Joset",
        "le directeur des opérations": "Alexandre Joset",
        "le directeur des operations": "Alexandre Joset",  # STT may drop accents
        "Marc Dupont": None,
        "Al": None,  # partial words don't count
        "": None,
    }
    for said, expected in cases.items():
        got = find_member(said, TEAM)
        assert (got.full_name if got else None) == expected, f"{said!r}: {got}"
    section = team_prompt_section(TEAM)
    assert "@" not in section, "emails must never reach the prompt"
    print(f"✓ find_member: {len(cases)} cases; TEAM prompt section has no emails")


async def test_resend_delivery() -> None:
    sandbox = Member("Test", "Inbox", "Test", "Test", "delivered@resend.dev", ())
    ok = await team_messages.send_message_email(
        sandbox, "Kiosk <script>alert(1)</script> test", "Hello from the test suite.", "test@example.com"
    )
    assert ok, "Resend rejected the test email (key / sender domain?)"
    print("✓ Resend accepted a test email (to delivered@resend.dev)")


async def test_conversation() -> None:
    from livekit.agents import AgentSession
    from livekit.plugins import google

    import worker

    sent: list[tuple] = []

    async def record(member, visitor_name, message, reply_contact):
        sent.append((member.full_name, visitor_name, message, reply_contact))
        return True

    worker.send_message_email = record  # the tool looks it up in worker's globals

    async def converse(lang: str, lines: list[str]) -> None:
        # Text only: no voice. MiaAgent keeps its TTS in Agent._tts (the base
        # class slot the session speaks through), so clear it and the swap.
        agent = worker.MiaAgent(tts=None)
        agent._tts = None
        agent._speak_in = lambda _lang: None
        # Same LLM settings as worker.entrypoint (thinking off).
        llm = google.LLM(model="gemini-2.5-flash", thinking_config={"thinking_budget": 0})
        async with AgentSession(llm=llm) as session:
            await session.start(agent)
            for line in lines:
                agent._last_raw_language = lang  # what Deepgram would report
                before = len(sent)
                result = await session.run(user_input=line)
                reply = " ".join(
                    ev.item.text_content
                    for ev in result.events
                    if getattr(ev, "type", "") == "message" and ev.item.role == "assistant"
                )
                tool = " [tool called → recorded]" if len(sent) > before else ""
                print(f"  VISITOR: {line}\n  MIA:     {reply}{tool}")

    print("— French, message for the CEO:")
    await converse("fr", [
        "Bonjour, je voudrais laisser un message pour le PDG.",
        "Je m'appelle Julie Tremblay.",
        "Dites-lui que je passerai demain matin pour signer le contrat.",
        "Oui, c'est bien ça. Pas besoin de me rappeler.",
    ])
    assert len(sent) == 1 and sent[0][0] == "Nicolas Bastien", f"expected one message to Nicolas: {sent}"
    print(f"✓ one message recorded: {sent[0]}")

    # Text runs skip on_user_turn_completed (it runs on spoken turns only), so the
    # per-turn reply-language note isn't exercised here: a French reply to this
    # English line is a harness limit. Language switching is covered by voice tests.
    print("— English, someone not on the team:")
    await converse("en", ["Hi, can I leave a message for Marc Dupont?"])
    assert len(sent) == 1, f"nothing should be sent for an unknown person: {sent}"
    print("✓ nothing sent for someone not in team.json")


async def main() -> None:
    test_find_member()
    if os.environ.get("RESEND_API_KEY"):
        await test_resend_delivery()
    await test_conversation()


if __name__ == "__main__":
    asyncio.run(main())
