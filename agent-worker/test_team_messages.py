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
        # How speech recognition has spelled them (#15).
        "Alexander": "Alexandre Joset",
        "Alexandra": "Alexandre Joset",
        "Nic": "Nicolas Bastien",
        "Nicholas": "Nicolas Bastien",
        # The general inbox (#2); a named person always wins over it.
        "info": "the general inbox",
        "info at mobileappslabs dot com": "the general inbox",
        "the team": "the general inbox",
        "l'équipe": "the general inbox",
        "Mobile Apps Labs": "the general inbox",
        "Nicolas at Mobile Apps Labs": "Nicolas Bastien",
        "Alex from the team": "Alexandre Joset",
        "Nicolas and Alexandre": None,
    }
    for said, expected in cases.items():
        got = find_member(said, TEAM)
        assert (got.full_name if got else None) == expected, f"{said!r}: {got}"
    section = team_prompt_section(TEAM)
    assert "@" not in section, "emails must never reach the prompt"
    for block in ("TEAM\n", "TEAM ABOUT", "GENERAL INBOX", "Alexander", "the person to let know is Nicolas Bastien"):
        assert block in section, f"TEAM prompt section is missing {block!r}"

    # Bios (#1): rendered only when team.json has them, never invented.
    with_bio = Member("Ada", "Test", "CTO", "Directrice technique", "x@example.com", (), bio_en="Ada loves maps.", bio_fr="Ada adore les cartes.")
    rendered = team_prompt_section([with_bio])
    assert "Ada loves maps." in rendered and "Ada adore les cartes." in rendered, rendered
    assert "Ada loves maps." not in team_prompt_section([Member("Ada", "Test", "CTO", "CTO", "x@example.com", ())])
    print(f"✓ find_member: {len(cases)} cases; TEAM prompt section has no emails, has bios only when given")


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


# What the tools did, by kind: ("message" | "notify" | "emergency" | "suggestion" |
# "project" | "call" | "end" | "screen", details). "screen" is a mia.screen message she sent.
calls: list[tuple] = []


def kinds(*kind: str) -> list[tuple]:
    return [c for c in calls if c[0] in kind]


def use_assistant_name(worker) -> None:
    """Fill in {ASSISTANT_NAME} if this worker doesn't yet (it does it at load)."""
    if "{ASSISTANT_NAME}" in worker.MIA_SYSTEM_PROMPT:
        worker.MIA_SYSTEM_PROMPT = worker.MIA_SYSTEM_PROMPT.replace("{ASSISTANT_NAME}", "Mia")


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

    async def suggestion(inbox, suggestion, visitor_name, reply_contact):
        calls.append(("suggestion", inbox.full_name, suggestion, visitor_name, reply_contact))
        return True

    async def project(inbox, fields, language):
        calls.append(("project", inbox.full_name, dict(fields), language))
        return True

    async def call(member, visitor_name, assistant):
        calls.append(("call", member.full_name, visitor_name))
        return True

    worker.start_staff_call = call
    worker.send_message_email = message
    worker.send_visitor_waiting_email = notify
    worker.send_emergency_email = emergency
    worker.send_suggestion_email = suggestion
    worker.send_project_request_email = project


class Conversation:
    """One text conversation with her, kept open between lines:

        async with Conversation("en") as c:
            reply = await c.say("Hi!")

    `agent` is the MiaAgent, for tests that need its state."""

    def __init__(self, lang: str) -> None:
        self.lang = lang

    async def __aenter__(self) -> "Conversation":
        from livekit.agents import AgentSession
        from livekit.plugins import google

        import worker

        # Text only: no voice. MiaAgent keeps its TTS in Agent._tts (the base class
        # slot the session speaks through), so clear it and the swap. on_goodbye
        # stands in for end_session, which in production deletes the room once the
        # goodbye it is handed has had time to play.
        def on_goodbye(said: str, done_at: float) -> None:
            assert said.strip(), "end_session must be handed the goodbye she said, to time its playout"
            calls.append(("end",))

        agent = worker.MiaAgent(tts=None, on_goodbye=on_goodbye, on_screen=lambda msg: calls.append(("screen", msg)))
        agent._tts = None
        # As if the visitor had answered "Français ou English?" with `lang`, so the
        # screen messages carry it as they would on the kiosk.
        agent._chosen_language = self.lang
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
        llm = worker.make_llm()  # same model + fallback as production
        self.agent = agent
        self.session = AgentSession(llm=llm)
        await self.session.__aenter__()
        await self.session.start(agent)
        return self

    async def __aexit__(self, *exc) -> None:
        await self.session.__aexit__(*exc)

    async def say(self, line: str) -> str:
        """The visitor says `line`; her reply."""
        self.agent._last_raw_language = self.lang  # what Deepgram would report
        before = len(calls)
        seen = len(self.session.history.items)
        await self.session.run(user_input=line)
        # Anything she says right after, on her own (the worker's checks can
        # add a reply), belongs to this turn too.
        for _ in range(2):
            await asyncio.sleep(0.5)  # on_goodbye runs from a speech-done callback
            while (speech := self.session.current_speech) is not None:
                await speech
        reply = " ".join(
            item.text_content
            for item in self.session.history.items[seen:]
            if getattr(item, "type", "") == "message" and item.role == "assistant" and item.text_content
        )
        tools = "".join(
            f" [screen {c[1].get('type')} {c[1].get('kind') or c[1].get('status') or ''}]".replace(" ]", "]")
            if c[0] == "screen" else f" [{c[0]} recorded]"
            for c in calls[before:]
        )
        print(f"  VISITOR: {line}\n  MIA:     {reply}{tools}")
        return reply


async def converse(lang: str, lines: list[str]) -> list[str]:
    """Play `lines` as one conversation; return her reply to each."""
    async with Conversation(lang) as c:
        return [await c.say(line) for line in lines]


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
    replies = await converse("en", [
        "Hi, I'm here to see Alex, I have a meeting with him at two.",
        "My name is David Chen.",
    ])
    # Seen in testing: "I've let Alex know you're here" with no name and no tool call.
    assert not any(w in replies[0].lower() for w in ("i've let", "i have let", "let alex")), f"claimed to notify before having the name: {replies[0]!r}"
    notified = kinds("notify")
    assert len(notified) == 1, f"expected one notification: {calls}"
    assert notified[0][1] == "Alexandre Joset" and "Chen" in notified[0][2], notified
    print(f"✓ one notification recorded: {notified[0]}")

    print("— French, here to see someone not on the team:")
    replies = await converse("fr", ["Bonjour, je suis Sophie Martin, j'ai rendez-vous avec Marc Dupont."])
    assert len(kinds("notify")) == 1, f"nobody outside team.json may be notified: {calls}"
    assert "prévenu" not in replies[0].lower(), f"claimed to notify someone: {replies[0]!r}"
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

    use_assistant_name(worker)
    install_recorders(worker)
    for name in sys.argv[1:] or CONVERSATIONS:
        await CONVERSATIONS[name]()


if __name__ == "__main__":
    asyncio.run(main())
