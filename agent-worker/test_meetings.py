"""Checks for meetings on the shared calendar (meetings.py, check_calendar,
book_meeting). Run inside the worker image:

    docker run --rm --env-file .env -e RESEND_API_KEY= -v "$PWD":/app -w /app simli-worker python test_meetings.py

1. Offline: reading days and times, free windows, what blocks what, the
   calendar's event format. No Google, no Gemini.
2. Text conversations with the real Gemini, the calendar replaced by a fake
   (no Google account needed), "now" fixed at Monday 2026-10-12 09:00 Eastern.

Pass conversation names to run only those, e.g. `python test_meetings.py book_en`.
"""

import asyncio
import sys
from datetime import date, datetime, time, timedelta

import meetings
from meetings import TZ, Busy, free_windows, is_free, parse_day, parse_time, why_not_bookable

MONDAY = date(2026, 10, 12)
NOW = datetime(2026, 10, 12, 9, 0, tzinfo=TZ)
NICOLAS = "nbastien@mobileappslabs.com"
ALEX = "ajoset@mobileappslabs.com"


def at(d: date, hh: int, mm: int = 0) -> datetime:
    return datetime(d.year, d.month, d.day, hh, mm, tzinfo=TZ)


def test_parse_day() -> None:
    cases = {
        "today": MONDAY,
        "aujourd'hui": MONDAY,
        "tomorrow": date(2026, 10, 13),
        "demain": date(2026, 10, 13),
        "après-demain": date(2026, 10, 14),
        "Thursday": date(2026, 10, 15),
        "jeudi": date(2026, 10, 15),
        "Monday": MONDAY,
        "next Monday": date(2026, 10, 19),
        "lundi prochain": date(2026, 10, 19),
        "October 14": date(2026, 10, 14),
        "le 14 octobre": date(2026, 10, 14),
        "14 octobre": date(2026, 10, 14),
        "the 20th": date(2026, 10, 20),
        "le 3": date(2026, 11, 3),
        "January 5": date(2027, 1, 5),
        "2026-10-21": date(2026, 10, 21),
        "February 30": None,
        "soon": None,
        "": None,
    }
    for said, expected in cases.items():
        got = parse_day(said, MONDAY)
        assert got == expected, f"parse_day({said!r}) = {got}, expected {expected}"
    print(f"✓ parse_day: {len(cases)} cases")


def test_parse_time() -> None:
    cases = {
        "14:30": time(14, 30),
        "14h30": time(14, 30),
        "14 h": time(14),
        "14h": time(14),
        "9:00": time(9),
        "2pm": time(14),
        "2:30 pm": time(14, 30),
        "2:30 p.m.": time(14, 30),
        "11 am": time(11),
        "12 pm": time(12),
        "noon": time(12),
        "midi": time(12),
        "25:00": None,
        "afternoon": None,
    }
    for said, expected in cases.items():
        got = parse_time(said)
        assert got == expected, f"parse_time({said!r}) = {got}, expected {expected}"
    print(f"✓ parse_time: {len(cases)} cases")


