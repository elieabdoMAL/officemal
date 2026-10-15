"""Lead capture for Mia: the suggestion box (#17) and project requests (#20).

Both go to the team's general inbox (info@, `general_inbox` in team.json, so
tests can point it at a sandbox). Also here: the guard that stops any of her
tools sending the same thing twice in one conversation.

The project-request form is PROJECT_FIELDS, and only that: the tool's schema,
the prompt's list of questions (`{PROJECT_FIELDS}` in mia_prompt.txt), the
email and the screen card (docs/screen-protocol.md) all follow it. The list is
provisional until the boss confirms it; change it here and nowhere else.
"""

import difflib
import html
import re
from dataclasses import dataclass

from team_messages import (
    _STT_FOOTER,
    EMAIL_RE,
    MAX_CONTACT_CHARS,
    MAX_MESSAGE_CHARS,
    MAX_NAME_CHARS,
    Member,
    _norm,
    _one_line,
    _send_email,
)


@dataclass(frozen=True)
class ProjectField:
    key: str  # also the key in the screen message
    label_en: str  # email and screen label
    label_fr: str
    ask: str  # what she asks for, in the prompt's list of questions
    hint: str  # for Gemini, in the tool's schema
    required: bool = False
    max_chars: int = MAX_CONTACT_CHARS


PROJECT_FIELDS: tuple[ProjectField, ...] = (
    ProjectField("name", "Name", "Nom", "their name", "The visitor's full name.", required=True, max_chars=MAX_NAME_CHARS),
    ProjectField("company", "Company", "Entreprise", "their company", "Their company or organisation."),
    ProjectField("email", "Email", "Courriel", "an email address or a phone number to reach them, one is enough",
                 "Their email address, written as an address, for example jean.tremblay@gmail.com."),
    ProjectField("phone", "Phone", "Téléphone", "an email address or a phone number to reach them, one is enough",
                 "Their phone number, in digits, for example 514 555 0199."),
    ProjectField("description", "Project", "Projet", "what the project is, in a sentence or two",
                 "What the project is, in the visitor's words, in a sentence or two.", required=True,
                 max_chars=600),
    ProjectField("timeline", "Timeline", "Échéancier", "their timeline", "When they would like it, as they said it."),
    ProjectField("budget", "Budget", "Budget", "their budget range", "Their budget range, exactly as they said it."),
)
# At least one of these, so the team can answer.
PROJECT_CONTACT_FIELDS = ("email", "phone")

# The optional fields are asked once each: she writes this for one she asked
# and got no answer to, and the draft isn't shown until every one has a value
# or this (Gemini, left to itself, skipped the timeline and budget).
DECLINED = "none"
_DECLINED_WORDS = {"none", "no", "n a", "na", "not given", "no answer", "unknown", "aucun", "aucune", "non", "rien"}


def _optional(f: ProjectField) -> bool:
    return not f.required and f.key not in PROJECT_CONTACT_FIELDS


def project_fields_prompt() -> str:
    """The questions she asks, in order, for the prompt's {PROJECT_FIELDS}:
    "One, their name. Two, their company, optional. ..." The email and phone
    share one question, and that one isn't optional."""
    numbers = ["One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"]
    asks: list[str] = []
    for f in PROJECT_FIELDS:
        ask = f.ask + (", optional" if _optional(f) else "")
        if ask not in asks:
            asks.append(ask)
    return " ".join(f"{numbers[i]}, {ask}." for i, ask in enumerate(asks))


def project_request_schema(name: str, description: str) -> dict:
    """The raw schema of the tool that shows the draft: one string per field."""
    return {
        "name": name,
        "description": description,
        "parameters": {
            "type": "object",
            "properties": {
                f.key: {
                    "type": "string",
                    "description": f.hint
                    + (
                        f" Write {DECLINED} if you asked and they have none or prefer not to say; "
                        "leave it out if you have not asked yet."
                        if _optional(f)
                        else ""
                    ),
                }
                for f in PROJECT_FIELDS
            },
            "required": [],
        },
    }


def clean_project_fields(raw: dict) -> dict[str, str]:
    """The known fields of `raw`, trimmed and capped; unknown keys and empty
    values dropped. A declined optional field is kept, as "" (asked, no answer)."""
    out = {}
    for f in PROJECT_FIELDS:
        value = raw.get(f.key)
        if not isinstance(value, str) or not value.strip():
            continue
        out[f.key] = "" if _optional(f) and _norm(value) in _DECLINED_WORDS else _one_line(value, f.max_chars)
    if out.get("email"):
        # Dictated: "ana at Paindoor dot com" came back "ana@Paindoor.com".
        out["email"] = out["email"].replace(" ", "").lower()
    return out


