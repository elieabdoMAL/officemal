# Screen tests for Mia

Checks for the kiosk screen work of 2026-10-12: #2 (Mia presses on-screen
buttons), #3 (layout in one tunable place) and #7 (the directions card).
Companion of `tests/voice/` (whose lib supplies the keys, the sandbox team
and the worker/site boot); `docs/screen-protocol.md` sections 3, 5 and 9 are
the contract under test.

Both scripts open the full kiosk page only with **every request to
production blocked** and the tour's AIWEB frame rewritten to the local site
(`lib.mjs`, `kioskPage`): a full-page test must never talk to the live Mia.
Needs the tour in `public/3dvista` (git-ignored; copy it from the main
checkout), `npm ci`, and Docker for anything with a worker.

## run.mjs — the checks

```bash
node tests/screen/run.mjs --id u --port 3123             # parts 1 and 2 (no worker)
node tests/screen/run.mjs --id u --port 3123 --livekit   # + part 3 (worker + a real room)
```

1. **Embed alone** (`/receptionist-embed`, dev build, `miaDev`): `press`
   `contact` draws the contact card in the embed; every other button is
   forwarded to the top page as `receptionist-press`, in order; unknown
   buttons, bad `maps_url`s and a missing address are refused; the directions
   card shows the address and a client-side QR, closes on × and on its
   timeout (shortened with `?cardMs=1500`).
2. **Full kiosk page**: a press injected in the embed frame opens each
   meeting room pop-up, recenters the view (spied on the tour's `blazeIT`),
   mutes/unmutes the kiosk and enters VR — the same code path as a tap. The
   private meeting room's external Jitsi is stubbed out.
3. **`--livekit`**: the worker runs (image `simli-worker:<id>`, sandbox team
   mounted), a real session opens on the full page, and the press +
   directions messages travel through the real LiveKit room
   (`scripts/mia-screen-push.py`) — the same `send_text` path the worker's
   `press_button` uses.

Output: `tests/screen/out/report.md` + screenshots. Exit 0 when all pass.

That Gemini actually calls `press_button` the right way is covered by
`agent-worker/test_press_button.py` (text, real Gemini) and the voice
scenario `press_screen` (`node tests/voice/run.mjs --id u --port 3123 screen`).

## shots.mjs — the layout screenshots (#3)

```bash
node tests/screen/shots.mjs --id u --port 3123 before
# …edit src/lib/screenLayout.ts…
node tests/screen/shots.mjs --id u --port 3123 after
```

Starts the worker and the site, opens the kiosk page at 1920x1080 and
1080x1920 (in case the kiosk is vertical), waits for her real session, then
drives captions and each card through `miaDev`. Output:
`tests/screen/out/shots/<label>/<WxH>_<state>.png` — the before/after pairs
the boss picks from. Every tunable (captions, Contact button, cards) lives in
`src/lib/screenLayout.ts`.
