"""Checks for the TTS choice and the voice settings in worker.py.

Offline (no keys, no network):

    docker run --rm -v "$PWD":/app -w /app simli-worker python test_tts.py

With --live and the real keys, also checks that Aura takes over when Cartesia
fails, using a Cartesia key that is refused (CARTESIA_API_KEY=bad) — she must
never go silent:

    docker run --rm --env-file <main .env> -e CARTESIA_API_KEY=bad -v "$PWD":/app -w /app \
        simli-worker python test_tts.py --live

The provider is read when worker.py is imported, so each case runs in a fresh
Python process with its own environment.
"""

import asyncio
import os
import subprocess
import sys
import time

DUMMY = {"DEEPGRAM_API_KEY": "x", "CARTESIA_API_KEY": "x", "GOOGLE_API_KEY": "x"}
# The voice settings, cleared so each case sees only its own (keys are kept for --live).
TTS_VARS = [
    k for k in os.environ if k.startswith(("TTS_", "CARTESIA_", "ELEVENLABS_", "ELEVEN_")) and not k.endswith("API_KEY")
]


def run_case(case: str, env: dict[str, str]) -> None:
    clean = {k: v for k, v in os.environ.items() if k not in TTS_VARS}
    if "--live" not in sys.argv:
        clean.update(DUMMY)
    clean.update(env)
    out = subprocess.run([sys.executable, __file__, "--case", case], env=clean, capture_output=True, text=True)
    if out.returncode != 0:
        print(out.stdout, out.stderr)
        raise SystemExit(f"✗ {case} {env}")
    print(out.stdout.strip())


# --- cases, each in its own process -----------------------------------------


def case_provider() -> None:
    import worker

    expected = os.environ["EXPECT"]
    assert worker.TTS_PROVIDER == expected, (os.environ.get("TTS_PROVIDER"), worker.TTS_PROVIDER)
    tts = worker.make_tts()
    kind = type(tts).__name__
    assert kind == {"deepgram": "TTS", "cartesia": "CartesiaVoice"}[expected], kind
    print(f"✓ TTS_PROVIDER={os.environ.get('TTS_PROVIDER')!r} -> {expected}")


def case_cartesia_settings() -> None:
    import worker

    tts = worker.make_tts()
    c, aura = tts.cartesia._opts, tts.aura._opts
    # The greeting: French voice, as Aura's DEFAULT_LANG.
    assert (c.language.language, c.voice, c.speed, c.emotion) == ("fr", worker.JOSETTE_VOICE_ID, 1.1, None), c
    assert c.model == "sonic-3", c.model
    assert tts.cartesia._sentence_tokenizer._config.min_sentence_len == worker.CARTESIA_MIN_SENTENCE_LEN
    assert aura.model == worker.VOICE_BY_LANG["fr"]
    tts.speak_in("en")
    assert (c.language.language, c.speed, c.emotion) == ("en", 1.0, ["content"]), c
    assert aura.model == worker.VOICE_BY_LANG["en"]
    tts.speak_in("fr")
    assert (c.language.language, c.speed, c.emotion) == ("fr", 1.1, None), c
    assert aura.model == worker.VOICE_BY_LANG["fr"]
    assert not tts.on_aura
    print("✓ Cartesia: French voice for the greeting, per-language voice, speed and emotion, Aura follows")


def case_cartesia_env() -> None:
    import worker

    assert worker.CARTESIA_VOICE_BY_LANG == {"fr": "v-fr", "en": "v-en"}, worker.CARTESIA_VOICE_BY_LANG
    # "fast" isn't a number: default. 3 is out of Sonic-3's range: clamped.
    assert worker.CARTESIA_SPEED_BY_LANG == {"fr": 1.1, "en": 1.5}, worker.CARTESIA_SPEED_BY_LANG
    assert worker.CARTESIA_EMOTION_EN == "" and worker.CARTESIA_MODEL == "sonic-2"
    tts = worker.make_tts()
    tts.speak_in("en")
    assert tts.cartesia._opts.emotion is None and tts.cartesia._opts.voice == "v-en"
    print("✓ Cartesia env: voices, speeds (bad and out-of-range values), no emotion, model")


async def _what_the_voice_gets(agent, text: str) -> str:
    import worker

    got: list[str] = []

    async def fake_tts_node(self, text, model_settings):
        async for chunk in text:
            got.append(chunk)
        return
        yield

    worker.Agent.default.tts_node = fake_tts_node

    async def gen():
        for word in text.split(" "):
            yield word + " "

    async for _ in agent.tts_node(gen(), None):
        pass
    return "".join(got).strip()


