"""Lead capture and the screen (wave 2, Chat L): #17 suggestion box, #18 cards
pushed to the screen, #20 project requests, the send-once guard, and the
screen's resume / wake taps.

Same harness as test_team_messages.py — real Gemini, every email replaced by a
recorder, every mia.screen message recorded as ("screen", msg). Run inside the
worker image, emails disabled:

    docker run --rm --env-file .env -v "$PWD":/app -w /app -e RESEND_API_KEY= simli-worker python test_leads.py

Pass scenario names to run only those, e.g. `python test_leads.py project_en`.
Offline checks always run first. Every check runs; failures are listed at the
end (exit 1 if any).
"""

import asyncio
import json
import re
import sys

from leads import (
    PROJECT_FIELDS,
    SentLog,
    asks_again,
    clean_project_fields,
    missing_project_fields,
    project_fields_prompt,
)
from screen_cards import gives_contact_details
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


def screens(since: int, type_: str, **match) -> list[dict]:
    """mia.screen messages of `type_` since `since`, matching every key in `match`."""
    return [
        c[1]
        for c in calls[since:]
        if c[0] == "screen" and c[1].get("type") == type_ and all(c[1].get(k) == v for k, v in match.items())
    ]


# ---------------------------------------------------------------- offline


def test_offline() -> None:
    print("— offline:")
    # Contact card trigger: the office's details only, never the visitor's.
    yes = [
        "You can call us at one, five one four, five seven three, two three two four.",
        "Vous pouvez nous joindre au un, cinq un quatre, cinq sept trois, deux trois deux quatre.",
        "Our number is 1 514 573 2324.",
        "Email us at info at mobileappslabs dot com.",
        "The office is at seventy four Turgeon Street, Sainte Therese.",
        "Visit mobileappslabs dot com for more.",
        "Notre site est mobileappslabs point com.",
    ]
    no = [
        "Mobile Apps Labs builds web and mobile applications.",
        "Your number is five one four, five five five, zero one nine nine. Is that right?",
        "I have your email as jean.tremblay@gmail.com.",
        "The demo reel is at w w w dot infini dash view dot com.",
    ]
    check(all(gives_contact_details(t) for t in yes), "contact card: office phone, email, address, website (EN/FR)")
    check(not any(gives_contact_details(t) for t in no), "contact card: not for the company name, a visitor's 514 number or email, Infini View")

    # The send-once guard.
    log = SentLog()
    log.add("message", "nb@x", "Tell him I'll come by tomorrow morning to sign the contract.")
    check(log.is_repeat("message", "nb@x", "Tell him I will come by tomorrow morning to sign the contract", "Did it go through?"),
          "guard: a reworded copy of a sent message is a repeat")
    check(not log.is_repeat("message", "nb@x", "Tell him I'll come by tomorrow morning to sign the contract.", "Can you send it again please?"),
          "guard: 'send it again' lets it through")
    check(not log.is_repeat("message", "aj@x", "Tell him I'll come by tomorrow morning to sign the contract.", "ok"),
          "guard: same words to someone else is not a repeat")
    check(not log.is_repeat("message", "nb@x", "Also, please bring the invoice from last month.", "ok"),
          "guard: a different message to the same person is not a repeat")
    check(all(asks_again(t) for t in ("Send it again", "Pouvez-vous le renvoyer ?", "Envoyez-le encore une fois", "re-send it")),
          "guard: 'again' in English and French")

    # The project form, all from PROJECT_FIELDS.
    keys = [f.key for f in PROJECT_FIELDS]
    check(keys == ["name", "company", "email", "phone", "description", "timeline", "budget"], f"project fields in order: {keys}")
    fields = clean_project_fields({"name": " Ana  Silva ", "phone": "", "bogus": "x", "description": 5, "budget": "None"})
    check(fields == {"name": "Ana Silva", "budget": ""}, f"clean_project_fields trims, drops junk, keeps 'none' as asked: {fields}")
    check(len(missing_project_fields(fields)) == 4, "missing: description, a way to reach them, company and timeline not asked")
    done = {"name": "A", "phone": "514", "description": "An app", "company": "", "timeline": "", "budget": ""}
    check(missing_project_fields(done) == [], "phone alone is enough, declined optional ones count as asked")
    check(clean_project_fields({"name": "none"}) == {"name": "none"}, "'none' only declines an optional field")
    check(clean_project_fields({"email": "Ana@PainDoor.com "}) == {"email": "ana@paindoor.com"}, "email lowercased")
    check("optional" in project_fields_prompt() and "One, their name" in project_fields_prompt(), "prompt lists the questions")


