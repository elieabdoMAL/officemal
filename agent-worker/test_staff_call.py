"""Checks for the video call to staff (#22, staff_call.py). Run inside the worker image:

    docker run --rm --env-file .env -v "$PWD":/app -e RESEND_API_KEY= simli-worker python test_staff_call.py

1. Offline: the join token (one room, camera and mic only, 15 minutes), the
   link (token in the fragment), the email (escaped), and call_staff's guards.
2. Text conversations with the real Gemini model, the call replaced by a
   recorder (same harness as test_team_messages.py): she offers the call, asks
   the visitor's name, calls; goes quiet while staff are in the call and takes
   the visitor back after; offers a message when nobody answers.

Pass names to run only those conversations, e.g. `python test_staff_call.py handover`.
Every check runs; failures are listed at the end (exit 1 if any).
"""

import asyncio
import base64
import json
import sys
import time
import types
import urllib.parse

import staff_call
from team_messages import find_member, load_team
from test_team_messages import Conversation, calls, install_recorders, use_assistant_name

TEAM = load_team()
NICOLAS = find_member("Nicolas", TEAM)
failures: list[str] = []


def check(ok: bool, what: str) -> None:
    print(f"{'✓' if ok else '✗'} {what}")
    if not ok:
        failures.append(what)


def has(text: str, *words: str) -> bool:
    low = text.lower().replace("’", "'")
    return any(w.lower() in low for w in words)


def recorded(kind: str, since: int) -> list[tuple]:
    return [c for c in calls[since:] if c[0] == kind]


def screens(since: int, type_: str) -> list[dict]:
    return [c[1] for c in calls[since:] if c[0] == "screen" and c[1].get("type") == type_]


def jwt_claims(token: str) -> dict:
    payload = token.split(".")[1]
    return json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))


# --- offline ------------------------------------------------------------------


async def offline() -> None:
    print("— join token, link and email:")
    token = staff_call.join_token("kiosk-test-room", NICOLAS, "Eve Adams")
    claims = jwt_claims(token)
    video = claims.get("video", {})
    check(json.loads(claims.get("metadata", "{}")).get("visitor") == "Eve Adams", f"visitor's name in the metadata: {claims.get('metadata')}")
    check(claims.get("sub") == "staff-nbastien", f"identity staff-<team.json id>: {claims.get('sub')}")
    check(claims.get("name") == "Nicolas Bastien", f"name is the display name: {claims.get('name')}")
    check(video.get("room") == "kiosk-test-room" and video.get("roomJoin") is True, f"this room only: {video}")
    check(sorted(video.get("canPublishSources", [])) == ["camera", "microphone"], f"camera and mic only: {video}")
    check(not video.get("roomAdmin") and not video.get("roomCreate") and video.get("canPublishData") is False,
          f"no admin, room creation or data: {video}")
    ttl = claims["exp"] - claims["nbf"]
    check(14 * 60 <= ttl <= 15 * 60 + 5, f"valid ~15 minutes: {ttl}s")

    link = staff_call.join_link(token, "wss://example.livekit.cloud", site="https://kiosk.example")
    base, _, fragment = link.partition("#")
    params = urllib.parse.parse_qs(fragment)
    check(base == "https://kiosk.example/join", f"link to /join: {base}")
    check(params.get("t") == [token] and params.get("u") == ["wss://example.livekit.cloud"], "token and LiveKit URL in the fragment")
    check("?" not in base, "nothing in the query string (it would reach server logs)")

    sent: list[tuple] = []

    async def fake_send(what, to, subject, body, reply_to=""):
        sent.append((what, to, subject, body))
        return True

    real_send = staff_call._send_email
    staff_call._send_email = fake_send
    try:
        ok = await staff_call.send_call_email(NICOLAS, "Eve <script>x</script>\r\nBcc: a@b.c", link, "Linda")
        check(ok and len(sent) == 1, "email handed to Resend")
        what, to, subject, body = sent[0]
        check(to == [NICOLAS.email], f"to the member's team.json address: {to}")
        check(subject.endswith("is at the kiosk — join the call") and "\n" not in subject and "\r" not in subject,
              f"subject on one line: {subject!r}")
        check("<script>" not in body and "&lt;script&gt;" in body, "visitor name escaped in the body")
        check(link.replace("&", "&amp;") in body, "the join link is in the body")
        check("Linda" in body, "names her (ASSISTANT_NAME)")

        # call_member: this job's room, the env's LiveKit URL.
        import livekit.agents as agents

        real_ctx = agents.get_job_context
        agents.get_job_context = lambda: types.SimpleNamespace(room=types.SimpleNamespace(name="kiosk-abc"))
        try:
            sent.clear()
            ok = await staff_call.call_member(NICOLAS, "Eve Adams", "Linda")
        finally:
            agents.get_job_context = real_ctx
        body = sent[0][3] if sent else ""
        href = body.split('href="', 1)[-1].split('"', 1)[0].replace("&amp;", "&")
        got = urllib.parse.parse_qs(href.partition("#")[2])
        check(ok and jwt_claims(got["t"][0])["video"]["room"] == "kiosk-abc", "call_member invites into the job's room")
        check(got.get("u", [""])[0].startswith("wss://"), f"call_member puts the LiveKit URL in the link: {got.get('u')}")
    finally:
        staff_call._send_email = real_send

    check(staff_call.is_staff("staff-nbastien") and not staff_call.is_staff("visitor-1") and not staff_call.is_staff("simli-avatar-agent"),
          "is_staff by identity prefix")

    print("— call_staff guards, direct calls:")
    import worker

    agent = worker.MiaAgent(tts=None, on_screen=lambda msg: calls.append(("screen", msg)))
    agent._chosen_language = "en"
    agent._visitor_lines = ["Hi, can you call Nicolas for me?"]
    n = len(calls)
    for name in ("there", "Nicolas", "the visitor"):
        out = await agent.call_staff(None, member="Nicolas", visitor_name=name)
        check(out.startswith("NOT CALLED") and "name" in out, f"call_staff(visitor_name={name!r}) before any name: {out[:50]}")
    agent._visitor_lines.append("I'm Eve Adams.")
    for who in ("Marc Dupont", "the general inbox", "info"):
        out = await agent.call_staff(None, member=who, visitor_name="Eve Adams")
        check(out.startswith("NOT CALLED"), f"call_staff(member={who!r}): {out[:50]}")
    agent._staff["staff-ajoset"] = "Alexandre Joset"
    out = await agent.call_staff(None, member="Nicolas", visitor_name="Eve Adams")
    check(out.startswith("NOT CALLED") and "already in the call" in out, f"while someone is in the call: {out[:60]}")
    agent._staff.clear()
    agent._call_member = NICOLAS
    out = await agent.call_staff(None, member="Nicolas", visitor_name="Eve Adams")
    check(out.startswith("NOT CALLED") and "already calling Nicolas" in out, f"while a call is ringing: {out[:60]}")
    agent._call_member = None
    real_call = worker.start_staff_call

    async def failing(member, visitor_name, assistant):
        calls.append(("call", member.full_name, visitor_name))
        return False

    worker.start_staff_call = failing
    try:
        out = await agent.call_staff(None, member="Nicolas", visitor_name="Eve Adams")
    finally:
        worker.start_staff_call = real_call
    check(out.startswith("NOT CALLED") and "could not be placed" in out, f"email failed: {out[:60]}")
    check(agent._call_member is None and not screens(n, "calling"), "nothing shown when the call failed")
    check(len(recorded("call", n)) == 1, f"only the failing attempt reached the email: {recorded('call', n)}")


