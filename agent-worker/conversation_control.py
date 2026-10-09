"""Conversation control for the receptionist: what the visitor's words mean for
how she talks, decided in code rather than by the LLM, plus the digit rewrite
her text goes through before the TTS.

    wants_pause(text)                 "stop talking", "tais-toi", "I'm talking to someone else"
    says_name(text, name)             her name (or "assistant") said while she is paused
    language_choice(text)             "English please" at the start: which language they chose
    language_switch(text, current)    "je veux parler en anglais" later: which language to switch to
    visitor_said_name(name, lines)    a visitor_name a tool is given is one the visitor actually said
    speak_digits(text, lang)          "514 573 2324" -> "five one four, five seven three, ..."

Everything here is pure (no LiveKit), so test_conversation_control.py checks it
offline. All matching runs on fold(): lowercase, accents stripped, apostrophes
straightened, because the STT is not consistent about any of those.
"""

import difflib
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


# Deepgram's live stream is poor at one lone word: in testing "Français." came
# back as "Franc", "Franck" or "france" (tagged English), "English." as
# "Engösch" (tagged German). One word alone that starts like a language name is
# taken as that answer.
_BARE_PREFIXES = {"fr": ("fran",), "en": ("eng", "ing", "angl")}


def language_choice(text: str) -> str | None:
    """'fr' / 'en' when the visitor's answer names a language, else None."""
    rest = [w for w in _words(text) if w not in _CHOICE_FILLERS]
    if len(rest) == 1:
        for lang, prefixes in _BARE_PREFIXES.items():
            if rest[0].startswith(prefixes):
                return lang
    return _requested(text, loose=True)


def language_switch(text: str, current: str, name: str = "") -> str | None:
    """The language the visitor explicitly asks to switch to, or None.

    Only a request counts: "can we speak French", "on peut revenir en
    anglais ?", "English please", or "I don't speak French" (the other one). A
    sentence that merely names a language does not: "is the app in French?",
    "mon collègue parle anglais", "a French restaurant". When both are named,
    the one they ask to speak wins: "Can we speak English? My French isn't
    great." `name`: hers, allowed right after the language ("English, Mia").
    """
    asked: set[str] = set()
    refused: set[str] = set()
    for clause in _CLAUSE.split(fold(text)):
        a, r = _clause_requests(_switch_tokens(clause), name)
        asked |= a
        refused |= r
    if len(asked) == 1:
        lang = next(iter(asked))
    elif not asked and len(refused) == 1:
        lang = _OTHER[next(iter(refused))]
    else:
        return None
    return lang if lang != current else None


