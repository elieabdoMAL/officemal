"""Voice messages (#5, round 2) — the recorder, the stop words, the encoders,
the notify-claim hold, and the conversation flow. Run inside the worker image:

    docker run --rm --env-file .env -v "$PWD":/app -e RESEND_API_KEY= simli-worker python test_voice_message.py

Offline parts need no keys. The conversations run against the real Gemini,
every email replaced by a recorder, and the microphone capture replaced by a
stub that returns synthetic audio (the encoders still run for real on it).
Pass scenario names to run only those, e.g. `python test_voice_message.py flow_en`.
"""

import asyncio
import math
import struct
import sys
import time
import wave as wave_mod
import io

import voice_message
from voice_message import Recorder, VoiceMessage, encode_ogg_opus, encode_voice_audio, encode_wav, strip_done
from team_messages import load_team
from test_team_messages import Conversation, calls, install_recorders, use_assistant_name

TEAM = load_team()
NICOLAS = next(m for m in TEAM if m.first_name == "Nicolas")

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


# --- offline: stop words ------------------------------------------------------


def test_strip_done() -> None:
    cases = {
        "Done.": ("", True),
        "I'm done.": ("", True),
        "That's it.": ("", True),
        "That's all, thanks!": ("", True),
        "Okay, done, thank you.": ("", True),
        "C'est tout.": ("", True),
        "C'est tout, merci.": ("", True),
        "J'ai fini.": ("", True),
        "Terminé.": ("", True),
        "Voilà.": ("", True),
        "Voilà, c'est tout.": ("", True),
        "Stop.": ("", True),
        "Please call me back tomorrow, that's it.": ("Please call me back tomorrow", True),
        "Dites-lui que je passerai demain, c'est tout.": ("Dites-lui que je passerai demain", True),
        "Tell him the demo is ready and I'll be there at two.": (
            "Tell him the demo is ready and I'll be there at two.",
            False,
        ),
        "Le projet avance bien.": ("Le projet avance bien.", False),
        "Don't stop the project.": ("Don't stop the project.", False),  # mid-sentence stop words don't fire
    }
    for said, expected in cases.items():
        got = strip_done(said)
        check(got == expected, f"strip_done({said!r}) = {got!r} (wanted {expected!r})")


# --- offline: the recorder ----------------------------------------------------


class Frame:
    def __init__(self, data: bytes, rate: int = 48000, channels: int = 1) -> None:
        self.data = data
        self.sample_rate = rate
        self.num_channels = channels


def sine_pcm(seconds: float, rate: int = 48000, freq: float = 440.0) -> bytes:
    n = int(seconds * rate)
    return struct.pack(f"<{n}h", *(int(12000 * math.sin(2 * math.pi * freq * i / rate)) for i in range(n)))


def test_recorder() -> None:
    rec = Recorder()
    rec.add_frame(Frame(sine_pcm(1.5)))
    rec.mark_voice()
    rec.add_frame(Frame(sine_pcm(1.5)))  # trailing silence-era audio, after the last word
    pcm = rec.finalize()
    want = 1.5 + voice_message.VM_TAIL_S
    got = len(pcm) / 2 / rec.rate
    check(abs(got - want) < 0.05, f"finalize trims to the last voice + tail ({got:.2f}s ≈ {want:.2f}s)")
    check(rec.seconds() > got, "the raw buffer kept everything")

    silent = Recorder()
    silent.add_frame(Frame(sine_pcm(2.0)))
    check(silent.finalize() == b"", "never marked as voice: nothing kept")

    stereo = Recorder()
    mono = sine_pcm(0.5)
    import numpy as np

    pair = np.repeat(np.frombuffer(mono, dtype=np.int16), 2).tobytes()
    stereo.add_frame(Frame(pair, channels=2))
    stereo.mark_voice()
    out = stereo.finalize()
    check(len(out) == len(mono), f"stereo downmixed to mono ({len(out)} == {len(mono)} bytes)")