async def test_tool_guards() -> None:
    """The project tools' own refusals, called directly (no Gemini)."""
    print("— project tool guards, direct calls:")
    import worker

    agent = worker.MiaAgent(tts=None, on_screen=lambda msg: calls.append(("screen", msg)))
    agent._chosen_language = "en"
    agent._visitor_lines = ["I'm Ana Silva, I'd like a loyalty app for my bakery."]
    n = len(calls)
    show = agent.show_project_request
    submit = agent.submit_project_request

    out = await submit(None)
    check(out.startswith("NOT SENT") and "show_project_request" in out, f"submit before show refused: {out}")
    agent._visitor_turns = 3
    out = await show({"name": "Ana Silva", "description": "A loyalty app for a bakery"}, None)
    check(out.startswith("NOT SHOWN") and "phone" in out, f"show without a way to reach them refused: {out}")
    out = await show({"email": "ana@silva.ca"}, None)
    check(out.startswith("NOT SHOWN") and "timeline" in out and "budget" in out, f"show before the optional ones were asked refused: {out}")
    out = await show({"company": "none", "timeline": "this fall", "budget": "aucun"}, None)
    check(out.startswith("SHOWN"), f"show once complete (fields merged): {out}")
    draft = screens(n, "project_request", status="draft")
    check(len(draft) == 1 and draft[0]["fields"]["name"] == "Ana Silva" and draft[0]["fields"]["email"] == "ana@silva.ca"
          and list(draft[0]["fields"]) == [f.key for f in PROJECT_FIELDS] and draft[0].get("lang") == "en",
          f"draft on screen, every field in order, lang en: {draft}")
    out = await submit(None)
    check(out.startswith("NOT SENT") and "checked" in out, f"submit in the same turn as show refused: {out}")
    agent._visitor_turns = 4
    out = await submit(None)
    check(out.startswith("SENT"), f"submit after the visitor answered: {out}")
    check(len(recorded("project", n)) == 1 and len(screens(n, "project_request", status="sent")) == 1, "one email, one 'sent' card")
    agent._visitor_turns = 5
    out = await submit(None)
    check(out.startswith("NOT SENT AGAIN"), f"same request twice refused: {out}")
    check(len(recorded("project", n)) == 1, "still one email")

    print("— visitor names the tools are given, direct calls:")
    agent = worker.MiaAgent(tts=None, on_screen=lambda msg: calls.append(("screen", msg)))
    agent._chosen_language = "en"
    agent._visitor_lines = ["Hi, I'm here to see Alex, I have a meeting with him at two."]
    n = len(calls)
    for name in ("there", "Alex", "Alexandre", "the visitor", "David Chen"):
        out = await agent.notify_member(None, visitor_name=name, member="Alex", note="meeting at two")
        check(out.startswith("NOT SENT") and "name" in out, f"notify_member(visitor_name={name!r}) before any name: {out[:60]}")
        out = await agent.take_message(None, visitor_name=name, recipient="Alex", message="Running late.")
        check(out.startswith("NOT SENT"), f"take_message(visitor_name={name!r}) before any name: {out[:60]}")
    check(not recorded("notify", n) and not recorded("message", n), "nothing sent without the visitor's name")
    agent._visitor_lines.append("My name is David Chen.")
    out = await agent.notify_member(None, visitor_name="David Chen", member="Alex", note="meeting at two")
    check(out.startswith("NOTIFIED"), f"notify_member once the visitor said it: {out[:40]}")
    agent._visitor_said = "I have a suggestion: you should add background music in the lobby."
    out = await agent.send_suggestion(None, suggestion="You should add background music in the lobby.")
    check(out.startswith("NOT SENT yet"), f"send_suggestion in the turn it was dictated, before she repeats it: {out[:50]}")
    agent._visitor_said = "Yes, send it."
    out = await agent.send_suggestion(None, suggestion="Add music.", visitor_name="Sir")
    sent = recorded("suggestion", n)
    check(out.startswith("SENT") and sent and sent[0][3] == "", f"send_suggestion with a made-up name goes anonymous: {sent}")
    out = await agent.show_project_request(
        {"name": "there", "email": "d@chen.ca", "description": "An app", "company": "none", "timeline": "none", "budget": "none"}, None
    )
    check(out.startswith("NOT SHOWN") and "their name" in out, f"show_project_request with a made-up name: {out[:70]}")
    out = await agent.show_project_request({"name": "David Chen"}, None)
    check(out.startswith("SHOWN"), f"show_project_request with the name they said: {out[:40]}")


