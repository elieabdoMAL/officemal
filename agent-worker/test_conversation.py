"""Text conversations for the language lock and pause mode, against the real
Gemini model. Run inside the worker image, emails disabled:

    docker run --rm --env-file .env -e RESEND_API_KEY= -v "$PWD":/app -w /app simli-worker python test_conversation.py

Each visitor line goes through MiaAgent.on_user_turn_completed exactly as a
spoken turn does (test_team_messages.py skips it), with the language Deepgram
would report, so the lock, the pause and the per-turn notes are the real code.
Gemini calls are counted at the source, to prove a paused Mia makes none.

Pass test names to run only those, e.g. `python test_conversation.py pause`.
"""

import asyncio
import re
import sys

from livekit.agents import Agent, AgentSession, StopResponse
from livekit.agents.llm import ChatMessage
from livekit.plugins import google

import worker
from conversation_control import speak_digits

# Every real Gemini call, counted under MiaAgent's paused guard.
llm_calls = 0
_real_llm_node = Agent.default.llm_node


async def _counting_llm_node(agent, chat_ctx, tools, model_settings):
    global llm_calls
    llm_calls += 1
    async for chunk in _real_llm_node(agent, chat_ctx, tools, model_settings):
        yield chunk


Agent.default.llm_node = _counting_llm_node


class FakeSTT:
    """Stands in for deepgram.STT: records the language the lock asks for."""

    def __init__(self) -> None:
        self.language = worker.STT_MULTI

    def update_options(self, *, language: str) -> None:
        self.language = language


_FR = {"je", "vous", "le", "la", "les", "de", "des", "est", "pour", "avec", "une", "un", "nous", "bien", "suis", "votre", "en", "et", "à", "que"}
_EN = {"i", "you", "the", "is", "to", "and", "we", "for", "with", "our", "can", "a", "of", "are", "your", "it", "in", "how", "help"}


def language_of(text: str) -> str:
    words = re.findall(r"[a-zà-ÿ']+", text.lower())
    fr = sum(w in _FR for w in words)
    en = sum(w in _EN for w in words)
    return "fr" if fr > en else "en"


class Conversation:
    def __init__(self, title: str) -> None:
        print(f"— {title}")
        self.stt = FakeSTT()
        self.voices: list[str] = []
        self.statuses: list[tuple[bool, str | None]] = []
        self.agent = worker.MiaAgent(tts=None, stt=self.stt, on_status=self._on_status)
        self.agent._tts = None
        self.agent._speak_in = self.voices.append
        self.note = ""
        self.said: list[str] = []

    def _on_status(self) -> None:
        self.statuses.append((self.agent.paused, self.agent.chosen_language))

    async def __aenter__(self) -> "Conversation":
        agent = self.agent
        history = agent.chat_ctx.copy()
        history.add_message(role="assistant", content=worker.FIRST_MESSAGE)
        await agent.update_chat_ctx(history)
        print(f"  MIA:     {worker.FIRST_MESSAGE}")

        # session.run() takes the line as typed input and skips
        # on_user_turn_completed; turn() runs that hook itself and hands its
        # note to Gemini here, the way the hook's turn_ctx would.
        guarded_llm_node = agent.llm_node

        async def llm_node(chat_ctx, tools, model_settings):
            chat_ctx = chat_ctx.copy()
            if self.note:
                chat_ctx.add_message(role="system", content=self.note)
            async for chunk in guarded_llm_node(chat_ctx, tools, model_settings):
                yield chunk

        agent.llm_node = llm_node
        llm = google.LLM(model="gemini-2.5-flash", thinking_config={"thinking_budget": 0})
        self.session = AgentSession(llm=llm)
        await self.session.__aenter__()

        @self.session.on("conversation_item_added")
        def _on_item(ev) -> None:
            if getattr(ev.item, "role", None) == "assistant" and ev.item.text_content:
                self.said.append(ev.item.text_content)

        await self.session.start(agent)
        return self

    async def __aexit__(self, *exc) -> None:
        await self.session.__aexit__(*exc)

    async def turn(self, line: str, heard_as: str) -> dict:
        """The visitor says `line`; Deepgram reports language `heard_as`."""
        agent = self.agent
        agent._last_raw_language = heard_as
        agent._last_language = worker._normalize_lang(heard_as)
        agent._last_confidence = 0.95
        calls_before, said_before = llm_calls, len(self.said)
        turn_ctx = agent.chat_ctx.copy()
        replied = True
        try:
            await agent.on_user_turn_completed(turn_ctx, ChatMessage(role="user", content=[line]))
        except StopResponse:
            replied = False
        if replied:
            self.note = turn_ctx.items[-1].text_content
            await self.session.run(user_input=line)
        await asyncio.sleep(0.5)  # a say() from the hook or a tool lands asynchronously
        reply = " ".join(self.said[said_before:])
        state = "PAUSED" if agent.paused else "listening"
        tag = f"[stt={self.stt.language} voice={self.voices[-1] if self.voices else '-'} {state} llm_calls={llm_calls - calls_before}]"
        print(f"  VISITOR: {line}   (heard as {heard_as})\n  MIA:     {reply or '(nothing)'}   {tag}")
        return {"reply": reply, "llm_calls": llm_calls - calls_before, "paused": agent.paused}


