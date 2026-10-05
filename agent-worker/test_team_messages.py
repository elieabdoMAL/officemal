"""Checks for Mia's team tools. Run inside the worker image:

    docker run --rm --env-file .env -v "$PWD":/app simli-worker python test_team_messages.py

1. find_member — offline.
2. Resend delivery — real emails to Resend's test inbox, never to the team.
   Skipped when RESEND_API_KEY is empty (add `-e RESEND_API_KEY=`).
3. Text conversations with the real Gemini model, every email replaced by a
   recorder, to check when she calls take_message, notify_member,
   alert_emergency and end_conversation — and when she doesn't.

Pass test names to run only those conversations, e.g. `python
test_team_messages.py notify goodbye`.
"""

import asyncio
import os
import sys

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
    ok = await team_messages.send_visitor_waiting_email(sandbox, "Kiosk\r\nBcc: x <b>test</b>", "Test suite.")
    assert ok, "Resend rejected the visitor-waiting test email"
    ok = await team_messages.send_emergency_email([sandbox], "Test suite <b>not a real emergency</b>.")
    assert ok, "Resend rejected the emergency test email"
    print("✓ Resend accepted message, notify and emergency test emails (to delivered@resend.dev)")


# What the tools did, by kind: ("message" | "notify" | "emergency" | "end", details).
calls: list[tuple] = []


def kinds(*kind: str) -> list[tuple]:
    return [c for c in calls if c[0] in kind]


def install_recorders(worker) -> None:
    """Swap every email for a recorder. The tools look these up in worker's globals."""

    async def message(member, visitor_name, message, reply_contact):
        calls.append(("message", member.full_name, visitor_name, message, reply_contact))
        return True

    async def notify(member, visitor_name, note):
        calls.append(("notify", member.full_name, visitor_name, note))
        return True

    async def emergency(team, description):
        calls.append(("emergency", [m.full_name for m in team], description))
        return True

    worker.send_message_email = message
    worker.send_visitor_waiting_email = notify
    worker.send_emergency_email = emergency


async def converse(lang: str, lines: list[str]) -> None:
    from livekit.agents import AgentSession
    from livekit.plugins import google

    import worker

    # Text only: no voice. MiaAgent keeps its TTS in Agent._tts (the base class
    # slot the session speaks through), so clear it and the swap. on_goodbye
    # stands in for end_session, which in production deletes the room.
    agent = worker.MiaAgent(tts=None, on_goodbye=lambda: calls.append(("end",)))
    agent._tts = None
    agent._speak_in = lambda _lang: None
    # In production the greeting is spoken before the visitor talks and sits in
    # her history; without it she tends to greet again.
    history = agent.chat_ctx.copy()
    history.add_message(role="assistant", content=worker.FIRST_MESSAGE)
    await agent.update_chat_ctx(history)

    # Text runs skip on_user_turn_completed, which adds the per-turn "reply in
    # <language>" note on spoken turns. Add the same note here instead, or she
    # answers English lines in French after that French greeting.
    base_llm_node = agent.llm_node

    async def llm_node(chat_ctx, tools, model_settings):
        chat_ctx = chat_ctx.copy()
        chat_ctx.add_message(role="system", content=worker._reply_language_note(agent._last_raw_language))
        async for chunk in base_llm_node(chat_ctx, tools, model_settings):
            yield chunk

    agent.llm_node = llm_node
    # Same LLM settings as worker.entrypoint (thinking off).
    llm = google.LLM(model="gemini-2.5-flash", thinking_config={"thinking_budget": 0})
    async with AgentSession(llm=llm) as session:
        await session.start(agent)
        for line in lines:
            agent._last_raw_language = lang  # what Deepgram would report
            before = len(calls)
            result = await session.run(user_input=line)
            await asyncio.sleep(0.2)  # on_goodbye runs from a speech-done callback
            reply = " ".join(
                ev.item.text_content
                for ev in result.events
                if getattr(ev, "type", "") == "message" and ev.item.role == "assistant"
            )
            tools = "".join(f" [{c[0]} recorded]" for c in calls[before:])
            print(f"  VISITOR: {line}\n  MIA:     {reply}{tools}")


async def conv_message() -> None:
    print("— French, message for the CEO:")
    await converse("fr", [
        "Bonjour, je voudrais laisser un message pour le PDG.",
        "Je m'appelle Julie Tremblay.",
        "Dites-lui que je passerai demain matin pour signer le contrat.",
        "Oui, c'est bien ça. Pas besoin de me rappeler.",
    ])
    sent = kinds("message")
    assert len(sent) == 1 and sent[0][1] == "Nicolas Bastien", f"expected one message to Nicolas: {sent}"
    print(f"✓ one message recorded: {sent[0]}")

    print("— English, message for someone not on the team:")
    await converse("en", ["Hi, can I leave a message for Marc Dupont?"])
    assert len(kinds("message")) == 1, f"nothing should be sent for an unknown person: {calls}"
    print("✓ nothing sent for someone not in team.json")


async def conv_notify() -> None:
    print("— English, here to see the COO, name not given yet:")
    await converse("en", [
        "Hi, I'm here to see Alex, I have a meeting with him at two.",
        "My name is David Chen.",
    ])
    notified = kinds("notify")
    assert len(notified) == 1, f"expected one notification: {calls}"
    assert notified[0][1] == "Alexandre Joset" and "Chen" in notified[0][2], notified
    print(f"✓ one notification recorded: {notified[0]}")

    print("— French, here to see someone not on the team:")
    await converse("fr", ["Bonjour, je suis Sophie Martin, j'ai rendez-vous avec Marc Dupont."])
    assert len(kinds("notify")) == 1, f"nobody outside team.json may be notified: {calls}"
    print("✓ nobody notified for someone not in team.json")


async def conv_emergency() -> None:
    print("— English, emergency:")
    await converse("en", ["Help, there's smoke coming from the hallway!"])
    alerts = kinds("emergency")
    assert len(alerts) == 1, f"expected one emergency alert: {calls}"
    assert sorted(alerts[0][1]) == sorted(m.full_name for m in TEAM), "every member must be alerted"
    print(f"✓ whole team alerted: {alerts[0]}")


async def conv_goodbye() -> None:
    print("— English, a question then goodbye:")
    await converse("en", [
        "What's your phone number?",
        "Great, thanks. That's all, goodbye!",
    ])
    ends = kinds("end")
    assert len(ends) == 1, f"expected the session to end once, after goodbye: {calls}"
    assert calls[-1] == ("end",), f"nothing may happen after the end: {calls}"
    print("✓ ended once, after her goodbye")

    print("— French, thanks mid-conversation is not goodbye:")
    await converse("fr", ["Merci. Et vous êtes situés où exactement ?"])
    assert len(kinds("end")) == 1, f"must not end while the visitor still has a question: {calls}"
    print("✓ did not end on a thank-you with a question")


CONVERSATIONS = {
    "message": conv_message,
    "notify": conv_notify,
    "emergency": conv_emergency,
    "goodbye": conv_goodbye,
}


async def main() -> None:
    test_find_member()
    if os.environ.get("RESEND_API_KEY"):
        await test_resend_delivery()

    import worker

    install_recorders(worker)
    for name in sys.argv[1:] or CONVERSATIONS:
        await CONVERSATIONS[name]()


if __name__ == "__main__":
    asyncio.run(main())
