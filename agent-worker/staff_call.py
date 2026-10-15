"""Video calls to staff (#22, "put us online").

When a visitor wants to talk to a person, she can call someone listed in
team.json. call_staff (worker.py) opens a private LiveKit room for the call
(CallRoom: "call-<uuid>", two people at most), emails the person a link to the
site's /join page with a token for that room, and hands the kiosk its own
token on "mia.screen" (call_open). The kiosk's top page opens a full-screen
call window and joins the room with camera and mic, "Calling Nicolas…" until
they join; her own session stays up meanwhile, with the kiosk's mic muted.

- They join: her session ends (the worker deletes the kiosk room, the kiosk
  hides her). The call goes on in the call window without her; the visitor
  starts a fresh session with the AI button afterwards.
- Nobody within CALL_ANSWER_TIMEOUT, or the visitor cancels the call: the
  worker deletes the call room, the window closes, she offers a message.
- The visitor leaves while it rings: the call room goes with her session.

The worker watches the call room through LiveKit's server API
(CallRoom.status, every CALL_POLL_S), never joining it. The kiosk's Cancel
also arrives as "call_cancel" on mia.control. docs/screen-protocol.md
section 8 has the whole flow, both sides.

The link carries the token in its fragment (#t=...&u=...), which browsers
never send to a server, so it stays out of access logs. The /join page hands
it to /api/livekit/call-status, which checks it and that the call room is
still open with the visitor in it, before joining.

Env: LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET (as for the worker),
SITE_URL (where /join lives), CALL_ANSWER_TIMEOUT.
Emails go to the member's team.json address, so the sandbox team.json covers
them in tests.
"""

import datetime
import html
import json
import logging
import os
import re
import urllib.parse
import uuid
from dataclasses import dataclass

from livekit import api

from team_messages import (
    MAX_NAME_CHARS,
    TEAM_FILE,
    Member,
    _norm,
    _one_line,
    _send_email,
)

logger = logging.getLogger("simli-receptionist")


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    try:
        return int(raw) if raw else default
    except ValueError:
        logger.warning("%s=%r is not an integer, using %s", name, raw, default)
        return default


# Staff join as "staff-<team.json id>"; the kiosk as "visitor-<uuid>", in the
# call room as in its own.
STAFF_PREFIX = "staff-"
VISITOR_PREFIX = "visitor-"
CALL_ROOM_PREFIX = "call-"
# Nobody joined within this long: she tells the visitor and offers a message.
# Shortened through env for tests.
CALL_ANSWER_TIMEOUT = _env_int("CALL_ANSWER_TIMEOUT", 120)
# How often the worker asks LiveKit who is in the call room while it rings.
CALL_POLL_S = 1.0
# The join link works this long (LiveKit only checks it when joining).
CALL_LINK_TTL = datetime.timedelta(minutes=15)
# The kiosk joins at once; this only bounds a token that leaks.
KIOSK_TOKEN_TTL = datetime.timedelta(minutes=5)
# The call room: the visitor and the person called, nobody else. LiveKit
# closes it on its own if nobody ever joins (the kiosk does at once) or this
# long after the last one leaves; normally whoever leaves deletes it.
CALL_MAX_PARTICIPANTS = 2
CALL_EMPTY_TIMEOUT_S = 60
CALL_DEPARTURE_TIMEOUT_S = 20
# After a call that wasn't answered, the visitor still has this long with her
# (to leave a message), even if the usual max length has passed meanwhile.
AFTER_CALL_S = 180
# One visitor calls one person, maybe a second after no answer.
MAX_CALLS_PER_SESSION = 2

SITE_URL = (os.environ.get("SITE_URL", "").strip() or "https://officemal.mobileappslabs.ca").rstrip("/")

# What CallRoom.status reports.
WAITING = "waiting"  # ringing: nobody from the team yet
ANSWERED = "answered"  # someone from the team is in the call room
GONE = "gone"  # the call room no longer exists (the kiosk cancelled)