async def test_encoders() -> None:
    pcm = sine_pcm(2.0)
    wav = encode_wav(pcm, 48000)
    with wave_mod.open(io.BytesIO(wav), "rb") as w:
        check(
            w.getnchannels() == 1 and w.getframerate() == 48000 and w.getnframes() == len(pcm) // 2,
            "WAV header and length match the PCM",
        )
    ogg = await encode_ogg_opus(pcm, 48000)
    if ogg is None:
        check(False, "ffmpeg not available for OGG/Opus (run inside the worker image)")
        return
    check(ogg[:4] == b"OggS", "OGG container magic")
    check(len(ogg) < len(pcm) / 10, f"Opus is compact ({len(ogg)} bytes for {len(pcm)} PCM)")
    # Decode it back: the attachment must play.
    proc = await asyncio.create_subprocess_exec(
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "ogg", "-i", "pipe:0",
        "-f", "s16le", "-ar", "48000", "-ac", "1", "pipe:1",
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    out, err = await proc.communicate(ogg)
    seconds = len(out) / 2 / 48000
    check(proc.returncode == 0 and abs(seconds - 2.0) < 0.3, f"the OGG decodes back to ~2s of audio ({seconds:.2f}s)")
    data, ext, mime = await encode_voice_audio(pcm, 48000)
    check(ext == "ogg" and mime == "audio/ogg" and data[:4] == b"OggS",
          f"encode_voice_audio picks Opus in the image ({ext}, {len(data)} bytes)")


# --- offline: tool guards and the notify-claim hold ---------------------------


def offline_agent(worker):
    agent = worker.MiaAgent(tts=None)
    agent._chosen_language = "en"
    agent._speak_in = lambda _lang: None
    return agent


async def test_guards(worker) -> None:
    agent = offline_agent(worker)
    out = await agent.record_voice_message(None, recipient="Nicolas", visitor_name="there")
    check(out.startswith("NOT RECORDED") and "name" in out, f"record refuses a name the visitor never said: {out[:70]}")
    out = await agent.record_voice_message(None, recipient="Marc Dupont", visitor_name="Eve Adams")
    check(out.startswith("NOT RECORDED") and "no single team member" in out, f"record refuses someone not in team.json: {out[:70]}")

    # send: the read-back gate (#6), then the privacy drop and the repeat answer.
    agent = offline_agent(worker)
    agent._visitor_lines = ["My name is Eve Adams"]
    agent._visitor_turns = 3
    vm = VoiceMessage(member=NICOLAS, audio=b"x" * 2048, ext="ogg", mime="audio/ogg", seconds=4.0, transcript="hello there")
    agent._voice_message = vm
    out = await agent.send_voice_message(None, visitor_name="Eve Adams")
    check(out.startswith("NOT SENT") and "read" in out, f"send refuses before the read-back: {out[:70]}")
    agent._read_backs = [(2, "So that's Eve Adams, is that right?")]
    n = len(calls)
    out = await agent.send_voice_message(None, visitor_name="Eve Adams")
    sent = recorded("voice", n)
    check(out.startswith("SENT") and len(sent) == 1 and sent[0][1] == "Nicolas Bastien", f"send goes through after the read-back: {out[:60]}")
    check(agent._voice_message is None, "the recording is dropped the moment it is sent")
    out = await agent.send_voice_message(None, visitor_name="Eve Adams")
    check(out.startswith("NOT SENT AGAIN") and "deleted" in out, f"a second send is refused, audio gone: {out[:80]}")

    # The notify-claim patterns (#10 hardening): claims in every tense, offers never.
    agent = offline_agent(worker)
    for claim in (
        "I've let Alexandre know you're here.",
        "I have just let Nicolas know.",
        "I'll let Alexandre know you're here.",
        "I will notify Nicolas right away.",
        "I'm letting Alexandre know now.",
        "Alexandre has been notified.",
        "J'ai prévenu Alexandre de votre arrivée.",
        "J'ai déjà informé Nicolas.",
        "Je vais prévenir Alexandre.",
        "Je viens d'aviser Nicolas.",
        "Alexandre a été prévenu.",
    ):
        check(agent._early_notify_claim(claim), f"held as a claim: {claim!r}")
    for fine in (
        "Would you like me to let Alexandre know you're here?",
        "Voulez-vous que j'informe Nicolas ?",
        "Shall I let him know you've arrived?",
        "I've let you know everything I can.",
        "May I have your name?",
        "The team will get back to you.",
    ):
        check(not agent._early_notify_claim(fine), f"not a claim: {fine!r}")
    agent._notifications_sent = 1
    check(not agent._early_notify_claim("I've let Alexandre know you're here."), "a true claim passes once someone was notified")


# --- conversations (real Gemini, stubbed microphone) --------------------------


def stub_capture(agent, transcript: str, seconds: float = 6.0):
    """Replace the mic capture: the 'visitor' dictated `transcript`."""
    async def capture(member):
        agent._vm_transcript = [transcript]
        await asyncio.sleep(0.2)
        pcm = sine_pcm(seconds)
        return pcm, 48000, seconds, "stop word"

    agent._capture_voice_message = capture


def _assistant_said(c: Conversation) -> list[str]:
    return [
        i.text_content
        for i in c.session.history.items
        if getattr(i, "type", "") == "message" and i.role == "assistant" and i.text_content
    ]


# The worker's RECORD_LINE, as it appears in her history: everything after the
# last of these is the recording-done read-back (VM_DONE_NOTE).
RECORD_MARK = ("recording your message", "enregistre votre message")


async def recording_done(c: Conversation, within: float = 30.0, previous: VoiceMessage | None = None) -> str:
    """Wait out the (stubbed) recording, then her recording-done read-back:
    what she says after the recording line, once _voice_message is set.
    `previous`: a re-record waits for a new recording, not that one."""
    deadline = time.monotonic() + within
    while time.monotonic() < deadline:
        await asyncio.sleep(0.4)
        while (speech := c.session.current_speech) is not None:
            await speech
        vm = c.agent._voice_message
        if c.agent._vm_active or vm is None or vm is previous:
            continue
        said = _assistant_said(c)
        marks = [i for i, s in enumerate(said) if any(m in s.lower() for m in RECORD_MARK)]
        if marks and len(said) > marks[-1] + 1:
            done = " ".join(said[marks[-1] + 1 :])
            print(f"  MIA (recording done): {done}")
            return done
    return ""


async def start_recording(c: Conversation, n: int, *lines: str) -> bool:
    """Say `lines`, then a confirmation if she read the name back first;
    True once record_voice_message has started (the worker said RECORD_LINE)."""
    for line in lines:
        await c.say(line)
        if c.agent._vm_active or c.agent._voice_message is not None:
            return True
    for line in ("Yes, that's right.", "Yes, go ahead."):
        if c.agent._vm_active or c.agent._voice_message is not None:
            return True
        await c.say(line)
    return c.agent._vm_active or c.agent._voice_message is not None


async def flow_en(worker) -> None:
    print("— English, voice message for Nicolas: ask, name, record, read-back, send:")
    n = len(calls)
    async with Conversation("en") as c:
        stub_capture(c.agent, "Hi Nicolas, it's Sam. Please call me back about the demo next week.", 8.0)
        r1 = await c.say("Hi, can I leave a voice message for Nicolas?")
        check(not c.agent._vm_active and c.agent._voice_message is None, "no recording before the visitor's name")
        check(has(r1, "name"), f"asks for the name first: {r1!r}")
        started = await start_recording(c, n, "My name is Sam Fortin.")
        check(started, "record_voice_message starts once she has recipient and name")
        done = await recording_done(c)
        check(has(" ".join(_assistant_said(c)), "recording your message"), "the worker's recording line was said")
        check(has(done, "record"), f"the done read-back says it is recorded: {done!r}")
        check(has(done, "fortin", "sam"), f"the done read-back names Sam Fortin: {done!r}")
        check(has(done, "second"), f"the done read-back gives the length: {done!r}")
        check(not has(done, "demo next week"), f"she never repeats the dictation: {done!r}")
        r3 = await c.say("Yes, that's right, please send it.")
        if not recorded("voice", n):
            r3 = await c.say("Yes.")
    sent = recorded("voice", n)
    check(len(sent) == 1 and sent[0][1] == "Nicolas Bastien", f"one voice email to Nicolas: {sent}")
    if sent:
        vm = sent[0][4]
        check(vm.ext in ("ogg", "wav") and len(vm.audio) > 200, f"audio attached ({vm.ext}, {len(vm.audio)} bytes)")
        check("call me back" in vm.transcript.lower(), f"the transcript rode along: {vm.transcript!r}")
        check(abs(vm.seconds - 8.0) < 0.5, f"duration recorded ({vm.seconds}s)")
    check(has(r3, "sent", "envoyé"), f"says it is sent only after SENT: {r3!r}")


async def flow_fr(worker) -> None:
    print("— French, message vocal pour Alexandre:")
    n = len(calls)
    async with Conversation("fr") as c:
        stub_capture(c.agent, "Bonjour Alexandre, c'est Julie. Rappelez-moi pour le contrat.", 5.0)
        r1 = await c.say("Bonjour, je voudrais laisser un message vocal pour Alexandre.")
        check(has(r1, "nom"), f"demande le nom: {r1!r}")
        started = await start_recording(c, n, "Je m'appelle Julie Tremblay.")
        check(started, "l'enregistrement démarre (FR)")
        done = await recording_done(c)
        check(has(" ".join(_assistant_said(c)), "enregistre votre message"), "la consigne d'enregistrement est dite (FR)")
        check(has(done, "enregistr"), f"la relecture dit que c'est enregistré (FR): {done!r}")
        check(has(done, "julie", "tremblay"), f"relit le nom (FR): {done!r}")
        r3 = await c.say("Oui, c'est bien ça, envoyez-le.")
        if not recorded("voice", n):
            r3 = await c.say("Oui.")
    sent = recorded("voice", n)
    check(len(sent) == 1 and sent[0][1] == "Alexandre Joset", f"un courriel vocal à Alexandre: {sent}")
    check(has(r3, "envoyé"), f"dit que c'est envoyé (FR): {r3!r}")


async def flow_cancel(worker) -> None:
    print("— English, recorded then not sent:")
    n = len(calls)
    async with Conversation("en") as c:
        stub_capture(c.agent, "Never mind the content.", 4.0)
        await c.say("I'd like to record a voice message for Nicolas. My name is Paul Lavoie.")
        if not (c.agent._vm_active or c.agent._voice_message is not None):
            await c.say("Yes, that's right.")
        await recording_done(c)
        r = await c.say("Actually, no. Don't send it, forget it.")
        check(not recorded("voice", n), "nothing sent on a cancel")
        check(not has(r, "it's sent", "it is sent", "envoyé"), f"never claims it was sent: {r!r}")
    check(not recorded("voice", n), "still nothing sent when the session ends")


async def flow_rerecord(worker) -> None:
    print("— English, re-record replaces the first take:")
    n = len(calls)
    async with Conversation("en") as c:
        stub_capture(c.agent, "First take, wrong words.", 4.0)
        await c.say("Can I record a voice message for Nicolas? I'm Paul Lavoie.")
        if not (c.agent._vm_active or c.agent._voice_message is not None):
            await c.say("Yes, that's right.")
        await recording_done(c)
        stub_capture(c.agent, "Second take, the right words.", 5.0)
        first = c.agent._voice_message
        await c.say("Can I record it again please?")
        if c.agent._voice_message is first and not c.agent._vm_active:
            await c.say("Go ahead, record it now.")  # she announced instead of recording
        done = await recording_done(c, previous=first)
        check(c.agent._voice_message is not None and "Second take" in c.agent._voice_message.transcript,
              "the second take replaced the first")
        check(has(done, "record"), f"recorded again: {done!r}")
        await c.say("Yes, that's right, send it.")
        if not recorded("voice", n):
            await c.say("Yes, send it.")
    sent = recorded("voice", n)
    check(len(sent) == 1, f"one send in all: {sent}")
    if sent:
        check("Second take" in sent[0][4].transcript, f"what went out is the second take: {sent[0][4].transcript!r}")


async def flow_unknown(worker) -> None:
    print("— English, voice message for someone not on the team:")
    n = len(calls)
    async with Conversation("en") as c:
        r = await c.say("Hi, I'm Anna Reid, can I leave a voice message for Marc Dupont?")
        check(not c.agent._vm_active and c.agent._voice_message is None, "no recording for someone not in team.json")
        check(has(r, "general inbox", "can't reach", "cannot reach", "team"), f"offers the general inbox instead: {r!r}")
    check(not recorded("voice", n), "nothing sent")


SCENARIOS = {
    "flow_en": flow_en,
    "flow_fr": flow_fr,
    "cancel": flow_cancel,
    "rerecord": flow_rerecord,
    "unknown": flow_unknown,
}


async def main() -> None:
    test_strip_done()
    test_recorder()
    await test_encoders()

    import worker

    use_assistant_name(worker)
    install_recorders(worker)
    await test_guards(worker)
    for name in sys.argv[1:] or SCENARIOS:
        await SCENARIOS[name](worker)
    print(f"\n{len(failures)} failed check(s)" + "".join(f"\n  ✗ {f}" for f in failures))
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    asyncio.run(main())
