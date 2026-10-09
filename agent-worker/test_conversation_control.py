"""Offline checks for conversation_control.py (no API keys, no network):

    docker run --rm -v "$PWD":/app -w /app simli-worker python test_conversation_control.py

Inputs are written the way Deepgram returns them, including its slips
("Assistant" for "Assistante", "Mía", missing accents).
"""

import asyncio

from conversation_control import (
    language_choice,
    language_switch,
    only_name,
    says_name,
    speak_digits,
    speak_digits_stream,
    visitor_said_name,
    wants_pause,
)


def check(fn, cases: dict, label: str) -> None:
    for given, expected in cases.items():
        got = fn(*given) if isinstance(given, tuple) else fn(given)
        assert got == expected, f"{label}({given!r}) = {got!r}, expected {expected!r}"
    print(f"✓ {label}: {len(cases)} cases")


def test_pause() -> None:
    check(lambda t: wants_pause(t, "Mia"), {
        "Stop talking.": True,
        "Stop.": True,
        "Okay, stop, please.": True,
        "Mia, stop!": True,
        "Shut up.": True,
        "Be quiet please.": True,
        "Sorry, I'm talking to someone else.": True,
        "Sorry. I'm talking to someone else.": True,
        "I'm talking to my colleague.": True,
        "Stop, I'm talking with my friend.": True,
        "I wasn't talking to you.": True,
        "Tais-toi.": True,
        "Tais toi s'il te plaît.": True,
        "Taisez-vous.": True,
        "Arrêtez de parler s'il vous plaît.": True,
        "Arrete de parler": True,
        "Chut!": True,
        "Je parle à quelqu'un d'autre.": True,
        "Je parle à mon collègue.": True,
        "Je ne vous parle pas.": True,
        "C'est pas à vous que je parle.": True,
        "Silence, s'il vous plaît.": True,
        # Not a pause
        "Where is the bus stop?": False,
        "Is there a stop nearby?": False,
        "Can you stop by the office?": False,
        "I'm talking to Nicolas tomorrow.": False,
        "Thank you.": False,
        "Merci.": False,
        "Je voudrais parler à Nicolas.": False,
        "I want to talk to the CEO.": False,
        "Stop what was the address again": False,
        "": False,
    }, "wants_pause")


def test_name() -> None:
    check(lambda t: says_name(t, "Mia"), {
        "Mia?": True,
        "Mia.": True,
        "Okay, Mia. I'm back.": True,
        "¿Mía?": True,
        "MIA, vous êtes là?": True,
        "Hey assistant.": True,
        "Assistante?": True,
        "Assistant": True,
        "Hay assistant.": True,
        "Did you see that?": False,
        "Maria said hi": False,
        "My amiable friend": False,
        "Media": False,
        "": False,
    }, "says_name(Mia)")
    check(lambda t: only_name(t, "Mia"), {
        "Mia?": True,
        "Okay, Mia. I'm back.": True,
        "Mia, vous êtes là?": True,
        "Hey assistant.": True,
        "Mia, what's your phone number?": False,
        "Mia, je voudrais laisser un message.": False,
    }, "only_name(Mia)")
    check(lambda t: says_name(t, "Linda"), {
        "Linda, are you there?": True,
        "linda": True,
        "Mia?": False,
        "Assistante, vous êtes là?": True,
    }, "says_name(Linda)")


