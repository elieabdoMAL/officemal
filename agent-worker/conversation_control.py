"""Conversation control for the receptionist: what the visitor's words mean for
how she talks, decided in code rather than by the LLM, plus the digit rewrite
her text goes through before the TTS.

    wants_pause(text)                 "stop talking", "tais-toi", "I'm talking to someone else"
    says_name(text, name)             her name (or "assistant") said while she is paused
    language_choice(text)             "English please" at the start: which language they chose
    language_switch(text, current)    "je veux parler en anglais" later: which language to switch to
    speak_digits(text, lang)          "514 573 2324" -> "five one four, five seven three, ..."

Everything here is pure (no LiveKit), so test_conversation_control.py checks it
offline. All matching runs on fold(): lowercase, accents stripped, apostrophes
straightened, because the STT is not consistent about any of those.
"""

import re
import unicodedata
from collections.abc import AsyncIterable, AsyncIterator, Callable


def fold(text: str) -> str:
    """'Arrêtez, S’IL vous plaît' -> "arretez, s'il vous plait"."""
    text = unicodedata.normalize("NFKD", text)
    text = "".join(c for c in text if not unicodedata.combining(c))
    return text.lower().replace("’", "'").replace("‘", "'")


def _words(text: str) -> list[str]:
    """Words of folded text; "tais-toi" stays one word, "d'autre" too."""
    return re.findall(r"[a-z0-9]+(?:['-][a-z0-9]+)*", fold(text))


# ---------------------------------------------------------------------------
# Pause: "stop talking" and friends
# ---------------------------------------------------------------------------

# Phrases that ask her to be quiet wherever they appear in what was said.
_PAUSE_PHRASES = re.compile(
    r"\b("
    # English
    r"stop talking|stop speaking|stop it|shut up|be quiet|keep quiet|quiet please|"
    r"(?:i'?m|i am|we'?re|we are) (?:talking|speaking) (?:to|with) (?:someone|somebody|my|a|an|him|her|them|someone else)\b|"
    r"talking to (?:someone|somebody) else|not talking to you|wasn'?t talking to you|"
    r"(?:i|we) (?:need|have) to talk to (?:someone|somebody|my)|"
    # French
    r"tais[- ]toi|taisez[- ]vous|arrete de parler|arretez de parler|arrete de me parler|"
    r"arretez de me parler|je parle a (?:quelqu'un|quelqu un|mon|ma|mes|un|une)|"
    r"on parle a (?:quelqu'un|quelqu un)|je ne (?:vous|te) parle pas|je (?:vous|te) parle pas|"
    r"c'est pas a (?:vous|toi)|ce n'est pas a (?:vous|toi)|pas a (?:vous|toi) que je parle"
    r")"
)

# A whole utterance made only of these (plus the fillers below) is a pause too:
# "Stop!", "OK stop, please", "Chut". Alone they're too common to match inside
# a sentence ("the bus stop", "non-stop").
_PAUSE_WORDS = {"stop", "chut", "shh", "shhh", "chh", "silence", "quiet", "enough", "assez", "arrete", "arretez"}
_FILLERS = {
    "ok", "okay", "please", "now", "it", "oh", "hey", "hum", "um", "uh", "euh", "bon", "alors", "merci",
    "thanks", "thank", "you", "s'il", "vous", "plait", "svp", "sorry", "pardon", "desolee", "desole",
    "just", "juste", "a", "moment", "second", "minute", "sec", "wait", "attends", "attendez",
}


def wants_pause(text: str, name: str = "") -> bool:
    """True when the visitor asks her to stop talking / be quiet."""
    folded = fold(text)
    if _PAUSE_PHRASES.search(folded):
        return True
    words = _words(text)
    skip = _FILLERS | {fold(name)}
    rest = [w for w in words if w not in skip]
    return bool(rest) and all(w in _PAUSE_WORDS for w in rest)


# ---------------------------------------------------------------------------
# Wake: her name, while paused
# ---------------------------------------------------------------------------

