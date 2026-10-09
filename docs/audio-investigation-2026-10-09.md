# Mia audio investigation (boss notes #4, #19, #14), 2026-10-09

Chat A. Measured on local voice sessions against the real pipeline (Deepgram
STT → Gemini → Deepgram Aura → Simli → LiveKit → kiosk page in Chromium).
Nothing here was deployed. Tools: `scripts/loudness.mjs` (loudness over time)
and `public/audio-check.html` (test to run on the kiosk).

## Short version

- **#4 / #19 (quieter, "lowers then comes back")**: the audio that reaches the
  kiosk browser holds a steady level. Over 3 sessions of 3.5–4.5 minutes (34
  replies) her level doesn't fall over time (−0.16 to 0 dB/min). French and English replies arrive at
  the same level, and the page never changes the volume. So the drop most
  likely happens **on the kiosk PC, after the browser**: something that
  turns playback down while the microphone is open or someone is talking.
  The mic opens right after her greeting, so any such effect makes everything
  after the greeting quieter, which matches "after a while she talks less loud".
  This can't be seen from here: run the checklist below on the kiosk.
- **Simli**: passes her voice through at the same level it receives it. It
  lost 2 words in 34 replies, both a reply's first word ("Bonjour"), both in
  the first 20 s of a session. One greeting also started ~5 dB quiet for its
  first 1.5 s. On top of that, Simli refused new sessions with
  **429 "Rate limit exceeded"** while the parallel chats were testing. When
  that happens Mia has no face, only her voice.
- **#14 (French slow)**: her French really is slower, and it's the voice, not the delay.
  French: 139 words/min, 3.8 syllables/s, 30% of each reply is pause.
  English: 162 words/min, 4.2 syllables/s, 25% pause. Spoken French normally runs at
  least as fast as English in syllables per second. Reply delay differs by only
  ~0.3 s (3.5 s vs 3.15 s median). Deepgram can't fix it: only 2 French voices
  (both France French) and the API **rejects `speed` for French voices**.
  Recommendation: ElevenLabs Flash v2.5 (already built into the worker) with a
  Québec French female voice at speed ~1.1. A/B it against Cartesia Sonic-3.

## Measurements

### Setup
Three long scenarios (visitor voice by Deepgram TTS, 9–11 questions, ~20 s
apart): English only, French only, and English → French → English. Kit runner
adapted from `mia_e2e/run.mjs`: records the kiosk `<audio>` stream, samples
WebRTC inbound stats every second, keeps worker logs with timestamps. One
extra session ran with a test-only hook that saved the exact audio the worker
streams to Simli, to compare sent vs received.

The recording is taken from the `<audio>` element's MediaStream: it covers
everything up to the browser (TTS, Simli, LiveKit, network, decoding), but
**not** Chrome's output mixing, Windows or the speakers.

### Loudness over time (#4, #19)
Active-speech level per reply (RMS of voiced 10 ms frames, dBFS):

| Session | Length | Replies | Median | Trend | First third → last third |
|---|---|---|---|---|---|
| English | 4.3 min | 12 | −25.4 | 0.0 dB/min | −25.5 → −25.4 |
| French | 4.3 min | 12 | −24.1 | −0.16 dB/min | −24.3 → −24.7 |
| EN → FR → EN | 3.6 min | 10 | −24.4 | +0.73 dB/min* | −25.7 → −24.2 |

\* Upward, and only because the greeting at the start arrived quiet (see
Simli). EN replies −24.7, FR replies −24.4 in this session.

What the per-second plot shows: flat bands of speech at ±1–2 dB around the
median for the whole session, with silences between replies. The only
outlier was the start of one greeting (see Simli). `audio.volume` stayed 1.0
throughout, and nothing in `src/` sets a volume on Mia's audio.

Ruled out:
- **Drift over time** in the stream: none.
- **The French/English voice swap**: straight from Deepgram, Agathe (FR)
  is ~3 dB louder than Andromeda (EN) (−23.7 vs −26.6 dBFS on the same
  sentences). After Simli the difference is ≤1 dB (same session: EN −24.7, FR
  −24.4), so switching language doesn't make her audibly quieter.
- **Network**: 1 lost packet in ~20,500, jitter ≤12 ms, jitter buffer 50–75 ms.
  NetEq concealed ~10 short pieces per session (10–70 ms, ~0.3 s in total,
  ~0.1% of the audio) with no packet loss: possible tiny clicks, not volume
  changes. A session without Simli had them too (1 in 47 s), so the source isn't clear.
- **Interruption handling**: with an avatar the framework can't pause audio
  (only cut it), so a false interruption can't turn into "quieter".

### Browser microphone processing
livekit-client 2.22.3 asks for `echoCancellation`, `noiseSuppression`,
`autoGainControl` and `voiceIsolation` (all true, device `default`). Chrome
applied the first three and reported `voiceIsolation: false` (not supported).
None of these touch playback: echo cancellation and noise suppression only
clean up the mic. On Windows, Chrome's AGC can move the system **mic** level
slider, which affects how well she hears, not how loud she is.

