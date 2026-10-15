"""Screen buttons (#2, Chat U): she knows the kiosk's buttons, names where
they are, and presses them with press_button only when the visitor asks or
agrees — never on her own, and with a warning first for vr and mute.

Same harness as test_team_messages.py — real Gemini, every mia.screen message
recorded as ("screen", msg). Run inside the worker image:

    docker run --rm --env-file .env -v "$PWD":/app -w /app -e RESEND_API_KEY= simli-worker python test_press_button.py

Pass scenario names to run only those, e.g. `python test_press_button.py vr_en`.
Offline checks always run first. Every check runs; failures are listed at the
end (exit 1 if any).
"""

import asyncio
import sys

from screen_cards import PRESS_BUTTONS, press
from test_team_messages import Conversation, calls, install_recorders, use_assistant_name

failures: list[str] = []


def check(ok: bool, what: str) -> None:
    print(f"{'✓' if ok else '✗'} {what}")
    if not ok:
        failures.append(what)


def has(text: str, *words: str) -> bool:
    low = text.lower()
    return any(w.lower() in low for w in words)


def presses(since: int) -> list[str]:
    """The buttons pressed (mia.screen "press" messages) since `since`."""
    return [c[1]["button"] for c in calls[since:] if c[0] == "screen" and c[1].get("type") == "press"]


# ---------------------------------------------------------------- offline


async def test_tool() -> None:
    """press_button itself, called directly (no Gemini)."""
    print("— press_button, direct calls:")
    import worker

    agent = worker.MiaAgent(tts=None, on_screen=lambda msg: calls.append(("screen", msg)))
    n = len(calls)

    check(press("contact") == {"type": "press", "button": "contact"}, "screen_cards.press builds the message")

    for name in PRESS_BUTTONS:
        answer = await agent.press_button(None, name)
        if name in ("vr", "mute"):
            check(answer is None, f"{name}: no reply after the tool (she already warned)")
        else:
            check(answer is not None and answer.startswith("PRESSED"), f"{name}: PRESSED")
    check(presses(n) == list(PRESS_BUTTONS), f"every allowed button was sent to the screen: {presses(n)}")

    n = len(calls)
    for given, want in (("Contact card", "contact"), ("VR mode", "vr"), ("public meeting room", "public_meeting"),
                        ("MEETING", "meeting_room"), ("recenter camera", "recenter")):
        await agent.press_button(None, given)
        check(presses(n)[-1:] == [want], f"{given!r} folds to {want}")

    n = len(calls)
    answer = await agent.press_button(None, "self destruct")
    check(answer.startswith("NOT PRESSED"), "an unknown button answers NOT PRESSED")
    check(presses(n) == [], "and nothing reaches the screen")


# ---------------------------------------------------------------- Gemini


async def conv_names_buttons_en() -> None:
    """EN: asked where things are, she describes accurately and presses nothing."""
    print("— EN: names the buttons, presses only on request:")
    async with Conversation("en") as c:
        n = len(calls)
        reply = await c.say("Where is the sound button on this screen?")
        print(f"   MIA: {reply}")
        check(has(reply, "bottom left"), "the sound button is at the bottom left")
        check(presses(n) == [], "describing is not pressing")

        reply = await c.say("And what does the button with the headset do?")
        print(f"   MIA: {reply}")
        check(has(reply, "vr", "virtual reality"), "the headset button is the VR view")
        check(presses(n) == [], "still nothing pressed")

        reply = await c.say("Can you open your contact card on the screen for me?")
        print(f"   MIA: {reply}")
        check(presses(n) == ["contact"], f"asked for the contact card, she presses contact: {presses(n)}")
        check(has(reply, "screen"), "and tells the visitor to look at the screen")


async def conv_meeting_room_en() -> None:
    """EN: the public meeting room opens on request; nothing opens unasked."""
    print("— EN: meeting rooms:")
    async with Conversation("en") as c:
        n = len(calls)
        reply = await c.say("What does Mobile Apps Labs do?")
        print(f"   MIA: {reply}")
        check(presses(n) == [], "an ordinary question presses nothing")

        reply = await c.say("Could you open the public meeting room for me?")
        print(f"   MIA: {reply}")
        check(presses(n) == ["public_meeting"], f"she presses public_meeting: {presses(n)}")
        check(has(reply, "screen"), "and says it is on the screen")


async def conv_vr_warns_en() -> None:
    """EN: VR needs a warning that she disappears, and a yes, before the press."""
    print("— EN: VR warns first:")
    async with Conversation("en") as c:
        n = len(calls)
        reply = await c.say("Turn on VR mode please.")
        print(f"   MIA: {reply}")
        check(presses(n) == [], "no press before the visitor confirms")
        check(has(reply, "disappear", "won't see me", "will not see me", "video"), "she warns that her video disappears")

        reply = await c.say("Yes, go ahead.")
        print(f"   MIA: {reply}")
        check(presses(n) == ["vr"], f"after the yes she presses vr: {presses(n)}")


async def conv_fr() -> None:
    """FR: places in French, press on request, refusal names what she has."""
    print("— FR: boutons en français:")
    async with Conversation("fr") as c:
        n = len(calls)
        reply = await c.say("Où est le bouton du son sur cet écran ?")
        print(f"   MIA: {reply}")
        check(has(reply, "en bas à gauche", "bas a gauche", "en bas, à gauche"), "le bouton du son est en bas à gauche")
        check(presses(n) == [], "décrire n'est pas appuyer")

        reply = await c.say("Ouvrez la salle de réunion publique, s'il vous plaît.")
        print(f"   MIA: {reply}")
        check(presses(n) == ["public_meeting"], f"elle appuie public_meeting: {presses(n)}")

        reply = await c.say("Pouvez-vous appuyer sur le bouton qui ouvre la porte ?")
        print(f"   MIA: {reply}")
        check(presses(n) == ["public_meeting"], "pas de bouton de porte: rien de plus n'est appuyé")


SCENARIOS = {
    "names_en": conv_names_buttons_en,
    "meeting_en": conv_meeting_room_en,
    "vr_en": conv_vr_warns_en,
    "fr": conv_fr,
}


async def main() -> None:
    import worker

    use_assistant_name(worker)
    install_recorders(worker)
    await test_tool()
    for name in sys.argv[1:] or SCENARIOS:
        await SCENARIOS[name]()
    print(f"\n{len(failures)} failed check(s)" + "".join(f"\n  ✗ {f}" for f in failures))
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    asyncio.run(main())
