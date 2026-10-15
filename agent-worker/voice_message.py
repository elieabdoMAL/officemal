"""Voice messages (#5, round 2): the visitor records a message in their own
voice at the kiosk, and Mia emails it — audio attached, with the transcript —
to a team member or the general inbox.

This module is the pure part: the PCM recorder fed from the worker's audio
input, the "done" stop words, the encoders (OGG/Opus through the image's
ffmpeg, WAV if that fails) and the email. The conversation flow — when to
record, staying silent meanwhile, the read-back before sending — lives in
worker.py (record_voice_message / send_voice_message).

Privacy: the recording lives only in memory, is attached to the email and
dropped the moment it is sent (or when the session ends), and never appears
in the logs — only its size and length do.
"""

import asyncio
import base64
import html
import io
import logging
import os
import re
import wave
from dataclasses import dataclass

from conversation_control import fold
from team_messages import (
    MAX_CONTACT_CHARS,
    MAX_MESSAGE_CHARS,
    MAX_NAME_CHARS,
    Member,
    _one_line,
    _send_email,
    _STT_FOOTER,
)

logger = logging.getLogger("simli-receptionist")


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name, "").strip()
    try:
        return float(raw) if raw else default
    except ValueError:
        logger.warning("%s=%r is not a number, using %s", name, raw, default)
        return default


# How long a recording may run; past this it stops and is sent as it is.
VM_MAX_S = _env_float("VOICE_MESSAGE_MAX_S", 60.0)
# The visitor stopped talking for this long: they are done.
VM_SILENCE_S = _env_float("VOICE_MESSAGE_SILENCE_S", 2.5)
# Nothing said at all since the recording started: give up.
VM_START_TIMEOUT_S = _env_float("VOICE_MESSAGE_START_TIMEOUT_S", 10.0)
# Audio kept after the visitor's last word, so a soft ending isn't clipped.
VM_TAIL_S = 0.8
# Shorter than this is a cough, not a message.
VM_MIN_S = 1.0

# Resend takes emails up to 40 MB; stay far under it. A 60 s recording is
# ~180 KB as Opus and ~5.8 MB as the WAV fallback (48 kHz mono).
MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024
# Hard cap on buffered PCM, whatever the clock says: max length plus slack.
_MAX_PCM_BYTES = int((VM_MAX_S + 5) * 48000) * 2

OPUS_BITRATE = "24k"  # mono voice; plenty at 48 kHz


# ---------------------------------------------------------------------------
# "Done": how the visitor ends the recording in words
# ---------------------------------------------------------------------------

# A whole utterance of just these (fillers aside) ends the recording. "stop"
# too: during a recording nothing else listens, so it can't collide with the
# pause words.
_DONE_PHRASES = (
    r"(?:i(?:'| a)?m )?done|finished|that'?s (?:it|all)|that is (?:it|all)|it'?s done|it is done|"
    r"c(?:'| )?est tout|c(?:'| )?est fini|j(?:'| )?ai (?:fini|termin[eé])|termin[eé]|fini|voil[aà]|stop"
)
_DONE_ONLY = re.compile(rf"^(?:(?:{_DONE_PHRASES})(?:\s+|$))+$")
_DONE_TAIL = re.compile(rf"[\s,.!?]+(?:{_DONE_PHRASES})[\s.!?]*$", re.IGNORECASE)
# Allowed around the stop words: "OK, done.", "C'est tout, merci."
_DONE_FILLERS = {"ok", "okay", "so", "and", "et", "alors", "bon", "merci", "thanks", "thank", "you", "uh", "um", "euh"}


def _plain(text: str) -> str:
    return " ".join(re.findall(r"[a-z0-9]+(?:'[a-z0-9]+)*", fold(text)))


def strip_done(text: str) -> tuple[str, bool]:
    """(the message part of `text`, whether it ends the recording).

    "Done." / "C'est tout, merci" -> ("", True); "call me back, that's it"
    -> ("call me back", True); ordinary dictation comes back unchanged. The
    audio is never cut by this: a message that happens to end in "…is done"
    loses only those transcript words, not its sound.
    """
    plain = _plain(text)
    rest = " ".join(w for w in plain.split() if w not in _DONE_FILLERS)
    if rest and _DONE_ONLY.match(rest):
        return "", True
    if _DONE_TAIL.search(plain):
        raw = text.strip().replace("’", "'").replace("‘", "'")
        return _DONE_TAIL.sub("", raw).rstrip(" ,;"), True
    return text.strip(), False


# ---------------------------------------------------------------------------
# The recorder: raw PCM from the kiosk's microphone frames
# ---------------------------------------------------------------------------


