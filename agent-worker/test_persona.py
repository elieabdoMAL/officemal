"""Text conversations for the persona notes (boss feedback 2026-10-09).

Same harness as test_team_messages.py — real Gemini, every email replaced by a
recorder — one scenario per note. Run inside the worker image:

    docker run --rm --env-file .env -v "$PWD":/app -e RESEND_API_KEY= simli-worker python test_persona.py

Pass scenario names to run only those, e.g. `python test_persona.py inbox talk`.
Her wording varies run to run, so the checks look for a few key words; every
check runs and the failures are listed at the end (exit 1 if any).
"""

import asyncio
import re
import sys

from conversation_control import speak_for_voice
from test_team_messages import Conversation, calls, converse, install_recorders, test_find_member, use_assistant_name

failures: list[str] = []


def check(ok: bool, what: str) -> None:
    print(f"{'✓' if ok else '✗'} {what}")
    if not ok:
        failures.append(what)


def has(text: str, *words: str) -> bool:
    """True if `text` contains any of `words` (case-insensitive)."""
    low = text.lower()
    return any(w.lower() in low for w in words)


def recorded(kind: str, since: int) -> list[tuple]:
    return [c for c in calls[since:] if c[0] == kind]


# Her "I've told them" line, which is only true after notify_member ran.
CLAIMED_NOTIFY = ("let nicolas know", "let alexandre know", "let alex know", "i've let", "i have let",
                  "i've notified", "i have notified", "prévenu", "informé")


def no_false_claim(reply: str, notified_this_turn: bool, what: str) -> None:
    check(notified_this_turn or not has(reply, *CLAIMED_NOTIFY), f"{what}: no 'I've let them know' without notify_member")


REFUSED = ("can't give", "cannot give", "can't share", "cannot share", "not able to share",
           "can't reach", "cannot reach", "general inbox",
           "ne peux pas donner", "ne peux pas partager", "pas autorisée", "ne peux pas joindre")


async def note2_inbox() -> None:
    print("— #2/#3 English, email the general inbox:")
    n = len(calls)
    async with Conversation("en") as c:
        replies = [await c.say("Hi, can I send an email to info at Mobile Apps Labs?")]
        replies.append(await c.say("My name is Kevin Roy."))
        replies.append(await c.say("Tell them I'd like a quote for a mobile app for my restaurant. My number is 450 555 0199."))
        replies.append(await c.say("Yes, that's right."))
        if not recorded("message", n):  # she re-read the full name (#6r2): one more yes
            replies.append(await c.say("Yes, that's right."))
    sent = recorded("message", n)
    check(len(sent) == 1 and sent[0][1] == "the general inbox", f"#2 one message to the general inbox: {sent}")
    check(bool(sent) and has(replies[-1], "sent") and not any(has(r, "it's sent", "it is sent") for r in replies[:-1]),
          "#3 says it's sent, and only once it was")

    print("— #2/#3 French, a message for the team:")
    n = len(calls)
    async with Conversation("fr") as c:
        replies = [await c.say("Bonjour, je voudrais laisser un message à l'équipe.")]
        replies.append(await c.say("Marie Gagnon."))
        replies.append(await c.say("Je voudrais savoir si vous engagez des stagiaires en design. Pas besoin de me répondre."))
        replies.append(await c.say("Oui, c'est parfait."))
        if not recorded("message", n):  # she re-read the full name (#6r2): one more yes
            replies.append(await c.say("Oui, c'est bien ça."))
    sent = recorded("message", n)
    check(len(sent) == 1 and sent[0][1] == "the general inbox", f"#2 one message to the general inbox (FR): {sent}")
    check(bool(sent) and has(replies[-1], "envoyé"), "#3 says C'est envoyé after sending (FR)")

    print("— #2 English, someone not on the team is offered the general inbox:")
    n = len(calls)
    replies = await converse("en", ["Can I leave a message for Marc Dupont?"])
    check(not recorded("message", n), "#2 nothing sent for Marc Dupont")
    check(has(replies[0], "general inbox", "team"), "#2 offers the general inbox instead")


