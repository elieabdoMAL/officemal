"""Simli Trinity receptionist — self-hosted LiveKit Agents worker.

This is the conversation loop for the lobby kiosk avatar. Simli's hosted "Auto"
API only drives Legacy faces; Trinity faces (like Mia / face 3d1cf1cf) must be
rendered through a self-hosted LiveKit worker — this file. It joins the same
LiveKit room the browser joins and runs:

    Deepgram STT  ->  Gemini 2.5 Flash (LLM)  ->  Deepgram TTS  ->  Simli avatar

(or ElevenLabs TTS, with TTS_PROVIDER=elevenlabs). The Simli plugin renders the
Trinity face lip-synced to the TTS audio and publishes the video+audio into the
room; the browser subscribes to it.

She is bilingual (FR/EN): she greets in both and asks which one, then locks the
conversation to the visitor's choice — the STT listens in that language only,
the Aura voice matches it (ElevenLabs keeps one multilingual voice for both),
and Gemini is told every turn to reply in it — until the visitor explicitly
asks to switch. "Stop talking" pauses her until her name is said. What the
visitor's words mean for this is decided in conversation_control.py.

She also drives the kiosk screen (docs/screen-protocol.md, screen_cards.py):
cards on "mia.screen" (contact details, "sent" confirmations, the project
request form) and taps back on "mia.control". Suggestions and project requests
(leads.py) go to the team's general inbox. She can call a team member by
video: the call opens on the kiosk screen, and her session ends once they
join (staff_call.py).

Run:
    python worker.py dev      # local dev + hot reload (test via LiveKit Sandbox)
    python worker.py start    # production (under systemd on the server)

Env (see env.example): SIMLI_API_KEY, SIMLI_FACE_ID, GOOGLE_API_KEY,
DEEPGRAM_API_KEY, LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET.
Optional: ASSISTANT_NAME, SESSION_IDLE_TIMEOUT, SESSION_MAX_LENGTH,
PAUSE_TIMEOUT, LIVEKIT_AGENT_NAME, TTS_PROVIDER, ELEVENLABS_API_KEY,
ELEVENLABS_VOICE_ID, ELEVENLABS_MODEL, SITE_URL, CALL_ANSWER_TIMEOUT.
The LIVEKIT_* vars are read automatically by the agents framework.
"""

import asyncio
import contextlib
import functools
import json
import logging
import os
import re
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv
from livekit.agents import (
    Agent,
    AgentSession,
    JobContext,
    RunContext,
    StopResponse,
    WorkerOptions,
    cli,
    function_tool,
)
from livekit.agents.llm import ChatChunk, FallbackAdapter
from livekit.agents.stt import SpeechEventType
from livekit.plugins import deepgram, google, simli

from conversation_control import (
    fold,
    language_choice,
    language_switch,
    only_name,
    says_name,
    speak_digits_stream,
    visitor_said_name,
    wants_pause,
)
from leads import (
    SentLog,
    clean_project_fields,
    missing_project_fields,
    project_fields_prompt,
    project_request_schema,
    project_screen_fields,
    send_project_request_email,
    send_suggestion_email,
)
from screen_cards import (
    DRAFT_CARD_S,
    SENT_CARD_S,
    TOPIC_CONTROL,
    TOPIC_SCREEN,
    contact_card,
    gives_contact_details,
    message_sent,
    project_request,
)
from staff_call import (
    AFTER_CALL_S,
    ANSWERED,
    CALL_ANSWER_TIMEOUT,
    CALL_ANSWERED,
    CALL_CLOSE,
    CALL_POLL_S,
    GONE,
    MAX_CALLS_PER_SESSION,
    call_open_message,
)
from staff_call import open_call as start_staff_call
from team_messages import (
    _norm,
    find_member,
    is_real_name,
    load_team,
    send_emergency_email,
    send_message_email,
    send_visitor_waiting_email,
    team_prompt_section,
)

logger = logging.getLogger("simli-receptionist")
logger.setLevel(logging.INFO)

load_dotenv(override=True)

# Her name, in one place: the prompt's {ASSISTANT_NAME}, the "say my name" line
# when she pauses, the name that wakes her, and the screen (mia.name). The boss
# may rename her (e.g. ASSISTANT_NAME=Linda); nothing else needs to change.
ASSISTANT_NAME = os.environ.get("ASSISTANT_NAME", "").strip() or "Mia"

# She opens in both languages and asks which one; the visitor's answer locks
# the conversation to it (MiaAgent._language_note). The prompt quotes this line
# as {FIRST_MESSAGE}, so it knows the question has been asked.
FIRST_MESSAGE = "Bonjour, hello! Français ou English?"

# Mia's persona, rules and company knowledge. The worker is the only place her
# prompt lives: Simli just renders the face, so a prompt saved in the Simli
# dashboard is never used. Kept in its own file so it can be edited without
# touching code (still needs an image rebuild + push to go live). Features she
# can't do yet are listed there under COMING SOON — see docs/mia-tasks.md.
PROMPT_FILE = Path(__file__).with_name("mia_prompt.txt")
# The TEAM section is generated from team.json, so the people she names and the
# people take_message / notify_member accept can never drift apart.
TEAM = load_team()


def load_prompt() -> str:
    """mia_prompt.txt with its placeholders filled. str.replace, not format():
    the prompt may contain braces of its own."""
    text = PROMPT_FILE.read_text(encoding="utf-8").strip()
    return (
        text.replace("{ASSISTANT_NAME}", ASSISTANT_NAME)
        .replace("{FIRST_MESSAGE}", FIRST_MESSAGE)
        .replace("{PROJECT_FIELDS}", project_fields_prompt())
    )


MIA_SYSTEM_PROMPT = load_prompt() + "\n\n" + team_prompt_section(TEAM)

# Per conversation. A kiosk is open to anyone; this stops someone filling the
# team's inboxes from it.
MAX_MESSAGES_PER_SESSION = 3
# One visitor sees one or two people; more than this is someone playing.
MAX_NOTIFICATIONS_PER_SESSION = 3
# Emails the whole team. A second alert allows for "it's getting worse"; past
# that it's a prank or a loop, and the visitor has already been told 911.
MAX_EMERGENCY_ALERTS_PER_SESSION = 2
# Both go to the general inbox. A second allows for a correction after sending.
MAX_SUGGESTIONS_PER_SESSION = 2
MAX_PROJECT_REQUESTS_PER_SESSION = 2

# The general inbox (info@, team.json), where suggestions and project requests go.
INBOX = next((m for m in TEAM if m.inbox), None)

# One Aura voice speaks one language, so we swap the TTS model per turn to match
# whatever Deepgram detected. andromeda-en is the plugin's own default — keeping
# it means her English is unchanged by all this. The French voices are fr-FR
# only; Aura has no fr-CA, so expect a France accent rather than a Québec one.
VOICE_BY_LANG = {"fr": "aura-2-agathe-fr", "en": "aura-2-andromeda-en"}
# Words the French Aura voice can't say, respelled for it (audio only).
FRENCH_VOICE_RESPELL = re.compile(r"\bEnglish\b")
# A reply that opens with a one-word sentence, then more ("Goodbye! Have a
# great day!"), and one that is a single word so far (MiaAgent._join_one_word_opening).
ONE_WORD_OPENING = re.compile(r"\s*([^\s.!?,;:]+)([.!]+)(?=\s+\S)")
ONE_WORD_SO_FAR = re.compile(r"\s*[^\s.!?,;:]*[.!]*\s*$")

# Voice for the bilingual greeting and anything said before the visitor has
# chosen: the French voice says "hello" well enough (and "English" respelled,
# FRENCH_VOICE_RESPELL); the English one mangles "Français".
DEFAULT_LANG = "fr"

# Deepgram language once the visitor has chosen. A single-language model is
# more accurate than "multi" (which also misreads English as French now and
# then, the "she mixes English" complaint), and can't flip the conversation.
# fr-CA: this is a Québec lobby.
STT_LANGUAGE = {"fr": "fr-CA", "en": "en"}
STT_MULTI = "multi"

# Words Deepgram should expect (keyterm prompting, nova-3). Without them, in
# testing, "Mia, vous êtes là?" came back as "Vous êtes là?" and "Tais-toi" as
# "Qu'est-toi". The language names let a locked STT still catch "French
# please" said in English, and the reverse.
STT_KEYTERMS = [ASSISTANT_NAME, "assistante", "tais-toi", "English", "anglais", "French", "français"]

# A French-locked STT still writes out English, roughly; an English-locked one
# returns nothing at all for French. So when speech produces no transcript this
# many times in a row, she goes back to listening in both languages (her reply
# language stays locked) until a turn is understood — enough for a French
# visitor to be heard asking "en français, s'il vous plaît". Once: at 2, in
# the voice tests, "Est-ce qu'on peut parler français ?" had to be said three
# times before it was heard (2026-10-09).
UNHEARD_BEFORE_WIDENING = 1
# How long after the visitor stops speaking a transcript may still arrive.
UNHEARD_AFTER_S = 2.5

# Optional ElevenLabs voice instead of Aura: TTS_PROVIDER=elevenlabs plus an
# ELEVENLABS_API_KEY. One multilingual ElevenLabs voice speaks both languages,
# so there is no voice swap; with the v2.5 models we only tell it which language
# is coming. Anything else (unset, unknown, no key) keeps Deepgram as before.
ARIA_VOICE_ID = "9BWtsMINqrJLrRacOk9x"  # ElevenLabs' premade "Aria"
ELEVENLABS_API_KEY = (
    os.environ.get("ELEVENLABS_API_KEY", "").strip() or os.environ.get("ELEVEN_API_KEY", "").strip()
)
ELEVENLABS_VOICE_ID = os.environ.get("ELEVENLABS_VOICE_ID", "").strip() or ARIA_VOICE_ID
# flash_v2_5: ElevenLabs' lowest-latency multilingual model (French included).
ELEVENLABS_MODEL = os.environ.get("ELEVENLABS_MODEL", "").strip() or "eleven_flash_v2_5"
# Models that take a language_code; ElevenLabs doesn't support it on multilingual_v2.
ELEVENLABS_LANGUAGE_MODELS = {"eleven_flash_v2_5", "eleven_turbo_v2_5"}


def _tts_provider() -> str:
    wanted = os.environ.get("TTS_PROVIDER", "").strip().lower() or "deepgram"
    if wanted == "elevenlabs":
        if ELEVENLABS_API_KEY:
            return "elevenlabs"
        logger.error("TTS_PROVIDER=elevenlabs but ELEVENLABS_API_KEY is not set: using Deepgram Aura")
    elif wanted != "deepgram":
        logger.warning("TTS_PROVIDER=%r is not deepgram or elevenlabs: using Deepgram Aura", wanted)
    return "deepgram"


TTS_PROVIDER = _tts_provider()
if TTS_PROVIDER == "elevenlabs":
    # Imported here, not with the other plugins, so the Deepgram path never
    # needs it. LiveKit plugins must be imported on the main thread, at load.
    from livekit.plugins import elevenlabs