async def conv_choose_english() -> None:
    async with Conversation("English chosen, then stays English (even on a line Deepgram calls French)") as c:
        r = await c.turn("English, please.", "en")
        assert c.agent.chosen_language == "en" and c.stt.language == "en", "English must lock the STT to English"
        assert language_of(r["reply"]) == "en", r
        r = await c.turn("What does Mobile Apps Labs do?", "en")
        assert language_of(r["reply"]) == "en", r
        # Before the lock, a misdetected line flipped her to French (#4).
        r = await c.turn("Okay. And where is the office?", "fr")
        assert c.agent.chosen_language == "en" and language_of(r["reply"]) == "en", r
        assert c.voices[-1] == "en"
    print("✓ English locked: STT en, English voice, English replies")


async def conv_first_line_decides() -> None:
    async with Conversation("No language named: the first answer's language decides") as c:
        r = await c.turn("Bonjour, vous faites quoi exactement chez Mobile Apps Labs?", "fr")
        assert c.agent.chosen_language == "fr" and c.stt.language == "fr-CA", "French must lock STT to fr-CA"
        assert language_of(r["reply"]) == "fr", r
    print("✓ French locked from a French question")


async def conv_switch() -> None:
    async with Conversation("French, then an explicit switch to English, then back") as c:
        await c.turn("Français.", "fr")
        assert c.agent.chosen_language == "fr"
        r = await c.turn("Je veux parler en anglais.", "fr")
        assert c.agent.chosen_language == "en" and c.stt.language == "en", "explicit request must switch"
        assert language_of(r["reply"]) == "en", r
        r = await c.turn("What's your phone number?", "en")
        assert language_of(r["reply"]) == "en", r
        print(f"  (as the TTS gets it: {speak_digits(r['reply'], 'en')!r})")
        r = await c.turn("Can we speak French, please?", "en")
        assert c.agent.chosen_language == "fr" and language_of(r["reply"]) == "fr", r
    print("✓ switched only on request, both ways")


async def conv_pause() -> None:
    async with Conversation("Pause in English: stop, ignore others, wake by name") as c:
        await c.turn("English.", "en")
        calls_before = llm_calls
        r = await c.turn("Stop talking.", "en")
        assert r["paused"] and r["reply"] == worker.PAUSE_LINE["en"], r
        assert r["llm_calls"] == 0, "the pause line must not come from Gemini"
        for line in [
            "So anyway, the meeting moved to three o'clock.",
            "Did you bring the contract?",
            "Yeah, I'll call Nicolas about it tomorrow.",
        ]:
            r = await c.turn(line, "en")
            assert r["paused"] and not r["reply"] and r["llm_calls"] == 0, f"paused Mia must ignore {line!r}: {r}"
        assert llm_calls == calls_before, "no Gemini call at all while paused"
        r = await c.turn("Mia, what's your phone number?", "en")
        assert not r["paused"] and r["reply"] and language_of(r["reply"]) == "en", r
        assert ("five" in r["reply"].lower()) or ("514" in r["reply"]), f"should answer the question: {r}"
        assert (True, "en") in c.statuses and c.statuses[-1] == (False, "en"), c.statuses
    print("✓ paused on 'stop talking', ignored 3 lines with 0 LLM calls, resumed on her name")

    async with Conversation("Pause in French: tais-toi, then just her name") as c:
        await c.turn("Français, s'il vous plaît.", "fr")
        r = await c.turn("Tais-toi.", "fr")
        assert r["paused"] and r["reply"] == worker.PAUSE_LINE["fr"], r
        r = await c.turn("Oui, on se voit à midi.", "fr")
        assert r["paused"] and not r["reply"], r
        r = await c.turn("Assistante?", "fr")
        assert not r["paused"] and language_of(r["reply"]) == "fr", r
    print("✓ French pause line, woken by 'assistante'")


async def conv_pause_tool() -> None:
    async with Conversation("Pause asked in words the code doesn't match: Gemini's tool") as c:
        await c.turn("English please.", "en")
        r = await c.turn("Could you please be silent for a little while? My colleague just arrived.", "en")
        assert r["paused"], f"expected pause_conversation to be called: {r}"
        assert worker.PAUSE_LINE["en"] in r["reply"], r
        r = await c.turn("Hi Marc, how was the drive?", "en")
        assert not r["reply"] and r["llm_calls"] == 0, r
    print("✓ pause_conversation tool paused her, and she then ignored speech")


CONVERSATIONS = {
    "english": conv_choose_english,
    "first": conv_first_line_decides,
    "switch": conv_switch,
    "pause": conv_pause,
    "tool": conv_pause_tool,
}


async def main() -> None:
    from test_team_messages import install_recorders

    install_recorders(worker)  # no email can leave, whatever she decides
    for name in sys.argv[1:] or CONVERSATIONS:
        await CONVERSATIONS[name]()


if __name__ == "__main__":
    asyncio.run(main())