async def note3_confirm_person() -> None:
    print("— #3 English, message for Nicolas, confirmation after SENT:")
    n = len(calls)
    replies = await converse("en", [
        "I'd like to leave a message for Nicolas.",
        "Sam Fortin.",
        "Please call me back about the demo next week. You can reach me at sam at fortin dot ca.",
        "Yes, correct.",
    ])
    sent = recorded("message", n)
    check(len(sent) == 1 and sent[0][1] == "Nicolas Bastien", f"#3 one message to Nicolas: {sent}")
    check(bool(sent) and has(replies[-1], "sent") and has(replies[-1], "Nicolas"), "#3 'It's sent to Nicolas' after SENT")
    check(not any(has(r, "sent") for r in replies[:-1]), "#3 never says sent before the tool ran")
    check(has(replies[-2], "sam"), f"#6r2 the read-back names Sam: {replies[-2]!r}")


async def note10_talk() -> None:
    # Since the video call (#22), she offers to call the person and calls on a
    # yes once she has the visitor's name (more in test_staff_call.py).
    print("— #10 English, wants to talk to someone, no name:")
    n = len(calls)
    async with Conversation("en") as c:
        replies = [await c.say("Hi, I'd like to talk to someone please.")]
        replies.append(await c.say("Yes please. I'm Paul Lavoie."))
        # She asks the name and offers the call in either order, and reads the
        # name back before calling (#6r2): confirm until the call is placed.
        for line in ("Yes, that's right.", "Yes, please call him."):
            if recorded("call", n):
                break
            replies.append(await c.say(line))
    called = recorded("call", n)
    no_false_claim(replies[0], False, "#10 before the name")
    check(has(replies[0], "call"), "#10 offers to call someone")
    check(any(has(r, "paul", "lavoie") for r in replies[1:]), f"#10 reads the name back first (#6r2): {replies[1:]}")
    check(len(called) == 1 and called[0][1] == "Nicolas Bastien", f"#10 Nicolas called: {called}")
    check(has(replies[-1], "calling nicolas"), "#10 says she is calling Nicolas")
    check(len(replies[0].split()) <= 30, f"#10 no over-justification on the first reply ({len(replies[0].split())} words)")

    print("— #10 French, wants a real person:")
    n = len(calls)
    async with Conversation("fr") as c:
        replies = [await c.say("Est-ce que je peux parler à une vraie personne ?")]
        replies.append(await c.say("Oui, s'il vous plaît. Lucie Bouchard."))
        for line in ("Oui, c'est bien ça.", "Oui, appelez-le s'il vous plaît."):
            if recorded("call", n):
                break
            replies.append(await c.say(line))
    called = recorded("call", n)
    no_false_claim(replies[0], False, "#10 before the name (FR)")
    check(len(called) == 1, f"#10 someone called (FR): {called}")
    check(has(replies[-1], "j'appelle"), "#10 says 'J'appelle …' (FR)")

    print("— #10 meeting with someone not on the team, and with Alex before the name:")
    n = len(calls)
    replies = await converse("fr", ["Bonjour, je suis Sophie Martin, j'ai rendez-vous avec Marc Dupont."])
    check(not recorded("notify", n), "#10 nobody notified for Marc Dupont")
    no_false_claim(replies[0], False, "#10 Marc Dupont")
    # Seen 2026-10-09, 1 run in 3 or 4: notify_member(visitor_name="there") on this line.
    for attempt in (1, 2, 3):
        n = len(calls)
        replies = await converse("en", ["Hi, I'm here to see Alex, I have a meeting with him at two."])
        notified = recorded("notify", n)
        check(not notified, f"#10 Alex, name not given ({attempt}/3): nobody notified before the name ({notified})")
        no_false_claim(replies[0], False, f"#10 Alex, name not given ({attempt}/3)")