# --- conversations ------------------------------------------------------------


async def her_next_words(c: Conversation, seen: int, within: float = 20.0) -> str:
    """What she says on her own (no visitor line), starting from history item `seen`."""
    deadline = time.monotonic() + within
    while time.monotonic() < deadline:
        await asyncio.sleep(0.5)
        while (speech := c.session.current_speech) is not None:
            await speech
        said = [
            i.text_content
            for i in c.session.history.items[seen:]
            if getattr(i, "type", "") == "message" and i.role == "assistant" and i.text_content
        ]
        if said:
            print(f"  MIA (on her own): {' '.join(said)}")
            return " ".join(said)
    return ""


async def conv_offer() -> None:
    print("— English, wants to talk to Nicolas: offer, yes with the name, call:")
    n = len(calls)
    async with Conversation("en") as c:
        r1 = await c.say("Hi, I'd like to talk to Nicolas, please.")
        check(has(r1, "call") and not recorded("call", n), f"offers to call, doesn't call yet: {r1!r}")
        r2 = await c.say("Yes please. I'm Sophie Martin.")
    called = recorded("call", n)
    check(not has(r1, "i'm calling", "i am calling"), f"doesn't say she's calling before the yes: {r1!r}")
    check(len(called) == 1 and called[0][1:] == ("Nicolas Bastien", "Sophie Martin"), f"called Nicolas for Sophie Martin: {called}")
    check(has(r2, "I'm calling Nicolas now"), f"says 'I'm calling Nicolas now': {r2!r}")
    cards = screens(n, "calling")
    check(len(cards) == 1 and cards[0].get("to") == "Nicolas Bastien" and cards[0].get("lang") == "en", f"calling card: {cards}")
    check(not recorded("notify", n), "no notify_member on top of the call")


async def conv_name_first() -> None:
    print("— English, 'call Alex' before giving a name:")
    n = len(calls)
    async with Conversation("en") as c:
        r1 = await c.say("Can you call Alex for me right now?")
        check(not recorded("call", n), f"no call before the visitor's name: {recorded('call', n)}")
        # Either order is fine (Gemini varies): the name first, or the offer first.
        check(has(r1, "name", "call"), f"asks for the name or offers the call: {r1!r}")
        await c.say("David Chen.")
    called = recorded("call", n)
    check(len(called) == 1 and called[0][1:] == ("Alexandre Joset", "David Chen"), f"then calls Alexandre: {called}")