async def test_screen_claim_filter() -> None:
    """#6: "check your request on the screen" before show_project_request
    answered SHOWN is dropped from what she says. Scripted LLM, no Gemini."""
    print("— 'it's on the screen' before the draft is shown, scripted LLM:")
    import worker
    from livekit.agents.llm import ChatChunk, ChatContext, ChoiceDelta, FunctionToolCall

    script: list = []

    async def scripted(_agent, chat_ctx, tools, model_settings):
        for chunk in script:
            yield chunk

    def text(t: str) -> ChatChunk:
        return ChatChunk(id="t", delta=ChoiceDelta(role="assistant", content=t))

    async def run(agent, ctx, chunks: list) -> tuple[str, list]:
        script[:] = chunks
        out = [c async for c in agent.llm_node(ctx, [], None)]
        said = "".join(c if isinstance(c, str) else (c.delta.content or "") for c in out)
        return said, [c for c in out if isinstance(c, ChatChunk) and c.delta and c.delta.tool_calls]

    real = worker.Agent.default.llm_node
    worker.Agent.default.llm_node = scripted
    agent = worker.MiaAgent(tts=None)
    agent._screen_check_turn = 1  # no session here for the follow-up reply (SCREEN_CLAIM_NOTE)
    plain = worker.MiaAgent(tts=None)
    ctx = ChatContext.empty()
    ctx.add_message(role="user", content="Nous aimerions un site web pour vendre nos bouquets, c'est notre projet.")
    try:
        said, _ = await run(agent, ctx, [text("Merci Chloé ! Je vais afficher votre demande "), text("à l'écran. Quel est votre "), text("budget ?")])
        check("écran" not in said and "Merci" in said and "budget ?" in said, f"FR claim dropped, the rest kept: {said!r}")
        said, _ = await run(agent, ctx, [text("Veuillez vérifier sur l'écran si les détails de votre demande sont corrects.")])
        check(said == "", f"FR claim alone dropped: {said!r}")
        call = FunctionToolCall(name="show_project_request", arguments="{}", call_id="c1")
        said, calls_out = await run(agent, ctx, [text("Please take a look at the screen and let me know if everything looks right. "),
                                                 ChatChunk(id="t", delta=ChoiceDelta(role="assistant", tool_calls=[call]))])
        check(said == "" and len(calls_out) == 1, f"EN claim dropped, the tool call passes: {said!r} {len(calls_out)}")
        # Same step, but show_project_request answers SHOWN while she talks: then it's true, and said.
        shown_soon = asyncio.get_running_loop().call_later(0.3, setattr, agent, "_project_shown_at", 2)
        said, _ = await run(agent, ctx, [text("Parfait. Votre demande est affichée à l'écran, pouvez-vous la vérifier ? "),
                                         ChatChunk(id="t", delta=ChoiceDelta(role="assistant", tool_calls=[call]))])
        shown_soon.cancel()
        check("écran" in said and said.startswith("Parfait."), f"claim kept once the same step showed the draft: {said!r}")
        agent._project_shown_at = None
        said, _ = await run(agent, ctx, [text("Touchez l'écran et glissez le doigt pour vous déplacer. "),
                                         text("Nos coordonnées sont aussi à l'écran. Avez-vous un projet en tête ?")])
        check("Touchez l'écran" in said and "coordonnées" in said, f"other uses of the screen kept: {said!r}")
        agent._project_shown_at = 3
        said, _ = await run(agent, ctx, [text("Veuillez vérifier votre demande à l'écran.")])
        check("écran" in said, f"once shown, the screen may be mentioned: {said!r}")
        ctx = ChatContext.empty()
        ctx.add_message(role="user", content="Can I leave a message for Nicolas?")
        said, _ = await run(plain, ctx, [text("You'll see it on the screen in a moment, you can check everything there.")])
        check("screen" in said, f"no project talk: nothing dropped: {said!r}")
    finally:
        worker.Agent.default.llm_node = real
        for task in list(agent._tasks) + list(plain._tasks):
            task.cancel()


