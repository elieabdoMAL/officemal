"""Checks for the video call to staff (#22, staff_call.py). Run inside the worker image:

    docker run --rm --env-file .env -v "$PWD":/app -e RESEND_API_KEY= simli-worker python test_staff_call.py

1. Offline: the call room (two people, timeouts), the tokens (staff and
   kiosk: that room only, camera and mic only), the link (token in the
   fragment), the email (escaped), what the call room's lookups mean, the
   call_open message, and the worker's call states (answered, gone, timeout,
   hang-up) and call_staff's guards. LiveKit is replaced by fakes.
2. Text conversations with the real Gemini model, the call replaced by a
   recorder (same harness as test_team_messages.py): she offers the call, asks
   the visitor's name, calls and opens the call window; nobody answers or the
   visitor cancels, and she offers a message; they join, and her session ends.

Pass names to run only those conversations, e.g. `python test_staff_call.py answered`.
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
from livekit import api
from team_messages import find_member, load_team
from test_team_messages import Conversation, FakeCall, calls, fake_calls, install_recorders, use_assistant_name

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


class FakeRoomService:
    """LiveKitAPI.room, recording what it is asked; `participants` is what
    list_participants answers, or an exception to raise."""

    def __init__(self) -> None:
        self.created: list = []
        self.deleted: list[str] = []
        self.participants: list[str] | Exception = []

    async def create_room(self, req):
        self.created.append(req)

    async def delete_room(self, req):
        self.deleted.append(req.room)
        if isinstance(self.participants, Exception):
            raise self.participants

    async def list_participants(self, req):
        if isinstance(self.participants, Exception):
            raise self.participants
        return types.SimpleNamespace(participants=[types.SimpleNamespace(identity=i) for i in self.participants])


# --- offline ------------------------------------------------------------------


async def offline() -> None:
    print("— tokens, link and email:")
    token = staff_call.join_token("call-test-room", NICOLAS, "Eve Adams")
    claims = jwt_claims(token)
    video = claims.get("video", {})
    check(json.loads(claims.get("metadata", "{}")).get("visitor") == "Eve Adams", f"visitor's name in the metadata: {claims.get('metadata')}")
    check(claims.get("sub") == "staff-nbastien", f"identity staff-<team.json id>: {claims.get('sub')}")
    check(claims.get("name") == "Nicolas Bastien", f"name is the display name: {claims.get('name')}")
    check(video.get("room") == "call-test-room" and video.get("roomJoin") is True, f"this room only: {video}")
    check(sorted(video.get("canPublishSources", [])) == ["camera", "microphone"], f"camera and mic only: {video}")
    check(not video.get("roomAdmin") and not video.get("roomCreate") and video.get("canPublishData") is False,
          f"no admin, room creation or data (so no chat): {video}")
    ttl = claims["exp"] - claims["nbf"]
    check(14 * 60 <= ttl <= 15 * 60 + 5, f"valid ~15 minutes: {ttl}s")

    kiosk = jwt_claims(staff_call.kiosk_token("call-test-room", "Eve Adams"))
    kvideo = kiosk.get("video", {})
    check(kiosk.get("sub", "").startswith("visitor-") and kiosk.get("name") == "Eve Adams",
          f"kiosk token: visitor-…, named with the visitor's name: {kiosk.get('sub')} {kiosk.get('name')}")
    check(kvideo.get("room") == "call-test-room" and sorted(kvideo.get("canPublishSources", [])) == ["camera", "microphone"]
          and kvideo.get("canPublishData") is False and not kvideo.get("roomAdmin"), f"kiosk: this room, camera and mic only: {kvideo}")
    check(kiosk["exp"] - kiosk["nbf"] <= 5 * 60 + 5, f"kiosk token short-lived: {kiosk['exp'] - kiosk['nbf']}s")

    link = staff_call.join_link(token, "wss://example.livekit.cloud", site="https://kiosk.example")
    base, _, fragment = link.partition("#")
    params = urllib.parse.parse_qs(fragment)
    check(base == "https://kiosk.example/join", f"link to /join: {base}")
    check(params.get("t") == [token] and params.get("u") == ["wss://example.livekit.cloud"], "token and LiveKit URL in the fragment")
    check("?" not in base, "nothing in the query string (it would reach server logs)")

    sent: list[tuple] = []
    email_ok = True

    async def fake_send(what, to, subject, body, reply_to=""):
        sent.append((what, to, subject, body))
        return email_ok

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

        print("— open_call: a private room, the link into it, the kiosk's token for it:")
        import livekit.agents as agents

        rooms = FakeRoomService()
        real_ctx = agents.get_job_context
        agents.get_job_context = lambda: types.SimpleNamespace(api=types.SimpleNamespace(room=rooms))
        try:
            sent.clear()
            call = await staff_call.open_call(NICOLAS, "Eve Adams", "Linda")
            check(call is not None and call.room.startswith("call-") and len(rooms.created) == 1,
                  f"a call room is created: {call and call.room}")
            req = rooms.created[0] if rooms.created else None
            check(req is not None and req.name == call.room and req.max_participants == 2
                  and req.empty_timeout > 0 and req.departure_timeout > 0,
                  f"two people at most, empty and departure timeouts: {req}")
            body = sent[0][3] if sent else ""
            href = body.split('href="', 1)[-1].split('"', 1)[0].replace("&amp;", "&")
            got = urllib.parse.parse_qs(href.partition("#")[2])
            check(jwt_claims(got["t"][0])["video"]["room"] == call.room, "the link's token is for the call room")
            check(got.get("u", [""])[0].startswith("wss://") and call.url == got["u"][0], f"the LiveKit URL in the link and for the kiosk: {got.get('u')}")
            check(jwt_claims(call.kiosk_token)["video"]["room"] == call.room, "the kiosk's token is for the call room")
            msg = staff_call.call_open_message(call, "fr")
            check(msg == {"type": "call_open", "url": call.url, "token": call.kiosk_token, "to": "Nicolas Bastien", "lang": "fr"},
                  f"call_open message: {msg}")
            check("lang" not in staff_call.call_open_message(call, None), "no lang before the visitor chose one")

            email_ok = False
            rooms.created.clear()
            failed = await staff_call.open_call(NICOLAS, "Eve Adams", "Linda")
            check(failed is None and rooms.deleted == [rooms.created[0].name], f"email failed: no call, room deleted: {rooms.deleted}")
        finally:
            agents.get_job_context = real_ctx
    finally:
        staff_call._send_email = real_send

    print("— what the call room's lookups mean:")
    rooms = FakeRoomService()
    room = staff_call.CallRoom(NICOLAS, "call-x", "wss://x", "k", types.SimpleNamespace(room=rooms))
    rooms.participants = ["visitor-abc"]
    check(await room.status() == staff_call.WAITING, "only the kiosk: waiting")
    rooms.participants = ["visitor-abc", "staff-nbastien"]
    check(await room.status() == staff_call.ANSWERED, "a staff- participant: answered")
    rooms.participants = api.TwirpError("not_found", "requested room does not exist", status=404)
    check(await room.status() == staff_call.GONE, "room not found: gone")
    await room.close()
    check(rooms.deleted == ["call-x"], "close() on a room already gone doesn't raise")
    rooms.participants = api.TwirpError("unavailable", "try later", status=503)
    check(await room.status() == staff_call.WAITING, "lookup failed: still waiting (asks again)")
    rooms.participants = OSError("network")
    check(await room.status() == staff_call.WAITING, "network error: still waiting")

    check(staff_call.is_staff("staff-nbastien") and not staff_call.is_staff("visitor-1") and not staff_call.is_staff("simli-avatar-agent"),
          "is_staff by identity prefix")

    print("— the worker's call states, no Gemini:")
    import worker

    answered: list = []
    agent = worker.MiaAgent(tts=None, on_screen=lambda msg: calls.append(("screen", msg)), on_call_answered=lambda: answered.append(1))
    agent._stop_speaking = lambda: None
    over: list[str] = []

    async def record_over(call, why):
        over.append(why)
        agent._call = None

    real_over = agent._call_over
    agent._call_over = record_over
    real_poll = worker.CALL_POLL_S
    worker.CALL_POLL_S = 0.05
    try:
        fake = FakeCall(NICOLAS)
        agent._call = fake
        fake.state = "answered"
        await agent._watch_call(fake)
        check(answered == [1] and not agent.call_active and not fake.closed,
              "answered: her session is told to end, the call room is left open")
        fake = FakeCall(NICOLAS)
        agent._call = fake
        fake.state = "gone"
        await agent._watch_call(fake)
        check(over == ["cancelled"], f"room gone: cancelled: {over}")
        real_timeout = worker.CALL_ANSWER_TIMEOUT
        worker.CALL_ANSWER_TIMEOUT = 0.2
        try:
            fake = FakeCall(NICOLAS)
            agent._call = fake
            t0 = time.monotonic()
            await agent._watch_call(fake)
            check(over[-1] == "no_answer" and time.monotonic() - t0 < 2, f"nobody within the timeout: no answer: {over}")
        finally:
            worker.CALL_ANSWER_TIMEOUT = real_timeout
        agent._call = None
        agent.cancel_call_by_tap()
        check(over[-1] == "no_answer", "call_cancel with no call ringing: ignored")
    finally:
        worker.CALL_POLL_S = real_poll
        agent._call_over = real_over

    fake = FakeCall(NICOLAS)
    agent._call = fake
    await agent.hang_up()
    check(fake.closed and not agent.call_active, "session ending while it rings: the call room is closed")
    await agent.hang_up()  # nothing ringing: nothing to do

    print("— call_staff guards, direct calls:")
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
    agent._call = FakeCall(NICOLAS)
    out = await agent.call_staff(None, member="Nicolas", visitor_name="Eve Adams")
    check(out.startswith("NOT CALLED") and "already calling Nicolas" in out, f"while a call is ringing: {out[:60]}")
    agent._call = None
    real_call = worker.start_staff_call

    async def failing(member, visitor_name, assistant):
        calls.append(("call", member.full_name, visitor_name))
        return None

    worker.start_staff_call = failing
    try:
        out = await agent.call_staff(None, member="Nicolas", visitor_name="Eve Adams")
    finally:
        worker.start_staff_call = real_call
    check(out.startswith("NOT CALLED") and "could not be placed" in out, f"call failed: {out[:60]}")
    check(agent._call is None and not screens(n, "call_open"), "nothing shown when the call failed")
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


async def placed_call(c: Conversation, n: int, *lines: str) -> FakeCall | None:
    """Say `lines` (then "Yes please." if she only offered); the call she placed."""
    for line in lines:
        await c.say(line)
    if not recorded("call", n):
        await c.say("Yes please.")
    check(len(recorded("call", n)) == 1, f"call placed: {recorded('call', n)}")
    return fake_calls[-1] if recorded("call", n) else None


async def conv_offer() -> None:
    print("— English, wants to talk to Nicolas: offer, yes with the name, call:")
    n = len(calls)
    async with Conversation("en") as c:
        r1 = await c.say("Hi, I'd like to talk to Nicolas, please.")
        check(has(r1, "call") and not recorded("call", n), f"offers to call, doesn't call yet: {r1!r}")
        r2 = await c.say("Yes please. I'm Sophie Martin.")
        check(c.agent.call_active, "the call is ringing")
    called = recorded("call", n)
    check(not has(r1, "i'm calling", "i am calling"), f"doesn't say she's calling before the yes: {r1!r}")
    check(len(called) == 1 and called[0][1:] == ("Nicolas Bastien", "Sophie Martin"), f"called Nicolas for Sophie Martin: {called}")
    check(has(r2, "I'm calling Nicolas now"), f"says 'I'm calling Nicolas now': {r2!r}")
    opened = screens(n, "call_open")
    check(len(opened) == 1 and opened[0].get("to") == "Nicolas Bastien" and opened[0].get("lang") == "en"
          and opened[0].get("token") == "kiosk-token" and opened[0].get("url", "").startswith("wss://"),
          f"call window opened with the kiosk's token: {opened}")
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
            check(len(screens(n, "call_close")) == 1, "call window closed (call_close)")
            check(bool(fake_calls) and fake_calls[-1].closed, "call room deleted")
            check(not c.agent.call_active and c.agent.call_ended_at is not None, "the call is over")
            await c.say("Oui, dites-lui que je repasserai demain matin.")
            await c.say("Pas besoin de me rappeler. Oui, c'est parfait, envoyez-le.")
    finally:
        worker.CALL_ANSWER_TIMEOUT = real_timeout
    sent = recorded("message", n)
    check(len(sent) == 1 and sent[0][1] == "Alexandre Joset" and "Lucie" in sent[0][2], f"message to Alexandre: {sent}")


async def conv_cancel() -> None:
    print("— English, call, the visitor taps Cancel: a message instead:")
    n = len(calls)
    async with Conversation("en") as c:
        call = await placed_call(c, n, "Could you call Nicolas for me? I'm Sophie Martin.")
        seen = len(c.session.history.items)
        c.agent.cancel_call_by_tap()
        said = await her_next_words(c, seen)
        check(has(said, "message"), f"offers a message: {said!r}")
        check(not has(said, "isn't available", "not available", "didn't answer", "did not answer"),
              f"doesn't say he didn't answer (the visitor cancelled): {said!r}")
        check(len(screens(n, "call_close")) == 1 and call is not None and call.closed, "call window closed, call room deleted")
        check(not c.agent.call_active, "the call is over")
        r = await c.say("Yes, tell him I'll come back on Monday.")
        check(not recorded("call", n)[1:], f"doesn't call again: {recorded('call', n)}")
        print(f"  (after the cancel: {r!r})")


async def conv_answered() -> None:
    print("— English, Nicolas joins: her session ends, she says nothing more:")
    n = len(calls)
    ended: list = []
    async with Conversation("en") as c:
        c.agent._on_call_answered = lambda: ended.append(time.monotonic())
        call = await placed_call(c, n, "Could you call Nicolas for me? I'm Sophie Martin.")
        seen = len(c.session.history.items)
        if call is not None:
            call.state = "answered"
        deadline = time.monotonic() + 10
        while not ended and time.monotonic() < deadline:
            await asyncio.sleep(0.2)
        check(len(ended) == 1, "her session is told to end once he joins")
        check(not c.agent.call_active and call is not None and not call.closed, "the call room stays open (the call goes on)")
        check(not screens(n, "call_close"), "the call window stays open")
        said = await her_next_words(c, seen, within=5)
        check(not said, f"she says nothing after he joins: {said!r}")


CONVERSATIONS = {
    "offer": conv_offer,
    "name_first": conv_name_first,
    "someone": conv_someone,
    "unknown": conv_unknown,
    "decline": conv_decline,
    "no_answer": conv_no_answer_fr,
    "cancel": conv_cancel,
    "answered": conv_answered,
}


async def main() -> None:
    import worker

    use_assistant_name(worker)
    install_recorders(worker)
    worker.CALL_POLL_S = 0.2
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
