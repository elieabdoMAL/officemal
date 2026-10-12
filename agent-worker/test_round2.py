"""Checks for the boss's round-2 notes (docs/feedback-2026-10-12.md), Chat B's
share: #1 small talk and emotions, #4 the virtual office, #6 confirm before
sending (including the "Debriel" name correction), #7 the directions card, and
the no-promises fix ("he will get back to you").

Same harness as test_team_messages.py — real Gemini, every email replaced by a
recorder, every mia.screen message recorded. Run inside the worker image:

    docker run --rm --env-file .env -v "$PWD":/app -w /app -e RESEND_API_KEY= simli-worker python test_round2.py

Pass scenario names to run only those, e.g. `python test_round2.py debriel_en`.
Offline checks always run first. Every check runs; failures are listed at the
end (exit 1 if any).
"""

import asyncio
import sys

from conversation_control import contact_read_back
from screen_cards import directions_card
from test_team_messages import Conversation, calls, converse, install_recorders, use_assistant_name

failures: list[str] = []


def check(ok: bool, what: str) -> None:
    print(f"{'✓' if ok else '✗'} {what}")
    if not ok:
        failures.append(what)


def has(text: str, *words: str) -> bool:
    low = text.lower()
    return any(w.lower() in low for w in words)


def recorded(kind: str, since: int) -> list[tuple]:
    return [c for c in calls[since:] if c[0] == kind]


def screens(since: int, type_: str) -> list[dict]:
    return [c[1] for c in calls[since:] if c[0] == "screen" and c[1].get("type") == type_]


# Her line that declines emotional support / personal matters (#1). Allowed at
# most once per conversation; never as an answer to ordinary small talk.
BOUNDARY = (
    "not here to", "pas là pour", "pas la pour", "manage emotion", "gérer les émotions",
    "gerer les emotions", "gérer vos émotions", "gerer vos emotions", "emotional support",
    "soutien émotionnel", "soutien emotionnel", "beyond me", "me dépasse", "me depasse",
    "can't help with", "cannot help with", "ne peux pas vous aider", "not something i can",
    "limitation of my system", "limite de mon système", "limite de mon systeme",
    "therapist", "thérapeute", "therapeute",
)

# A promise on someone else's behalf (boss, 2026-10-12: never promise).
PROMISES = (
    "will get back to you", "will call you back", "will come to", "is coming to",
    "va vous revenir", "vous reviendra", "va vous rappeler", "vous rappellera",
)


# ---------------------------------------------------------------- offline


def test_offline() -> None:
    print("— offline: contact_read_back")
    said_en = ["So that's Gabriel Roy, and your number is five one four, five five five, zero one nine nine — is that right?"]
    check(contact_read_back("514 555 0199", said_en), "a number read back as English digit words")
    check(contact_read_back("(514) 555-0199", said_en), "punctuation in the contact doesn't matter")
    check(not contact_read_back("514 555 0198", said_en), "a different number was not read back")
    said_fr = ["Donc Gabriel Roy, au cinq un quatre, cinq cinq cinq, zéro un neuf neuf, c'est bien ça ?"]
    check(contact_read_back("514 555 0199", said_fr), "a number read back as French digit words")
    check(contact_read_back("514 555 0199", ["I have your number as 514 555 0199, correct?"]), "a number written in digits")
    said_mail = ["I have your email as Sam at Fortin dot CA — is that right?"]
    check(contact_read_back("sam@fortin.ca", said_mail), "an email read back as 'at ... dot'")
    check(contact_read_back("sam@fortin.ca", ["Votre courriel : sam@fortin.ca, c'est exact ?"]), "an email written out")
    check(not contact_read_back("sam@fortin.com", said_mail), "a different email was not read back")
    check(contact_read_back("suite 200", ["anything"]), "too short to check counts as read back")
    check(contact_read_back("", ["anything"]), "no contact, nothing to check")
    check(not contact_read_back("514 555 0199", []), "nothing said yet: not read back")

    print("— offline: the directions card (#7)")
    card = directions_card("fr")
    check(card["type"] == "directions" and card.get("lang") == "fr", f"type and lang: {card}")
    check(card["address"] == "74 rue Turgeon, Sainte-Thérèse, QC", f"the address: {card['address']}")
    check(card["maps_url"].startswith("https://www.google.com/maps/") and "Turgeon" in card["maps_url"],
          f"the Google Maps link: {card['maps_url']}")
    check("lang" not in directions_card(None), "no lang before the visitor chose one")


