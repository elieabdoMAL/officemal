# Mia's voice: Cartesia Sonic-3 (boss notes #14, #11), 2026-10-09

Chat K. Replaces Deepgram Aura's France-French Agathe, found slow and flat,
with a Québec French Cartesia voice. Nothing deployed.

## Config

| Env | Default | What |
|---|---|---|
| `TTS_PROVIDER` | `deepgram` | `cartesia` turns it on (needs `CARTESIA_API_KEY`, else Aura and an error in the log) |
| `CARTESIA_API_KEY` | | play.cartesia.ai → API keys |
| `CARTESIA_MODEL` | `sonic-3` | |
| `CARTESIA_VOICE_FR` / `_EN` | Josette `3b7d569e-01fc-45ef-b74b-29460956c691` | voice id per language |
| `CARTESIA_SPEED_FR` / `_EN` | `1.1` / `1.0` | 0.6–1.5 (clamped); 1.0 is the voice's own pace |
| `CARTESIA_EMOTION_EN` | `content` | English only: Cartesia ignores emotions in French. Empty = none |

How it works in `worker.py`:
- `CartesiaVoice` is a LiveKit `FallbackAdapter` over Cartesia then Aura. If
  Cartesia fails (credits used up = HTTP 402, outage, bad key), Aura says
  the line instead (~1.4 s later on the first failure, no delay after that),
  and Cartesia is retried in the background. Tested with a refused key and
  with the real out-of-credits key (`test_tts.py --live`).
- `_speak_in(lang)` sets voice, language, speed and emotion for the locked
  session language, and Aura's voice too in case it takes over.
