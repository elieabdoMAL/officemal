# Voice tests for Mia

End-to-end tests through the real kiosk page: a scenario's visitor lines are
played as the microphone, Mia's audio is recorded off the page, transcribed
with Deepgram, and checked against what the scenario expects (words she must
or mustn't say, tools that must or mustn't fire, whether the session ended).

## Run

From the repo root (Windows Git Bash is fine), after `npm ci`:

```bash
node tests/voice/run.mjs --id t --port 3106 wave1        # a group of scenarios
node tests/voice/run.mjs --id t --port 3106 phone_en     # one scenario
node tests/voice/run.mjs --id t --port 3106 all          # every scenario, idle included (~2 min more)
```

`--id` names your worker: container and LiveKit agent `mia-<id>`, image
`simli-worker:<id>`. Use your own id and port so parallel runs don't answer
each other's rooms (defaults: `e2e`, 3100).

It starts what isn't running and stops it at the end:

- the worker: image `simli-worker:<id>`, built from `agent-worker/` if missing
  (`--build` rebuilds it, `--restart` replaces a running container), with
  the main `.env` and **the sandbox team mounted over `/app/team.json`**;
- the site: `next dev -p <port>`, dispatching to `mia-<id>`.

`--keep` leaves both running for the next run. If a server is already on the
port, it is used as is: it must have been started with
`LIVEKIT_AGENT_NAME=mia-<id>` and `NEXT_PUBLIC_AVATAR_PROVIDER=simli-livekit`.

Scenarios run one at a time with a pause between them. The Simli key is shared
and returns 429 when several sessions start at once: on a 429 (or a session
that never opens the mic) the runner waits 60s, 120s, then 240s and retries.
Keep voice runs few when other chats are testing too.

Results go to `tests/voice/out/` (git-ignored): `report.md` (pass/fail, worker
log excerpts and transcript per scenario), `<name>.json` (everything),
`<name>_mia.webm` (the kiosk audio, to listen to). Exit code 0 when all pass.

## Files

| File | What |
|---|---|
| `scenarios.json` | The scenarios: visitor lines with the silence after each, voice, groups, expectations. The `_about` field documents every key. |
| `make-wavs.mjs` | Builds `out/<name>.wav` with Deepgram TTS (48 kHz mono). Run by `run.mjs`; regenerates only when a scenario's lines change. `node tests/voice/make-wavs.mjs [name ...] [--force]` |
| `sandbox-team.mjs` | Writes `out/team.sandbox.json`: `agent-worker/team.json` with every email (members and general inbox) set to `delivered@resend.dev`, and fails if any other address is left. |
| `run.mjs` | The runner (Playwright Chromium with the WAV as a fake mic). |
| `lib.mjs` | Paths, keys, options. |

Keys are read from `agent-worker/.env`; from a git worktree (which has none),
the main checkout's is found through git. `MIA_ENV=<path>` overrides.

## Writing a scenario

```json
"phone_en": {
  "groups": ["wave1"],
  "about": "What it checks, one line.",
  "voice": "en",
  "lines": [["English.", 8], ["What's your phone number?", 14], ["Sorry, can you say it again slowly?", 22]],
  "expect": { "say": [["/5 1 4 5 7 3 2 3 2 4/"]], "notSay": ["/hundred|fourteen/"], "said": ["/one, five, one, four/"], "ended": false }
}
```

- The WAV starts playing when the kiosk opens the mic, after her greeting, so
  the first line answers "Français ou English?".
- The pause after a line must cover her reply (latency ~2s plus speaking time).
  A short pause makes the next line interrupt her, which is sometimes the point
  (`pause_wake`).
- A third item in a line picks another voice: `en2` is a second English
  speaker (someone else in the lobby).
- `say` checks the recording (what the kiosk really played); `said` checks the
  worker's log of her text before TTS. Digit words are matched as digits too,
  so `/5 1 4/` matches both "five one four" and "514".
- `tools`: `take_message`, `notify_member`, `alert_emergency`,
  `end_conversation`, `pause`, `wake`, `switch` (read from the worker logs).

The text tests (real Gemini, no audio, emails recorded) are in `agent-worker/`:
`test_team_messages.py`, `test_conversation.py`, `test_persona.py`,
`test_guardrails.py`. Run them with the sandbox team too:

```bash
node tests/voice/sandbox-team.mjs   # writes tests/voice/out/team.sandbox.json
MSYS_NO_PATHCONV=1 docker run --rm --env-file "<main checkout>/agent-worker/.env" \
  -v "$(cygpath -w "$PWD/agent-worker")":/app \
  -v "$(cygpath -w "$PWD/tests/voice/out/team.sandbox.json")":/app/team.json:ro \
  -w /app -e PYTHONIOENCODING=utf-8 -e RESEND_API_KEY= simli-worker:t python test_guardrails.py
```