async def test_send_guards() -> None:
    """#6 in code: the tools refuse until the name and contact were read back
    in an earlier turn. Direct calls, no Gemini."""
    print("— offline: the read-back guard on the send tools (#6)")
    import worker

    agent = worker.MiaAgent(tts=None, on_screen=lambda msg: calls.append(("screen", msg)))
    agent._chosen_language = "en"
    agent._visitor_lines = [
        "Hi, I'm here to see Alex.",
        "My name is David Chen.",
        "My number is 514 555 0199.",
    ]
    agent._visitor_turns = 3
    out = await agent.notify_member(None, visitor_name="David Chen", member="Alex")
    check(out.startswith("NOT SENT") and "read" in out, f"notify refused before the name was read back: {out[:70]}")
    out = await agent.call_staff(None, member="Alex", visitor_name="David Chen")
    check(out.startswith("NOT CALLED") and "read" in out, f"call refused before the name was read back: {out[:70]}")
    agent._visitor_said = "Yes."
    out = await agent.take_message(None, visitor_name="David Chen", recipient="Alex",
                                   message="I will be late tomorrow.", reply_contact="514 555 0199")
    check(out.startswith("NOT SENT") and "read" in out, f"message refused before the read-back: {out[:70]}")

    # She read the name back and the visitor answered in a later turn.
    agent._read_backs.append((3, "So that's David Chen — is that right?"))
    agent._visitor_turns = 4
    out = await agent.notify_member(None, visitor_name="David Chen", member="Alex")
    check(out.startswith("NOTIFIED"), f"notify goes out once the name was read back and answered: {out[:40]}")
    check("will get back" not in out, "NOTIFIED never tells her to promise he will get back")
    # The contact still wasn't read back: the message still waits.
    out = await agent.take_message(None, visitor_name="David Chen", recipient="Alex",
                                   message="I will be late tomorrow.", reply_contact="514 555 0199")
    check(out.startswith("NOT SENT") and "contact" in out, f"message refused while the number wasn't read back: {out[:70]}")
    agent._read_backs.append((4, "Your number is five one four, five five five, zero one nine nine, and I should tell Alexandre you'll be late — right?"))
    agent._visitor_turns = 5
    agent._visitor_said = "Yes, that's right."
    out = await agent.take_message(None, visitor_name="David Chen", recipient="Alex",
                                   message="I will be late tomorrow.", reply_contact="514 555 0199")
    check(out.startswith("SENT"), f"message goes out once name and number were read back: {out[:40]}")

    # The message dictated this very turn is never sent as-is (Chat W's fix).
    agent._visitor_said = "Tell him the invoices are ready for pickup."
    out = await agent.take_message(None, visitor_name="David Chen", recipient="Alex",
                                   message="The invoices are ready for pickup.")
    check(out.startswith("NOT SENT yet"), f"a message just dictated is read back first: {out[:60]}")

    # A read-back in the same turn as the send is not a confirmation.
    agent = worker.MiaAgent(tts=None)
    agent._chosen_language = "en"
    agent._visitor_lines = ["I'm Eve Adams, tell Nicolas I came by to sign."]
    agent._visitor_turns = 2
    agent._read_backs = [(2, "So that's Eve Adams — is that right?")]
    agent._visitor_said = "Yes, that's right."
    out = await agent.take_message(None, visitor_name="Eve Adams", recipient="Nicolas", message="She came by to sign.")
    check(out.startswith("NOT SENT") and "read" in out, f"a read-back in the send's own turn doesn't count: {out[:70]}")

    # A suggestion with no name and no contact stays anonymous, nothing to confirm.
    agent._visitor_said = "Yes, send it."
    out = await agent.send_suggestion(None, suggestion="Add plants in the lobby.")
    check(out.startswith("SENT"), f"an anonymous suggestion needs no read-back: {out[:40]}")


async def test_directions_tool() -> None:
    print("— offline: show_directions (#7), direct call")
    import worker

    agent = worker.MiaAgent(tts=None, on_screen=lambda msg: calls.append(("screen", msg)))
    agent._chosen_language = "en"
    n = len(calls)
    out = await agent.show_directions(None)
    check(out.startswith("SHOWN") and "QR" in out and "Turgeon" in out, f"tells her to point out the QR code: {out[:80]}")
    cards = screens(n, "directions")
    check(len(cards) == 1 and cards[0].get("lang") == "en", f"one directions card, lang en: {cards}")
    # Saying the address right after must not replace it with the contact card.
    k = len(calls)
    agent._show_contact_card()
    check(not screens(k, "contact_card"), "the contact card is skipped while the directions card is up")