# Said instead of her name. Deepgram writes "Assistante" as "Assistant" in
# English; both are accepted in both languages.
_WAKE_WORDS = {"assistant", "assistante"}


def _wake_words(name: str) -> set[str]:
    return {fold(n) for n in name.split()} | _WAKE_WORDS


def says_name(text: str, name: str) -> bool:
    """True when `text` contains her name (any case or accent) or "assistant"."""
    wanted = _wake_words(name)
    return any(w in wanted for w in _words(text))


_CALLING = {"hey", "hi", "hello", "allo", "bonjour", "salut", "are", "you", "there", "etes", "vous", "la", "es", "tu", "i'm", "back", "je", "suis", "revenu", "revenue", "de", "retour"}


def only_name(text: str, name: str) -> bool:
    """True when `text` just calls her ("Mia?", "Mia, vous êtes là?") with no request."""
    skip = _wake_words(name) | _FILLERS | _CALLING
    return not [w for w in _words(text) if w not in skip]


# ---------------------------------------------------------------------------
# Language: the choice at the start, and explicit switch requests later
# ---------------------------------------------------------------------------

_LANG_WORDS = {
    "en": {"english", "anglais", "inglish", "ingles"},
    "fr": {"french", "francais", "fransais", "franca"},
}
_OTHER = {"en": "fr", "fr": "en"}
# Asking for a language: speak / talk / switch / answer ... in it.
_ASK_VERBS = re.compile(
    r"\b(speak|speaking|talk|talking|switch|change|continue|answer|reply|respond|say it|go|"
    r"parler|parle|parlez|parlons|passer|passe|passez|passons|changer|change|continuer|continuons|"
    r"repondre|repondez|reponds|discuter|prefer|prefere|preferer|rather|plutot)\b"
)
# "I don't speak French" asks for the *other* language.
_NEGATION = re.compile(r"\b(don'?t|do not|doesn'?t|can'?t|cannot|not|pas)\b")
# Allowed around a bare language word: "English please", "en français svp".
_CHOICE_FILLERS = _FILLERS | {"in", "en", "the", "le", "yes", "oui", "ok", "okay", "si", "my", "pour", "moi", "me", "for"}


def _mentioned(words: list[str]) -> set[str]:
    return {lang for lang, names in _LANG_WORDS.items() if any(w in names for w in words)}


def _requested(text: str, *, loose: bool) -> str | None:
    """The language `text` asks for, or None.

    loose: also count a language word in any sentence ("Do you have this in
    English?"), used only for the very first answer, to "Français ou English?".
    """
    words = _words(text)
    mentioned = _mentioned(words)
    if len(mentioned) != 1:
        return None  # none, or both ("français ou English?") — not a choice
    lang = next(iter(mentioned))
    folded = fold(text)
    rest = [w for w in words if w not in _CHOICE_FILLERS and w not in _LANG_WORDS[lang]]
    if not rest:
        return lang  # "English", "En français, s'il vous plaît"
    asked = bool(_ASK_VERBS.search(folded))
    if not (asked or loose):
        return None
    if asked and _NEGATION.search(folded):
        return _OTHER[lang]  # "I don't speak French", "je ne parle pas anglais"
    return lang


def language_choice(text: str) -> str | None:
    """'fr' / 'en' when the visitor's answer names a language, else None."""
    return _requested(text, loose=True)


def language_switch(text: str, current: str) -> str | None:
    """The language the visitor explicitly asks to switch to, or None.

    Only a request counts: "can we speak French", "je veux parler en anglais",
    "English please". A question that merely names a language ("is the app in
    French?") does not.
    """
    lang = _requested(text, loose=False)
    return lang if lang and lang != current else None


# ---------------------------------------------------------------------------
# Digits: spoken one by one, in groups, so a phone number is never read as a
# big number ("5732324" -> "five million ...").
# ---------------------------------------------------------------------------

DIGIT_WORDS = {
    "en": ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"],
    "fr": ["zéro", "un", "deux", "trois", "quatre", "cinq", "six", "sept", "huit", "neuf"],
}

