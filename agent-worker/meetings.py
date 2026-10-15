"""Meetings on the Mobile Apps Labs meeting calendar (mia-tasks #8).

Mia sees and books meetings on ONE shared Google Calendar that the team
subscribes to; she never reads anyone's personal calendar. Access is a Google
service account the calendar is shared with ("Make changes to events"):

    GOOGLE_CALENDAR_ID            the calendar's ID (Settings > Integrate calendar)
    GOOGLE_SERVICE_ACCOUNT_FILE   path to the service account's JSON key
                                  (default: google-service-account.json next to this file)

Optional: CALENDAR_TIMEZONE (America/Toronto), OFFICE_HOURS (09:00-17:00),
weekdays only. Unset or unreadable: `configured()` is False and her tools
answer UNAVAILABLE, so she falls back to a message or the contact details.

Every event she creates carries `mia_member` (the member's email, or "team") in its
private extended properties. A meeting blocks that person, and a meeting with
the team blocks everyone. Anything put on the calendar by hand has no tag and
blocks everyone, so the team can close a slot by adding any event.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import unicodedata
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from pathlib import Path
from urllib.parse import quote
from zoneinfo import ZoneInfo

import aiohttp
from dotenv import load_dotenv

# Same as worker.py, which imports this module before it loads .env itself.
load_dotenv(override=True)

logger = logging.getLogger("meetings")

CALENDAR_ID = os.environ.get("GOOGLE_CALENDAR_ID", "").strip()
KEY_FILE = Path(
    os.environ.get("GOOGLE_SERVICE_ACCOUNT_FILE", "").strip()
    or Path(__file__).with_name("google-service-account.json")
)
SCOPE = "https://www.googleapis.com/auth/calendar.events"
EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars/{cal}/events"

TZ = ZoneInfo(os.environ.get("CALENDAR_TIMEZONE", "").strip() or "America/Toronto")
TEAM_KEY = "team"  # mia_member of a meeting with the whole team
SLOT_STEP = timedelta(minutes=30)
DEFAULT_MINUTES = 30
MIN_MINUTES, MAX_MINUTES = 15, 120
MIN_LEAD = timedelta(hours=1)  # no booking that starts sooner than this
MAX_DAYS_AHEAD = 60
WORKDAYS = {0, 1, 2, 3, 4}  # Monday to Friday


def _office_hours() -> tuple[time, time]:
    raw = os.environ.get("OFFICE_HOURS", "").strip() or "09:00-17:00"
    try:
        a, b = (time.fromisoformat(p.strip()) for p in raw.split("-"))
        if a < b:
            return a, b
    except ValueError:
        pass
    logger.warning("OFFICE_HOURS %r unreadable, using 09:00-17:00", raw)
    return time(9), time(17)


OPEN, CLOSE = _office_hours()


def configured() -> bool:
    return bool(CALENDAR_ID) and KEY_FILE.is_file()


# --- Reading what the visitor said ------------------------------------------

def _fold(text: str) -> str:
    t = unicodedata.normalize("NFKD", text.lower())
    return "".join(c for c in t if not unicodedata.combining(c)).strip()


WEEKDAYS = {
    "monday": 0, "tuesday": 1, "wednesday": 2, "thursday": 3, "friday": 4, "saturday": 5, "sunday": 6,
    "lundi": 0, "mardi": 1, "mercredi": 2, "jeudi": 3, "vendredi": 4, "samedi": 5, "dimanche": 6,
}
MONTHS = {
    "january": 1, "february": 2, "march": 3, "april": 4, "may": 5, "june": 6, "july": 7,
    "august": 8, "september": 9, "october": 10, "november": 11, "december": 12,
    "janvier": 1, "fevrier": 2, "mars": 3, "avril": 4, "mai": 5, "juin": 6, "juillet": 7,
    "aout": 8, "septembre": 9, "octobre": 10, "novembre": 11, "decembre": 12,
}
_ORDINAL = re.compile(r"\b(\d{1,2})(?:st|nd|rd|th|er|e)?\b")


def parse_day(text: str, today: date) -> date | None:
    """The day a visitor named: today, tomorrow, a weekday (the next one, today
    included), "October 14" / "le 14 octobre" / "the 14th" (the next such day),
    or 2026-10-14. None when it is not a day."""
    t = _fold(text)
    if not t:
        return None
    try:
        return date.fromisoformat(t[:10])
    except ValueError:
        pass
    if re.search(r"\b(after tomorrow|apres-demain|apres demain)\b", t):
        return today + timedelta(days=2)
    if re.search(r"\b(tomorrow|demain)\b", t):
        return today + timedelta(days=1)
    if re.search(r"\b(today|aujourd'hui|aujourdhui|this afternoon|this morning|cet apres-midi|ce matin)\b", t):
        return today
    month = next((n for name, n in MONTHS.items() if re.search(rf"\b{name}\b", t)), None)
    m = _ORDINAL.search(t)
    if m and (month or re.search(r"\b(the|le)\s+\d", t)):
        day_no = int(m.group(1))
        if month:  # "October 14": this year's, or next year's once it has passed
            for y in (today.year, today.year + 1):
                try:
                    d = date(y, month, day_no)
                except ValueError:
                    return None
                if d >= today:
                    return d
            return None
        y, mo = today.year, today.month  # "the 14th": the next 14th
        for _ in range(13):
            try:
                d = date(y, mo, day_no)
                if d >= today:
                    return d
            except ValueError:
                pass
            y, mo = (y + 1, 1) if mo == 12 else (y, mo + 1)
        return None
    for name, wd in WEEKDAYS.items():
        if re.search(rf"\b{name}\b", t):
            ahead = (wd - today.weekday()) % 7
            if re.search(r"\b(next|prochain)\b", t) and ahead == 0:
                ahead = 7
            return today + timedelta(days=ahead)
    return None


_TIME = re.compile(
    r"^(?P<h>\d{1,2})(?:\s*(?::|h|\.)\s*(?P<m>\d{2})?|\s+(?P<m2>\d{2}))?\s*(?P<ap>a\.?m\.?|p\.?m\.?)?$"
)


def parse_time(text: str) -> time | None:
    """A start time: 14:00, 14h30, 14 h, 2pm, 2:30 pm, noon / midi. None otherwise."""
    t = _fold(text).replace("heures", "h").replace("heure", "h")
    if t in ("noon", "midi", "midday"):
        return time(12)
    m = _TIME.match(t)
    if not m:
        return None
    h, mins = int(m.group("h")), int(m.group("m") or m.group("m2") or 0)
    ap = (m.group("ap") or "").replace(".", "")
    if ap == "pm" and h < 12:
        h += 12
    elif ap == "am" and h == 12:
        h = 0
    if h > 23 or mins > 59:
        return None
    return time(h, mins)


# --- What is free -------------------------------------------------------------

@dataclass(frozen=True)
class Busy:
    start: datetime
    end: datetime
    member: str | None  # the member's email, TEAM_KEY, or None (put there by hand)


def blocks(busy: Busy, member: str) -> bool:
    """Does `busy` stop a meeting with `member` (an email, or TEAM_KEY)?"""
    return busy.member is None or busy.member == TEAM_KEY or member == TEAM_KEY or busy.member == member


def why_not_bookable(day: date, now: datetime) -> str | None:
    """Why no meeting can go on `day` at all, in a few words, or None."""
    if day < now.date():
        return "that day is in the past"
    if day > now.date() + timedelta(days=MAX_DAYS_AHEAD):
        return f"that is more than {MAX_DAYS_AHEAD} days away"
    if day.weekday() not in WORKDAYS:
        return "meetings are only on weekdays"
    if datetime.combine(day, CLOSE, TZ) - timedelta(minutes=MIN_MINUTES) < now + MIN_LEAD:
        return "it is too late in the day to book anything today"
    return None


def free_windows(day: date, member: str, minutes: int, busy: list[Busy], now: datetime) -> list[tuple[datetime, datetime]]:
    """Free stretches of `day` long enough for a `minutes` meeting with
    `member`. A meeting may start at any half hour inside one and must end by
    its end."""
    length = timedelta(minutes=minutes)
    earliest = now + MIN_LEAD
    starts: list[datetime] = []
    t = datetime.combine(day, OPEN, TZ)
    close = datetime.combine(day, CLOSE, TZ)
    while t + length <= close:
        if t >= earliest and not any(blocks(b, member) and b.start < t + length and t < b.end for b in busy):
            starts.append(t)
        t += SLOT_STEP
    windows: list[tuple[datetime, datetime]] = []
    for s in starts:
        if windows and s == windows[-1][1] - length + SLOT_STEP:
            windows[-1] = (windows[-1][0], s + length)
        else:
            windows.append((s, s + length))
    return windows


def is_free(start: datetime, minutes: int, member: str, busy: list[Busy], now: datetime) -> bool:
    end = start + timedelta(minutes=minutes)
    return (
        start.date().weekday() in WORKDAYS
        and datetime.combine(start.date(), OPEN, TZ) <= start
        and end <= datetime.combine(start.date(), CLOSE, TZ)
        and start >= now + MIN_LEAD
        and not any(blocks(b, member) and b.start < end and start < b.end for b in busy)
    )


def clock(t: datetime | time) -> str:
    return f"{t.hour:02d}:{t.minute:02d}"


DAY_EN = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
DAY_FR = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"]
MONTH_EN = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
MONTH_FR = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"]


def say_day(d: date, lang: str | None = "en") -> str:
    if lang == "fr":
        return f"{DAY_FR[d.weekday()]} {'1er' if d.day == 1 else d.day} {MONTH_FR[d.month - 1]}"
    return f"{DAY_EN[d.weekday()]} {MONTH_EN[d.month - 1]} {d.day}"


def say_when(start: datetime, lang: str | None = "en") -> str:
    """For the screen card: "Wednesday October 14, 2:30 PM" / "mercredi 14 octobre, 14 h 30"."""
    if lang == "fr":
        return f"{say_day(start.date(), 'fr')}, {start.hour} h {start.minute:02d}".replace(" h 00", " h")
    h12 = start.hour % 12 or 12
    mins = f":{start.minute:02d}" if start.minute else ""
    return f"{say_day(start.date())}, {h12}{mins} {'AM' if start.hour < 12 else 'PM'}"


def now_local() -> datetime:
    return datetime.now(TZ)


def day_bounds(day: date) -> tuple[datetime, datetime]:
    """Midnight to midnight, local time: what to read from the calendar for `day`."""
    start = datetime.combine(day, time(0), TZ)
    return start, start + timedelta(days=1)


# --- Google Calendar ---------------------------------------------------------

_creds = None


async def _token() -> str:
    global _creds
    from google.auth.transport.requests import Request
    from google.oauth2 import service_account

    if _creds is None:
        _creds = service_account.Credentials.from_service_account_file(str(KEY_FILE), scopes=[SCOPE])
    if not _creds.valid:
        await asyncio.to_thread(_creds.refresh, Request())
    return _creds.token


def _url() -> str:
    return EVENTS_URL.format(cal=quote(CALENDAR_ID, safe=""))


def _parse_event(ev: dict) -> Busy | None:
    if ev.get("status") == "cancelled" or ev.get("transparency") == "transparent":
        return None
    s, e = ev.get("start", {}), ev.get("end", {})
    if "dateTime" in s and "dateTime" in e:
        start = datetime.fromisoformat(s["dateTime"].replace("Z", "+00:00")).astimezone(TZ)
        end = datetime.fromisoformat(e["dateTime"].replace("Z", "+00:00")).astimezone(TZ)
    elif "date" in s and "date" in e:  # all-day: the whole day is taken
        start = datetime.combine(date.fromisoformat(s["date"]), time(0), TZ)
        end = datetime.combine(date.fromisoformat(e["date"]), time(0), TZ)
    else:
        return None
    member = (ev.get("extendedProperties", {}).get("private", {}) or {}).get("mia_member")
    return Busy(start, end, member or None)


async def busy_between(start: datetime, end: datetime) -> list[Busy] | None:
    """What is on the calendar between `start` and `end`; None if it can't be read."""
    params = {
        "timeMin": start.isoformat(),
        "timeMax": end.isoformat(),
        "singleEvents": "true",
        "orderBy": "startTime",
        "maxResults": "250",
    }
    try:
        token = await _token()
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=10)) as http:
            async with http.get(_url(), params=params, headers={"Authorization": f"Bearer {token}"}) as r:
                if r.status != 200:
                    logger.error("calendar list failed: HTTP %s %s", r.status, (await r.text())[:300])
                    return None
                data = await r.json()
    except Exception:
        logger.exception("calendar list failed")
        return None
    return [b for ev in data.get("items", []) if (b := _parse_event(ev))]