def case_rewrites() -> None:
    """What reaches the voice: digits for everyone; the Aura-only rewrites
    ("Inglish", the one-word opening joined) only while Aura speaks."""
    import worker

    async def main() -> None:
        tts = worker.make_tts()
        agent = worker.MiaAgent(tts=tts)
        greeting = "Bonjour, hello! Français ou English?"
        bye = "Goodbye! Have a great day!"
        phone = "Notre numéro: 514 573-2324."
        agent._speak_in("fr")
        assert await _what_the_voice_gets(agent, greeting) == greeting
        assert await _what_the_voice_gets(agent, phone) == "Notre numéro: cinq un quatre, cinq sept trois, deux trois deux quatre."
        agent._speak_in("en")
        assert await _what_the_voice_gets(agent, bye) == bye
        tts._status[0].available = False  # Cartesia failed: Aura speaks
        assert tts.on_aura
        assert await _what_the_voice_gets(agent, bye) == "Goodbye, Have a great day!"
        agent._speak_in("fr")
        assert await _what_the_voice_gets(agent, greeting) == "Bonjour, hello! Français ou Inglish?"
        print("✓ Cartesia gets the text as written (digits spelled); Aura's rewrites only while Aura speaks")

    asyncio.run(main())


def case_live_fallback() -> None:
    """A refused Cartesia key: the reply still comes out, from Aura."""
    import aiohttp

    from livekit.agents import utils

    import worker

    async def main() -> None:
        async with aiohttp.ClientSession() as http:
            utils.http_context._ContextVar.set(lambda: http)  # what a job context provides
            tts = worker.make_tts()
            started = time.perf_counter()
            first = None
            stream = tts.stream()
            stream.push_text("Bonjour! Je suis là.")
            stream.end_input()
            seconds = 0.0
            async for ev in stream:
                first = first or time.perf_counter() - started
                seconds += ev.frame.samples_per_channel / ev.frame.sample_rate
            await stream.aclose()
            assert seconds > 0.5, seconds
            assert tts.on_aura
            await tts.aclose()
            print(f"✓ Cartesia refused: Aura said it ({seconds:.1f}s of audio, first after {first:.2f}s), on_aura set")

    asyncio.run(main())


CASES = {
    "provider": case_provider,
    "cartesia_settings": case_cartesia_settings,
    "cartesia_env": case_cartesia_env,
    "rewrites": case_rewrites,
    "live_fallback": case_live_fallback,
}

if __name__ == "__main__":
    if "--case" in sys.argv:
        CASES[sys.argv[sys.argv.index("--case") + 1]]()
        raise SystemExit(0)
    if "--live" in sys.argv:
        run_case("live_fallback", {"TTS_PROVIDER": "cartesia"})
        raise SystemExit(0)
    run_case("provider", {"EXPECT": "deepgram"})
    run_case("provider", {"TTS_PROVIDER": "Deepgram", "EXPECT": "deepgram"})
    run_case("provider", {"TTS_PROVIDER": "cartesia", "EXPECT": "cartesia"})
    run_case("provider", {"TTS_PROVIDER": " Cartesia ", "EXPECT": "cartesia"})
    run_case("provider", {"TTS_PROVIDER": "cartesia", "CARTESIA_API_KEY": "", "EXPECT": "deepgram"})
    run_case("provider", {"TTS_PROVIDER": "elevenlabs", "EXPECT": "deepgram"})  # no ElevenLabs key
    run_case("provider", {"TTS_PROVIDER": "playht", "EXPECT": "deepgram"})
    run_case("cartesia_settings", {"TTS_PROVIDER": "cartesia"})
    run_case(
        "cartesia_env",
        {
            "TTS_PROVIDER": "cartesia",
            "CARTESIA_VOICE_FR": "v-fr",
            "CARTESIA_VOICE_EN": "v-en",
            "CARTESIA_SPEED_FR": "fast",
            "CARTESIA_SPEED_EN": "3",
            "CARTESIA_EMOTION_EN": "",
            "CARTESIA_MODEL": "sonic-2",
        },
    )
    run_case("rewrites", {"TTS_PROVIDER": "cartesia"})
    print("all TTS checks passed")