# language_switch reads one clause at a time: a request is a verb of speaking
# whose complement is the language ("parler en anglais", "switch back to
# English"), said by the visitor (I, we, you, on...), not about someone else.
_CLAUSE = re.compile(r"[.!?;,:]+")
# Asking for a language: speak / switch / go back ... to it.
_SWITCH_VERBS = {
    "speak", "speaking", "talk", "talking", "switch", "switching", "change", "changing", "continue", "continuing",
    "answer", "reply", "respond", "go", "going", "come", "prefer", "repeat", "explain", "say", "use", "keep",
    "parler", "parle", "parles", "parlez", "parlons", "passer", "passe", "passez", "passons", "changer", "change",
    "changez", "changeons", "continuer", "continue", "continuez", "continuons", "repondre", "repondez", "reponds",
    "discuter", "discutons", "preferer", "prefere", "preferez", "preferons", "revenir", "reviens", "revient",
    "revenez", "revenons", "retourner", "retourne", "retournons", "retournez", "repeter", "repetez", "expliquer",
    "explique", "expliquez", "dire", "dites", "utiliser", "garder", "rester", "restons",
}
# Allowed between that verb and the language: "switch back to", "parler en",
# "passer à l'", "continue this in", "parlez-moi en".
_SWITCH_LINKS = {
    "in", "into", "to", "en", "au", "aux", "a", "the", "le", "la", "l'", "back", "over", "with", "me", "us", "avec",
    "moi", "nous", "it", "that", "this", "ca", "cela", "again", "only", "just", "juste", "seulement", "plutot",
    "rather", "please", "svp", "now", "maintenant", "on", "conversation", "discussion", "pas", "not", "bien",
}
# Who may be asking: the visitor, or "you" in "do you speak English?".
# Anyone else ("mon collègue parle anglais", "who knows French") is a mention.
_SELF = {
    "i", "i'm", "im", "i'd", "id", "i'll", "we", "we're", "we'd", "let's", "lets", "us", "you", "je", "j'",
    "on", "nous", "vous", "tu", "me", "m'", "moi",
}
# Skipped between the visitor and the verb: "could we please", "est-ce qu'on
# peut", "is it possible to", "would rather", "je voudrais".
_SWITCH_AUX = _FILLERS | {
    "can", "could", "would", "will", "shall", "should", "may", "might", "must", "do", "does", "did", "to",
    "like", "want", "wanna", "need", "rather", "better", "also", "maybe", "perhaps", "possible", "is", "it",
    "it's", "be", "able", "let", "instead", "actually", "so", "well", "hmm", "hm", "and", "but", "then", "there",
    "any", "way", "if", "veux", "voudrais", "voudrait", "voulez", "voulons", "peux", "peut", "pouvez",
    "pouvons", "pourrait", "pourrions", "pourriez", "pourrais", "aimerais", "aimerait", "aimerions",
    "preferais", "prefererais", "faut", "est", "ce", "c'", "qu'", "que", "de", "d'", "possible", "aussi",
    "plutot", "encore", "si", "serait", "va", "allons", "aller", "doit", "devrait", "etre", "bien", "ne",
    "n'", "pas", "not", "don't", "dont", "can't", "cant", "cannot", "won't", "doesn't", "didn't", "please",
} | _SWITCH_VERBS
_NOT = {"not", "don't", "dont", "doesn't", "can't", "cant", "cannot", "won't", "isn't", "aren't", "never", "ne", "n'", "pas", "jamais"}
# "My French isn't great", "mon anglais est mauvais".
_POOR = {"bad", "poor", "terrible", "rusty", "limited", "weak", "mauvais", "nul", "faible", "rouille"}
# What may follow a language word that is asked for. Anything else after an
# English-form word makes it an adjective: "French restaurant", "French cooking".
_SWITCH_AFTER = _SWITCH_LINKS | _FILLERS | {
    "please", "pls", "instead", "for", "from", "if", "then", "so", "because", "too", "as", "than", "maybe",
    "today", "here", "all", "everyone", "is", "well", "fluently", "better", "bit", "little", "also", "and",
    "or", "but", "s'", "il", "plait", "merci", "si", "pour", "et", "ou", "mais", "de", "d'", "alors", "aussi",
    "language", "langue", "assistant", "assistante", "was", "isn't", "wasn't",
} | _NOT


def _switch_tokens(clause: str) -> list[str]:
    """Words of a folded clause, French elisions and hyphens split off:
    "passer à l'anglais" -> passer, a, l', anglais; "pouvez-vous" -> pouvez, vous."""
    out: list[str] = []
    for w in re.findall(r"[a-z0-9]+(?:'[a-z0-9]+)*", clause.replace("-", " ")):
        m = re.match(r"^(l|d|j|qu|c|s|n|m|t)'(.+)$", w)
        out += [m.group(1) + "'", m.group(2)] if m else [w]
    # "est-il possible de...": inverted, "il" is nobody.
    return [w for i, w in enumerate(out) if not (w == "il" and i and out[i - 1] in {"est", "faut", "peut"})]


def _lang_of(word: str) -> str | None:
    return next((lang for lang, names in _LANG_WORDS.items() if word in names), None)


def _clause_requests(words: list[str], name: str) -> tuple[set[str], set[str]]:
    """(languages asked for, languages the visitor says they don't speak) in one clause."""
    asked: set[str] = set()
    refused: set[str] = set()
    rest = [w for w in words if w not in _CHOICE_FILLERS and w not in {"plutot", "rather", "instead", "back"}]
    if rest and len({_lang_of(w) for w in rest}) == 1 and all(_lang_of(w) for w in rest):
        return {_lang_of(rest[0])}, set()  # "English, please", "en français svp"
    after_ok = _SWITCH_AFTER | ({fold(name)} if name else set())
    # "Can't we speak French?", "why don't we...": a request, not a refusal.
    negated = any(w in _NOT for w in words) and not {"why", "pourquoi"} & set(words) and not any(
        w in _NOT and i + 1 < len(words) and words[i + 1] in {"we", "you", "on", "nous", "vous"}
        for i, w in enumerate(words)
    )
    for k, w in enumerate(words):
        lang = _lang_of(w)
        if lang is None:
            continue
        if w in {"english", "french"} and k + 1 < len(words) and words[k + 1] not in after_ok:
            continue  # an adjective: "a French restaurant"
        not_before = negated and any(x in _NOT for x in words[:k])
        verb = _switch_verb(words, k)
        if verb is not None:
            if _said_by_visitor(words, verb):
                (refused if not_before else asked).add(lang)
            continue
        mine = k and words[k - 1] in {"my", "mon", "our", "notre"}
        if mine and (negated or any(x in _POOR for x in words[k:])):
            refused.add(lang)  # "my French isn't great"
        elif not_before and _said_by_visitor(words, next(i for i, x in enumerate(words) if x in _NOT)):
            refused.add(lang)  # "I don't understand French well"
    return asked, refused