def test_free_windows() -> None:
    tue = date(2026, 10, 13)
    busy = [
        Busy(at(tue, 10), at(tue, 11), NICOLAS),  # Nicolas only
        Busy(at(tue, 14), at(tue, 15), None),  # put there by hand: everyone
        Busy(at(tue, 16), at(tue, 16, 30), ALEX),  # Alex only
    ]
    w = free_windows(tue, NICOLAS, 30, busy, NOW)
    assert [(a.time(), b.time()) for a, b in w] == [(time(9), time(10)), (time(11), time(14)), (time(15), time(17))], w
    w = free_windows(tue, ALEX, 30, busy, NOW)
    assert [(a.time(), b.time()) for a, b in w] == [(time(9), time(14)), (time(15), time(16)), (time(16, 30), time(17))], w
    w = free_windows(tue, meetings.TEAM_KEY, 60, busy, NOW)  # the team: everyone's meetings block
    assert [(a.time(), b.time()) for a, b in w] == [(time(9), time(10)), (time(11), time(14)), (time(15), time(16))], w
    # Today: nothing sooner than an hour from now (09:00 -> first start 10:00).
    w = free_windows(MONDAY, NICOLAS, 30, [], NOW)
    assert w[0][0] == at(MONDAY, 10), w
    # A 90 minute meeting doesn't fit the 09:00-10:00 gap.
    w = free_windows(tue, NICOLAS, 90, busy, NOW)
    assert w[0][0].time() == time(11), w

    assert is_free(at(tue, 11), 60, NICOLAS, busy, NOW)
    assert not is_free(at(tue, 10, 30), 30, NICOLAS, busy, NOW), "inside Nicolas's meeting"
    assert is_free(at(tue, 10, 30), 30, ALEX, busy, NOW), "Nicolas's meeting doesn't block Alex"
    assert not is_free(at(tue, 13, 30), 60, ALEX, busy, NOW), "runs into the 14:00 block"
    assert not is_free(at(tue, 16, 45), 30, NICOLAS, busy, NOW), "ends after closing"
    assert not is_free(at(tue, 8, 30), 30, NICOLAS, busy, NOW), "before opening"
    assert not is_free(at(MONDAY, 9, 30), 30, NICOLAS, [], NOW), "less than an hour away"

    assert why_not_bookable(date(2026, 10, 17), NOW), "Saturday"
    assert why_not_bookable(date(2026, 10, 9), NOW), "in the past"
    assert why_not_bookable(date(2027, 3, 1), NOW), "too far ahead"
    assert why_not_bookable(MONDAY, datetime(2026, 10, 12, 16, 30, tzinfo=TZ)), "too late today"
    assert why_not_bookable(MONDAY, NOW) is None
    print("✓ free windows, blocking, office hours, lead time")


def test_event_format() -> None:
    ev = {
        "start": {"dateTime": "2026-10-13T14:00:00-04:00"},
        "end": {"dateTime": "2026-10-13T18:30:00Z"},
        "extendedProperties": {"private": {"mia_member": NICOLAS}},
    }
    b = meetings._parse_event(ev)
    assert b and b.start == at(date(2026, 10, 13), 14) and b.end == at(date(2026, 10, 13), 14, 30) and b.member == NICOLAS, b
    allday = meetings._parse_event({"start": {"date": "2026-10-14"}, "end": {"date": "2026-10-15"}})
    assert allday and allday.member is None and allday.start == at(date(2026, 10, 14), 0), allday
    assert meetings._parse_event({**ev, "status": "cancelled"}) is None
    assert meetings._parse_event({**ev, "transparency": "transparent"}) is None, "a 'free' event blocks nothing"
    assert meetings.say_when(at(date(2026, 10, 14), 14, 30)) == "Wednesday October 14, 2:30 PM"
    assert meetings.say_when(at(date(2026, 10, 14), 14), "fr") == "mercredi 14 octobre, 14 h"
    print("✓ event format, spoken dates")


# --- Conversations -----------------------------------------------------------

TUESDAY = date(2026, 10, 13)
# The fake calendar: Nicolas is taken 10:00-11:00 on Tuesday; 14:00-15:00 is
# blocked for everyone (an event added by hand).
FAKE_BUSY = [
    Busy(at(TUESDAY, 10), at(TUESDAY, 11), NICOLAS),
    Busy(at(TUESDAY, 14), at(TUESDAY, 15), None),
]
booked: list[dict] = []
checked: list[tuple] = []


def install_fake_calendar(configured: bool = True) -> None:
    async def busy_between(start, end):
        checked.append((start.date(),))
        return [b for b in FAKE_BUSY + [Busy(x["start"], x["start"] + timedelta(minutes=x["minutes"]), x["member"]) for x in booked] if b.start < end and start < b.end]

    async def create_meeting(start, minutes, member_key, with_name, visitor_name, contact, topic, assistant):
        booked.append(dict(start=start, minutes=minutes, member=member_key, with_name=with_name,
                           visitor=visitor_name, contact=contact, topic=topic))
        return "evt-test"

    meetings.busy_between = busy_between
    meetings.create_meeting = create_meeting
    meetings.configured = lambda: configured
    meetings.now_local = lambda: NOW