async def conv_someone() -> None:
    print("— English, a real person, nobody named:")
    n = len(calls)
    async with Conversation("en") as c:
        r1 = await c.say("Can I speak to a real person?")
        await c.say("Sure. My name is Tom Baker.")
    called = recorded("call", n)
    check(has(r1, "Nicolas", "name", "connect"), f"offers Nicolas or asks the name first: {r1!r}")
    check(len(called) == 1 and called[0][1] == "Nicolas Bastien", f"calls Nicolas: {called}")


async def conv_unknown() -> None:
    print("— English, someone not on the team:")
    n = len(calls)
    async with Conversation("en") as c:
        r1 = await c.say("Hi, I'm Paul Roy. Can you call Marc Dupont for me?")
    check(not recorded("call", n) and not recorded("notify", n), f"nobody called or notified: {calls[n:]}")
    check(not has(r1, "i'm calling", "calling marc"), f"doesn't pretend to call: {r1!r}")


async def conv_decline() -> None:
    print("— English, doesn't want the call: notify instead:")
    n = len(calls)
    async with Conversation("en") as c:
        await c.say("I'd like to talk to Nicolas.")
        await c.say("No, don't call him. Just let him know I'm here. I'm Marie Roy.")
    check(not recorded("call", n), f"no call: {recorded('call', n)}")
    notified = recorded("notify", n)
    check(len(notified) == 1 and notified[0][1] == "Nicolas Bastien", f"Nicolas notified instead: {notified}")


async def conv_no_answer_fr() -> None:
    print("— French, call, nobody answers, a message instead:")
    import worker

    real_timeout = worker.CALL_ANSWER_TIMEOUT
    worker.CALL_ANSWER_TIMEOUT = 4
    n = len(calls)
    try:
        async with Conversation("fr") as c:
            r1 = await c.say("Bonjour, je voudrais parler à Alexandre.")
            r2 = await c.say("Oui, appelez-le s'il vous plaît. Je m'appelle Lucie Bouchard.")
            called = recorded("call", n)
            check(has(r1, "appelle"), f"offers the call (FR): {r1!r}")
            check(len(called) == 1 and called[0][1:] == ("Alexandre Joset", "Lucie Bouchard"), f"calls Alexandre: {called}")
            check(has(r2, "J'appelle Alexandre"), f"'J'appelle Alexandre maintenant' (FR): {r2!r}")
            seen = len(c.session.history.items)
            said = await her_next_words(c, seen, within=20)
            check(has(said, "Alexandre") and has(said, "message"), f"no answer: says so and offers a message: {said!r}")
            check(len(screens(n, "dismiss")) == 1, "calling card dismissed")
            check(not c.agent.call_active and c.agent.call_ended_at is not None, "the call is over")
            await c.say("Oui, dites-lui que je repasserai demain matin.")
            await c.say("Pas besoin de me rappeler. Oui, c'est parfait, envoyez-le.")
    finally:
        worker.CALL_ANSWER_TIMEOUT = real_timeout
    sent = recorded("message", n)
    check(len(sent) == 1 and sent[0][1] == "Alexandre Joset" and "Lucie" in sent[0][2], f"message to Alexandre: {sent}")


async def conv_handover() -> None:
    print("— English, Nicolas joins: she's quiet, then takes the visitor back:")
    n = len(calls)
    async with Conversation("en") as c:
        await c.say("Could you call Nicolas for me? I'm Sophie Martin.")
        if not recorded("call", n):
            await c.say("Yes please.")
        check(len(recorded("call", n)) == 1, f"Nicolas called: {recorded('call', n)}")
        c.agent.staff_joined("staff-nbastien", "Nicolas Bastien")
        check(c.agent.handover and not c.agent.paused, "handover state")
        check(len(screens(n, "dismiss")) == 1, "calling card dismissed when he joins")
        quiet = [await c.say(line) for line in ("Hi Nicolas! Thanks for joining.", "So about the contract, can we meet Tuesday?")]
        check(not any(quiet), f"says nothing while he's in the call: {quiet}")
        seen = len(c.session.history.items)
        c.agent.staff_left("staff-nbastien")
        back = await her_next_words(c, seen)
        check(has(back, "anything else"), f"back with 'anything else': {back!r}")
        check(not c.agent.handover and c.agent.call_ended_at is not None, "handover over")
        r = await c.say("What did I just talk about with Nicolas?")
        check(not has(r, "tuesday", "contract"), f"heard nothing of the call: {r!r}")
        await c.say("No, that's all. Thank you, goodbye!")
    check(recorded("end", n) != [], "ends on goodbye after the call")


CONVERSATIONS = {
    "offer": conv_offer,
    "name_first": conv_name_first,
    "someone": conv_someone,
    "unknown": conv_unknown,
    "decline": conv_decline,
    "no_answer": conv_no_answer_fr,
    "handover": conv_handover,
}


async def main() -> None:
    import worker

    use_assistant_name(worker)
    install_recorders(worker)
    names = sys.argv[1:]
    if not names or "offline" in names:
        await offline()
    for name in names or CONVERSATIONS:
        if name != "offline":
            await CONVERSATIONS[name]()
    print(f"\n{len(failures)} failure(s)" + "".join(f"\n  ✗ {f}" for f in failures))
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    asyncio.run(main())
