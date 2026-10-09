"""Team directory and visitor messages for Mia.

team.json lists the only people Mia may take messages for or notify, plus the
team's general inbox (info@), which she can take messages for too. A visitor
names someone however they like ("Nicolas", "the CEO", "le PDG", "l'équipe");
find_member maps that to a directory entry, and the send_* functions email them
through Resend (the same email service the website uses).

Env: RESEND_API_KEY, RESEND_FROM_EMAIL.
"""

import html
import json
import logging
import os
import re
import unicodedata
from dataclasses import dataclass
from pathlib import Path

import aiohttp

logger = logging.getLogger("simli-receptionist")

TEAM_FILE = Path(__file__).with_name("team.json")
RESEND_URL = "https://api.resend.com/emails"

# Anything the visitor dictates is capped: it lands in someone's inbox.
MAX_NAME_CHARS = 80
MAX_MESSAGE_CHARS = 1000
MAX_CONTACT_CHARS = 120

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


@dataclass(frozen=True)
class Member:
    first_name: str
    last_name: str
    role_en: str
    role_fr: str
    email: str
    aliases: tuple[str, ...]
    # Short spoken bios she may share when asked about the team. Empty until
    # the boss approves them: she says nothing about a person beyond these.
    bio_en: str = ""
    bio_fr: str = ""
    # The one she notifies when a visitor wants "someone" without naming anyone.
    visitor_contact: bool = False
    # The general inbox (info@): not a person, the whole team reads it.
    inbox: bool = False

    @property
    def full_name(self) -> str:
        return f"{self.first_name} {self.last_name}".strip()


def load_team(path: Path = TEAM_FILE) -> list[Member]:
    """Everyone in team.json, then the general inbox if it has one.

    The inbox rides in the same list so take_message (and the emergency email,
    which goes to every address here) reach it with no special case.
    """
    data = json.loads(path.read_text(encoding="utf-8"))
    contact_id = data.get("visitor_contact", "")
    team = [
        Member(
            first_name=m["first_name"],
            last_name=m["last_name"],
            role_en=m["role_en"],
            role_fr=m["role_fr"],
            email=m["email"],
            aliases=tuple(m.get("aliases", [])),
            bio_en=m.get("bio_en", "").strip(),
            bio_fr=m.get("bio_fr", "").strip(),
            visitor_contact=bool(contact_id) and m.get("id") == contact_id,
        )
        for m in data["members"]
    ]
    box = data.get("general_inbox")
    if box:
        team.append(
            Member(
                first_name=box["name_en"],
                last_name="",
                role_en="",
                role_fr=box["name_fr"],
                email=box["email"],
                aliases=tuple(box.get("aliases", [])),
                inbox=True,
            )
        )
    return team


def _norm(text: str) -> str:
    """'Le  PDG!' -> 'le pdg'. Accents dropped: STT may or may not keep them."""
    text = unicodedata.normalize("NFKD", text)
    text = "".join(c for c in text if not unicodedata.combining(c))
    text = re.sub(r"[^\w\s]", " ", text.lower())
    return " ".join(text.split())


def find_member(spoken: str, team: list[Member]) -> Member | None:
    """Match how the visitor named someone to exactly one team member.

    Whole-word matching, so "Alex" finds Alexandre via his alias but "Al"
    finds nobody. Two members matching is treated as no match — Mia then asks
    who they mean rather than guessing. A named person beats the general
    inbox: "Nicolas at Mobile Apps Labs" is for Nicolas, not info@.
    """
    said = f" {_norm(spoken)} "
    if not said.strip():
        return None
    hits = []
    for m in team:
        names = (m.full_name, m.first_name, m.last_name, m.role_en, m.role_fr, *m.aliases)
        if any(f" {_norm(n)} " in said for n in names if _norm(n)):
            hits.append(m)
    people = [m for m in hits if not m.inbox]
    if people:
        return people[0] if len(people) == 1 else None
    return hits[0] if len(hits) == 1 else None


# What the model writes when it calls a tool before the visitor has said their
# name. Seen in testing with thinking off: "the visitor" went out in an email.
_PLACEHOLDER_NAME_WORDS = {
    "visitor", "visiteur", "visiteuse", "guest", "invite", "unknown", "inconnu",
    "inconnue", "someone", "quelqu", "anonymous", "anonyme", "client", "n", "a",
}