# Her brain. gemini-3.1-flash-lite: the fastest first word with her full prompt
# (~0.8s) and Google's cheapest model. Each Gemini model has its own free-tier
# allowance, so when one runs out (429, as gemini-2.5-flash did on 2026-10-09
# after heavy testing) the FallbackAdapter moves to the next instead of
# leaving her silent. Both are overridable without a rebuild.
LLM_MODEL = os.environ.get("LLM_MODEL", "").strip() or "gemini-3.1-flash-lite"
LLM_FALLBACK_MODELS = [
    m.strip()
    for m in (os.environ.get("LLM_FALLBACK_MODELS", "").strip() or "gemini-3.5-flash").split(",")
    if m.strip() and m.strip() != LLM_MODEL
]


def _gemini(model: str) -> google.LLM:
    # Thinking at its minimum: it only delays the first word. Gemini 3 models
    # take a thinking_level, 2.5 and earlier a thinking_budget.
    if model.startswith("gemini-3"):
        return google.LLM(model=model, thinking_config={"thinking_level": "minimal"})
    return google.LLM(model=model, thinking_config={"thinking_budget": 0})


def make_llm():
    """Linda's LLM: LLM_MODEL, falling back to LLM_FALLBACK_MODELS on errors."""
    models = [LLM_MODEL, *LLM_FALLBACK_MODELS]
    logger.info("LLM: %s", " -> ".join(models))
    if len(models) == 1:
        return _gemini(models[0])
    # attempt_timeout is also sent to Gemini as the request deadline, and
    # Gemini rejects anything under 10s (400 INVALID_ARGUMENT).
    return FallbackAdapter([_gemini(m) for m in models], attempt_timeout=10.0)


def make_tts():
    """The TTS for one session, set up for DEFAULT_LANG (the greeting)."""
    if TTS_PROVIDER != "elevenlabs":
        return deepgram.TTS(model=VOICE_BY_LANG[DEFAULT_LANG])
    logger.info("TTS: ElevenLabs %s, voice %s", ELEVENLABS_MODEL, ELEVENLABS_VOICE_ID)
    extra = {"language": DEFAULT_LANG} if ELEVENLABS_MODEL in ELEVENLABS_LANGUAGE_MODELS else {}
    return elevenlabs.TTS(
        api_key=ELEVENLABS_API_KEY,
        voice_id=ELEVENLABS_VOICE_ID,
        model=ELEVENLABS_MODEL,
        **extra,
    )


# She now listens continuously (the browser leaves the mic open), so the room's
# background noise reaches Deepgram all day. Rather than let Gemini improvise on
# a garbled transcript, bounce anything too weak to act on — in the language she
# just heard, so the apology doesn't arrive in the wrong one.
DIDNT_GET_THAT = {
    "en": "I'm sorry, I didn't get that.",
    "fr": "Désolée, je n'ai pas compris.",
}

# Deepgram's per-utterance confidence, 0..1. Below this we assume the audio was
# noise or half a word. Multilingual STT scores lower than the English-only
# models did, hence 0.5 rather than 0.6 — watch the logged values in
# `docker compose logs -f` and retune.
MIN_STT_CONFIDENCE = 0.5

# Sub-threshold transcripts are usually 1-2 stray characters or a lone filler.
MIN_TRANSCRIPT_CHARS = 3
FILLER_ONLY = {"uh", "um", "hmm", "mhm", "ah", "eh", "oh", "hm", "huh"}

# Before the visitor has chosen a language, "I didn't get that" would have to
# guess one, so she asks the question again instead. Also said, once, when
# speech gives no transcript at all: Deepgram's live stream can return nothing
# for a lone "Français.", the likeliest answer to her greeting.
ASK_LANGUAGE_AGAIN = "Pardon? Français ou English?"

# Said once, by the worker, when the visitor asks her to stop talking (#24,
# #25). Then she ignores everything until her name is said.
PAUSE_LINE = {
    "en": f"No problem, I'll stop talking. If you want to talk to me, just say my name, {ASSISTANT_NAME}.",
    "fr": f"Pas de problème, j'arrête de parler. Si vous voulez me parler, dites simplement mon nom, {ASSISTANT_NAME}.",
}


def _env_int(name: str, default: int) -> int:
    """Read an int from env, ignoring blanks and junk rather than crashing."""
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        logger.warning("%s=%r is not an integer, using %s", name, raw, default)
        return default


# Session limits. LiveKit, Simli, Deepgram and Gemini all bill while a session
# is open, so every session must end on its own — the kiosk is never closed.
#
# SESSION_IDLE_TIMEOUT: nobody has spoken (visitor or Mia) for this long, so the
#   lobby is empty. 2 minutes keeps her through someone reading the panorama.
# SESSION_MAX_LENGTH: hard cap on one conversation, however lively. A lobby
#   chat rarely passes a few minutes; this stops a wedged or looping session.
#
# Either way — or when she ends it herself on goodbye (end_conversation) — the
# worker deletes the room, which disconnects the kiosk; the kiosk then hides
# her until the next visitor taps the AI button.
SESSION_IDLE_TIMEOUT = _env_int("SESSION_IDLE_TIMEOUT", 120)
SESSION_MAX_LENGTH = _env_int("SESSION_MAX_LENGTH", 600)
# PAUSE_TIMEOUT: paused ("stop talking") and not called back by name for this
#   long, the session ends, quietly — she said she'd stop talking. Speech she
#   ignores while paused doesn't count as activity: two people chatting next to
#   her would otherwise keep a paused session (and its bill) open to the cap.
PAUSE_TIMEOUT = _env_int("PAUSE_TIMEOUT", SESSION_IDLE_TIMEOUT)

# A video call to staff (#22, staff_call.py) that rings near the max length
# holds the session until it is answered (her session ends) or not; then the
# visitor still gets AFTER_CALL_S to leave a message. Never more than this
# past SESSION_MAX_LENGTH in all.
CALL_STRETCH_MAX = CALL_ANSWER_TIMEOUT + AFTER_CALL_S

# Simli's own limits, kept 30s behind ours as a backstop: if this worker ever
# fails to end a session, Simli still stops rendering (and billing) by itself.
# She is silent while a call rings, which Simli counts as idle.
MAX_IDLE_TIME = _env_int("SIMLI_MAX_IDLE_TIME", max(SESSION_IDLE_TIMEOUT, CALL_ANSWER_TIMEOUT) + 30)
MAX_SESSION_LENGTH = _env_int("SIMLI_MAX_SESSION_LENGTH", SESSION_MAX_LENGTH + CALL_STRETCH_MAX + 30)

# Said when the hard cap ends a conversation mid-flow, so she doesn't just vanish.
GOODBYE = {
    "en": "I have to go now. Tap the AI button any time to talk again. Goodbye!",
    "fr": "Je dois vous laisser. Touchez le bouton IA pour me reparler. Au revoir!",
}

# How long to keep the room open after her goodbye is reported "done", so the
# kiosk actually hears it. With the Simli avatar, "done" is not "heard": her
# audio goes to Simli, which plays it into the room itself, and the playout
# count the framework waits on can be thrown off by an earlier interruption (a
# clear-buffer whose playback-finished never came is marked done after 2 s, and
# Simli's late event then "finishes" the next segment early). Even without one,
# "done" doesn't track the kiosk: measured 2026-10-09, the room (LiveKit's
# active speakers) starts hearing her 1.6-2.9 s after her "speaking" state,
# and "done" fired from ~1 s to 3.3 s after it. A lone "Goodbye!" with 2 s of
# grace after "done" was cut off at "Good…" 3 times in 3, and a 47-character
# one held 4.4 s at "Goodbye for [now]". So the room is held until the goodbye
# has had time to play, counted from when she started saying it, plus the
# avatar pipeline, and never less than GOODBYE_GRACE_MIN_S after "done"; then,
# if the room still hears her, until she has been silent there for
# GOODBYE_QUIET_S (let_goodbye_play). Aura speaks ~14-15 characters a second;
# the max keeps a rambling goodbye from holding the room open.
GOODBYE_CHARS_PER_SEC = 14.0
AVATAR_PIPELINE_S = 3.0
GOODBYE_GRACE_MIN_S = 5.0
GOODBYE_GRACE_MAX_S = 10.0
# Silence in the room that ends a goodbye: longer than the pause between two
# of her sentences, during which the room "no longer hears" her for ~0.4 s.
GOODBYE_QUIET_S = 1.0
# After the grace, wait at most this much more for the room to stop hearing her.
GOODBYE_OVERRUN_MAX_S = 6.0


def goodbye_grace(text: str, done_at: float, started_at: float | None = None) -> float:
    """Seconds to hold the room open from `done_at` (monotonic) for a goodbye
    of `text`, reported done then, whose audio started at `started_at`."""
    start = done_at if started_at is None else min(started_at, done_at)
    heard_by = start + len(text.strip()) / GOODBYE_CHARS_PER_SEC + AVATAR_PIPELINE_S
    return min(max(heard_by - done_at, GOODBYE_GRACE_MIN_S), GOODBYE_GRACE_MAX_S)


# A goodbye said in the same reply as a send ("Yes, perfect, thanks, bye!"):
# the session ends only if the visitor says nothing for this long after her
# reply, so they hear the confirmation and can still correct it.
END_AFTER_SEND_S = 6.0

# Explicit dispatch: the worker joins only rooms whose token asks for this agent
# by name (see /api/livekit/token), never every room on the LiveKit project.
# The project is shared with expo360, whose rooms she must stay out of.
# Must match LIVEKIT_AGENT_NAME on Vercel (same default on both sides).
AGENT_NAME = os.environ.get("LIVEKIT_AGENT_NAME", "").strip() or "officemal-mia"


def _normalize_lang(code: str | None) -> str:
    """'fr-CA' -> 'fr'. Anything we have no voice for falls back to English."""
    if not code:
        return DEFAULT_LANG
    short = code.split("-")[0].lower()
    return short if short in VOICE_BY_LANG else "en"


LANGUAGE_NAMES = {"fr": "French", "en": "English"}

# Per-turn instructions to Gemini (added to that turn only, never saved). The
# prompt's LANGUAGE and PAUSING sections describe them.
CHOSEN_NOTE = (
    "The visitor chose {name} for this conversation. Reply only in {name} from now on. "
    "If they only named the language, say in a few words that you will continue in {name} "
    "and ask how you can help."
)
LOCKED_NOTE = (
    "The conversation language is {name}. Reply only in {name}, even if the visitor's words "
    "look like another language. It changes only when the system tells you the visitor asked."
)
SWITCHED_NOTE = (
    "The visitor asked to switch to {name}. Reply only in {name} from now on: confirm the "
    "switch in a few words, then answer anything else they asked."
)
# After a pause, by whether the visitor only called her ("Mia?") or called her
# with a request ("Mia, what's your number?"): Gemini, told "if they only said
# your name", answered the request with "I'm listening" in testing.
WOKEN_NOTE = (
    "You were paused and the visitor just called you back by name; you heard nothing in "
    "between. Say in a few words that you are listening and ask how you can help."
)
WOKEN_ASKING_NOTE = (
    "You were paused and the visitor just called you back by name; you heard nothing in "
    "between. Answer what they are asking now, directly: do not say that you are listening."
)
# Tapping the "say my name" banner on the screen does what her name does
# ("resume" on mia.control, docs/screen-protocol.md).
TAPPED_NOTE = (
    "You were paused and the visitor just tapped the screen to call you back; you heard nothing "
    "in between. Say in a few words that you are listening and ask how you can help."
)