Chrome turned Windows ducking off for WebRTC playback, and by default opens
the normal device rather than the "communications" one (codereview.chromium.org
368273010, 155863003). So Windows "communications activity" ducking is
**less likely** than first thought, but it costs nothing to rule out, and other
software on the kiosk can trigger it.

### Simli
- **Level and delay**: sent vs received per segment: −24.0/−24.0, −23.4/−24.2,
  −23.9/−23.8 dBFS. Audio is heard at the kiosk 0.47–0.75 s after the worker
  sends it (part of the ~3.3 s reply delay).
- **Lost words**: 2 of 34 replies (~1,100 words) came through without their first
  word, both "Bonjour", both in the first 20 s of a session (the greeting of one
  session, the first reply of another). Clipped and transcribed alone, the
  French reply starts at "Mobile…". The same text through the worker's Deepgram
  streaming path produced "Bonjour" 5 of 5 times, so the word is lost after the
  TTS: between the worker's stream to the avatar and Simli's published track. The
  sent-audio hook ran in one session only, and no word was lost in that one, so the
  exact place is not yet proven. All other differences between said and
  transcribed text were recognizer spellings (Medisolution, Sainte-Thérèse).
- **Fade-in**: in that same session the greeting's first 1.5 s arrived at
  −29/−34 dBFS before settling at −24.
- **Rate limit**: `failed to connect to simli avatar session server returned
  429 {"detail":"Rate limit exceeded"}` on 3 session starts while other chats
  were running voice tests on the same key. The worker kept going without a
  face (audio only).

### French speed and delay (#14)
Live sessions (17 replies per language, ~3 minutes of her speech each):

| | Words/min | Syllables/s overall | Syllables/s while voiced | Pause share |
|---|---|---|---|---|
| French (Agathe) | 139 | 3.78 | 5.40 | 30% |
| English (Andromeda) | 162 | 4.23 | 5.67 | 25% |