def _switch_verb(words: list[str], k: int) -> int | None:
    """Index of the speaking verb whose complement is the language at `k`."""
    for v in range(k - 1, max(-1, k - 6), -1):
        if words[v] in _SWITCH_VERBS:
            return v
        if words[v] not in _SWITCH_LINKS:
            return None
    return None


def _said_by_visitor(words: list[str], at: int) -> bool:
    """True when what is at `at` is said by the visitor about themselves (or
    asked of her): the nearest word before it, past "can", "would like to"
    and the like, is I / we / you / on..., or nothing (an imperative)."""
    for w in reversed(words[:at]):
        if w in _SELF:
            return True
        if w not in _SWITCH_AUX:
            return False
    return True


# ---------------------------------------------------------------------------
# The visitor's name, as a tool is given it: it must be one the visitor said
# ---------------------------------------------------------------------------

# Dropped before matching: "Mr. Chen" is Chen.
_TITLES = {"mr", "mrs", "ms", "miss", "mister", "dr", "m", "mme", "mlle", "monsieur", "madame", "mademoiselle"}
# Not a name, whatever the visitor said: what Gemini wrote for a visitor who
# hadn't given one ("Hi, I'm here to see Alex" -> visitor_name="there").
NOT_A_NAME = {
    "there", "here", "hi", "hello", "hey", "bonjour", "bonsoir", "salut", "allo", "sir", "madam", "you", "vous",
    "me", "moi", "i", "je", "friend", "ami", "amie", "dear", "everyone", "guys", "yes", "no", "oui", "non", "ok",
    "okay", "thanks", "merci", "please", "good", "morning", "afternoon", "evening", "welcome", "name", "nom",
    "visitor", "visiteur", "visiteuse", "guest", "invite", "unknown", "inconnu", "inconnue", "someone",
    "somebody", "quelqu'un", "anonymous", "anonyme", "client", "cliente", "user", "assistant", "assistante",
    "receptionist", "receptionniste", "na", "none", "aucun",
}
# Close enough to a word the visitor said: STT and Gemini spell names freely
# (Marc / Mark, Sean / Shawn, Chloé / Chloe).
NAME_MATCH_RATIO = 0.75


def _name_words(text: str) -> list[str]:
    return re.findall(r"[a-z0-9]+", fold(text).replace("'", " "))


def visitor_said_name(name: str, visitor_lines: list[str], assistant_name: str = "") -> bool:
    """True when `name` is a real name the visitor gave in this conversation.

    Every word of it (titles aside) must be one the visitor said, give or take
    case, accents and spelling, and none may be a greeting or a placeholder
    ("there", "sir", "the visitor"). Spelled-out letters count too: "C H E N".
    """
    words = [w for w in _name_words(name) if w not in _TITLES]
    if not words or any(w in NOT_A_NAME or w == fold(assistant_name) for w in words):
        return False
    heard: set[str] = set()
    for line in visitor_lines:
        said = _name_words(line)
        heard.update(said)
        heard.update(a + b for a, b in zip(said, said[1:]))  # "Le Blanc" for "Leblanc"
        letters = ""
        for w in said + [""]:
            if len(w) == 1:
                letters += w
            else:
                if len(letters) > 1:
                    heard.add(letters)  # "C H E N" for "Chen"
                letters = ""
    return all(
        w in heard
        or (len(w) > 2 and any(difflib.SequenceMatcher(None, w, h).ratio() >= NAME_MATCH_RATIO for h in heard))
        for w in words
    )


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