# Said when the visitor taps the "say my name or tap to talk" hint while she
# waits ("wake" on mia.control). Before the language is chosen, in both.
WAKE_LINE = {
    "en": "Yes? How can I help?",
    "fr": "Oui ? Comment puis-je vous aider ?",
}
WAKE_LINE_BOTH = "Oui? Yes? Français ou English?"

# Video call to staff (#22, staff_call.py). Said by the worker, not Gemini:
# the same words every time, and only once the invitation is really out.
CALLING_LINE = {
    "en": "I'm calling {first} now — please hold on a moment.",
    "fr": "J'appelle {first} maintenant — un petit moment, s'il vous plaît.",
}
NO_ANSWER_NOTE = (
    "System: {name} did not join the video call: nobody answered within {wait}. Tell the visitor, in "
    "one or two short sentences, that {first} is not available right now, and offer to take a message "
    "for {first}. If they want one, follow TAKING A MESSAGE. Do not call call_staff again unless the "
    "visitor asks you to try again."
)
CANCELLED_NOTE = (
    "System: the visitor cancelled the video call to {name} on the screen before {first} joined. Say, in "
    "one or two short sentences, that no problem, and offer to take a message for {first}. If they want "
    "one, follow TAKING A MESSAGE. Do not call call_staff again unless the visitor asks you to call again."
)
NO_ANSWER_PAUSED_NOTE = (
    "While you were paused, the video call to {name} went unanswered: {first} did not join. "
    "If the visitor asks, offer to take a message for {first}."
)

# "I've let Alexandre know you're here" with no notify_member call: a lie to
# the visitor. Gemini did it now and then (the base branch, every time, on
# "J'ai rendez-vous avec Alexandre. Je suis Lucie Bouchard."), so the worker
# checks what she said and has her make it true (or take it back) at once.
NOTIFY_CLAIM = re.compile(
    r"\bI(?:'ve| have) (?:let (?!you\b)\w+ know|notified|informed)\b"
    r"|\bI(?:'m| am) (?:letting (?!you\b)\w+ know|notifying|informing)\b"
    r"|\bj'ai (?:prévenu|informé|avisé)\b"
    r"|\bje (?:préviens|vais prévenir|l'informe|vais l'informer|l'avise)\b",
    re.IGNORECASE,
)
NOTIFY_CLAIM_NOTE = (
    "System check: in your last reply you told the visitor you let someone know they are here, "
    "but notify_member was not called, so nobody was told. If you have the visitor's name and "
    "know who they came to see, call notify_member now, then confirm it as its answer says. "
    "Otherwise say in a few words that you have not told anyone yet, and ask for what is missing."
)

# "Please check your request on the screen" before show_project_request has
# answered SHOWN: the screen shows nothing (test_leads, FR, now and then).
# Such sentences are dropped before anyone hears them (MiaAgent.llm_node);
# she is then asked to show it, or to ask for what is missing.
SCREEN_WORDS = re.compile(r"\b(screen|ecran)\b")
DRAFT_WORDS = re.compile(
    r"\b(request|demande|draft|brouillon|form|formulaire|summary|resume|recapitulatif|project|projet|"
    r"everything|tout|correct|exact|accurate|check|verify|verifier|verifiez|show|display|afficher|affiche|"
    r"affichee|affichees|affiches|details?|informations?)\b"
)
# The screen's other uses: the contact card (whenever she gives the office's
# details), the "sent" cards, and Infini View, which is moved around by touch.
NOT_DRAFT_WORDS = re.compile(
    r"\b(contact|coordonnees|phone|telephone|number|numero|email|courriel|address|adresse|website|site|"
    r"sent|envoye|envoyee|message|confirmation|touch|touching|tap|pan|panning|slide|sliding|swipe|drag|"
    r"toucher|touchez|glisser|glissez|appuyer|appuyez)\b"
)
STILL_HERE_NOTE = (
    "The conversation has not ended: after your goodbye, the visitor said something more. "
    "Answer them as usual."
)
SCREEN_CLAIM_NOTE = (
    "System check: you were about to tell the visitor to check their project request on the screen, "
    "but it is not on the screen: show_project_request has not answered SHOWN. The visitor heard "
    "nothing of it. Call show_project_request now with everything the visitor told you. If it answers "
    "NOT SHOWN, ask for what is missing, in one short question, without mentioning the screen."
)
# Her sentences, for that check: a sentence ends at . ! ? or a line break.
SENTENCE_END = re.compile(r"(?<=[.!?…])\s+|\n+")


def sends_email(tool):
    """Marks a tool that emails someone (take_message, notify_member, ...): a
    goodbye in the same reply then doesn't end the session at once
    (end_conversation, END_AFTER_SEND_S). Goes under @function_tool."""

    @functools.wraps(tool)
    async def wrapper(self: "MiaAgent", *args, **kwargs):
        self._send_turn = self._visitor_turns
        return await tool(self, *args, **kwargs)

    return wrapper


# Her answer when a tool refuses a repeat send (leads.SentLog).
ALREADY_SENT = (
    "NOT SENT AGAIN: {what} was already sent to {to} in this conversation. Tell the visitor it is "
    "already sent. Send it again only if they clearly ask you to send it again."
)

# Her answer when a tool is given a visitor name the visitor never said
# (MiaAgent._visitor_named): "Hi, I'm here to see Alex" -> visitor_name="there".
NOT_THEIR_NAME = (
    "NOT SENT: {name!r} is not a name the visitor has told you in this conversation, so you do not "
    "have their name yet. Ask for it in one short question, then call this again with the name they say."
)


def _assistant_texts(handle) -> list[str]:
    """What she has said so far in this turn (one entry per LLM step)."""
    return [
        item.text_content
        for item in handle.chat_items
        if getattr(item, "type", "") == "message" and item.role == "assistant" and item.text_content
    ]


def _assistant_lines(handle) -> int:
    """How many things she has said so far in this turn (one per LLM step)."""
    return len(_assistant_texts(handle))


def _reply_language_note(code: str) -> str:
    """Per-turn instruction telling Gemini which language to answer in."""
    if code in LANGUAGE_NAMES:
        return LOCKED_NOTE.format(name=LANGUAGE_NAMES[code])
    return (
        f"The visitor just spoke a language other than French or English "
        f"(language code {code}). Follow the LANGUAGE rule: say in English that "
        f"you can continue in French or English, and ask which they prefer."
    )


@dataclass
class TurnPlan:
    """What to do with one visitor turn (MiaAgent._plan_turn).

    note: reply through Gemini, with this system note for the turn.
    say: say this line instead, without Gemini.
    Neither: ignore the turn (she is paused).
    """

    note: str = ""
    say: str = ""