- `tts_node`: the digit normalizer runs for every provider. The two Aura
  workarounds ("English" respelled "Inglish" for the French voice, a one-word
  opening sentence joined to the next) run only while Aura is speaking:
  Cartesia said "English" right 8/8 as written and garbled "Inglish" 2/4,
  and said one-word openings ("Goodbye! Have a great day!", "Parfait!
  Votre message est envoyé.", "Oui? Comment je peux vous aider?") 24/24.
- The plugin waits for 20 characters of sentence before sending text to
  Cartesia, so "Avec plaisir!" waited for the whole next sentence. At 6:
  first byte 0.25 s (vs 0.44 s), same as Aura.
- Captions are unchanged: the fallback adapter doesn't offer word timings,
  same as Aura today.

Tests: `agent-worker/test_tts.py` (offline: provider choice, per-language
settings, env parsing, which rewrites reach which voice; `--live`: Aura takes
over from a refused Cartesia key).

## Voice choice

All 23 Cartesia voices that are female and native fr-CA, same four lines
(greeting, a company answer, the phone number, a goodbye), speed 1.0, one
take each, direct from the API (not through Simli). Words/min and syllables/s
over the speech span; pitch variation = std of pitch in semitones (more =
livelier intonation); level = active speech, dBFS.

| Voice | Id | Words/min | Syll/s | Pause | Pitch Hz | Pitch var | Level |
|---|---|---|---|---|---|---|---|
| Aura Agathe (current) | `aura-2-agathe-fr` | 153 | 3.76 | 22% | 207 | 2.41 | −24.2 |
| **Josette - Frontline Helper** (fr-CA + en-CA) | `3b7d569e-01fc-45ef-b74b-29460956c691` | 172 | 4.22 | 26% | 253 | 3.40 | −14.4 |
| Léonie - Bright Host | `63fdecc2-4e1d-4aa3-a442-27204e3cd3b5` | 157 | 3.86 | 26% | 204 | 2.98 | −13.2 |
| Alice - Attentive Supporter | `c606ce2f-650e-40ca-958b-e11a393cead5` | 162 | 3.99 | 24% | 263 | 3.90 | −12.3 |
| Amelie - Warm Concierge | `2590a84a-68cf-4b08-970d-b4ff824bf242` | 168 | 4.13 | 27% | 263 | 2.76 | −15.2 |
| Roxane - Problem-Solver | `328e0683-d1a7-4cde-ad46-0ee69a3cbd6a` | 164 | 4.03 | 30% | 242 | 3.79 | −17.5 |
| Romy - Steady Anchor | `a0ad191b-2f51-4dc9-8cf3-7d1c8f5c5317` | 173 | 4.24 | 23% | 256 | 3.12 | −14.8 |
| Sophie - Voice Concierge | `6e6993ab-22b2-4a7e-9867-b40f92e01d8c` | 183 | 4.49 | 20% | 217 | 2.95 | −14.1 |
| Nora - Attentive Assistant | `bf9d8264-6a49-4baa-8918-842c7b86d0d8` | 196 | 4.80 | 25% | 231 | 2.83 | −13.2 |
| Marie-Eve - Team Mentor | `6d912a43-805f-4673-bbc8-a9e6c45a6ad0` | 182 | 4.47 | 17% | 233 | 2.67 | −16.2 |
| Ariane - Prompt Assistant | `2a6a0bd5-9fe4-41a9-a73e-6a7d3ca1ac57` | 177 | 4.33 | 19% | 218 | 2.88 | −15.0 |
| Delphine - Service Desk | `267cd81d-ce80-43b5-996e-17ef75d2016a` | 169 | 4.14 | 27% | 228 | 2.95 | −14.3 |
| Audrey - Customer Service | `e2ab5462-e7c8-492d-a244-41f39444af6e` | 170 | 4.16 | 21% | 171 | 2.23 | −14.9 |
| Rosalie - Attentive Helper | `3143159f-07d9-4bd9-a4e4-c5dd3d7339b9` | 167 | 4.09 | 24% | 179 | 3.65 | −14.6 |
| Camille - Gracious Guide | `4325f426-c4e0-418e-a0e5-97fcdfcdf8e6` | 165 | 4.04 | 28% | 207 | 2.30 | −17.2 |
| Isabelle - Professional Liaison | `22f1a356-56c2-4428-bc91-2ab2e6d0c215` | 160 | 3.93 | 22% | 250 | 3.29 | −16.2 |
| Geneviève - Precision Analyst | `16568a79-0a3b-4032-ae17-ac0b826276fb` | 155 | 3.82 | 32% | 228 | 3.83 | −13.9 |
| Coralie - Concise Explainer | `2c3c8033-e2b5-4752-887b-0c591ad4521f` | 147 | 3.62 | 28% | 191 | 3.55 | −14.2 |
| Livia - Customer Advocate | `0e8d318d-7b5a-49d1-9952-dc265248c12a` | 142 | 3.49 | 28% | 193 | 3.24 | −14.4 |
| Léane - Order Expeditor | `bfb5c6a9-db28-40c8-8981-2904e96e69b2` | 140 | 3.45 | 33% | 206 | 2.84 | −13.9 |
| Madeleine - Reliable Resident ✗ | `3817fdb0-7ae1-42d2-b46e-734dd9601bf2` | 164 | 4.03 | 30% | 208 | 3.45 | −17.5 |
| Calm French Woman ✗ | `a8a1eb38-5f15-4c1d-8722-7ac0f329727d` | 126 | 3.10 | 24% | 168 | 2.09 | −17.2 |
| Mika - Empathetic Friend ✗ | `187d1cc5-a771-4ccd-9110-9df8c4e39499` | 184 | 4.52 | 42% | 252 | 3.64 | −31.9 |
| Vanessa ✗ | `dd951538-c475-4bde-a3f7-9fd7b3e4d8f5` | 178 | 4.38 | 48% | 246 | 2.95 | −32.8 |

✗ Out: Madeleine said "un, un, cinq…" and "Enguish"; Calm French Woman said
"anglais" for "English" and is the slowest; Mika and Vanessa come out
~17 dB quieter than the others.

Default **Josette**: the only voice native in both Québec French and Canadian
English (one person in both languages, the way the face is one person),
bright pitch with lively intonation, quick, and clean on every check. Same
voice id for English. English alternatives measured (en, speed 1.0): Joanie
(`a7b8d8fa-f6e5-4908-900e-0c11d1d82519`, the most expressive, 4.75),
Katie (`f786b574-…`, Cartesia's default), Skylar, Connie, Harlow (en-CA).
Josette in English: 185 words/min vs Aura Andromeda 187.

The numbers are only a short list: pick by ear. Samples:
`tests/voice/out/cartesia-voices/` (`fr_<voice>_<line>.wav`,
`en_<voice>_<line>.wav`, and `*_AURA-*-current_*` for today's voice).

Notes:
- Cartesia's takes vary: the same lines from the same voice ran 154–200
  words/min across takes, so single-take differences of ±15 words/min mean
  nothing. Speed does work: 0.7 → 129, 1.0 → 200, 1.5 → 263 on one paragraph.
- Cartesia is ~9 dB louder than Aura (−15 vs −24 dBFS, peaks near 0 dBFS).
  The kiosk volume may need turning down a little the first day.
- One take in 16 said a digit twice ("un, un, cinq…") with Josette, as
  Madeleine did. Not yet measured how often: the credits ran out first.

## Measurements vs Aura

Aura numbers: docs/audio-investigation-2026-10-09.md (live sessions).

| | Aura (Agathe / Andromeda) | Cartesia (Josette) |
|---|---|---|
| French words/min, live | 139 | *pending* |
| French syllables/s, live | 3.78 | *pending* |
| English words/min, live | 162 | *pending* |
| Reply delay FR, median (end of speech → first audio at the kiosk) | 3.48 s | *pending* |
| Reply delay EN, median | 3.15 s | *pending* |
| TTS first byte, streaming, same text (direct, no Simli) | 0.25 s | 0.25 s (min sentence 6) |

## Cost

Sonic-3 costs about 1 credit per character (Cartesia: 750–800 credits per
minute of audio). Mia speaks ~500 characters per minute of conversation, so
**~500 credits per minute of conversation**.

| Plan | Price/month | Credits | Minutes of conversation |
|---|---|---|---|
| Free | $0 | 20k | ~40 (no overage: then Aura takes over) |
| Pro | $5 | 100k | ~200; overage $65 / 1M credits |
| Startup | $49 | 1.25M | ~2,500; overage $45 / 1M |
| Scale | $299 | 8M | ~16,000 |

At the usage estimated in the audio investigation (20 three-minute
conversations a day, ~650k characters/month): Pro + overage ≈ $5 + 550k ×
$65/M ≈ **$41/month**, or Startup **$49/month** with room for ~2× that.
Testing uses credits too (a voice-test run is ~5–10k).