# ---------------------------------------------------------------- with Gemini


async def conv_contact_card() -> None:
    print("— #18 English, phone number → contact card:")
    n = len(calls)
    await converse("en", ["What's your phone number?"])
    check(len(screens(n, "contact_card", lang="en")) == 1, f"one contact card, lang en: {calls[n:]}")
    print("— #18 French, adresse → contact card:")
    n = len(calls)
    await converse("fr", ["Où sont vos bureaux ?"])
    check(len(screens(n, "contact_card", lang="fr")) == 1, f"one contact card, lang fr: {calls[n:]}")
    print("— #18 English, small talk → no card:")
    n = len(calls)
    await converse("en", ["How are you today?"])
    check(not screens(n, "contact_card"), "no card when she gives no contact details")


async def conv_sent_cards() -> None:
    print("— #18 French, message for the CEO → message_sent card:")
    n = len(calls)
    replies = await converse("fr", [
        "Bonjour, je voudrais laisser un message pour le PDG.",
        "Je m'appelle Julie Tremblay.",
        "Dites-lui que je passerai demain matin pour signer le contrat.",
        "Oui, c'est bien ça. Pas besoin de me rappeler.",
    ])
    sent = screens(n, "message_sent", kind="message", to="Nicolas Bastien", lang="fr")
    check(len(recorded("message", n)) == 1 and len(sent) == 1, f"one message, one card to Nicolas Bastien in fr: {sent}")
    check(has(replies[-1], "envoyé"), "says it's sent")

    print("— #18 English, general inbox → card names the inbox:")
    n = len(calls)
    await converse("en", [
        "I'd like to leave a message for the team.",
        "Kevin Roy.",
        "Do you hire summer interns in design?",
        "Yes, that's it.",
    ])
    sent = screens(n, "message_sent", kind="message")
    check(len(sent) == 1 and sent[0].get("to") == "the general inbox", f"card to 'the general inbox': {sent}")

    print("— #18 English, notify → card:")
    n = len(calls)
    await converse("en", ["Hi, I'm here to see Alex, I have a meeting at two.", "My name is David Chen."])
    sent = screens(n, "message_sent", kind="notify", to="Alexandre Joset", lang="en")
    check(len(recorded("notify", n)) == 1 and len(sent) == 1, f"one notify, one card: {sent}")

    print("— #18 + guard English, emergency → alert card, never 'received':")
    n = len(calls)
    replies = await converse("en", ["Help, there's smoke coming from the hallway!", "Did they get your email? Are they coming?"])
    check(len(recorded("emergency", n)) == 1 and len(screens(n, "message_sent", kind="alert")) == 1, "one alert, one card")
    check(has(replies[0], "911", "nine one one"), "911 first")
    # "I don't know if they've read it or if they're coming" is right; "they
    # received it" is not. A sentence that says she doesn't know claims nothing.
    sentences = [s for r in replies for s in re.split(r"(?<=[.!?])\s+", r)]
    claims = [s for s in sentences
              if has(s, "received", "they got it", "they've got it", "on their way", "they're coming", "help is coming")
              and not has(s, "know", "not sure", "can't say", "cannot say")]
    check(not claims, f"never claims the team received it or is coming: {claims}")
    print("— guard French, urgence:")
    n = len(calls)
    replies = await converse("fr", ["Au secours, quelqu'un est tombé et ne bouge plus !", "Est-ce qu'ils ont reçu votre courriel ?"])
    check(len(recorded("emergency", n)) == 1, "one alert (FR)")
    # "Je ne sais pas s'ils l'ont reçu" is right; "ils l'ont reçu" is not.
    claims = re.compile(r"(?<!s')ils (l')?ont (bien )?reçu|a bien été reçu|sont en route|arrivent", re.I)
    check(not any(claims.search(r) for r in replies), "never 'ils ont reçu' (FR)")