async def note15_alexandre() -> None:
    for lang, first, name, spelled in (
        ("en", "I want to talk to Alexandre.", "Yes please, I'm Mark Stone.", "Alexandre"),
        ("en", "I want to talk to Alexander.", "Yes please, I'm Nina Patel.", "Alexander (STT)"),
        ("en", "Can I speak with Alexandra please?", "Yes please, I'm Tom Reid.", "Alexandra (STT)"),
        ("fr", "Je veux parler à Alexandre.", "Oui, s'il vous plaît, je suis Julien Côté.", "Alexandre (FR)"),
    ):
        print(f"— #15 {spelled}:")
        n = len(calls)
        # The follow-ups both confirm the read-back (#6r2) and, when she offers
        # a choice of call or notice, pick one; extras after a send are harmless.
        follow_ups = (
            ("Yes, that's right. Please let him know I'm here.", "Yes, exactly.")
            if lang == "en"
            else ("Oui, c'est bien ça. Prévenez-le que je suis là, s'il vous plaît.", "Oui, exactement.")
        )
        async with Conversation(lang) as c:
            replies = [await c.say(first)]
            replies.append(await c.say(name))
            for line in follow_ups:
                if recorded("call", n) or recorded("notify", n):
                    break
                replies.append(await c.say(line))
        # Called on the yes (#22), or notified: either way, Alexandre.
        reached = recorded("call", n) + recorded("notify", n)
        check(not has(replies[0], *REFUSED), f"#15 {spelled}: no 'can't give the info' refusal")
        no_false_claim(replies[0], False, f"#15 {spelled} before the name")
        check(bool(reached) and all(r[1] == "Alexandre Joset" for r in reached),
              f"#15 {spelled}: Alexandre called or notified: {reached}")


async def note5_where() -> None:
    print("— #5 English, where are you:")
    replies = await converse("en", ["Where are you exactly? Where is your office?"])
    check(has(replies[0], "virtual") and has(replies[0], "Turgeon"), "#5 virtual office + Turgeon Street")
    print("— #5 English, already here:")
    replies = await converse("en", ["I'm already here, I'm at your office right now."])
    check(has(replies[0], "virtual"), "#5 explains it's a virtual office")
    print("— #5 French, déjà sur place:")
    replies = await converse("fr", ["Je suis déjà sur place, je suis devant vos bureaux."])
    check(has(replies[0], "virtuel"), "#5 explique le bureau virtuel (FR)")


async def note7_infiniview() -> None:
    print("— #7/#8 English, Infini-View:")
    replies = await converse("en", [
        "Are you in Infini-View?",
        "How do I move around in here?",
        "Where can I see a demo?",
    ])
    check(has(replies[0], "yes", "I am", "I'm in", "that's right", "indeed"), "#7 says yes, she's in Infini-View")
    check(has(replies[1], "touch", "pan", "slid", "swip", "drag"), "#7 explains touch and pan")
    # Spoken or written form: the voice-only rewrite (speak_addresses) turns
    # "www.infini-view.com" into "w w w dot infini dash view dot com".
    check(
        has(replies[2], "infini dash view") or has(replies[2], "infini-view.com"),
        "#8 gives the web address infini-view.com",
    )
    check(has(replies[2], "door"), "#8 suggests the door for a demo")
    print("— #7/#8 French, Infini-View:")
    replies = await converse("fr", ["Est-ce que c'est Infini-View ici ? Où est-ce que je peux voir une démo ?"])
    check(has(replies[0], "oui"), "#7 dit oui (FR)")
    check(has(replies[0], "porte", "infini tiret view"), "#8 la porte ou l'adresse web (FR)")


async def note12_product() -> None:
    print("— #12 English, why are you here:")
    replies = await converse("en", ["Why are you here? What are you exactly?", "Could my company use something like you?"])
    check(has(replies[0], "Mobile Apps Labs") and has(replies[0], "receptionist", "avatar"), "#12 a Mobile Apps Labs product")
    # Said in either reply: she may not repeat the uses if the first answer gave them.
    check(has(" ".join(replies), "front desk", "after hours", "event", "language", "tour"), "#12 how a company can use her")
    check(len(replies[1].split()) <= 80, f"#12 short ({len(replies[1].split())} words)")
    check(not re.search(r"\$|dollar|price is|costs", replies[1], re.I), "#12 no prices")