def missing_project_fields(fields: dict[str, str]) -> list[str]:
    """What the draft still needs, as she would ask for it: the required
    fields, a way to reach them, and any optional field not asked yet."""
    missing = [f.ask for f in PROJECT_FIELDS if f.required and not fields.get(f.key)]
    if not any(fields.get(k) for k in PROJECT_CONTACT_FIELDS):
        missing.append(next(f.ask for f in PROJECT_FIELDS if f.key == PROJECT_CONTACT_FIELDS[0]))
    missing += [
        f"{f.ask}, optional: if they have none or prefer not to say, write {DECLINED}"
        for f in PROJECT_FIELDS
        if _optional(f) and f.key not in fields
    ]
    return missing


def project_screen_fields(fields: dict[str, str]) -> dict[str, str]:
    """Every field, in form order, empty when unknown: what the screen draws."""
    return {f.key: fields.get(f.key, "") for f in PROJECT_FIELDS}


# ---------------------------------------------------------------- the guard

# Two sends count as the same when their text is at least this similar: Gemini
# rewords a message a little when it calls the tool a second time.
SAME_CONTENT_RATIO = 0.85

# The visitor explicitly asking to send it again, the only thing that lets an
# identical send through.
_AGAIN = re.compile(
    r"\b(again|resend|re send|one more time|another time|once more|"
    r"encore|renvoy\w*|re envoy\w*|de nouveau|a nouveau|une autre fois|une deuxieme fois)\b"
)


def asks_again(text: str) -> bool:
    """True if the visitor's words ask to send something again."""
    return bool(_AGAIN.search(_norm(text)))


class SentLog:
    """What her tools sent in this conversation, to refuse sending it twice."""

    def __init__(self) -> None:
        self._sent: list[tuple[str, str, str]] = []

    def is_repeat(self, kind: str, recipient: str, content: str, visitor_said: str) -> bool:
        """Already sent to `recipient`, and the visitor didn't ask to send it again."""
        if asks_again(visitor_said):
            return False
        content = _norm(content)
        return any(
            k == kind
            and r == recipient
            and difflib.SequenceMatcher(None, c, content).ratio() >= SAME_CONTENT_RATIO
            for k, r, c in self._sent
        )

    def add(self, kind: str, recipient: str, content: str) -> None:
        self._sent.append((kind, recipient, _norm(content)))


# ---------------------------------------------------------------- emails


async def send_suggestion_email(inbox: Member, suggestion: str, visitor_name: str, reply_contact: str) -> bool:
    """Email a suggestion to the general inbox. True only if Resend accepted it."""
    suggestion = suggestion.strip()[:MAX_MESSAGE_CHARS]
    visitor_name = _one_line(visitor_name, MAX_NAME_CHARS)
    reply_contact = reply_contact.strip()[:MAX_CONTACT_CHARS]

    e = html.escape  # a stranger at the kiosk dictated all of it
    who = f"<strong>From:</strong> {e(visitor_name)}" if visitor_name else "Left anonymously."
    contact = f"<p style='margin:0 0 8px;color:#333'><strong>Reply to:</strong> {e(reply_contact)}</p>" if reply_contact else ""
    body = f"""
      <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px;background:#f9f9f9;border-radius:12px">
        <h2 style="margin:0 0 16px;color:#1a1a1a">Suggestion box (reception kiosk)</h2>
        <p style="margin:0 0 8px;color:#333">{who}</p>
        {contact}
        <blockquote style="margin:16px 0;padding:12px 16px;background:#fff;border-left:4px solid #16a34a;color:#1a1a1a;white-space:pre-wrap">{e(suggestion)}</blockquote>
        {_STT_FOOTER}
      </div>
    """
    return await _send_email(
        "send_suggestion",
        [inbox.email],
        "Suggestion from the reception kiosk",
        body,
        reply_to=reply_contact,
    )


async def send_project_request_email(inbox: Member, fields: dict[str, str], language: str) -> bool:
    """Email a project request to the general inbox. True only if Resend accepted it."""
    e = html.escape
    rows = "".join(
        f"<tr><td style='padding:4px 12px 4px 0;color:#555;vertical-align:top'>{e(f.label_en)}</td>"
        f"<td style='padding:4px 0;color:#1a1a1a;white-space:pre-wrap'>{e(fields.get(f.key, '')) or '<span style=color:#999>-</span>'}</td></tr>"
        for f in PROJECT_FIELDS
    )
    spoke = {"fr": "French", "en": "English"}.get(language, language)
    body = f"""
      <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px;background:#f9f9f9;border-radius:12px">
        <h2 style="margin:0 0 16px;color:#1a1a1a">Project request (reception kiosk)</h2>
        <table style="border-collapse:collapse;font-size:15px">{rows}</table>
        <p style="margin:16px 0 0;color:#555">The visitor checked this on the kiosk screen before it was sent. They spoke {e(spoke)}.</p>
        {_STT_FOOTER}
      </div>
    """
    email = fields.get("email", "")
    return await _send_email(
        "submit_project_request",
        [inbox.email],
        f"Project request from {_one_line(fields.get('name', ''), MAX_NAME_CHARS)} (reception kiosk)",
        body,
        reply_to=email if EMAIL_RE.match(email) else "",
    )