async def conv_guard() -> None:
    print("— #5 guard English, asking whether the message went through:")
    n = len(calls)
    replies = await converse("en", [
        "I'd like to leave a message for Nicolas.",
        "Sam Fortin.",
        "Please call me back about the demo next week.",
        "Yes, correct.",
        "Did it really go through? Can you make sure he gets it?",
        "OK. Actually yes, please send it again, just in case.",
    ])
    sent = recorded("message", n)
    check(len(sent) == 2, f"sent once, then again only when asked again: {len(sent)} sent")
    check(has(replies[4], "sent", "already"), "says it's already sent")
    print("— #5 guard French, notify twice:")
    n = len(calls)
    await converse("fr", [
        "Bonjour, j'ai rendez-vous avec Alexandre. Je suis Lucie Bouchard.",
        "Vous pouvez le prévenir que je suis là ?",
    ])
    check(len(recorded("notify", n)) == 1, f"Alexandre told once: {recorded('notify', n)}")


async def conv_suggestion() -> None:
    print("— #17 English, suggestion box:")
    n = len(calls)
    replies = await converse("en", [
        "I have a suggestion for you guys.",
        "You should add background music in this virtual office.",
        "Yes, send it.",
    ])
    sent = recorded("suggestion", n)
    check(len(sent) == 1 and sent[0][1] == "the general inbox" and has(sent[0][2], "music"), f"one suggestion to the inbox: {sent}")
    check(len(screens(n, "message_sent", kind="suggestion", lang="en")) == 1, "suggestion card, lang en")
    check(has(replies[-1], "sent", "thank"), "confirms by voice")
    check(not any(has(r, "sent") for r in replies[:-1]), "never says sent before the tool ran")
    print("— #17 French, boîte à suggestions, with a name:")
    n = len(calls)
    replies = await converse("fr", [
        "J'aimerais laisser une suggestion : vous devriez afficher les heures d'ouverture à l'écran.",
        "Oui, c'est ça. Je m'appelle Marc Lefebvre.",
    ])
    if not recorded("suggestion", n):
        replies += await converse("fr", ["Oui, envoyez-la."])
    sent = recorded("suggestion", n)
    check(len(sent) == 1 and has(sent[0][2], "heure"), f"one suggestion (FR): {sent}")
    check(len(screens(n, "message_sent", kind="suggestion", lang="fr")) == 1, "suggestion card, lang fr")
    check(has(replies[-1], "envoyée", "envoyé", "merci"), "confirms by voice (FR)")


# Her question -> which detail she is asking for. Checked in this order: "what's
# your budget for the project" is about the budget, not the project.
ASKS = [
    ("budget", ("budget",)),
    ("timeline", ("timeline", "when would", "when do you", "time frame", "timeframe", "deadline",
                  "échéancier", "échéance", "délai", "quand ", "période", "calendrier")),
    ("contact", ("email", "e-mail", "phone", "reach you", "contact you", "courriel", "téléphone", "joindre", "numéro")),
    ("company", ("company", "business", "bakery called", "name of your bakery", "entreprise", "société", "compagnie")),
    ("name", ("your name", "votre nom", "vous appelez")),
    # Not every sentence with "project" in it: "une demande de projet, c'est bien ça ?" is a yes/no.
    ("description", ("describe", "décri", "app to do", "tell me about your project", "tell me more about your project",
                     "what is your project", "what's your project", "quel est votre projet", "parlez-moi de votre projet",
                     "en quelques mots", "what kind of", "quel type de", "quel genre de")),
]


def asked_for(reply: str) -> str | None:
    """Which project detail her reply asks for (in its last sentence), if any."""
    questions = [q for q in re.split(r"(?<=[.!?])\s+", reply) if q.rstrip().endswith("?")]
    if not questions:
        return None
    low = questions[-1].lower()
    for key, words in ASKS:
        if any(w in low for w in words):
            return key
    return None