# ---------------------------------------------------------------- with Gemini


async def note1_emotions_en() -> None:
    print("— #1 English, small talk then venting: the boundary line at most once:")
    replies = await converse("en", [
        "Hi! I'm so tired today, what a day it's been.",
        "Honestly, I've been feeling pretty down lately. Can you help me with my personal problems?",
        "I just need some emotional support right now, nobody ever listens to me.",
    ])
    check(not has(replies[0], *BOUNDARY), f"#1 small talk gets a warm answer, no boundary line: {replies[0]!r}")
    limits = [r for r in replies if has(r, *BOUNDARY)]
    check(len(limits) <= 1, f"#1 the boundary line at most once per conversation: {limits}")
    check(has(replies[-1], "message", "team", "Mobile Apps Labs", "meeting", "help you with"),
          f"#1 goes straight back to what she can do: {replies[-1]!r}")
    check(all(len(r.split()) <= 60 for r in replies), "#1 stays brief")


async def note1_emotions_fr() -> None:
    print("— #1 French, même chose :")
    replies = await converse("fr", [
        "Bonjour ! Grosse journée, je suis épuisé.",
        "Pour être honnête, je file un mauvais coton. Vous pouvez m'écouter et me conseiller sur mes problèmes personnels ?",
        "J'ai juste besoin de soutien, personne ne m'écoute jamais.",
    ])
    check(not has(replies[0], *BOUNDARY), f"#1 FR: small talk sans sermon: {replies[0]!r}")
    limits = [r for r in replies if has(r, *BOUNDARY)]
    check(len(limits) <= 1, f"#1 FR: la phrase limite au plus une fois: {limits}")
    check(has(replies[-1], "message", "équipe", "equipe", "Mobile Apps Labs", "rendez-vous"),
          f"#1 FR: revient à ce qu'elle peut faire: {replies[-1]!r}")


async def note4_virtual() -> None:
    print("— #4 English, wants to walk to Alexandre's office:")
    replies = await converse("en", ["Nice office! Can I go see Alexandre in his office? I'll just walk over."])
    r = replies[0]
    check(has(r, "virtual"), f"#4 EN: says this office is virtual: {r!r}")
    check(has(r, "sainte", "turgeon", "remote", "physically"), f"#4 EN: the team is at Sainte-Thérèse / remote: {r!r}")
    check(has(r, "let him know", "let alexandre know", "notify", "call", "message", "meeting", "tell him"),
          f"#4 EN: offers ways to reach him: {r!r}")
    print("— #4 French, « je suis sur place » :")
    replies = await converse("fr", ["Je suis arrivé, je suis dans votre bureau là ! Je peux aller voir Nicolas à son bureau ?"])
    r = replies[0]
    check(has(r, "virtuel"), f"#4 FR: bureau virtuel: {r!r}")
    check(has(r, "sainte", "turgeon", "distance", "télétravail", "teletravail", "physiquement"),
          f"#4 FR: l'équipe à Sainte-Thérèse / à distance: {r!r}")
    check(has(r, "prévenir", "prevenir", "appeler", "appelle", "message", "rendez-vous", "avertir"),
          f"#4 FR: offre comment le joindre: {r!r}")


async def note6_debriel_en() -> None:
    print("— #6 English, message, the name corrected at the read-back (the Debriel case):")
    n = len(calls)
    async with Conversation("en") as c:
        await c.say("Hi, I'd like to leave a message for Nicolas.")
        await c.say("My name is Debriel.")
        r3 = await c.say("Tell him the contract is ready to sign.")
        check(not recorded("message", n), "#6 EN: nothing sent before the visitor confirmed")
        check(has(r3, "debriel"), f"#6 EN: she reads the (misheard) name back: {r3!r}")
        r4 = await c.say("No, no, it's Gabriel. G A B R I E L, not Debriel.")
        check(has(r4, "gabriel"), f"#6 EN: the corrected name is read back: {r4!r}")
        check(not recorded("message", n), "#6 EN: still nothing sent until they say the correction is right")
        await c.say("Yes, that's right.")
    sent = recorded("message", n)
    check(len(sent) == 1 and sent[0][1] == "Nicolas Bastien", f"#6 EN: one message to Nicolas: {sent}")
    check(bool(sent) and "gabriel" in sent[0][2].lower() and "debriel" not in sent[0][2].lower(),
          f"#6 EN: the corrected name is what was sent: {sent}")