async def create_meeting(
    start: datetime,
    minutes: int,
    member_key: str,
    with_name: str,
    visitor_name: str,
    contact: str,
    topic: str,
    assistant: str,
) -> str | None:
    """Put the meeting on the calendar; its event id, or None if it failed."""
    end = start + timedelta(minutes=minutes)
    lines = [
        f"Booked by {assistant}, the virtual receptionist, at the Mobile Apps Labs virtual office.",
        f"Visitor: {visitor_name}",
        f"Contact: {contact}",
        f"With: {with_name}",
    ]
    if topic:
        lines.append(f"Topic: {topic}")
    body = {
        "summary": f"{visitor_name} – meeting with {with_name}"[:200],
        "description": "\n".join(lines)[:2000],
        "start": {"dateTime": start.isoformat(), "timeZone": str(TZ)},
        "end": {"dateTime": end.isoformat(), "timeZone": str(TZ)},
        "extendedProperties": {"private": {"mia_member": member_key, "mia_booked": "1"}},
    }
    try:
        token = await _token()
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=10)) as http:
            async with http.post(_url(), json=body, headers={"Authorization": f"Bearer {token}"}) as r:
                if r.status not in (200, 201):
                    logger.error("calendar insert failed: HTTP %s %s", r.status, (await r.text())[:300])
                    return None
                event_id = (await r.json()).get("id")
    except Exception:
        logger.exception("calendar insert failed")
        return None
    logger.info("meeting booked: %s with %s at %s (%s min), event %s", visitor_name, with_name, start, minutes, event_id)
    return event_id or "booked"