def test_language() -> None:
    check(language_choice, {
        "English.": "en",
        "English, please.": "en",
        "Anglais": "en",
        "In English please": "en",
        "Français.": "fr",
        "Francais": "fr",
        "En français, s'il vous plaît.": "fr",
        "French please": "fr",
        "Oui, en français.": "fr",
        "Do you speak English?": "en",
        "I don't speak French.": "en",
        "Je ne parle pas anglais.": "fr",
        "Français ou English?": None,  # echoed the question: not a choice
        "Hi, what does your company do?": None,  # no choice word: detected language decides
        "Bonjour": None,
        # Deepgram's live readings of a lone "Français." / "English."
        "france": "fr",
        "Franc": "fr",
        "Franck.": "fr",
        "Engösch.": "en",
        "Inglish": "en",
        "I'm visiting from France, what do you do?": None,
    }, "language_choice")
    check(language_switch, {
        ("Can we speak French please?", "en"): "fr",
        ("Can we speak French, please?", "en"): "fr",
        ("I'd rather speak French.", "en"): "fr",
        ("French please.", "en"): "fr",
        ("En français, s'il vous plaît.", "en"): "fr",
        ("Est-ce qu'on peut parler français?", "en"): "fr",
        ("I don't speak English.", "en"): "fr",
        ("Je veux parler en anglais.", "fr"): "en",
        ("I'd better speak english please", "fr"): "en",
        ("English please", "fr"): "en",
        ("Que me speak English please?", "fr"): "en",
        ("Vous parlez anglais?", "fr"): "en",
        ("Je ne parle pas français.", "fr"): "en",
        # Already in that language, or not a request
        ("Can we speak French?", "fr"): None,
        ("Is the app available in French?", "en"): None,
        ("Is it in French", "en"): None,
        ("Votre site est-il en anglais?", "fr"): None,
        ("What does Mobile Apps Labs do?", "en"): None,
        ("Je voudrais laisser un message.", "fr"): None,
        # Going back to a language (missed before 2026-10-09).
        ("Hmm, est-ce qu'on peut revenir au français ?", "en"): "fr",
        ("est-ce qu'on peut revenir au français", "en"): "fr",
        ("Est-ce qu'on peut revenir aux français?", "en"): "fr",  # as the STT wrote it, 2026-10-09
        ("On peut revenir en anglais ?", "fr"): "en",
        ("On revient en français, s'il vous plaît.", "en"): "fr",
        ("Can we go back to French?", "en"): "fr",
        ("Can we switch back to English, please?", "fr"): "en",
        ("Passons à l'anglais.", "fr"): "en",
        ("Pouvez-vous me répondre en anglais ?", "fr"): "en",
        ("Est-il possible de parler anglais ?", "fr"): "en",
        ("Is it possible to speak in English?", "fr"): "en",
        ("Could you say that again in French?", "en"): "fr",
        ("Actually, can we continue in English, please?", "fr"): "en",
        ("Plutôt en anglais, s'il vous plaît.", "fr"): "en",
        ("English, Mia, please.", "fr"): "en",
        ("Can't we speak French?", "en"): "fr",
        ("Est-ce qu'on peut m'expliquer en anglais ?", "fr"): "en",
        ("qu'on m'explique English?", "fr"): "en",  # fr-CA STT on "can we speak English?"
        # Both named: the one they ask to speak wins.
        ("Sorry, can we speak English? My French isn't great.", "fr"): "en",
        ("Can we switch to English? I don't understand French well.", "fr"): "en",
        ("Je ne parle pas bien anglais, on peut parler français ?", "en"): "fr",
        ("My French is bad, English please.", "fr"): "en",
        ("Can we speak French? My English is not very good.", "en"): "fr",
        # Only the one they don't speak: the other.
        ("Sorry, my French isn't great.", "fr"): "en",
        ("I don't understand French well.", "fr"): "en",
        ("Je ne comprends pas bien l'anglais.", "en"): "fr",
        # Mere mentions.
        ("Mon collègue parle anglais, il viendra demain.", "fr"): None,
        ("Mon collègue parle anglais.", "fr"): None,
        ("Can I talk to someone who knows French cooking?", "en"): None,
        ("We could go to a French restaurant after the meeting.", "en"): None,
        ("My partner doesn't speak French, can I bring him next time?", "en"): None,
        ("Does Nicolas speak French?", "en"): None,
        ("Is the app not available in French?", "en"): None,
        ("I love French food.", "en"): None,
        ("I'd prefer a French version of the brochure.", "en"): None,
        ("Do you have a French version of the brochure?", "en"): None,
        ("Ma femme est anglaise, elle parle anglais.", "fr"): None,
        ("Nos clients parlent anglais.", "fr"): None,
        ("Can I talk to Nicolas in English?", "en"): None,
        ("Français ou anglais, peu importe.", "fr"): None,
    }, "language_switch")