class MiaAgent(Agent):
    """Mia: bilingual, pausable, and unwilling to answer transcripts she can't trust.

    Every visitor turn goes through `_plan_turn`, in code, before Gemini sees it:
      * paused: ignored entirely (no reply, no LLM call) unless it has her name.
      * "stop talking" and friends: she pauses and says PAUSE_LINE.
      * low confidence or too short: "sorry, I didn't get that", no LLM call.
      * otherwise Gemini replies, told which language to use (`_language_note`).

    Language: the first real answer to her "Français ou English?" locks the
    conversation, STT and voice included; after that only an explicit request
    ("can we speak French") switches it. Per-turn auto-switching on Deepgram's
    language guess is gone: it misfired on short or accented English.

    `stt_node` is the one place Deepgram's per-alternative metadata is still
    attached to the event: `confidence` gates the turn (the transcript is
    checked too, because confidence reads high on a clean recording of someone
    clearing their throat) and `language` is what Deepgram heard while the STT
    still runs "multi" (before the choice, or widened, see UNHEARD_*).
    """

    def __init__(
        self,
        tts,
        stt=None,
        on_goodbye: Callable[[str, float], None] | None = None,
        on_status: Callable[[], None] | None = None,
        on_screen: Callable[[dict], None] | None = None,
        on_call_answered: Callable[[], None] | None = None,
    ) -> None:
        # tts: deepgram.TTS or elevenlabs.TTS, see make_tts
        # stt: the session's deepgram.STT, so the language lock can retune it
        super().__init__(instructions=MIA_SYSTEM_PROMPT)
        # Ends the session the way the idle limit does (entrypoint's
        # end_session). end_conversation calls it once her goodbye is reported
        # played, with the words she said and when (time.monotonic()), so the
        # room is held open long enough for them to actually reach the kiosk
        # (see goodbye_grace).
        self._on_goodbye = on_goodbye
        # Called whenever `paused` or `chosen_language` changes (screen
        # attributes, pause timeout: see entrypoint).
        self._on_status = on_status
        # Sends one "mia.screen" message to the kiosk (entrypoint's
        # send_screen). Never awaited: the screen must not hold up her reply.
        self._on_screen = on_screen
        # The person she called joined the call room: the session ends
        # (entrypoint), the call goes on without her.
        self._on_call_answered = on_call_answered
        # Until then a card of hers is on screen that the contact card mustn't
        # replace (screen_cards.SENT_CARD_S / DRAFT_CARD_S).
        self._card_busy_until = 0.0
        self._ending = False
        self._tts = tts  # held directly so we can swap the voice per turn
        self._stt_ctl = stt  # not _stt: that is the base class slot
        self._stt_language = STT_MULTI
        self._last_confidence: float | None = None
        self._last_language: str = DEFAULT_LANG
        # Deepgram's code before _normalize_lang folds it to fr/en: "es" etc.
        # still needs to reach Gemini, which offers French or English to them.
        self._last_raw_language: str = DEFAULT_LANG
        self._chosen_language: str | None = None
        self._voice_language = DEFAULT_LANG  # the voice _speak_in last picked
        self._asked_again = False  # ASK_LANGUAGE_AGAIN said for unheard speech
        self._paused = False
        # Visitor speech (VAD) counted, vs. the last one that gave a transcript.
        self._speech_id = 0
        self._heard_speech_id = 0
        self._unheard = 0
        self._messages_sent = 0
        self._notifications_sent = 0
        self._emergency_alerts_sent = 0
        self._suggestions_sent = 0
        self._project_requests_sent = 0
        self._sent = SentLog()
        # The visitor's latest words, as Gemini sees them (llm_node): the
        # repeat guard lets a send through again only if they asked for it.
        self._visitor_said = ""
        self._visitor_turns = 0
        # Everything the visitor said so far (llm_node): a name a tool is
        # given must be one of theirs (_visitor_named).
        self._visitor_lines: list[str] = []
        # The visitor turn in which notify_member last answered NOTIFIED (NOTIFY_CLAIM).
        self._notify_turn = -1
        # The visitor turn in which a tool last tried to send an email
        # (sends_email), and the end that waits on the visitor after it.
        self._send_turn = -1
        # The visitor turn whose "it's on the screen" was dropped and checked (SCREEN_CLAIM_NOTE).
        self._screen_check_turn = -1
        self._pending_end: asyncio.Task | None = None  # see end_conversation
        self._pending_end_turn: int | None = None
        self._tasks: set[asyncio.Task] = set()
        # The project request she is filling in (#20), field key -> value,
        # and the visitor turn it was last shown in: it is sent only after
        # the visitor has answered the draft as shown.
        self._project: dict[str, str] = {}
        self._project_shown_at: int | None = None
        # Video call to staff (#22): the call ringing (staff_call.CallRoom),
        # and when the last unanswered one ended, which the session limits use
        # (entrypoint). An answered call ends the session.
        self._call = None
        self._call_watch: asyncio.Task | None = None
        self._calls_made = 0
        self._call_ended_at: float | None = None

    @property
    def language(self) -> str:
        """The language she speaks now: the visitor's choice, or before they've
        made one, what they last spoke."""
        return self._chosen_language or self._last_language

    @property
    def chosen_language(self) -> str | None:
        return self._chosen_language

    @property
    def paused(self) -> bool:
        return self._paused

    def _status_changed(self) -> None:
        if self._on_status is not None:
            self._on_status()

    def _show(self, msg: dict, busy_for: float = 0.0) -> None:
        """Put a card on the kiosk screen. Never raises: the screen is extra,
        the conversation goes on without it."""
        if busy_for:
            self._card_busy_until = time.monotonic() + busy_for
        if self._on_screen is None:
            return
        try:
            self._on_screen(msg)
        except Exception:
            logger.exception("screen message %s failed", msg.get("type"))

    def _show_sent(self, kind: str, to: str = "") -> None:
        self._show(message_sent(kind, self._chosen_language, to), busy_for=SENT_CARD_S)

    def _show_contact_card(self) -> None:
        if time.monotonic() < self._card_busy_until:
            logger.info("contact details said; another card is up, contact card skipped")
            return
        self._show(contact_card(self._chosen_language))

    def _display_name(self, member) -> str:
        """How the screen names a recipient: a person's name, or the inbox in her language."""
        if member.inbox:
            return member.role_fr if self._chosen_language == "fr" else member.first_name
        return member.full_name

    def _visitor_named(self, name: str, member=None) -> bool:
        """True when `name` is a name the visitor gave in this conversation,
        and not just the name of `member`, who they came to see or write to:
        "I'm here to see Alex" gave Gemini visitor_name="there", or "Alex"."""
        if not is_real_name(name) or not visitor_said_name(name, self._visitor_lines, ASSISTANT_NAME):
            logger.info("visitor_name %r: not a name the visitor gave, refused", name)
            return False
        if member is not None and not member.inbox:
            theirs = set(_norm(" ".join((member.full_name, *member.aliases))).split())
            if set(_norm(name).split()) <= theirs:
                logger.info("visitor_name %r is %s's name, refused", name, member.full_name)
                return False
        return True

    def _just_dictated(self, text: str) -> bool:
        """True when `text` is mostly the visitor's latest words: they have
        only just said it, so she hasn't repeated it for them to confirm."""
        latest = set(_norm(self._visitor_said).split())
        words = [w for w in _norm(text).split() if len(w) > 2]
        return bool(words) and sum(w in latest for w in words) >= 0.7 * len(words)

    def _is_repeat(self, kind: str, recipient: str, content: str) -> bool:
        if self._sent.is_repeat(kind, recipient, content, self._visitor_said):
            logger.info("%s to %s: same content already sent, refused", kind, recipient)
            return True
        return False

    def _set_paused(self, paused: bool) -> None:
        if paused != self._paused:
            self._paused = paused
            logger.info("paused" if paused else "resumed")
            self._status_changed()

    def _listen_in(self, lang: str | None) -> None:
        """Point the STT at `lang`, or at both languages (None)."""
        wanted = STT_LANGUAGE[lang] if lang else STT_MULTI
        if self._stt_ctl is None or wanted == self._stt_language:
            return
        logger.info("STT language %s -> %s", self._stt_language, wanted)
        self._stt_ctl.update_options(language=wanted)  # reconnects Deepgram's stream
        self._stt_language = wanted

    def _choose_language(self, lang: str) -> None:
        self._unheard = 0
        self._listen_in(lang)
        if lang != self._chosen_language:
            logger.info("language locked: %s", lang)
            self._chosen_language = lang
            self._status_changed()

    def _stop_speaking(self) -> None:
        """Cut her current reply off now (and any reply being prepared)."""
        try:
            self.session.interrupt()
        except RuntimeError:
            pass  # her goodbye or the pause line: those always finish

    def user_started_speaking(self) -> None:
        self._speech_id += 1

    async def check_heard(self) -> None:
        """After the visitor stops speaking: did the STT make anything of it?"""
        speech = self._speech_id
        await asyncio.sleep(UNHEARD_AFTER_S)
        if self._heard_speech_id >= speech or self._speech_id != speech:
            return
        self._unheard += 1
        if self._unheard >= UNHEARD_BEFORE_WIDENING and self._stt_language != STT_MULTI:
            logger.info("%d utterances without a transcript: listening in both languages", self._unheard)
            self._listen_in(None)
        elif (
            self._chosen_language is None
            and not self._asked_again
            and not self._paused
            and self.session.agent_state == "listening"
        ):
            # Once only: in an empty lobby, noise would have her asking forever.
            logger.info("speech without a transcript before a language was chosen: asking again")
            self._asked_again = True
            self._speak_in(DEFAULT_LANG)
            self.session.say(ASK_LANGUAGE_AGAIN)

    async def stt_node(self, audio, model_settings):
        async for event in super().stt_node(audio, model_settings):
            alternatives = getattr(event, "alternatives", None)
            if alternatives:
                confidence = getattr(alternatives[0], "confidence", None)
                if confidence is not None:
                    self._last_confidence = confidence
                language = getattr(alternatives[0], "language", None)
                if language:
                    self._last_raw_language = str(language).split("-")[0].lower()
                    self._last_language = _normalize_lang(str(language))
                text = alternatives[0].text or ""
                kind = getattr(event, "type", None)
                if text.strip() and kind == SpeechEventType.FINAL_TRANSCRIPT:
                    self._heard_speech_id = self._speech_id
                    self._unheard = 0
                # "Stop talking" cuts her off on the first interim transcript
                # that has it, not when the turn ends ~1s later. (Any speech
                # over half a second interrupts her anyway; a short "Stop!"
                # may not.) The pause itself happens in _plan_turn.
                if (
                    not self._paused
                    and kind in (SpeechEventType.INTERIM_TRANSCRIPT, SpeechEventType.FINAL_TRANSCRIPT)
                    and self.session.agent_state in ("speaking", "thinking")
                    and wants_pause(text, ASSISTANT_NAME)
                ):
                    logger.info("stop request heard while speaking: %r", text)
                    self._stop_speaking()
            yield event

    async def llm_node(self, chat_ctx, tools, model_settings):
        # Paused means no LLM calls at all. Turns are already dropped in
        # _plan_turn, but preemptive generation starts Gemini on the transcript
        # before the turn is even complete.
        if self._paused:
            return
        messages = [i for i in chat_ctx.items if getattr(i, "type", "") == "message"]
        visitor = [i for i in messages if i.role == "user"]
        if visitor:
            self._visitor_said = visitor[-1].text_content or ""
            self._visitor_turns = len(visitor)
            self._visitor_lines = [i.text_content or "" for i in visitor]
        if self._pending_end_turn is not None and self._visitor_turns > self._pending_end_turn:
            # They went on after a goodbye that was waiting on them
            # (_end_after_send). Without a word, Gemini took the conversation
            # as over: "I can only end the conversation, and I already did."
            logger.info("the visitor went on after the goodbye: not ending")
            self._pending_end_turn = None
            if self._pending_end is not None:
                self._pending_end.cancel()
            chat_ctx = chat_ctx.copy()
            chat_ctx.add_message(role="system", content=STILL_HERE_NOTE)
        project_talk = bool(self._project) or any(
            re.search(r"\bproje[ct]t?\b", fold(i.text_content or "")) for i in messages
        )
        if not project_talk or self._project_shown_at is not None:
            async for chunk in Agent.default.llm_node(self, chat_ctx, tools, model_settings):
                yield chunk
            return
        # A project request may be under way and isn't on the screen yet: her
        # text is passed on one sentence at a time, and one claiming it is on
        # the screen is held back until the end of this step. If she called
        # show_project_request in the same step and it answered SHOWN, the
        # sentence is true by then and is said; otherwise it is dropped
        # (SCREEN_CLAIM_NOTE). Tool calls pass straight through.
        turn = self._visitor_turns
        pending = ""
        held: list[str] = []
        shows = False
        async for chunk in Agent.default.llm_node(self, chat_ctx, tools, model_settings):
            if isinstance(chunk, str):
                text, chunk = chunk, None
            elif isinstance(chunk, ChatChunk) and chunk.delta and chunk.delta.content:
                text = chunk.delta.content
                chunk = chunk.model_copy(update={"delta": chunk.delta.model_copy(update={"content": None})})
            else:
                text = ""
            if isinstance(chunk, ChatChunk) and chunk.delta and chunk.delta.tool_calls:
                shows = shows or any(c.name == "show_project_request" for c in chunk.delta.tool_calls)
            pending += text
            while match := SENTENCE_END.search(pending):
                sentence, pending = pending[: match.end()], pending[match.end() :]
                if self._early_screen_claim(sentence):
                    held.append(sentence)
                    continue
                yield sentence
            if chunk is not None:
                yield chunk
        if pending and self._early_screen_claim(pending):
            held.append(pending)
        elif pending:
            yield pending
        if not held:
            return
        if shows:
            # Tools run as soon as they are called, while she is still talking.
            for _ in range(10):
                if self._project_shown_at is not None:
                    break
                await asyncio.sleep(0.1)
        if self._project_shown_at is not None:
            for sentence in held:
                yield sentence
            return
        logger.warning("dropped, the project request is not on the screen yet: %r", "".join(held))
        if self._screen_check_turn != turn:
            self._screen_check_turn = turn
            self._spawn(self._check_screen_claim(turn))

    def _early_screen_claim(self, sentence: str) -> bool:
        """True for "check your request on the screen" while it isn't there."""
        if self._project_shown_at is not None:
            return False
        s = fold(sentence)
        return bool(SCREEN_WORDS.search(s) and DRAFT_WORDS.search(s) and not NOT_DRAFT_WORDS.search(s))

    async def _check_screen_claim(self, turn: int) -> None:
        """A sentence about the request on the screen was dropped: once this
        turn is over, have her show it, or ask for what is missing."""
        try:
            handle = self.session.current_speech
            if handle is not None:
                await handle
            await asyncio.sleep(0.3)
            if self._project_shown_at is not None or self._visitor_turns != turn or self._paused or self._ending:
                return
            self.session.generate_reply(instructions=SCREEN_CLAIM_NOTE)
        except Exception:
            logger.exception("screen claim check failed")

    def _spawn(self, coro) -> asyncio.Task:
        task = asyncio.create_task(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return task

    async def tts_node(self, text, model_settings):
        # Phone numbers and long digit runs are spoken digit by digit (#6):
        # Gemini writes "573 2324" or "5732324" however the prompt asks, and
        # the TTS would say "five million ...". Only the audio changes: the
        # transcript (and on-screen captions) keep the digits.
        spoken = speak_digits_stream(text, lambda: self._voice_language)
        if TTS_PROVIDER == "deepgram":
            spoken = self._french_voice_respell(self._join_one_word_opening(spoken))
        async for frame in Agent.default.tts_node(self, spoken, model_settings):
            yield frame

    async def transcription_node(self, text, model_settings):
        # When she gives the office's phone, email, address or website, the
        # contact card comes up with them (#18), once per reply. This node
        # carries her words for the captions and her history, so it sees only
        # replies that are actually played (unlike the TTS's, which also runs
        # for guesses that preemptive generation throws away), and runs in the
        # text-only tests too.
        async for chunk in Agent.default.transcription_node(self, self._watch_for_contact_details(text), model_settings):
            yield chunk

    async def _watch_for_contact_details(self, text):
        said = ""
        shown = False
        async for chunk in text:
            said += chunk
            if not shown and gives_contact_details(said):
                shown = True
                self._show_contact_card()
            yield chunk
        if NOTIFY_CLAIM.search(said) and not self._notifications_sent:
            self._spawn(self._check_notify_claim(self._visitor_turns, said))

    async def _check_notify_claim(self, turn: int, said: str) -> None:
        """She said she told someone the visitor is here: once this turn is
        over (its tools included), make sure notify_member actually ran."""
        try:
            handle = self.session.current_speech
            if handle is not None:
                await handle
            await asyncio.sleep(0.3)
            if self._notify_turn == turn or self._notifications_sent or self._paused or self._ending:
                return
            logger.warning("said she notified someone without notify_member: %r", said)
            self.session.generate_reply(instructions=NOTIFY_CLAIM_NOTE)
        except Exception:
            logger.exception("notify claim check failed")

    async def _french_voice_respell(self, text):
        # Aura's French voice reads "English" the French way: in her greeting
        # ("Français ou English?") the kiosk recording was transcribed as
        # "ambiche". Spelled "Inglish" it comes out as English.
        async for chunk in text:
            yield FRENCH_VOICE_RESPELL.sub("Inglish", chunk) if self._voice_language == "fr" else chunk

    @staticmethod
    async def _join_one_word_opening(text):
        # Aura renders a one-word sentence on its own badly: "Goodbye!" came
        # out empty, as "about" or "you", in about half the tries (2026-10-09),
        # and it synthesizes each sentence as soon as it ends, so "Goodbye!
        # Have a great day!" lost its "Goodbye!" at the kiosk. A one-word
        # opening sentence is joined to the next one for the voice: "Goodbye,
        # have a great day!". Not a question ("Yes? How can I help?").
        head = ""
        async for chunk in text:
            if head is None:
                yield chunk
                continue
            head += chunk
            if m := ONE_WORD_OPENING.match(head):
                yield head[: m.end(1)] + "," + head[m.end(2) :]
            elif ONE_WORD_SO_FAR.match(head):
                continue  # may still become "Word! More words"
            else:
                yield head
            head = None
        if head:
            yield head

    @function_tool()
    @sends_email
    async def take_message(
        self,
        context: RunContext,
        visitor_name: str,
        recipient: str,
        message: str,
        reply_contact: str = "",
    ) -> str:
        """Email a visitor's message to a team member listed under TEAM.

        Call this only after reading the message back to the visitor and they
        confirmed it. Tell the visitor it was sent only if this returns SENT.

        Args:
            visitor_name: The visitor's name, as they gave it.
            recipient: Who the message is for, as the visitor said it: a name or a role such as "the CEO".
            message: The message, in the visitor's own words.
            reply_contact: A phone number or email for a reply, only if the visitor wants one. Empty otherwise.
        """
        if self._messages_sent >= MAX_MESSAGES_PER_SESSION:
            return "NOT SENT: message limit for this conversation reached. Give the contact details instead."
        member = find_member(recipient, TEAM)
        if member is None:
            return (
                f"NOT SENT: no single team member matches {recipient!r}. If it is unclear, ask who "
                "they mean. Otherwise say you cannot reach that person from here and give the contact details."
            )
        if not message.strip():
            return "NOT SENT: the message is empty. Ask the visitor what they would like to say."
        if not self._visitor_named(visitor_name, member):
            return NOT_THEIR_NAME.format(name=visitor_name)
        if self._is_repeat("message", member.email, message):
            self._show_sent("message", self._display_name(member))
            return ALREADY_SENT.format(what="This message", to=member.full_name)
        if not await send_message_email(member, visitor_name, message, reply_contact):
            return "NOT SENT: the email could not be delivered. Say so plainly and give the contact details."
        self._messages_sent += 1
        self._sent.add("message", member.email, message)
        self._show_sent("message", self._display_name(member))
        return f"SENT to {member.full_name}."

    @function_tool()
    @sends_email
    async def notify_member(
        self,
        context: RunContext,
        visitor_name: str,
        member: str,
        note: str = "",
    ) -> str:
        """Tell a team member listed under TEAM, by email, that a visitor is waiting at reception.

        Call this once you have the visitor's name and who they came to see.
        Tell the visitor the person was notified only if this returns NOTIFIED.

        Args:
            visitor_name: The visitor's name, as they gave it.
            member: Who they came to see, as the visitor said it: a name or a role such as "the CEO".
            note: Why they came, only if the visitor said, for example "for a two o'clock meeting". Empty otherwise.
        """
        if self._notifications_sent >= MAX_NOTIFICATIONS_PER_SESSION:
            return "NOT SENT: notification limit for this conversation reached. Give the contact details instead."
        found = find_member(member, TEAM)
        if found is None:
            return (
                f"NOT SENT: no single team member matches {member!r}. If it is unclear, ask who "
                "they mean. Otherwise say you cannot reach that person from here and give the contact details."
            )
        if not self._visitor_named(visitor_name, found):
            return NOT_THEIR_NAME.format(name=visitor_name)
        # Same person told about the same visitor: a repeat, whatever the note.
        if self._is_repeat("notify", found.email, visitor_name):
            self._show_sent("notify", found.full_name)
            return ALREADY_SENT.format(what=f"The notice that {visitor_name} is here", to=found.full_name)
        if not await send_visitor_waiting_email(found, visitor_name, note):
            return "NOT SENT: the email could not be delivered. Say so plainly and give the contact details."
        logger.info("notify_member: told %s that %s is here", found.full_name, visitor_name)
        self._notifications_sent += 1
        self._notify_turn = self._visitor_turns
        self._sent.add("notify", found.email, visitor_name)
        self._show_sent("notify", found.full_name)
        # The words to say come with the result, not from the prompt: given
        # them up front, Gemini sometimes said "J'ai prévenu Alexandre" without
        # calling this at all (seen on the base branch 3 times out of 3).
        first = found.first_name
        return (
            f"NOTIFIED {found.full_name} by email. Now tell the visitor, in their language, that you let "
            f"{first} know they are here and that {first} will get back to them, then ask whether they "
            f"would like to leave {first} a message too. For example, in English: I've let {first} know "
            f"you're here, {first} will get back to you. Would you like to leave a message too? In French: "
            f"J'ai prévenu {first} que vous êtes ici, {first} va vous revenir. Voulez-vous lui laisser un "
            "message aussi ?"
        )

    @function_tool()
    @sends_email
    async def alert_emergency(self, context: RunContext, description: str) -> str:
        """Email an urgent alert to the whole team that there is an emergency at reception.

        Call this straight away when someone is hurt, unwell, or reports a fire,
        smoke or any danger, in the same reply where you tell them to call 911.
        Tell the visitor the team was alerted only if this returns ALERTED.
        Never say the team received or read it, or that someone is coming.

        Args:
            description: What the visitor reported, in a few words, for example "visitor says there is smoke in the hallway".
        """
        if self._emergency_alerts_sent >= MAX_EMERGENCY_ALERTS_PER_SESSION:
            return "NOT SENT: the team was already alerted. Tell them to call nine one one and the office."
        # No member lookup: an emergency goes to everyone in team.json.
        if not await send_emergency_email(TEAM, description):
            return (
                "NOT SENT: the alert could not be delivered. Tell them to call nine one one, "
                "ask anyone nearby for help, and call the office."
            )
        self._emergency_alerts_sent += 1
        self._show_sent("alert")
        # Sent is all we know, not that anyone has read it: Chat P's report
        # had her telling visitors the team "received" the email.
        return (
            "ALERTED: an urgent email went out to the whole team. Say only that the team has been "
            "alerted. You do not know whether anyone has read it: never say they received it, saw it "
            "or are on their way."
        )

    @function_tool()
    @sends_email
    async def send_suggestion(
        self,
        context: RunContext,
        suggestion: str,
        visitor_name: str = "",
        reply_contact: str = "",
    ) -> str:
        """Put a visitor's suggestion in the suggestion box: an email to the team's general inbox.

        Call this only after repeating the suggestion to the visitor in a few
        words and they said yes. Tell them it was sent only if this returns SENT.

        Args:
            suggestion: The suggestion, in the visitor's own words.
            visitor_name: The visitor's name, only if they gave it. Empty to stay anonymous.
            reply_contact: A phone number or email for a reply, only if the visitor wants one. Empty otherwise.
        """
        if INBOX is None:
            return "NOT SENT: there is no suggestion box here. Give the contact details instead."
        if self._suggestions_sent >= MAX_SUGGESTIONS_PER_SESSION:
            return "NOT SENT: suggestion limit for this conversation reached. Give the contact details instead."
        if not suggestion.strip():
            return "NOT SENT: the suggestion is empty. Ask the visitor what they would like to suggest."
        if self._just_dictated(suggestion):
            # "C'est exact ? Votre suggestion est envoyée" in one breath, in testing.
            return (
                "NOT SENT yet: the visitor has only just said it. Repeat it in a few words and ask whether "
                "to send it; call this again once they say yes."
            )
        if visitor_name.strip() and not self._visitor_named(visitor_name):
            visitor_name = ""  # "the visitor", or a name they never gave: anonymous it is
        if self._is_repeat("suggestion", INBOX.email, suggestion):
            self._show_sent("suggestion")
            return ALREADY_SENT.format(what="This suggestion", to="the team")
        if not await send_suggestion_email(INBOX, suggestion, visitor_name, reply_contact):
            return "NOT SENT: the email could not be delivered. Say so plainly and give the contact details."
        self._suggestions_sent += 1
        self._sent.add("suggestion", INBOX.email, suggestion)
        self._show_sent("suggestion")
        return "SENT to the team's general inbox."

    @function_tool(
        raw_schema=project_request_schema(
            "show_project_request",
            "Show the visitor's project request on the screen as a draft for them to check. Call it "
            "once you have everything the PROJECT REQUESTS section asks for, and again with the "
            "corrected fields whenever the visitor corrects something. Pass every field you know; "
            "leave out what they did not give. Nothing is sent: that is submit_project_request.",
        )
    )
    async def show_project_request(self, raw_arguments: dict[str, object], context: RunContext) -> str:
        # Fields only ever get filled in or corrected here, never blanked:
        # Gemini sends "" for whatever it didn't think to repeat.
        fields = clean_project_fields(raw_arguments)
        if "name" in fields and not self._visitor_named(fields["name"]):
            del fields["name"]  # then it is missing, and she asks for it
        self._project.update(fields)
        missing = missing_project_fields(self._project)
        if missing:
            return "NOT SHOWN yet, still missing: " + "; ".join(missing) + ". Ask for it, one question at a time."
        self._project_shown_at = self._visitor_turns
        self._show(
            project_request("draft", project_screen_fields(self._project), self._chosen_language),
            busy_for=DRAFT_CARD_S,
        )
        logger.info("project request draft shown: %s", self._project)
        return (
            "SHOWN on the screen. Ask the visitor in one short sentence to check it there and tell you "
            "if anything needs changing. Do not read it all out."
        )

    @function_tool()
    @sends_email
    async def submit_project_request(self, context: RunContext) -> str:
        """Send the project request shown on the screen to the team's general inbox.

        Call this only after the visitor has checked the draft shown by
        show_project_request and said it is right. Tell them it was sent only
        if this returns SENT.
        """
        if INBOX is None:
            return "NOT SENT: project requests cannot be sent from here. Give the contact details instead."
        if self._project_shown_at is None:
            return "NOT SENT: show the request on the screen with show_project_request first."
        if missing_project_fields(self._project):
            return "NOT SENT: the request is incomplete. Call show_project_request with what is missing."
        # The visitor must have answered the draft as it is now, not just
        # seen it appear in this same reply.
        if self._visitor_turns == self._project_shown_at:
            return "NOT SENT: the visitor has not checked the draft yet. Ask them to check it on the screen."
        if self._project_requests_sent >= MAX_PROJECT_REQUESTS_PER_SESSION:
            return "NOT SENT: project request limit for this conversation reached. Give the contact details instead."
        content = json.dumps(self._project, sort_keys=True, ensure_ascii=False)
        if self._is_repeat("project_request", INBOX.email, content):
            return ALREADY_SENT.format(what="This project request", to="the team")
        fields = dict(self._project)
        if not await send_project_request_email(INBOX, fields, self.language):
            return "NOT SENT: the email could not be delivered. Say so plainly and give the contact details."
        self._project_requests_sent += 1
        self._sent.add("project_request", INBOX.email, content)
        self._show(
            project_request("sent", project_screen_fields(fields), self._chosen_language),
            busy_for=SENT_CARD_S,
        )
        logger.info("project request sent: %s", fields)
        return "SENT to the team's general inbox."

    @function_tool()
    async def end_conversation(self, context: RunContext) -> str | None:
        """End the conversation and put the screen back to standby.

        Call this only when the visitor has clearly finished: they said goodbye,
        or thanked you and want nothing else. Call it in the same reply as your
        short goodbye, after the goodbye words. Never call it while something is
        still in progress, such as a message they just confirmed: finish that
        with its own tool first. If something was sent in this same reply, it
        waits a few seconds for the visitor before ending.
        """
        if self._ending:
            return None
        if self._send_turn == self._visitor_turns:
            # "Yes, perfect, thanks, bye!": she sent something in this same
            # reply. The prompt says to end only in a later reply, which
            # Gemini didn't always do; ending here would cut the visitor off
            # from the confirmation (and from correcting it).
            return await self._end_after_send(context)
        # Once she's saying goodbye, let it finish: the mic stays open in a noisy
        # lobby, and a stray sound cutting her off would leave the session
        # running until the idle limit. A visitor who wasn't done taps AI again.
        try:
            context.disallow_interruptions()
        except RuntimeError:
            return None  # already talked over; they're still talking, keep going
        self._ending = True

        handle = context.speech_handle
        spoken_before = _assistant_lines(handle)
        # Gemini emits the call while her goodbye is still being spoken, and the
        # tool runs at once. Wait for those words to finish playing.
        await context.wait_for_playout()

        def _on_done(done_handle) -> None:
            if self._on_goodbye is not None:
                # Everything she said this turn: if "done" came early, none of
                # it may have played yet, so size the grace for all of it.
                self._on_goodbye(" ".join(_assistant_texts(done_handle)), time.monotonic())

        # Fires when this whole turn is reported played out, including any
        # reply after the tool; end_session then waits out the goodbye grace,
        # so the room is deleted only after her last word.
        handle.add_done_callback(_on_done)
        if _assistant_lines(handle) > spoken_before:
            logger.info("end_conversation: goodbye said, ending after playout")
            return None  # None means no reply after the tool
        # She called the tool without a word. Have her say it now, in this turn.
        logger.info("end_conversation: no goodbye yet, asking for one")
        return "Ending now. Say a short, warm goodbye in the visitor's language. Do not call any tool."

    async def _end_after_send(self, context: RunContext) -> str | None:
        """end_conversation in the reply that sent something: let the reply
        play, then end only if the visitor says nothing for END_AFTER_SEND_S."""
        handle = context.speech_handle
        turn = self._pending_end_turn = self._visitor_turns
        spoken_before = _assistant_lines(handle)
        await context.wait_for_playout()
        logger.info(
            "end_conversation in the reply that sent: ending if the visitor says nothing for %.0fs",
            END_AFTER_SEND_S,
        )

        def _on_done(done_handle) -> None:
            if self._pending_end is not None:
                self._pending_end.cancel()
            said = " ".join(_assistant_texts(done_handle))
            self._pending_end = self._spawn(self._end_if_quiet(turn, self._speech_id, said, time.monotonic()))

        handle.add_done_callback(_on_done)
        if _assistant_lines(handle) > spoken_before:
            return None
        return (
            "Not ended yet, because you sent it in this same reply. Say in a few words that it is sent, "
            "as the tool's answer says, then a short goodbye. Do not call any tool."
        )

    async def _end_if_quiet(self, turn: int, speech: int, said: str, done_at: float) -> None:
        try:
            await asyncio.sleep(END_AFTER_SEND_S)
            if (
                self._ending
                or self._paused
                or self._visitor_turns != turn
                or self._speech_id != speech
                or self.session.user_state == "speaking"
                or self.session.agent_state in ("speaking", "thinking")
            ):
                return  # they went on (llm_node)
            logger.info("end_conversation: nothing more from the visitor, ending")
            self._ending = True
            if self._on_goodbye is not None:
                self._on_goodbye(said, done_at)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("ending after the send failed")

    async def on_exit(self) -> None:
        if self._pending_end is not None:
            self._pending_end.cancel()
        if self._call_watch is not None:
            self._call_watch.cancel()

    @function_tool()
    async def pause_conversation(self, context: RunContext) -> None:
        """Stop talking and listening until the visitor says your name.

        Call this, without saying anything yourself, when the visitor asks you
        to stop talking, be quiet or wait while they talk to someone else, in
        whatever words. It tells them how to call you back. Never call it for
        a goodbye: that is end_conversation.
        """
        # The usual phrasings never reach Gemini (_plan_turn pauses on them
        # first); this catches the rest. The line is said here, not by Gemini:
        # once paused, llm_node makes no more calls, and the wording must be
        # the same every time.
        logger.info("pause_conversation called")
        self._set_paused(True)
        self.session.say(PAUSE_LINE[self.language], allow_interruptions=False)
        return None  # no reply after the tool

    def resume_by_tap(self):
        """The visitor tapped the "say my name" banner: the same as her name.
        Returns her reply's SpeechHandle, or None if she wasn't paused."""
        if not self._paused or self._ending:
            logger.info("resume tapped, not paused: ignored")
            return None
        logger.info("called back by a tap on the screen")
        self._set_paused(False)
        lang = self._chosen_language or self._last_language
        self._speak_in(lang)
        return self.session.generate_reply(instructions=_reply_language_note(lang) + " " + TAPPED_NOTE)

    def wake_by_tap(self) -> None:
        """The visitor tapped the "tap to talk" hint: a short "Yes?", only if
        she is waiting for them (not paused, speaking, thinking or hearing them)."""
        if (
            self._paused
            or self._ending
            or self.session.agent_state != "listening"
            or self.session.user_state == "speaking"
        ):
            logger.info("wake tapped while %s/%s: ignored", self.session.agent_state, self.session.user_state)
            return
        logger.info("woken by a tap on the screen")
        lang = self._chosen_language
        self._speak_in(lang or DEFAULT_LANG)
        self.session.say(WAKE_LINE[lang] if lang else WAKE_LINE_BOTH)

    # --- Video call to staff (#22, staff_call.py) ----------------------------
    # call_staff opens a call room and emails someone a link to it; the kiosk
    # opens the call window. While it rings she stays with the visitor (the
    # kiosk's mic is off meanwhile). They join: her session ends, the call goes
    # on without her. Nobody within CALL_ANSWER_TIMEOUT, or the visitor cancels:
    # the window closes and she offers a message.

    @property
    def call_active(self) -> bool:
        """A call she placed is ringing."""
        return self._call is not None

    @property
    def call_ended_at(self) -> float | None:
        """When the last unanswered call ended (time.monotonic())."""
        return self._call_ended_at

    @function_tool()
    @sends_email
    async def call_staff(self, context: RunContext, member: str, visitor_name: str) -> str | None:
        """Call a team member listed under TEAM by video: they get a link and join from their phone, and the call opens on the kiosk screen.

        Call this only after the visitor said yes to the call, and once you
        have their name. Say nothing yourself: it tells the visitor you are
        calling. Never say you are calling someone without it.

        Args:
            member: Who to call, as the visitor said it: a name or a role such as "the CEO".
            visitor_name: The visitor's name, as they gave it.
        """
        if self._call is not None:
            first = self._call.member.first_name
            return f"NOT CALLED: you are already calling {first}. Tell the visitor {first} has been called and to hold on a moment."
        if self._calls_made >= MAX_CALLS_PER_SESSION:
            return "NOT CALLED: call limit for this conversation reached. Offer to take a message instead."
        found = find_member(member, TEAM)
        if found is None or found.inbox:
            return (
                f"NOT CALLED: no single team member matches {member!r}. If it is unclear, ask who they mean. "
                "Otherwise say you cannot reach that person directly and offer to take a message for the general inbox."
            )
        if not self._visitor_named(visitor_name, found):
            return NOT_THEIR_NAME.format(name=visitor_name).replace("NOT SENT", "NOT CALLED", 1)
        if self._is_repeat("call", found.email, visitor_name):
            return (
                f"NOT CALLED AGAIN: you already called {found.first_name} in this conversation. Offer to take a "
                f"message for {found.first_name}; call again only if the visitor clearly asks you to try again."
            )
        call = await start_staff_call(found, visitor_name, ASSISTANT_NAME)
        if call is None:
            return "NOT CALLED: the call could not be placed. Say so plainly and offer to take a message instead."
        logger.info("call_staff: calling %s for %s in %s", found.full_name, visitor_name, call.room)
        self._calls_made += 1
        self._sent.add("call", found.email, visitor_name)
        self._call = call
        # The call window covers the screen: no card of hers comes up meanwhile.
        self._show(call_open_message(call, self._chosen_language), busy_for=CALL_ANSWER_TIMEOUT)
        self._call_watch = self._spawn(self._watch_call(call))
        self._status_changed()
        self._speak_in(self.language)
        self.session.say(CALLING_LINE[self.language].format(first=found.first_name), allow_interruptions=False)
        return None  # no reply after the tool: the line above is it

    async def _watch_call(self, call) -> None:
        """Ask LiveKit who is in the call room until it is answered, cancelled
        (the room is gone) or CALL_ANSWER_TIMEOUT passes."""
        deadline = time.monotonic() + CALL_ANSWER_TIMEOUT
        try:
            while self._call is call:
                status = await call.status()
                if self._call is not call:
                    return
                if status == ANSWERED:
                    self._call_answered(call)
                    return
                if status == GONE:
                    logger.info("call_staff: the call room %s is gone: cancelled", call.room)
                    await self._call_over(call, "cancelled")
                    return
                if time.monotonic() >= deadline:
                    logger.info("call_staff: %s did not answer within %ss", call.member.full_name, CALL_ANSWER_TIMEOUT)
                    await self._call_over(call, "no_answer")
                    return
                await asyncio.sleep(CALL_POLL_S)
        except Exception:
            logger.exception("watching the call room failed")

    def cancel_call_by_tap(self) -> None:
        """The visitor tapped Cancel in the call window ("call_cancel" on mia.control)."""
        if self._call is None:
            logger.info("call_cancel with no call ringing: ignored")
            return
        logger.info("call_staff: the visitor cancelled the call to %s", self._call.member.full_name)
        self._spawn(self._call_over(self._call, "cancelled"))

    def _call_answered(self, call) -> None:
        """They joined: the call goes on in the call window, her session ends."""
        logger.info("%s joined the call in %s: ending her session", call.member.full_name, call.room)
        self._call = None
        self._card_busy_until = 0.0
        self._stop_speaking()
        if self._on_call_answered is not None:
            self._on_call_answered()

    async def _call_over(self, call, why: str) -> None:
        """Unanswered ("no_answer") or cancelled by the visitor ("cancelled"):
        close the window and the call room, then offer a message."""
        if self._call is not call:
            return
        self._call = None
        self._call_ended_at = time.monotonic()
        self._card_busy_until = 0.0
        self._show(CALL_CLOSE)
        self._status_changed()
        await call.close()
        try:
            names = {"name": call.member.full_name, "first": call.member.first_name}
            if self._ending:
                return
            if self._paused:
                # She said she'd stop talking: no word now, but she'll know.
                await self._remember(NO_ANSWER_PAUSED_NOTE.format(**names))
                return
            if (handle := self.session.current_speech) is not None:
                await handle
            if why == "cancelled":
                note = CANCELLED_NOTE.format(**names)
            else:
                minutes = max(1, round(CALL_ANSWER_TIMEOUT / 60))
                note = NO_ANSWER_NOTE.format(wait=f"{minutes} minute{'s' if minutes > 1 else ''}", **names)
            self._speak_in(self.language)
            self.session.generate_reply(instructions=_reply_language_note(self.language) + " " + note)
        except Exception:
            logger.exception("offering a message after the call failed")

    async def hang_up(self) -> None:
        """The session is ending while a call rings: close the call room too,
        so the window on the kiosk closes and the link says the visitor left."""
        call, self._call = self._call, None
        if call is not None:
            logger.info("session ending while calling %s: closing the call room", call.member.full_name)
            await call.close()

    async def _remember(self, note: str) -> None:
        """Add a system note to her history."""
        ctx = self.chat_ctx.copy()
        ctx.add_message(role="system", content=note)
        await self.update_chat_ctx(ctx)

    def _language_note(self, text: str) -> str:
        """Lock, keep or switch the conversation language; the note for Gemini."""
        if self._chosen_language is None:
            # The answer to "Français ou English?": a language named, or else
            # the language they answered in.
            heard = self._last_raw_language if self._last_raw_language in LANGUAGE_NAMES else None
            choice = language_choice(text) or heard
            if choice is None:
                return _reply_language_note(self._last_raw_language)  # offer FR/EN
            self._choose_language(choice)
            return CHOSEN_NOTE.format(name=LANGUAGE_NAMES[choice])
        switch = language_switch(text, self._chosen_language, ASSISTANT_NAME)
        if switch is not None:
            logger.info("visitor asked to switch to %s", switch)
            self._choose_language(switch)
            return SWITCHED_NOTE.format(name=LANGUAGE_NAMES[switch])
        self._listen_in(self._chosen_language)  # back from "both", if widened
        return _reply_language_note(self._chosen_language)

    def _plan_turn(self, text: str, confidence: float | None) -> TurnPlan:
        """Decide what one visitor turn gets. Updates pause and language state."""
        woken = False
        if self._paused:
            if wants_pause(text, ASSISTANT_NAME) or not says_name(text, ASSISTANT_NAME):
                logger.info("paused, ignored %r", text)
                return TurnPlan()
            logger.info("called back by name: %r", text)
            self._set_paused(False)
            woken = True
        elif wants_pause(text, ASSISTANT_NAME):
            logger.info("pause requested: %r", text)
            self._set_paused(True)
            return TurnPlan(say=PAUSE_LINE[self.language])

        stripped = text.lower().strip(".,!? ")
        too_short = len(stripped) < MIN_TRANSCRIPT_CHARS
        filler = stripped in FILLER_ONLY
        unsure = confidence is not None and confidence < MIN_STT_CONFIDENCE
        # Her name alone ("Mia?") is short and often scored low; it's still
        # the visitor calling her back. So is a lone "English" mangled into
        # "Engösch" (confidence 0.40 in testing).
        choosing = self._chosen_language is None and language_choice(text) is not None
        if not (woken or choosing) and (not text or too_short or filler or unsure):
            logger.info(
                "rejected %r (lang=%s, confidence=%s, short=%s, filler=%s)",
                text,
                self._last_language,
                confidence,
                too_short,
                filler,
            )
            if self._chosen_language is None:
                return TurnPlan(say=ASK_LANGUAGE_AGAIN)
            return TurnPlan(say=DIDNT_GET_THAT[self.language])

        note = self._language_note(text)
        if woken:
            note += " " + (WOKEN_NOTE if only_name(text, ASSISTANT_NAME) else WOKEN_ASKING_NOTE)
        logger.info("heard %r (lang=%s, confidence=%s)", text, self._last_language, confidence)
        return TurnPlan(note=note)

    def _speak_in(self, lang: str) -> None:
        """Point the TTS at `lang`'s voice before the next thing she says."""
        self._voice_language = lang  # what tts_node rewrites for
        if TTS_PROVIDER == "elevenlabs":
            # Same voice for both languages. Only reconnects when it changes.
            if ELEVENLABS_MODEL in ELEVENLABS_LANGUAGE_MODELS:
                self._tts.update_options(language=lang)
            return
        self._tts.update_options(model=VOICE_BY_LANG[lang])

    async def on_user_turn_completed(self, turn_ctx, new_message) -> None:
        text = (new_message.text_content or "").strip()
        confidence = self._last_confidence
        self._last_confidence = None  # don't carry a stale score into next turn

        plan = self._plan_turn(text, confidence)

        # Set the voice before returning: the LLM reply is synthesized after
        # this hook, so this is what decides how the answer sounds.
        self._speak_in(DEFAULT_LANG if plan.say == ASK_LANGUAGE_AGAIN else self.language)

        if plan.note:
            # This turn only (turn_ctx isn't saved to the conversation history).
            turn_ctx.add_message(role="system", content=plan.note)
            return
        if plan.say:
            if self._paused:
                # Drop the reply Gemini may have started on "stop talking"
                # (preemptive generation), then say the pause line in full:
                # it's how the visitor learns to call her back.
                self._stop_speaking()
                self.session.say(plan.say, allow_interruptions=False)
            else:
                await self.session.say(plan.say)
        # Skip the LLM entirely for this turn — she's already answered, or
        # she's paused. The turn isn't saved to the conversation either.
        raise StopResponse()


async def entrypoint(ctx: JobContext) -> None:
    await ctx.connect()

    # STT -> LLM -> TTS. Deepgram covers both ears and voice (one API key);
    # Gemini 2.5 Flash is the brain (simple GOOGLE_API_KEY, no service account).
    # VAD: AgentSession uses the bundled Silero VAD by default (the standalone
    # livekit-plugins-silero is deprecated in 1.6.x), so no explicit vad= needed.
    #
    # The TTS is held as a local so MiaAgent gets the same instance the session
    # speaks through — that's what lets it swap the voice per turn.
    # Deepgram Aura unless TTS_PROVIDER=elevenlabs (see make_tts).
    tts = make_tts()

    # language="multi" until the visitor picks French or English: it hears
    # either, and reports which one it heard (a visitor who just starts talking
    # has chosen that way). Then MiaAgent narrows it to the chosen language
    # (STT_LANGUAGE). Multilingual and keyterms both need nova-3.
    stt = deepgram.STT(model="nova-3", language=STT_MULTI, keyterm=STT_KEYTERMS)

    session = AgentSession(
        stt=stt,
        # Gemini model + fallback, thinking at its minimum (see make_llm).
        llm=make_llm(),
        tts=tts,
        # The default endpointing (min 0.5s / max 3.0s of silence before she
        # accepts the turn is over) reads as a long dead pause at a reception
        # desk, where turns are short and the visitor expects a near-immediate
        # reply, so max is tightened to 1.5. min is 0.7: the turn closes when
        # Deepgram's final transcript of a phrase arrives (~0.4s after the
        # phrase ends) if min_delay has passed since the phrase ended, even if
        # the visitor has started the next one. At 0.3 the half-second pauses
        # between short sentences each closed a turn ("Great. Thanks. That's
        # all. Goodbye." became four, each reply cut off by the next, and
        # "transcript arrives after turn has been committed"); 0.5 still split
        # it in two or three; 0.7 kept it one turn in 3 of 3 voice tests.
        # Reply latency didn't measurably change (~3.3s end of speech to first
        # audio at 0.3, 0.5 and 0.7): the ~0.4s transcript lag dominates.
        #
        # preemptive_tts starts synthesizing before the turn is formally closed,
        # which removes most of the remaining gap — it costs a little wasted TTS
        # when a guess is discarded, which is the right trade here.
        turn_handling={
            "endpointing": {"min_delay": 0.7, "max_delay": 1.5},
            "preemptive_generation": {"preemptive_tts": True},
        },
        # Marks the visitor "away" once neither side has spoken for this long;
        # that is the idle signal that ends the session below.
        user_away_timeout=SESSION_IDLE_TIMEOUT,
    )

    # Simli renders the Trinity face into the room, lip-synced to session audio.
    # It renders nothing else: no prompt, no transcript, no language — the
    # persona lives entirely in MIA_SYSTEM_PROMPT above.
    avatar = simli.AvatarSession(
        simli_config=simli.SimliConfig(
            api_key=os.environ["SIMLI_API_KEY"],
            face_id=os.environ["SIMLI_FACE_ID"],
            max_idle_time=MAX_IDLE_TIME,
            max_session_length=MAX_SESSION_LENGTH,
        ),
    )
    await avatar.start(session, room=ctx.room)

    # Whether the kiosk can still hear her, per LiveKit's active-speaker
    # detection on the audio Simli publishes into the room. Used only to stretch
    # the goodbye grace when she runs long, never to shorten it: speaker events
    # are throttled and can drop out at a pause between sentences.
    avatar_quiet = asyncio.Event()
    avatar_quiet.set()

    # When the room last stopped hearing her (time.monotonic()).
    avatar_quiet_since = time.monotonic()

    @ctx.room.on("active_speakers_changed")
    def _on_speakers(speakers) -> None:
        nonlocal avatar_quiet_since
        if any(p.identity == avatar.avatar_identity for p in speakers):
            avatar_quiet.clear()
        elif not avatar_quiet.is_set():
            avatar_quiet_since = time.monotonic()
            avatar_quiet.set()

    # When she last started speaking (the agent's "speaking" state: her audio
    # is going out to the avatar), to time her goodbye (goodbye_grace).
    speaking_since: float | None = None

    async def let_goodbye_play(text: str, done_at: float) -> None:
        """Hold the room open until `text`, reported played at `done_at`, has been heard."""
        wait = done_at + goodbye_grace(text, done_at, speaking_since) - time.monotonic()
        logger.info(
            "holding the room %.1fs for the goodbye to play out (%d chars, started speaking %.1fs before done)",
            max(wait, 0.0),
            len(text),
            done_at - speaking_since if speaking_since is not None else -1.0,
        )
        if wait > 0:
            await asyncio.sleep(wait)
        # Then, if the room still hears her (a goodbye longer than the
        # estimate), until she has been silent there for GOODBYE_QUIET_S: a
        # pause between two sentences is not the end. Only ever longer: the
        # room's detection misses a lone short word like "Goodbye!".
        give_up = time.monotonic() + GOODBYE_OVERRUN_MAX_S
        while (left := give_up - time.monotonic()) > 0:
            if avatar_quiet.is_set():
                quiet_for = time.monotonic() - avatar_quiet_since
                if quiet_for >= GOODBYE_QUIET_S:
                    return
                await asyncio.sleep(min(GOODBYE_QUIET_S - quiet_for, left))
                continue
            logger.info("goodbye still playing in the room: waiting for it to end")
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(avatar_quiet.wait(), left)
        logger.warning("goodbye still playing %.0fs past the grace; ending anyway", GOODBYE_OVERRUN_MAX_S)

    ending = False

    async def end_session(reason: str, goodbye: bool = False, said: str = "", done_at: float | None = None) -> None:
        """Close the room for everyone and release this job. Safe to call twice.

        Deleting the room is what stops the bill: it disconnects the kiosk and
        the Simli avatar at once, instead of each lingering until a timeout.

        goodbye: say GOODBYE first (the hard cap ends her mid-conversation).
        said: a goodbye she has already said (end_conversation), reported
        played at `done_at`. Either way the room stays open until the goodbye
        has had time to reach the kiosk.
        """
        nonlocal ending
        if ending:
            return
        ending = True
        logger.info("ending session in %s: %s", ctx.room.name, reason)
        if goodbye or said:
            # She's leaving: stop listening, so a sound in the lobby can't start
            # a new reply that the room's deletion would cut off mid-sentence.
            try:
                session.input.set_audio_enabled(False)
            except Exception:
                logger.exception("could not stop listening; ending anyway")
        if goodbye:
            said = GOODBYE[agent.language]
            try:
                await session.say(said, allow_interruptions=False)
            except Exception:
                logger.exception("goodbye failed; ending anyway")
            done_at = time.monotonic()
        if said:
            await let_goodbye_play(said, done_at if done_at is not None else time.monotonic())
        # A call still ringing goes with her (an answered one goes on).
        await agent.hang_up()
        try:
            if said and speaking_since is not None:
                logger.info("deleting the room %.1fs after she started her goodbye", time.monotonic() - speaking_since)
            await ctx.delete_room()
        except Exception:
            logger.exception("delete_room failed; LiveKit's departure timeout will close it")
        ctx.shutdown(reason=reason)

    # Event callbacks are sync; hold task references so they aren't collected.
    tasks: set[asyncio.Task] = set()

    def spawn(coro) -> asyncio.Task:
        task = asyncio.create_task(coro)
        tasks.add(task)
        task.add_done_callback(tasks.discard)
        return task

    # What the kiosk screen shows about her, as attributes on this (the
    # agent's) participant. The contract is docs/screen-protocol.md.
    published: dict[str, str] = {}
    publishing = asyncio.Lock()

    def screen_attributes() -> dict[str, str]:
        if agent.paused:
            state = "paused"
        elif session.agent_state == "speaking":
            state = "speaking"
        else:
            state = "listening"  # also while she's working out a reply
        attributes = {"mia.state": state, "mia.name": ASSISTANT_NAME}
        if agent.chosen_language:
            attributes["mia.language"] = agent.chosen_language
        return attributes

    async def publish_screen_state() -> None:
        # One update at a time, always the latest state, only what changed.
        async with publishing:
            changed = {k: v for k, v in screen_attributes().items() if published.get(k) != v}
            if not changed:
                return
            try:
                await ctx.room.local_participant.set_attributes(changed)
            except Exception:
                logger.exception("could not update the screen attributes %s", changed)
                return
            published.update(changed)
            logger.info("screen: %s", changed)

    pause_timer: asyncio.Task | None = None

    async def end_if_still_paused() -> None:
        await asyncio.sleep(PAUSE_TIMEOUT)
        while agent.call_active:  # a call she is waiting on outlasts the pause
            await asyncio.sleep(5)
        # No goodbye: she said she'd stop talking.
        await end_session(f"paused {PAUSE_TIMEOUT}s without being called back")

    # The idle limit is LiveKit's "away" user state, which comes only once:
    # idle while a call rings (the kiosk's mic is off meanwhile) doesn't end
    # the session, but then nothing would end it after an unanswered call
    # either. So from the end of the call, this does.
    after_call_idle: asyncio.Task | None = None

    async def end_if_idle_after_call() -> None:
        nonlocal after_call_idle
        await asyncio.sleep(SESSION_IDLE_TIMEOUT)
        after_call_idle = None
        if session.user_state == "away" and not agent.call_active:
            await end_session(f"idle {SESSION_IDLE_TIMEOUT}s after the call")

    def on_status() -> None:
        nonlocal pause_timer, after_call_idle
        spawn(publish_screen_state())
        if agent.paused and pause_timer is None:
            pause_timer = spawn(end_if_still_paused())
        elif not agent.paused and pause_timer is not None:
            pause_timer.cancel()
            pause_timer = None
        if not agent.call_active and session.user_state == "away" and after_call_idle is None:
            after_call_idle = spawn(end_if_idle_after_call())

    # Cards for the screen ("mia.screen", docs/screen-protocol.md), one text
    # stream each, in order. Fail-safe: a screen that can't be reached costs
    # the card, never the conversation.
    screen_lock = asyncio.Lock()

    async def send_screen(msg: dict) -> None:
        async with screen_lock:
            try:
                await ctx.room.local_participant.send_text(json.dumps(msg, ensure_ascii=False), topic=TOPIC_SCREEN)
                logger.info("screen card: %s", msg)
            except Exception:
                logger.exception("could not send the screen card %s", msg.get("type"))

    # end_conversation's goodbye has already been said, so no goodbye=True
    # here; passing what she said still holds the room open while it plays.
    agent = MiaAgent(
        tts=tts,
        stt=stt,
        on_goodbye=lambda said, done_at: spawn(end_session("visitor said goodbye", said=said, done_at=done_at)),
        on_status=on_status,
        on_screen=lambda msg: spawn(send_screen(msg)),
        on_call_answered=lambda: spawn(call_answered()),
    )

    async def call_answered() -> None:
        # The person she called joined the call room (#22): the call goes on
        # in the kiosk's call window, without her. The screen hears it first,
        # so it hides her instead of offering "Tap to talk".
        await send_screen(CALL_ANSWERED)
        await end_session("call answered")

    # Taps on the screen ("mia.control"): "resume" on the paused banner, "wake"
    # on the "tap to talk" hint, "call_cancel" on the call window's Cancel.
    # Anything else, or bad JSON, is ignored.
    async def handle_control(reader, identity: str) -> None:
        try:
            msg = json.loads(await reader.read_all())
            kind = msg.get("type") if isinstance(msg, dict) else None
            logger.info("screen control from %s: %s", identity, kind)
            if kind == "resume":
                agent.resume_by_tap()
            elif kind == "wake":
                agent.wake_by_tap()
            elif kind == "call_cancel":
                agent.cancel_call_by_tap()
        except Exception:
            logger.exception("screen control from %s failed", identity)

    ctx.room.register_text_stream_handler(
        TOPIC_CONTROL, lambda reader, identity: spawn(handle_control(reader, identity))
    )

    # Log what she says next to what she heard ("heard …" in MiaAgent), so her
    # answers can be checked in `docker compose logs` after a prompt change.
    @session.on("conversation_item_added")
    def _on_item(ev) -> None:
        item = ev.item
        if getattr(item, "role", None) == "assistant" and item.text_content:
            logger.info("said %r", item.text_content)

    @session.on("user_state_changed")
    def _on_user_state(ev) -> None:
        nonlocal after_call_idle
        if ev.old_state == "away" and after_call_idle is not None:
            after_call_idle.cancel()
            after_call_idle = None
        if ev.new_state == "away":
            if agent.call_active:
                logger.info("idle %ss while a call rings: the session stays open", SESSION_IDLE_TIMEOUT)
            else:
                spawn(end_session(f"idle {SESSION_IDLE_TIMEOUT}s"))
        elif ev.new_state == "speaking":
            agent.user_started_speaking()
        elif ev.old_state == "speaking":
            spawn(agent.check_heard())

    @session.on("agent_state_changed")
    def _on_agent_state(ev) -> None:
        nonlocal speaking_since
        if ev.new_state == "speaking":
            speaking_since = time.monotonic()
        spawn(publish_screen_state())

    # The visitor left (AI button turned off, page closed, network gone):
    # close_on_disconnect has already stopped the session; clear up the room.
    @session.on("close")
    def _on_close(_ev) -> None:
        spawn(end_session("session closed"))

    started_at = time.monotonic()

    def length_limit() -> float:
        """When the session must end (monotonic): SESSION_MAX_LENGTH, stretched
        by a call (#22) — not while one rings, AFTER_CALL_S more after an
        unanswered one — never more than CALL_STRETCH_MAX past it."""
        hard = started_at + SESSION_MAX_LENGTH + CALL_STRETCH_MAX
        if agent.call_active:
            return hard
        limit = started_at + SESSION_MAX_LENGTH
        if agent.call_ended_at is not None:
            limit = max(limit, agent.call_ended_at + AFTER_CALL_S)
        return min(limit, hard)

    async def cap_length() -> None:
        while (left := length_limit() - time.monotonic()) > 0:
            await asyncio.sleep(min(left, 5.0))
        await end_session(f"max length {time.monotonic() - started_at:.0f}s", goodbye=True)

    await session.start(agent=agent, room=ctx.room)
    spawn(cap_length())
    spawn(publish_screen_state())

    # Greet the visitor on her own; the browser holds its mic shut until she has
    # finished (her avatar stops speaking), so she speaks before she listens.
    await session.say(FIRST_MESSAGE)


if __name__ == "__main__":
    # agent_name switches off automatic dispatch: the worker joins only rooms
    # whose join token requests AGENT_NAME (the kiosk's token route does).
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint, agent_name=AGENT_NAME))