async def project_flow(c: Conversation, n: int, first: str, answers: dict[str, str], given: set[str], what: str) -> None:
    """Answer each of her questions until the draft is on screen. `first`: her
    reply so far; `given`: details the visitor already said, never to be asked."""
    replies: list[str] = []
    asked: list[str] = []
    reply = first
    for _ in range(9):
        if screens(n, "project_request", status="draft"):
            break
        key = asked_for(reply)
        if key:
            asked.append(key)
        reply = await c.say(answers.get(key, answers["other"]))
        replies.append(reply)
    repeats = [k for k in asked if k in given] + [k for i, k in enumerate(asked) if k in asked[:i]]
    check(not repeats, f"{what}: never asks for what she already has (asked {asked})")
    early = [r for r in replies[:-1] if has(r, "on the screen", "à l'écran", "sur l'écran")]
    check(not early, f"{what}: no 'it's on the screen' before the draft was shown")


async def conv_project_en() -> None:
    print("— #20 English, full project request with a correction:")
    n = len(calls)
    async with Conversation("en") as c:
        reply = await c.say("Hi! What does Mobile Apps Labs do?")
        check(has(reply, "project in mind", "a project"), "asks if they have a project in mind after explaining")
        reply = await c.say("Yes, actually. I'd like a mobile app for my bakery, for loyalty points.")
        await project_flow(c, n, reply, {
            "name": "Ana Silva.",
            "company": "It's called Pain Doré.",
            "contact": "You can email me at ana at paindore dot ca.",
            "timeline": "Within three months, ideally.",
            "budget": "Around twenty thousand dollars.",
            "description": "A loyalty points app for my bakery customers.",
            "other": "Yes.",
        }, {"description"}, "#20 EN")
        drafts = screens(n, "project_request", status="draft")
        check(bool(drafts), "draft shown on screen")
        if drafts:
            f = drafts[-1]["fields"]
            print(f"   draft: {json.dumps(f, ensure_ascii=False)}")
            check(has(f.get("name", ""), "Ana") and has(f.get("email", ""), "ana@paindore.ca"), "draft has name and the email as an address")
            check(has(f.get("description", ""), "bakery", "loyalty"), "draft has the project")
            check(drafts[-1].get("lang") == "en", "draft lang en")
        check(not recorded("project", n), "nothing sent before the visitor checked it")
        k = len(calls)
        await c.say("Oh, the company name is Pain Doré Bakery, with Bakery at the end.")
        drafts2 = screens(k, "project_request", status="draft")
        check(bool(drafts2) and has(drafts2[-1]["fields"].get("company", ""), "Bakery"),
              f"correction applied on screen: {drafts2[-1]['fields'] if drafts2 else None}")
        check(not recorded("project", n), "still nothing sent after a correction")
        reply = await c.say("Yes, that's all correct now. Please send it.")
        sent = recorded("project", n)
        check(len(sent) == 1 and has(sent[0][2].get("company", ""), "Bakery") and sent[0][1] == "the general inbox",
              f"one request to the general inbox, corrected: {sent}")
        check(len(screens(n, "project_request", status="sent")) == 1, "'sent' shown on screen")
        check(has(reply, "sent"), "says it's sent")
        await c.say("Great. Did it really go through?")
        check(len(recorded("project", n)) == 1, "not sent twice when asked whether it went through")


async def conv_project_fr() -> None:
    print("— #20 French, details given up front, skipping what she knows:")
    n = len(calls)
    async with Conversation("fr") as c:
        reply = await c.say(
            "Bonjour, ici Chloé Bergeron, je travaille chez Fleuriste Bergeron. "
            "Nous aimerions un site web pour vendre nos bouquets en ligne."
        )
        if not asked_for(reply):  # she may first ask whether he wants a request sent
            reply = await c.say("Oui, s'il vous plaît.")
        await project_flow(c, n, reply, {
            "name": "Chloé Bergeron.",
            "company": "Fleuriste Bergeron.",
            "contact": "Mon numéro, c'est le 450 555 0123.",
            "timeline": "Pas de date précise.",
            "budget": "Je préfère ne pas le dire.",
            "description": "Un site web pour vendre nos bouquets en ligne.",
            "other": "Oui.",
        }, {"name", "company", "description"}, "#20 FR")
        drafts = screens(n, "project_request", status="draft")
        check(bool(drafts) and drafts[-1].get("lang") == "fr", "draft shown, lang fr")
        if drafts:
            f = drafts[-1]["fields"]
            print(f"   draft: {json.dumps(f, ensure_ascii=False)}")
            check(has(f.get("company", ""), "Fleuriste") and has(f.get("phone", "").replace(" ", ""), "4505550123"),
                  "draft: company and phone in digits")
        reply = await c.say("Oui, c'est parfait, envoyez-la.")
        check(len(recorded("project", n)) == 1, f"one project request sent: {recorded('project', n)}")
        check(has(reply, "envoyée", "envoyé"), "says it's sent (FR)")


