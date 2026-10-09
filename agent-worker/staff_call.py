"""Video calls to staff (#22, "put us online").

When a visitor wants to talk to a person, she can call someone listed in
team.json into the kiosk conversation itself: call_staff (worker.py) mints a
short-lived LiveKit join token for this kiosk's room and emails the person a
link to the site's /join page. They join from their phone or computer with
camera and mic; the kiosk shows their video, and she stays quiet ("handover")
until they leave. Nobody joining within CALL_ANSWER_TIMEOUT: she tells the
visitor and offers to take a message.

The link carries the token in its fragment (#t=...&u=...), which browsers
never send to a server, so it stays out of access logs. The /join page hands
it to /api/livekit/call-status, which checks it and that the visitor is still
there, before joining.

Env: LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET (as for the worker),
SITE_URL (where /join lives), CALL_ANSWER_TIMEOUT, SESSION_HARD_CAP.
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
from collections.abc import Callable

from livekit import api, rtc

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


# Staff join as "staff-<team.json id>"; the kiosk is "visitor-<uuid>".
STAFF_PREFIX = "staff-"
# Nobody joined within this long: she tells the visitor and offers a message.
# Shortened through env for tests.
CALL_ANSWER_TIMEOUT = _env_int("CALL_ANSWER_TIMEOUT", 120)
# The join link works this long (LiveKit only checks it when joining).
CALL_LINK_TTL = datetime.timedelta(minutes=15)
# No session lasts longer than this, call or not. Without a call the usual
# SESSION_MAX_LENGTH (10 min) still applies; a call stretches it up to here.
SESSION_HARD_CAP = _env_int("SESSION_HARD_CAP", 1800)
# After the person leaves, the visitor still has this long with her, even if
# the usual max length has passed meanwhile.
AFTER_CALL_S = 180
# One visitor calls one person, maybe a second after no answer.
MAX_CALLS_PER_SESSION = 2

SITE_URL = (os.environ.get("SITE_URL", "").strip() or "https://officemal.mobileappslabs.ca").rstrip("/")


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


def join_token(
    room: str, member: Member, visitor_name: str = "", ttl: datetime.timedelta = CALL_LINK_TTL
) -> str:
    """A token that lets `member` into `room` only, with camera and mic. The
    visitor's name rides in its metadata, for the /join page to show."""
    return (
        api.AccessToken()  # LIVEKIT_API_KEY / LIVEKIT_API_SECRET
        .with_identity(STAFF_PREFIX + member_id(member))
        .with_name(member.full_name)
        .with_metadata(json.dumps({"visitor": _one_line(visitor_name, MAX_NAME_CHARS)}))
        .with_ttl(ttl)
        .with_grants(
            api.VideoGrants(
                room_join=True,
                room=room,
                can_subscribe=True,
                can_publish=True,
                can_publish_data=False,
                can_publish_sources=["camera", "microphone"],
            )
        )
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
          Join the video call from your phone or computer: they will see and hear you.</p>
        <p style="margin:0 0 16px"><a href="{e(link)}" style="display:inline-block;padding:14px 22px;background:#0070f3;color:#fff;border-radius:10px;text-decoration:none;font-weight:bold">Join the call</a></p>
        <p style="margin:0 0 8px;color:#777;font-size:13px">The link works for {minutes} minutes. If nobody joins within
          {wait} minute{"s" if wait > 1 else ""}, {e(assistant)} offers to take a message instead. When you leave the call,
          {e(assistant)} takes over again.</p>
        <p style="margin:16px 0 0;color:#999;font-size:12px">Sent by the virtual receptionist. The visitor's name was
          transcribed by speech recognition and may contain errors. Don't forward this email: the link lets anyone into the call.</p>
      </div>
    """
    return await _send_email(
        "call_staff", [member.email], f"{visitor_name} is at the kiosk — join the call", body
    )


async def call_member(member: Member, visitor_name: str, assistant: str) -> bool:
    """Invite `member` into this job's room by email. True only if the email went out."""
    from livekit.agents import get_job_context

    room = get_job_context().room.name
    livekit_url = os.environ.get("LIVEKIT_URL", "").strip()
    if not livekit_url:
        logger.error("call_staff: LIVEKIT_URL is not set")
        return False
    try:
        token = join_token(room, member, visitor_name)
    except Exception:
        logger.exception("call_staff: could not mint the join token")
        return False
    logger.info("call_staff: inviting %s into %s", member.full_name, room)
    return await send_call_email(member, visitor_name, join_link(token, livekit_url), assistant)


def calling_card(to: str, lang: str | None) -> dict:
    """The "Calling Nicolas Bastien…" card (docs/screen-protocol.md)."""
    msg = {"type": "calling", "to": to}
    if lang:
        msg["lang"] = lang
    return msg


def watch_staff(
    room: rtc.Room,
    on_join: Callable[[str, str], None],
    on_leave: Callable[[str], None],
) -> None:
    """Call on_join(identity, name) / on_leave(identity) as staff come and go."""

    @room.on("participant_connected")
    def _joined(p: rtc.RemoteParticipant) -> None:
        if is_staff(p.identity):
            on_join(p.identity, p.name or p.identity[len(STAFF_PREFIX) :])

    @room.on("participant_disconnected")
    def _left(p: rtc.RemoteParticipant) -> None:
        if is_staff(p.identity):
            on_leave(p.identity)