Reply delay (end of the visitor's line → first audio at the kiosk): French
median 3.48 s (n=14, 2.04–3.94), English 3.15 s (n=17, 2.47–3.94). Where it goes:
Simli ~0.5–0.75 s; TTS first audible sound ~0.7 s including the voice's own
leading silence (Agathe 0.72 s, Andromeda 0.67 s, Hector 0.89 s; Agathe's
leading silence varies 0–1.1 s); the rest is end-of-turn detection, transcript
and Gemini.

Options:
- **Deepgram Aura-2** (current): French voices are `aura-2-agathe-fr` (female)
  and `aura-2-hector-fr` (male), both fr-FR, no fr-CA. Hector is slower still
  (166 vs 183 words/min on the same text). `speed` works for English
  (1.2 → 219 words/min) but returns *400 "Requested model does not support the
  'speed' parameter"* for French voices. The installed plugin (1.6.8) has no
  speed option anyway.
- **ElevenLabs** (built in the worker behind `TTS_PROVIDER=elevenlabs`):
  `eleven_flash_v2_5` takes the language per turn. The 1.6.8 plugin's
  `VoiceSettings(stability, similarity_boost, style, speed 0.8–1.2,
  use_speaker_boost)` gives speed control. The Voice Library has Québec French
  voices, but library voices need a paid plan (402 on free). One small worker change
  (Chat C's file): pass `voice_settings=elevenlabs.VoiceSettings(stability=0.5,
  similarity_boost=0.75, speed=<ELEVENLABS_SPEED, default 1.0>)` in `make_tts`.
- **Cartesia Sonic-3**: `livekit-plugins-cartesia==1.6.8` supports
  `language="fr"`, `speed` 0.6–2.0, `emotion` and `volume`, and is aimed at low latency.
  It needs the plugin added to `requirements.txt` plus a `make_tts` branch.
- Simli resamples her voice to 16 kHz, so premium "HD" voice quality is partly lost
  anyway. Choose on accent, pace and expressiveness, not fidelity.

Usage for pricing: she spoke ~450–530 characters per minute of conversation.
20 three-minute conversations a day is ~30k characters/day, ~650k/month. Check
current ElevenLabs and Cartesia plan prices against that.

**Recommendation**: ElevenLabs Flash v2.5 with a female Québec French
library voice, speed 1.1, on a paid plan sized to the usage above. It's
already wired in and fixes the accent too (Aura has no fr-CA). Before
committing, do a short A/B with Cartesia Sonic-3 (trial key) on the same
sentences, and measure both with the method above (words/min, pause share,
delay). Free in the meantime: ask Chat P for shorter French sentences, since
pauses at sentence ends are a large part of the "slow" feel.

## Root causes, most likely first

1. **Kiosk PC lowers playback while the mic is open or someone talks**
   (#4, #19). Candidates: a Bluetooth speaker or headset switching to
   "Hands-Free" when the mic opens (quieter, phone-quality); a USB
   speakerphone's half-duplex (turns the speaker down whenever it hears voice
   or noise, then back up); sound-card "voice / conference / loudness"
   effects; Windows communications ducking triggered by Chrome or another
   app. Fits both notes and the timing (mic opens after the greeting). **Not
   verified**: needs the kiosk (checklist below).
2. **Simli at the start of speech**: lost first word (2/34 replies), quiet start
   of a greeting (1/3 sessions). Brief, near session start. Report to Simli.
3. **Lobby perception**: the visitor steps back, the lobby gets louder, her
   16 kHz voice is less clear. Not a level change.
4. Ruled out by measurement: level drift in the stream, the FR/EN voice swap,
   network loss, anything in the site or LiveKit changing volume.

## Checklist for the kiosk owner

Do these on the kiosk, logged in as the Windows account that runs the kiosk
Chrome (sound settings are per account).

1. **Write down the audio hardware.** Settings → System → Sound: the exact
   names of the Output and Input devices. Note whether the speaker is
   Bluetooth, and whether the mic is part of a speakerphone or headset
   (Jabra, Poly, Anker, eMeet, …).
2. **Run the audio check.** In Chrome on the kiosk, open
   `https://<the site>/audio-check.html`, press Start and listen for 1 minute.
   A beep plays the whole time; the mic switches on and off every 10 s.
   - Beep **equally loud** in MIC ON and MIC OFF → the kiosk isn't lowering
     the sound when the mic opens; go to step 7.
   - Beep **quieter in MIC ON** → do steps 3–6, re-run the test after each one,
     and note which step fixed it.
   - Any device in the list marked "check: hands-free / communications" → step 4.
3. **Windows ducking off.** Win+R → `mmsys.cpl` → **Communications** tab →
   **Do nothing** → OK. (Same as the registry value
   `HKCU\Software\Microsoft\Multimedia\Audio\UserDuckingPreference` = DWORD `3`.)
4. **No Bluetooth hands-free.** If the speaker is Bluetooth: use a wired
   (USB or jack) speaker, or keep the Bluetooth speaker but use a separate
   USB mic and turn off its hands-free mode (Control Panel → Devices and
   Printers → the speaker → Properties → Services → untick "Handsfree
   Telephony"). The output must be "Speakers"/"Stereo", never "Headset" or
   "Hands-Free".
5. **Speakerphone.** If the mic and speaker are one conference unit, look
   in its app (Jabra Direct, Poly Lens, …) for "half duplex", "auto volume",
   "voice leveling", "noise/echo" options and turn them off. Or test with a
   separate mic and speakers.
6. **Sound effects off.** `mmsys.cpl` → Playback → the speakers → Properties →
   Enhancements / Advanced: untick audio enhancements and Loudness
   Equalization (Windows 11: Settings → System → Sound → the speakers → Audio
   enhancements: Off). Turn off "voice", "conference", "dynamic", "auto volume"
   modes in vendor apps (Realtek Audio Console, Dolby, Nahimic, Waves MaxxAudio,
   Dell/HP/Lenovo audio apps). Also Sounds tab → Sound scheme: **No Sounds**,
   so Windows notification sounds never play over her.
7. **Chrome.** No Chrome flag controls this in current versions. In Chrome →
   Settings → Privacy → Site settings → Microphone, keep the default mic
   (not a "Communications" entry). Don't run other call apps (Teams, Zoom,
   Phone Link) on the kiosk: they can trigger Windows ducking.
8. **If it still happens**, film it with a phone (screen + sound) and note
   the time, so it can be matched to that session's worker logs. Also check
   the 3DVista tour for background music or sounds that fade.

## What to send Simli support

- Setup: LiveKit Agents 1.6.8 with `livekit-plugins-simli` 1.6.8, Trinity face
  `SIMLI_FACE_ID`, audio streamed to the avatar as 16 kHz mono PCM over a
  LiveKit data stream, avatar publishes into the room.
- Issue 1: the first word of a speech segment is sometimes missing from the
  avatar's published audio (2 of 34 segments, both at a session's start).
  The same text from the TTS always contains it. Ask: does the avatar trim or
  fade the start of a segment, or drop audio while switching from idle to
  speaking? Is there a recommended lead-in or "warm-up" audio?
- Issue 2: the first ~1.5 s of the first segment of a session is ~5 dB quieter
  (1 of 3 sessions).
- Issue 3: `429 Rate limit exceeded` when starting sessions. Ask what the
  limit is (concurrent sessions? starts per minute? per key or per face?),
  since the kiosk and our tests share a key.
- Attach: room names and UTC times of the sessions, the recordings.
  Better: one session where it happened with the sent audio also saved (the
  test hook below), so they see the word present in what we sent and missing
  in what they published.

## Reproducing

- Loudness: decode a kit recording, then
  `node scripts/loudness.mjs <name>_mia.wav` (see the header of the script).
- Sent audio: a test-only `sitecustomize.py` mounted with `-e PYTHONPATH=/mod`
  wraps `DataStreamAudioOutput.capture_frame` and appends each frame to
  `/dump/<ms>_<rate>.raw`. No change to `worker.py`; don't use it in production.
- The long-session runner (kit `run.mjs` plus once-a-second
  `RTCPeerConnection.getStats()` of inbound audio and timestamped worker logs)
  and the join/latency scripts were scratch work and are not committed.
