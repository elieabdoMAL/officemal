"""What the worker puts on the kiosk screen (docs/screen-protocol.md, section 3).

Messages go out as JSON on the "mia.screen" text-stream topic; the screen side
is src/lib/screenProtocol.ts. Building them here keeps the field names in one
place on this side, and `gives_contact_details` decides when her words call
for the contact card.
"""

import re

from team_messages import _norm

TOPIC_SCREEN = "mia.screen"  # worker -> screen
TOPIC_CONTROL = "mia.control"  # screen -> worker

# How long the screen keeps each card up (CARD_MS in SimliLiveKitPanel.tsx).
# While one of hers is still up, the contact card waits: her "you can also
# call us at ..." mustn't replace "Message sent" or the project form.
SENT_CARD_S = 10.0
DRAFT_CARD_S = 180.0
# The directions card (#7, round 2) stays up like the contact card; saying the
# address while it shows must not have the contact card replace it.
DIRECTIONS_CARD_S = 45.0

# What the directions card shows (#7): the address and a QR code to Google
# Maps, drawn by the screen (docs/screen-protocol.md section 3).
OFFICE_ADDRESS = "74 rue Turgeon, Sainte-Thérèse, QC"
OFFICE_MAPS_URL = "https://www.google.com/maps/search/?api=1&query=74+rue+Turgeon+Sainte-Th%C3%A9r%C3%A8se+QC"


def _with_lang(msg: dict, lang: str | None) -> dict:
    if lang:
        msg["lang"] = lang
    return msg


def contact_card(lang: str | None) -> dict:
    return _with_lang({"type": "contact_card"}, lang)


def message_sent(kind: str, lang: str | None, to: str = "") -> dict:
    """kind: message | notify | alert | suggestion | project_request | meeting.
    to: a display name ("Nicolas Bastien"), never an address."""
    msg = {"type": "message_sent", "kind": kind}
    if to:
        msg["to"] = to
    return _with_lang(msg, lang)


def project_request(status: str, fields: dict[str, str], lang: str | None) -> dict:
    """status: draft (for the visitor to check) | sent."""
    return _with_lang({"type": "project_request", "status": status, "fields": fields}, lang)


def directions_card(lang: str | None) -> dict:
    """The way to the office (#7): the address and a QR code to Google Maps."""
    return _with_lang({"type": "directions", "address": OFFICE_ADDRESS, "maps_url": OFFICE_MAPS_URL}, lang)


# The office's own details as she says them (mia_prompt.txt, COMPANY
# KNOWLEDGE), never a visitor's: their 514 number or gmail address read back
# must not bring up our card.
_DIGIT_WORDS = {
    "zero": "0", "oh": "0", "one": "1", "two": "2", "three": "3", "four": "4", "five": "5",
    "six": "6", "seven": "7", "eight": "8", "nine": "9",
    "zéro": "0", "un": "1", "deux": "2", "trois": "3", "quatre": "4", "cinq": "5",
    "sept": "7", "huit": "8", "neuf": "9",
}
_OFFICE_DIGITS = "5732324"  # 514 573 2324, without the area code (shared by many)
_OFFICE_WORDS = re.compile(r"mobileappslabs|turgeon|mobile apps labs (dot|point) com")


def gives_contact_details(text: str) -> bool:
    """True if `text` gives the office phone, email, address or website."""
    if _OFFICE_WORDS.search(_norm(text)):
        return True
    digits = "".join(
        _DIGIT_WORDS.get(w, w if w.isdigit() else "")
        for w in re.findall(r"[a-zà-ÿ]+|\d+", text.lower())
    )
    return _OFFICE_DIGITS in digits