async def conv_book_en() -> None:
    from test_team_messages import converse

    print("— English, book with Nicolas tomorrow, ask for the taken 10:30 first:")
    replies = await converse("en", [
        "Hi, I'd like to book a meeting with Nicolas tomorrow.",
        "Is ten thirty in the morning possible?",
        "OK, then eleven thirty works.",
        "My name is Gabriel Roy.",
        "gabriel.roy@gmail.com",
        "It's about a mobile app for my restaurant.",
        "Yes, that's all correct.",
    ])
    assert checked, "she must check the calendar before offering times"
    assert len(booked) == 1, f"expected one booking: {booked}"
    b = booked[0]
    assert b["start"] == at(TUESDAY, 11, 30) and b["member"] == NICOLAS, b
    assert "Gabriel" in b["visitor"] and "gabriel.roy@gmail.com" in b["contact"].replace(" ", "").lower(), b
    assert not any("booked" in r.lower() for r in replies[:-1]), f"said booked before booking: {replies}"
    assert "book" in replies[-1].lower(), f"must confirm the booking: {replies[-1]!r}"
    print(f"✓ one booking: {b}")


async def conv_book_fr() -> None:
    from test_team_messages import converse

    print("— French, meeting with Alex on Thursday, name corrected at the read-back:")
    await converse("fr", [
        "Bonjour, je voudrais prendre rendez-vous avec Alexandre jeudi.",
        "Quatorze heures, c'est possible ?",
        "Je m'appelle Debriel Tremblay.",
        "Mon numéro, c'est le 514 555 1234.",
        "C'est pour un projet de site web.",
        "Non, c'est Gabriel, G A B R I E L, pas Debriel.",
        "Oui, c'est parfait.",
    ])
    assert len(booked) == 1, f"expected one booking: {booked}"
    b = booked[0]
    assert b["start"] == at(date(2026, 10, 15), 14) and b["member"] == ALEX, b
    assert b["visitor"].lower().startswith("gabriel"), f"the corrected name must be booked: {b}"
    print(f"✓ one booking with the corrected name: {b}")


async def conv_unconfigured() -> None:
    from test_team_messages import converse

    install_fake_calendar(configured=False)
    print("— English, calendar not set up:")
    replies = await converse("en", ["Can I book a meeting with Nicolas on Wednesday at 2?"])
    assert not booked, f"nothing can be booked: {booked}"
    assert "booked" not in replies[0].lower() or "not" in replies[0].lower(), replies[0]
    print("✓ nothing booked, she falls back")
    install_fake_calendar()


async def conv_not_in_office() -> None:
    from test_team_messages import converse

    print("— English, 'is Nicolas in?' is not a calendar question:")
    replies = await converse("en", ["Is Nicolas in the office right now?"])
    assert not booked
    low = replies[0].lower()
    assert not any(w in low for w in ("he is in", "he's in", "he is available", "he's available", "he's free", "he is free")), replies[0]
    print("✓ she does not claim to know whether he is in")


CONVERSATIONS = {
    "book_en": conv_book_en,
    "book_fr": conv_book_fr,
    "unconfigured": conv_unconfigured,
    "not_in_office": conv_not_in_office,
}


async def main() -> None:
    test_parse_day()
    test_parse_time()
    test_free_windows()
    test_event_format()

    import test_team_messages
    import worker

    test_team_messages.use_assistant_name(worker)
    test_team_messages.install_recorders(worker)
    install_fake_calendar()
    failed = []
    for name in sys.argv[1:] or CONVERSATIONS:
        booked.clear()
        checked.clear()
        test_team_messages.calls.clear()
        try:
            await CONVERSATIONS[name]()
        except AssertionError as e:
            failed.append(name)
            print(f"✗ {name}: {e}")
    print(f"\n{len(CONVERSATIONS) if not sys.argv[1:] else len(sys.argv[1:])} conversations, {len(failed)} failed {failed or ''}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    asyncio.run(main())