async def note11_tone() -> None:
    print("— #11 English, small talk (read for warmth and wit):")
    replies = await converse("en", ["Hi! How's your day going?", "Tell me a joke."])
    check(all(len(r.split()) <= 45 for r in replies), "#11 still brief")
    print("— #11 French:")
    await converse("fr", ["Bonjour ! Vous avez l'air de bonne humeur aujourd'hui."])


async def note21_impatient() -> None:
    print("— #21 English, impatient:")
    replies = await converse("en", ["This is useless, you're not helping at all! Just tell me how much an app costs."])
    check(has(replies[0], "sorry"), "#21 says sorry")
    check(has(replies[0], "limitation"), "#21 says it's a limitation of her system")
    # A price question may also be answered the COMPANY KNOWLEDGE way: free
    # consultation, App Express, "do you have a project in mind?".
    check(has(replies[0], "message", "let someone", "let the team", "team", "consultation", "project"),
          "#21 offers what she can do")
    print("— #21 French, hors sujet:")
    replies = await converse("fr", ["Pouvez-vous m'aider avec mes devoirs de maths ?"])
    check(has(replies[0], "désolée"), "#21 désolée (FR)")
    check(has(replies[0], "limite"), "#21 limite de mon système (FR)")


def _one_by_one(text: str, words: str) -> bool:
    """'one, five, one, four' — or '1, 5, 1, 4', which the voice reads digit by digit."""
    return has(text, words) or bool(re.search(r"1\D{1,4}5\D{1,4}1\D{1,4}4", text))


async def note6_phone() -> None:
    # Checked on what the visitor HEARS: her text after the worker's voice-only
    # rewrite (tts_node -> speak_for_voice), which turns a written
    # "514 573 2324" into grouped spoken digits. Captions keep the numerals.
    print("— #6 English, phone number then slowly:")
    replies = await converse("en", ["What's your phone number?", "Can you repeat it slowly please?"])
    heard = [speak_for_voice(r, "en") for r in replies]
    check(not has(" ".join(heard), "hundred", "fourteen", "fifty", "seventy", "thirty", "twenty"), "#6 no grouped numbers")
    check(has(heard[0], "five one four"), "#6 grouped digits")
    check(_one_by_one(heard[1], "one, five, one, four"), "#6 digit by digit when slow")
    print("— #6 French:")
    replies = await converse("fr", ["Quel est votre numéro de téléphone ?", "Pouvez-vous le répéter lentement ?"])
    heard = [speak_for_voice(r, "fr") for r in replies]
    check(has(heard[0], "cinq un quatre"), "#6 chiffres groupés (FR)")
    check(_one_by_one(heard[1], "un, cinq, un, quatre"), "#6 chiffre par chiffre (FR)")


async def note1_team() -> None:
    print("— #1 English, about the team (no bios yet: nothing invented):")
    replies = await converse("en", ["Tell me about your team. Who is Alexandre?"])
    check(has(replies[0], "COO", "operations", "operating"), "#1 gives name and role")


SCENARIOS = {
    "inbox": note2_inbox,
    "confirm": note3_confirm_person,
    "talk": note10_talk,
    "alexandre": note15_alexandre,
    "where": note5_where,
    "infiniview": note7_infiniview,
    "product": note12_product,
    "tone": note11_tone,
    "impatient": note21_impatient,
    "phone": note6_phone,
    "team": note1_team,
}


async def main() -> None:
    test_find_member()

    import worker

    use_assistant_name(worker)
    install_recorders(worker)
    for name in sys.argv[1:] or SCENARIOS:
        await SCENARIOS[name]()
    print(f"\n{len(failures)} failed check(s)" + "".join(f"\n  ✗ {f}" for f in failures))
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    asyncio.run(main())