def is_staff(identity: str) -> bool:
    return identity.startswith(STAFF_PREFIX)


def _member_ids() -> dict[tuple[str, str], str]:
    """team.json ids by (first, last) name; Member doesn't carry them."""
    try:
        data = json.loads(TEAM_FILE.read_text(encoding="utf-8"))
    except Exception:
        logger.exception("could not read the team.json ids")
        return {}
    return {(m["first_name"], m["last_name"]): m["id"] for m in data.get("members", []) if m.get("id")}


def member_id(member: Member) -> str:
    """Their team.json id ("nbastien"), or their name made into one."""
    found = _member_ids().get((member.first_name, member.last_name))
    return found or re.sub(r"[^a-z0-9]+", "-", _norm(member.full_name)).strip("-") or "member"


def new_room_name() -> str:
    return CALL_ROOM_PREFIX + uuid.uuid4().hex


def _call_grants(room: str) -> api.VideoGrants:
    """Into `room` only, camera and mic only: no data (so no chat), no screen share."""
    return api.VideoGrants(
        room_join=True,
        room=room,
        can_subscribe=True,
        can_publish=True,
        can_publish_data=False,
        can_publish_sources=["camera", "microphone"],
    )


def join_token(
    room: str, member: Member, visitor_name: str = "", ttl: datetime.timedelta = CALL_LINK_TTL
) -> str:
    """The team member's token for the call room. The visitor's name rides in
    its metadata, for the /join page to show."""
    return (
        api.AccessToken()  # LIVEKIT_API_KEY / LIVEKIT_API_SECRET
        .with_identity(STAFF_PREFIX + member_id(member))
        .with_name(member.full_name)
        .with_metadata(json.dumps({"visitor": _one_line(visitor_name, MAX_NAME_CHARS)}))
        .with_ttl(ttl)
        .with_grants(_call_grants(room))
        .to_jwt()
    )


def kiosk_token(room: str, visitor_name: str, ttl: datetime.timedelta = KIOSK_TOKEN_TTL) -> str:
    """The kiosk's token for the call room, named with the visitor's name (their tile)."""
    return (
        api.AccessToken()
        .with_identity(VISITOR_PREFIX + uuid.uuid4().hex[:12])
        .with_name(_one_line(visitor_name, MAX_NAME_CHARS) or "Visitor")
        .with_ttl(ttl)
        .with_grants(_call_grants(room))
        .to_jwt()
    )


def join_link(token: str, livekit_url: str, site: str = SITE_URL) -> str:
    """https://<site>/join#t=<token>&u=<livekit url>: in the fragment, never sent to a server."""
    return f"{site}/join#" + urllib.parse.urlencode({"t": token, "u": livekit_url})