def is_real_name(name: str) -> bool:
    """False for an empty or placeholder visitor name ("the visitor", "unknown")."""
    words = _norm(name).split()
    meaningful = [w for w in words if w not in {"the", "a", "le", "la", "l", "un", "une"}]
    return bool(meaningful) and not any(w in _PLACEHOLDER_NAME_WORDS for w in meaningful)


def team_prompt_section(team: list[Member]) -> str:
    """The TEAM, TEAM ABOUT and GENERAL INBOX blocks appended to Mia's prompt.

    Names, roles, aliases and approved bios — never emails.
    """
    people = [m for m in team if not m.inbox]
    lines = [
        "TEAM",
        "These are the only people you can take a message for or tell that a visitor "
        "is here. You may say their names and roles, and what TEAM ABOUT says about them. "
        "Never give their email or any other contact detail of theirs. "
        "Speech recognition often spells names differently. Treat any name a visitor "
        "says that is listed after a person, or sounds close to it, as that person, "
        "even when it looks like a different first name, and act on it. Never say you "
        "cannot reach someone whose name is listed here.",
    ]
    for m in people:
        line = f"{m.full_name}, {m.role_en}. In French, {m.role_fr}."
        if m.aliases:
            line += f" Visitors may also say: {', '.join(m.aliases)}."
        lines.append(line)
    contact = next((m for m in people if m.visitor_contact), None)
    if contact:
        lines.append(
            f"When a visitor wants to talk to someone but names nobody, the person to "
            f"let know is {contact.full_name}, who you may call {contact.first_name}. "
            "Do not ask the visitor who they want."
        )

    lines += ["", "TEAM ABOUT"]
    bios = [m for m in people if m.bio_en or m.bio_fr]
    if bios:
        lines.append(
            "When a visitor asks about the team or one of these people, you may share "
            "these short descriptions, in the visitor's language, and nothing more."
        )
        for m in bios:
            parts = [f"{m.full_name}."]
            if m.bio_en:
                parts.append(f"In English: {m.bio_en}")
            if m.bio_fr:
                parts.append(f"In French: {m.bio_fr}")
            lines.append(" ".join(parts))
    lines.append(
        "For anyone without a description here, you know only their name and role. "
        "If asked for more, say so warmly and suggest the website, mobileappslabs dot com."
    )

    box = next((m for m in team if m.inbox), None)
    if box:
        lines += [
            "",
            "GENERAL INBOX",
            f"You can also take a message for {box.first_name}, in French {box.role_fr}, "
            "the info address that the whole team reads. Use it when the visitor wants to "
            "write to the team or to Mobile Apps Labs in general, or to info at "
            "mobileappslabs dot com, or wants to reach someone who is not listed under TEAM. "
            f"With the take_message tool, put {box.first_name} as the recipient."
            + (f" Visitors may also say: {', '.join(box.aliases)}." if box.aliases else ""),
        ]
    return "\n".join(lines)


def _one_line(text: str, limit: int) -> str:
    """Collapse whitespace and cap: visitor text that ends up in a subject line."""
    return " ".join(text.split())[:limit]


async def _send_email(what: str, to: list[str], subject: str, body: str, reply_to: str = "") -> bool:
    """Send one email through Resend. True only if Resend accepted it.

    `what` names the caller (the tool) in the logs.
    """
    api_key = os.environ.get("RESEND_API_KEY", "").strip()
    sender = os.environ.get("RESEND_FROM_EMAIL", "").strip()
    if not api_key or not sender:
        logger.error("%s: RESEND_API_KEY / RESEND_FROM_EMAIL not set", what)
        return False

    payload: dict = {"from": sender, "to": to, "subject": subject, "html": body}
    if EMAIL_RE.match(reply_to):
        payload["reply_to"] = reply_to

    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=15)) as http:
            async with http.post(
                RESEND_URL, json=payload, headers={"Authorization": f"Bearer {api_key}"}
            ) as res:
                if res.status >= 300:
                    logger.error("%s: Resend %s %s", what, res.status, await res.text())
                    return False
                logger.info("%s: sent to %s (%s)", what, ", ".join(to), (await res.json()).get("id"))
                return True
    except Exception:
        logger.exception("%s: Resend request failed", what)
        return False


