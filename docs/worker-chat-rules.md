# Rules for worker chats (Mia / OfficeMal)

You are one of several chats working in parallel. A main chat reviews and
merges your branch. Read this file, `docs/feedback-2026-10-09.md`, and
`docs/mia-tasks.md` before starting.

## Setup
- Work in a **git worktree** on a new branch, branched from the latest
  `simli-livekit-trinity` (run `git fetch` first; check `git log --oneline -1`
  shows the latest commit, worktrees here have been created from old commits
  before). Commit on your branch, push it to `origin`, don't merge.
- Next.js 16 has breaking changes: read the relevant guide in
  `node_modules/next/dist/docs/` before writing Next code (see AGENTS.md).
- The worktree has no `node_modules`: run `npm ci` if you need the site.
- Python is not installed on this PC. Use Docker: build the worker image from
  your worktree, `docker build -t simli-worker:<your-chat-letter> agent-worker`.
- Bash is Git Bash on Windows: use `MSYS_NO_PATHCONV=1` and `cygpath -w` for
  Docker volume paths.
- API keys: only in the main checkout, read them from there, never copy them
  into your worktree or commits:
  `C:\Users\user\Desktop\officemal\agent-worker\.env`.

## Never
- Deploy: no `build-and-push.sh`, `push-keys.sh`, `vercel`, `docker push`,
  `ssh`, and never retag `simli-worker:latest`.
- Email real people. Mount the sandbox team file
  `C:\Users\user\AppData\Local\Temp\mia_e2e\team.json` (all addresses are
  `delivered@resend.dev`) over `/app/team.json` in every worker you run, and
  pass `-e RESEND_API_KEY=` to text tests. If you add a new email destination
  (e.g. info@), make it come from team.json or env so tests can sandbox it.
- Edit files another chat owns (see the ownership rule in
  `docs/feedback-2026-10-09.md`). If you must, keep it to a minimum and say so
  in your report.
- Commit secrets.

## Testing
- Text tests (real Gemini, emails recorded not sent):
  `docker run --rm --env-file "C:\Users\user\Desktop\officemal\agent-worker\.env" -v "<worktree>\agent-worker":/app -w /app -e PYTHONIOENCODING=utf-8 -e RESEND_API_KEY= simli-worker:<x> python test_team_messages.py`
  Extend it (or add a sibling test file) for what you change.
- Voice tests: kit in `C:\Users\user\AppData\Local\Temp\mia_e2e\` —
  `scenarios.json`, one WAV per scenario (visitor lines + pauses, made with
  Deepgram TTS), and `run.mjs` (Playwright: opens the kiosk page with the WAV as
  the mic, records Mia's audio to `<name>_mia.webm`, prints worker logs).
  Copy `run.mjs` into your worktree root to run it, delete it after.
  - Worker: `docker run -d --name mia-<x> --env-file <main .env> -e LIVEKIT_AGENT_NAME=mia-<x> -v "<kit>\team.json":/app/team.json:ro simli-worker:<x>`
  - Site: `npx next dev -p <port>` from your worktree with `LIVEKIT_URL`,
    `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` from the main .env,
    `LIVEKIT_AGENT_NAME=mia-<x>`, `NEXT_PUBLIC_AVATAR_PROVIDER=simli-livekit`.
  - Use your own agent name, container name and port so chats don't collide
    (P: 3101, C: 3102, S: 3103, A: 3104).
  - Transcribe recordings with Deepgram `/v1/listen?model=nova-3&language=multi&utterances=true`
    to check what the kiosk actually played.
- Site: `npx tsc --noEmit -p .` and `npx next build` must pass (`next build`
  needs any non-empty `RESEND_API_KEY` env to compile).
- Clean up at the end: stop your containers and dev server.

## Report (paste-ready for the main chat)
Branch name and commits · what changed and why, per note number · test
results (transcripts for voice tests) · anything not verified · inputs you
still need from the boss.