def test_visitor_name() -> None:
    lines = ["Hi, I'm here to see Alex, I have a meeting with him at two."]
    check(lambda name: visitor_said_name(name, lines, "Mia"), {
        "there": False,  # what Gemini wrote, 2026-10-09
        "Hi": False,
        "the visitor": False,
        "Alex": True,  # said, but it's who they came to see: worker.py refuses that
        "David Chen": False,
        "": False,
    }, "visitor_said_name before a name")
    lines += ["My name is David Chen.", "C'est Chloé Bergeron, B E R G E R O N.", "I'm Mr. Mark Le Blanc.", "Mia?"]
    check(lambda name: visitor_said_name(name, lines, "Mia"), {
        "David Chen": True,
        "david chen": True,
        "Chen": True,
        "Chloe Bergeron": True,  # accents
        "Chloé BERGERON": True,
        "Marc Leblanc": True,  # spelling, words run together
        "Mr. Leblanc": True,
        "Monsieur Chen": True,
        "Sir": False,
        "Madame": False,
        "Monsieur": False,
        "David Smith": False,  # never said
        "Mia": False,  # her name, not theirs
        "Hello there": False,
        "Hi David": False,
        "Unknown": False,
    }, "visitor_said_name after names")
    check(lambda name: visitor_said_name(name, ["Je m'appelle Hugo Gagnon de Toitures Gagnon."]), {
        "Hugo Gagnon": True,
        "Hugo": True,
        "Hugo Tremblay": False,
    }, "visitor_said_name (FR)")
    check(lambda name: visitor_said_name(name, ["My name is Chen, C H E N."]), {"Chen": True}, "visitor_said_name spelled")
    check(lambda name: visitor_said_name(name, ["I'm Sam O'Brien."]), {"Sam O'Brien": True, "Sam OBrien": True}, "visitor_said_name apostrophe")


def test_digits() -> None:
    en, fr = "en", "fr"
    check(speak_digits, {
        ("Call 1 514 573 2324.", en): "Call one, five one four, five seven three, two three two four.",
        ("Call 5145732324.", en): "Call five one four, five seven three, two three two four.",
        ("It's 5732324", en): "It's five seven three, two three two four",
        ("+1 (514) 573-2324", en): "one, five one four, five seven three, two three two four",
        ("1-514-573-2324 or email", en): "one, five one four, five seven three, two three two four or email",
        ("514.573.2324", en): "five one four, five seven three, two three two four",
        ("Composez le 1 514 573 2324.", fr): "Composez le un, cinq un quatre, cinq sept trois, deux trois deux quatre.",
        ("le 514-573-2324", fr): "le cinq un quatre, cinq sept trois, deux trois deux quatre",
        ("15145732324", fr): "un, cinq un quatre, cinq sept trois, deux trois deux quatre",
        ("Code 10203", en): "Code one zero two, zero three",
        ("Ref 1234567890123", en): "Ref one two three, four five six, seven eight nine, zero one, two three",
        # Left alone: short numbers, years, ranges, thousands, decimals
        ("74 Turgeon Street", en): "74 Turgeon Street",
        ("We answer within 24 hours.", en): "We answer within 24 hours.",
        ("Founded in 2015.", en): "Founded in 2015.",
        ("From 2015 to 2020, and 2015-2020.", en): "From 2015 to 2020, and 2015-2020.",
        ("10 000 visitors", fr): "10 000 visitors",
        ("1 000 000 $", fr): "1 000 000 $",
        ("pi is 3.14159", en): "pi is 3.14159",
        ("360 degrees, 14 days", en): "360 degrees, 14 days",
        ("J7E 4H5", fr): "J7E 4H5",
        ("one, five one four", en): "one, five one four",
    }, "speak_digits")


async def _stream(chunks: list[str], lang: str) -> str:
    async def gen():
        for c in chunks:
            yield c

    return "".join([part async for part in speak_digits_stream(gen(), lambda: lang)])


def test_digits_stream() -> None:
    cases = {
        ("Call us at 1 5", "14 573 23", "24, any time."): "Call us at one, five one four, five seven three, two three two four, any time.",
        ("Le numéro est le 51", "45732324."): "Le numéro est le cinq un quatre, cinq sept trois, deux trois deux quatre.",
        ("Hello ", "there, ", "how are you?"): "Hello there, how are you?",
        ("We are at 74", " Turgeon Street."): "We are at 74 Turgeon Street.",
        ("5732324",): "five seven three, two three two four",
    }
    for chunks, expected in cases.items():
        lang = "fr" if chunks[0].startswith("Le") else "en"
        got = asyncio.run(_stream(list(chunks), lang))
        assert got == expected, f"stream {chunks!r} -> {got!r}, expected {expected!r}"
    print(f"✓ speak_digits_stream: {len(cases)} cases (numbers split across chunks)")


if __name__ == "__main__":
    test_pause()
    test_name()
    test_language()
    test_visitor_name()
    test_digits()
    test_digits_stream()
    print("all conversation_control tests passed")