# Under every email: the visitor's words reach us through speech recognition.
_STT_FOOTER = (
    "<p style='margin:16px 0 0;color:#999;font-size:12px'>Sent by the virtual receptionist. "
    "The visitor's words were transcribed by speech recognition and may contain errors.</p>"
)


async def send_message_email(
    member: Member, visitor_name: str, message: str, reply_contact: str
) -> bool:
    """Email the visitor's message to `member`. True only if Resend accepted it."""
    visitor_name = _one_line(visitor_name, MAX_NAME_CHARS)
    message = message.strip()[:MAX_MESSAGE_CHARS]
    reply_contact = reply_contact.strip()[:MAX_CONTACT_CHARS]

    # Everything here was spoken by a stranger at the kiosk: escape it all.
    e = html.escape
    contact_html = (
        f"<p style='margin:0 0 8px;color:#333'><strong>Reply to:</strong> {e(reply_contact)}</p>"
        if reply_contact
        else "<p style='margin:0 0 8px;color:#777'>No reply contact left.</p>"
    )
    body = f"""
      <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px;background:#f9f9f9;border-radius:12px">
        <h2 style="margin:0 0 16px;color:#1a1a1a">Message from the reception kiosk</h2>
        <p style="margin:0 0 8px;color:#333"><strong>From:</strong> {e(visitor_name)}</p>
        {contact_html}
        <blockquote style="margin:16px 0;padding:12px 16px;background:#fff;border-left:4px solid #0070f3;color:#1a1a1a;white-space:pre-wrap">{e(message)}</blockquote>
        {_STT_FOOTER}
      </div>
    """
    return await _send_email(
        "take_message",
        [member.email],
        f"Message from {visitor_name} (reception kiosk)",
        body,
        reply_to=reply_contact,
    )


async def send_visitor_waiting_email(member: Member, visitor_name: str, note: str) -> bool:
    """Tell `member` a visitor is waiting at reception. True only if Resend accepted it."""
    visitor_name = _one_line(visitor_name, MAX_NAME_CHARS)
    note = note.strip()[:MAX_MESSAGE_CHARS]

    e = html.escape  # visitor-provided, like everything in take_message
    note_html = (
        f"<p style='margin:0 0 8px;color:#333'><strong>They said:</strong> {e(note)}</p>" if note else ""
    )
    body = f"""
      <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px;background:#f9f9f9;border-radius:12px">
        <h2 style="margin:0 0 16px;color:#1a1a1a">A visitor is waiting at reception</h2>
        <p style="margin:0 0 8px;color:#333"><strong>Visitor:</strong> {e(visitor_name)}</p>
        <p style="margin:0 0 8px;color:#333"><strong>Here to see:</strong> {e(member.full_name)}</p>
        {note_html}
        {_STT_FOOTER}
      </div>
    """
    return await _send_email(
        "notify_member", [member.email], f"{visitor_name} is waiting at reception", body
    )


async def send_emergency_email(team: list[Member], description: str) -> bool:
    """Alert every member at once. True only if Resend accepted it.

    One email to everyone rather than one each: it either reaches the whole
    team or Mia hears it failed, never a silent partial send.
    """
    description = description.strip()[:MAX_MESSAGE_CHARS] or "No details given."
    body = f"""
      <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px;background:#fff4f4;border-radius:12px;border:2px solid #d00">
        <h2 style="margin:0 0 16px;color:#b00">Emergency reported at reception</h2>
        <p style="margin:0 0 8px;color:#1a1a1a">A visitor at the reception kiosk reported an emergency. The virtual receptionist told them to call 911. Please check on the lobby now.</p>
        <blockquote style="margin:16px 0;padding:12px 16px;background:#fff;border-left:4px solid #d00;color:#1a1a1a;white-space:pre-wrap">{html.escape(description)}</blockquote>
        {_STT_FOOTER}
      </div>
    """
    return await _send_email(
        "alert_emergency",
        [m.email for m in team],
        "URGENT: emergency reported at reception",
        body,
    )