async def send_call_email(member: Member, visitor_name: str, link: str, assistant: str) -> bool:
    """Email `member` the join link. True only if Resend accepted it."""
    visitor_name = _one_line(visitor_name, MAX_NAME_CHARS)
    e = html.escape  # the name was spoken by a stranger at the kiosk
    minutes = int(CALL_LINK_TTL.total_seconds() // 60)
    wait = max(1, round(CALL_ANSWER_TIMEOUT / 60))
    body = f"""
      <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px;background:#f9f9f9;border-radius:12px">
        <h2 style="margin:0 0 16px;color:#1a1a1a">{e(visitor_name)} is at the kiosk</h2>
        <p style="margin:0 0 16px;color:#333">{e(visitor_name)} is at the reception kiosk and would like to talk to you.
          Join the video call from your phone or computer: you will see and hear each other.</p>
        <p style="margin:0 0 16px"><a href="{e(link)}" style="display:inline-block;padding:14px 22px;background:#0070f3;color:#fff;border-radius:10px;text-decoration:none;font-weight:bold">Join the call</a></p>
        <p style="margin:0 0 8px;color:#777;font-size:13px">The link works for {minutes} minutes. If nobody joins within
          {wait} minute{"s" if wait > 1 else ""}, {e(assistant)} offers to take a message instead. The call ends for
          both of you when either of you leaves.</p>
        <p style="margin:16px 0 0;color:#999;font-size:12px">Sent by the virtual receptionist. The visitor's name was
          transcribed by speech recognition and may contain errors. Don't forward this email: the link lets anyone into the call.</p>
      </div>
    """
    return await _send_email(
        "call_staff", [member.email], f"{visitor_name} is at the kiosk — join the call", body
    )


@dataclass
class CallRoom:
    """One call: its room, who was called, and the kiosk's way in."""

    member: Member
    room: str
    url: str  # the LiveKit server, for the kiosk
    kiosk_token: str
    lk: api.LiveKitAPI

    async def status(self) -> str:
        """WAITING, ANSWERED or GONE. A failed lookup counts as WAITING: the
        next poll asks again, and the answer timeout still ends the wait."""
        try:
            res = await self.lk.room.list_participants(api.ListParticipantsRequest(room=self.room))
        except api.TwirpError as e:
            if e.code == api.TwirpErrorCode.NOT_FOUND:
                return GONE
            logger.warning("call room %s: lookup failed: %s", self.room, e)
            return WAITING
        except Exception as e:
            logger.warning("call room %s: lookup failed: %r", self.room, e)
            return WAITING
        return ANSWERED if any(is_staff(p.identity) for p in res.participants) else WAITING

    async def close(self) -> None:
        """Delete the call room: everyone in it is disconnected, and the link
        then says the visitor has left. Already gone is fine."""
        try:
            await self.lk.room.delete_room(api.DeleteRoomRequest(room=self.room))
            logger.info("call room %s deleted", self.room)
        except api.TwirpError as e:
            if e.code != api.TwirpErrorCode.NOT_FOUND:
                logger.warning("could not delete the call room %s: %s", self.room, e)
        except Exception:
            logger.exception("could not delete the call room %s", self.room)


async def open_call(member: Member, visitor_name: str, assistant: str) -> CallRoom | None:
    """Open a call room and email `member` the link to it. None (and no room
    left behind) unless the email went out."""
    from livekit.agents import get_job_context

    livekit_url = os.environ.get("LIVEKIT_URL", "").strip()
    if not livekit_url:
        logger.error("call_staff: LIVEKIT_URL is not set")
        return None
    lk = get_job_context().api
    room = new_room_name()
    try:
        await lk.room.create_room(
            api.CreateRoomRequest(
                name=room,
                max_participants=CALL_MAX_PARTICIPANTS,
                empty_timeout=CALL_EMPTY_TIMEOUT_S,
                departure_timeout=CALL_DEPARTURE_TIMEOUT_S,
            )
        )
        call = CallRoom(member, room, livekit_url, kiosk_token(room, visitor_name), lk)
        link = join_link(join_token(room, member, visitor_name), livekit_url)
    except Exception:
        logger.exception("call_staff: could not open the call room")
        return None
    logger.info("call_staff: inviting %s into %s", member.full_name, room)
    if not await send_call_email(member, visitor_name, link, assistant):
        await call.close()
        return None
    return call


def call_open_message(call: CallRoom, lang: str | None) -> dict:
    """mia.screen: open the call window on the kiosk and join `call.room`
    (docs/screen-protocol.md). `to` is the person's full name."""
    msg = {"type": "call_open", "url": call.url, "token": call.kiosk_token, "to": call.member.full_name}
    if lang:
        msg["lang"] = lang
    return msg


# mia.screen: the call wasn't answered (or was cancelled): close the window.
CALL_CLOSE = {"type": "call_close"}
# mia.screen: they joined; her session ends next, the call window stays.
CALL_ANSWERED = {"type": "call_answered"}