async def conv_taps() -> None:
    """mia.control: resume and wake, on a text-only session."""
    print("— #24 resume tapped while paused, then wake:")
    import worker

    async with Conversation("fr") as c:
        agent, session = c.agent, c.session
        await c.say("Bonjour !")
        said: list[str] = []
        session.say = lambda text, **kw: said.append(text)  # no TTS in text mode

        check(agent.resume_by_tap() is None, "resume while not paused: ignored")
        agent._set_paused(True)
        handle = agent.resume_by_tap()
        check(not agent.paused and handle is not None, "resume: no longer paused, replies")
        if handle is not None:
            await handle
        reply = next(
            (i.text_content for i in reversed(agent.chat_ctx.items)
             if getattr(i, "type", "") == "message" and i.role == "assistant"), ""
        )
        print(f"   MIA after the tap: {reply}")
        check(bool(reply) and has(reply, "écoute", "aider", "comment", "oui"), "resume: answers in French that she's listening")

        agent.wake_by_tap()
        check(said == [worker.WAKE_LINE["fr"]], f"wake while listening: {said}")
        agent._set_paused(True)
        agent.wake_by_tap()
        check(said == [worker.WAKE_LINE["fr"]], "wake while paused: ignored")
        agent._set_paused(False)
        agent._chosen_language = None
        agent.wake_by_tap()
        check(said[-1] == worker.WAKE_LINE_BOTH, "wake before a language is chosen: both languages")


async def conv_false_claim() -> None:
    """She says she told someone the visitor is here without calling
    notify_member: the worker's check has her call it."""
    print("— guard: 'J'ai prévenu Alexandre' without notify_member:")
    import worker

    n = len(calls)
    async with Conversation("fr") as c:
        agent = c.agent
        # The lie, as Gemini told it on the base branch: no tool call.
        history = agent.chat_ctx.copy()
        history.add_message(role="user", content="Bonjour, j'ai rendez-vous avec Alexandre. Je suis Lucie Bouchard.")
        lie = "J'ai prévenu Alexandre que vous êtes ici, il va vous revenir. Voulez-vous lui laisser un message aussi ?"
        history.add_message(role="assistant", content=lie)
        await agent.update_chat_ctx(history)
        agent._visitor_turns = 1
        check(bool(worker.NOTIFY_CLAIM.search(lie)), "the claim is recognised")
        seen = len(c.session.history.items)
        await agent._check_notify_claim(1, lie)
        for _ in range(3):
            await asyncio.sleep(0.5)
            while (speech := c.session.current_speech) is not None:
                await speech
        said = " ".join(i.text_content for i in c.session.history.items[seen:]
                        if getattr(i, "type", "") == "message" and i.role == "assistant" and i.text_content)
        print(f"   MIA, after the check: {said}")
        notified = recorded("notify", n)
        check(len(notified) == 1 and notified[0][1] == "Alexandre Joset" and has(notified[0][2], "Lucie"),
              f"the check made her notify Alexandre: {notified}")
    for line in ("Would you like me to let Nicolas know you're here?", "Voulez-vous que je prévienne Nicolas ?",
                 "I've let you know the address.", "Je l'ai déjà prévenu."):
        check(not worker.NOTIFY_CLAIM.search(line), f"not a claim: {line!r}")


SCENARIOS = {
    "contact": conv_contact_card,
    "cards": conv_sent_cards,
    "guard": conv_guard,
    "suggestion": conv_suggestion,
    "project_en": conv_project_en,
    "project_fr": conv_project_fr,
    "taps": conv_taps,
    "false_claim": conv_false_claim,
}


async def main() -> None:
    import worker

    use_assistant_name(worker)
    install_recorders(worker)
    test_offline()
    await test_tool_guards()
    await test_screen_claim_filter()
    for name in sys.argv[1:] or SCENARIOS:
        await SCENARIOS[name]()
    print(f"\n{len(failures)} failed check(s)" + "".join(f"\n  ✗ {f}" for f in failures))
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    asyncio.run(main())