class Recorder:
    """Collects the visitor's audio frames (int16 PCM) while they dictate.

    `mark_voice()` is called whenever the visitor is heard speaking, so
    `finalize()` can cut the trailing silence that ended the recording.
    """

    def __init__(self) -> None:
        self._buf = bytearray()
        self._rate = 0
        self._channels = 1
        self._marked = 0  # buffer length the last time the visitor was speaking

    def add_frame(self, frame) -> None:
        """One audio frame from the session input (rtc.AudioFrame or anything
        with data / sample_rate / num_channels)."""
        if len(self._buf) >= _MAX_PCM_BYTES:
            return
        if not self._rate:
            self._rate = int(getattr(frame, "sample_rate", 0) or 48000)
            self._channels = int(getattr(frame, "num_channels", 1) or 1)
        data = bytes(frame.data)
        if self._channels > 1:
            import numpy as np  # a livekit-agents dependency

            samples = np.frombuffer(data, dtype=np.int16)
            samples = samples[: len(samples) - len(samples) % self._channels]
            data = samples.reshape(-1, self._channels).mean(axis=1).astype(np.int16).tobytes()
        self._buf += data

    def mark_voice(self) -> None:
        self._marked = len(self._buf)

    @property
    def rate(self) -> int:
        return self._rate or 48000

    def seconds(self) -> float:
        return len(self._buf) / 2 / self.rate

    def finalize(self) -> bytes:
        """The recording up to the visitor's last word plus a short tail;
        empty if they were never heard."""
        if not self._marked:
            return b""
        keep = self._marked + int(VM_TAIL_S * self.rate) * 2
        return bytes(self._buf[:keep])


# ---------------------------------------------------------------------------
# Encoding: OGG/Opus via the image's ffmpeg, WAV if that fails
# ---------------------------------------------------------------------------


def encode_wav(pcm: bytes, rate: int) -> bytes:
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm)
    return out.getvalue()


async def encode_ogg_opus(pcm: bytes, rate: int) -> bytes | None:
    """Mono s16 PCM -> OGG/Opus, or None when ffmpeg can't (missing, failed)."""
    try:
        proc = await asyncio.create_subprocess_exec(
            "ffmpeg", "-hide_banner", "-loglevel", "error",
            "-f", "s16le", "-ar", str(rate), "-ac", "1", "-i", "pipe:0",
            "-c:a", "libopus", "-b:a", OPUS_BITRATE, "-application", "voip",
            "-f", "ogg", "pipe:1",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except (FileNotFoundError, OSError):
        logger.warning("voice message: no ffmpeg, falling back to WAV")
        return None
    out, err = await proc.communicate(pcm)
    if proc.returncode or not out:
        logger.warning("voice message: ffmpeg failed (%s): %s", proc.returncode, err.decode(errors="replace")[:200])
        return None
    return bytes(out)


async def encode_voice_audio(pcm: bytes, rate: int) -> tuple[bytes, str, str]:
    """(encoded audio, file extension, MIME type) for the email attachment."""
    data = await encode_ogg_opus(pcm, rate)
    if data is not None:
        return data, "ogg", "audio/ogg"
    return encode_wav(pcm, rate), "wav", "audio/wav"


@dataclass
class VoiceMessage:
    """One finished recording, waiting for the visitor's yes to be sent."""

    member: Member
    audio: bytes
    ext: str
    mime: str
    seconds: float
    transcript: str


# ---------------------------------------------------------------------------
# The email
# ---------------------------------------------------------------------------


async def send_voice_message_email(member: Member, visitor_name: str, reply_contact: str, vm: VoiceMessage) -> bool:
    """Email the recording to `member`, audio attached, with the transcript.
    True only if Resend accepted it."""
    if len(vm.audio) > MAX_ATTACHMENT_BYTES:
        logger.error("send_voice_message: attachment too big (%d bytes)", len(vm.audio))
        return False
    visitor_name = _one_line(visitor_name, MAX_NAME_CHARS)
    transcript = vm.transcript.strip()[:MAX_MESSAGE_CHARS]
    reply_contact = reply_contact.strip()[:MAX_CONTACT_CHARS]

    e = html.escape  # a stranger at the kiosk spoke all of this
    contact_html = (
        f"<p style='margin:0 0 8px;color:#333'><strong>Reply to:</strong> {e(reply_contact)}</p>"
        if reply_contact
        else "<p style='margin:0 0 8px;color:#777'>No reply contact left.</p>"
    )
    transcript_html = (
        f"<blockquote style='margin:16px 0;padding:12px 16px;background:#fff;border-left:4px solid #7c3aed;"
        f"color:#1a1a1a;white-space:pre-wrap'>{e(transcript)}</blockquote>"
        if transcript
        else "<p style='margin:16px 0;color:#777'>No transcript could be made of the recording.</p>"
    )
    body = f"""
      <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px;background:#f9f9f9;border-radius:12px">
        <h2 style="margin:0 0 16px;color:#1a1a1a">Voice message from the reception kiosk</h2>
        <p style="margin:0 0 8px;color:#333"><strong>From:</strong> {e(visitor_name)}</p>
        {contact_html}
        <p style="margin:0 0 8px;color:#333">&#127908; The visitor's recording is attached ({round(vm.seconds)} seconds). Transcript, by speech recognition:</p>
        {transcript_html}
        {_STT_FOOTER}
      </div>
    """
    return await _send_email(
        "send_voice_message",
        [member.email],
        f"Voice message from {visitor_name} (reception kiosk)",
        body,
        reply_to=reply_contact,
        attachments=[
            {
                "filename": f"voice-message.{vm.ext}",
                "content": base64.b64encode(vm.audio).decode(),
                "content_type": vm.mime,
            }
        ],
    )