async def note6_debriel_fr() -> None:
    print("— #6 French, notice, the name corrected at the read-back:")
    n = len(calls)
    async with Conversation("fr") as c:
        await c.say("Bonjour, j'ai rendez-vous avec Alexandre à quatorze heures.")
        r2 = await c.say("Je m'appelle Debriel Tremblay.")
        check(not recorded("notify", n), "#6 FR: personne n'est prévenu avant la confirmation")
        # Gemini sometimes "fixes" the odd name on its own (Debriel -> Gabriel):
        # either way a name must be read back for the visitor to check.
        check(has(r2, "debriel", "gabriel", "tremblay"), f"#6 FR: elle relit le nom entendu: {r2!r}")
        r3 = await c.say("Non, c'est Gabriel, G A B R I E L, pas Debriel.")
        check(has(r3, "gabriel"), f"#6 FR: le nom corrigé est relu: {r3!r}")
        r4 = await c.say("Oui, c'est bien ça.")
    told = recorded("notify", n)
    check(len(told) == 1 and told[0][1] == "Alexandre Joset", f"#6 FR: Alexandre prévenu une fois: {told}")
    check(bool(told) and "gabriel" in told[0][2].lower() and "debriel" not in told[0][2].lower(),
          f"#6 FR: le nom corrigé est envoyé: {told}")
    check(not any(has(r, *PROMISES) for r in (r2, r3, r4)), "#6 FR: aucune promesse au nom d'Alexandre")


async def note6_contact_en() -> None:
    print("— #6 English, the email is read back too before the send:")
    n = len(calls)
    replies = await converse("en", [
        "I'd like to leave a message for Nicolas.",
        "Sam Fortin.",
        "Please call me back about the demo next week. You can reach me at sam at fortin dot ca.",
        "Yes, that's all correct.",
    ])
    sent = recorded("message", n)
    check(len(sent) == 1 and sent[0][1] == "Nicolas Bastien", f"#6 EN contact: one message to Nicolas: {sent}")
    check(has(replies[-2], "sam"), f"#6 EN contact: the read-back names Sam: {replies[-2]!r}")
    check(contact_read_back("sam@fortin.ca", [replies[-2]]), f"#6 EN contact: the read-back has the email: {replies[-2]!r}")
    check(not any(has(r, *PROMISES) for r in replies), "#6 EN contact: no promise on Nicolas's behalf")


async def note7_directions() -> None:
    print("— #7 English, how to get there → directions card:")
    n = len(calls)
    replies = await converse("en", ["Where is your office? How do I get there by car?"])
    cards = screens(n, "directions")
    check(len(cards) == 1, f"#7 EN: one directions card: {cards}")
    if cards:
        check(cards[0].get("address") == "74 rue Turgeon, Sainte-Thérèse, QC"
              and "google.com/maps" in cards[0].get("maps_url", "") and cards[0].get("lang") == "en",
              f"#7 EN: address, maps url and lang: {cards[0]}")
    check(has(replies[0], "turgeon"), f"#7 EN: says the address: {replies[0]!r}")
    check(has(replies[0], "qr"), f"#7 EN: points out the QR code on the screen: {replies[0]!r}")
    print("— #7 French, Google Maps → carte :")
    n = len(calls)
    replies = await converse("fr", ["C'est où vos bureaux ? Vous avez ça sur Google Maps ?"])
    cards = screens(n, "directions")
    check(len(cards) == 1 and bool(cards) and cards[0].get("lang") == "fr", f"#7 FR: une carte, lang fr: {cards}")
    check(has(replies[0], "turgeon"), f"#7 FR: donne l'adresse: {replies[0]!r}")
    check(has(replies[0], "qr"), f"#7 FR: mentionne le code QR: {replies[0]!r}")


SCENARIOS = {
    "emotions_en": note1_emotions_en,
    "emotions_fr": note1_emotions_fr,
    "virtual": note4_virtual,
    "debriel_en": note6_debriel_en,
    "debriel_fr": note6_debriel_fr,
    "contact_en": note6_contact_en,
    "directions": note7_directions,
}


async def main() -> None:
    import worker

    use_assistant_name(worker)
    install_recorders(worker)
    test_offline()
    await test_send_guards()
    await test_directions_tool()
    for name in sys.argv[1:] or SCENARIOS:
        await SCENARIOS[name]()
    print(f"\n{len(failures)} failed check(s)" + "".join(f"\n  ✗ {f}" for f in failures))
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    asyncio.run(main())