# A run of digits with the separators phone numbers use. It starts and ends on
# a digit (or the brackets around an area code), never touches a letter, and
# never starts right after a decimal point or comma ("3.14159").
_SEP = r"[ \t\-./()  ]"
_RUN = re.compile(rf"(?<![\w.,])\+?\(?\d(?:{_SEP}{{0,3}}\d)*\)?(?!\w)")
# Long enough to be a phone number, account or postal number, never a year.
MIN_SINGLE_RUN = 5
MIN_PHONE_DIGITS = 7


def _group_single(digits: str) -> list[str]:
    """Split one unbroken run the way people say phone numbers."""
    n = len(digits)
    if n == 7:
        return [digits[:3], digits[3:]]
    if n == 10:
        return [digits[:3], digits[3:6], digits[6:]]
    if n == 11 and digits[0] == "1":
        return [digits[0], digits[1:4], digits[4:7], digits[7:]]
    groups = [digits[i : i + 3] for i in range(0, n, 3)]
    if len(groups) > 1 and len(groups[-1]) == 1:  # no lonely last digit
        groups[-2:] = [groups[-2][:2], groups[-2][2] + groups[-1]]
    return groups


def _say_groups(groups: list[str], lang: str) -> str:
    names = DIGIT_WORDS.get(lang, DIGIT_WORDS["en"])
    return ", ".join(" ".join(names[int(d)] for d in g) for g in groups)


def _is_thousands(groups: list[str]) -> bool:
    """'10 000' or '1 000 000' (French thousands spacing), not a phone number."""
    return len(groups[0]) <= 3 and all(len(g) == 3 for g in groups[1:])


def _is_phone(groups: list[str]) -> bool:
    """'1 514 573 2324', '(514) 573-2324', '573-2324' — not '10 000 000' or '2015-2020'."""
    return (
        len(groups) > 1
        and sum(len(g) for g in groups) >= MIN_PHONE_DIGITS
        and len(groups[-1]) >= 3
        and not _is_thousands(groups)
        and not all(len(g) == 4 for g in groups)  # a range of years
    )


def _rewrite_run(raw: str, lang: str) -> str:
    groups = re.findall(r"\d+", raw)
    if _is_phone(groups):
        spoken: list[str] = []
        for g in groups:
            spoken += _group_single(g) if len(g) > 4 else [g]
        return _say_groups(spoken, lang)
    # Not one phone number: rewrite each long unbroken run, keep the rest
    # (and the decimals: "3.14159").
    return re.sub(
        r"(?<![.,])\d+",
        lambda m: _say_groups(_group_single(m.group(0)), lang) if len(m.group(0)) >= MIN_SINGLE_RUN else m.group(0),
        raw,
    )


def speak_digits(text: str, lang: str) -> str:
    """Rewrite phone numbers and long digit runs as digits spoken in groups.

    "Call 1 514 573 2324." -> "Call one, five one four, five seven three, two three two four."
    Short numbers ("74 Turgeon", "24 hours", "2026") are left for the TTS.
    """
    return _RUN.sub(lambda m: _rewrite_run(m.group(0), lang), text)


# What may still be the start of a number at the end of a streamed chunk.
_OPEN_TAIL = re.compile(rf"(?:\+|\(|\d|{_SEP})*$")


async def speak_digits_stream(text: AsyncIterable[str], lang: Callable[[], str]) -> AsyncIterator[str]:
    """speak_digits over streamed LLM text.

    A number can arrive split across chunks ("514 57" + "3 2324"), so anything
    at the end of the buffer that could still be part of a number is held back
    until the next chunk shows where it ends.
    """
    pending = ""
    async for chunk in text:
        pending += chunk
        cut = _OPEN_TAIL.search(pending).start()  # type: ignore[union-attr]
        if cut > 0:
            yield speak_digits(pending[:cut], lang())
            pending = pending[cut:]
    if pending:
        yield speak_digits(pending, lang())
