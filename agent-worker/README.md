# Simli Trinity Receptionist — LiveKit Agents Worker

This is the **conversation brain** for the lobby kiosk avatar (Mia). It's a
self-hosted Python process that joins a LiveKit room and runs:

```
Deepgram STT  →  Gemini 2.5 Flash  →  Deepgram TTS  →  Simli avatar (Trinity face 5f911c8d)
```

## Bilingual (FR / EN)

She greets with "Bonjour, hi!" and then answers in whichever language the
visitor speaks, switching per turn. Three pieces make that work:

- **STT** runs `nova-3` with `language="multi"` — required, since the nova-2
  models are English-only. It reports the language of each utterance.
- **TTS** swaps voices per turn via `update_options(model=…)`, because one Aura
  voice speaks one language: `aura-2-agathe-fr` / `aura-2-andromeda-en`.
- **The system prompt** tells her to match the visitor's language; without that
  line Gemini replies in English no matter what it was given.

> **Accent caveat:** Aura has no `fr-CA` voice, so her French is France French,
> not Québécois. Changing that means a different TTS vendor (ElevenLabs,
> Cartesia) — a new key and a `requirements.txt` change.

`MIN_STT_CONFIDENCE` gates each turn; below it she answers "I'm sorry, I didn't
get that" / "Désolée, je n'ai pas compris" instead of letting Gemini improvise
on noise. Multilingual STT scores lower than English-only did, so it sits at
0.5 — every turn logs its confidence and detected language, so retune from the
real distribution in `docker compose logs -f`.

**Why this exists:** Simli's hosted "Auto" API only renders *Legacy* faces. The
face we want (Mia, `5f911c8d`) is a *Trinity* face, and Trinity faces can only be
driven through a self-hosted LiveKit worker — this one. The browser
(`SimliLiveKitPanel.tsx` in the Next.js app) joins the same LiveKit room and
plays the avatar video/audio this worker publishes.

The worker is **identical** whether you run it on your PC or the server. Only the
run command and keep-alive differ. Test on your PC first, then deploy the same
folder to the server.

---

## Prerequisites: API keys (all free tiers)

Fill these into `.env` (copy from `env.example`):

| Key | Where to get it | Notes |
|---|---|---|
| `SIMLI_API_KEY` | Simli dashboard | already have it |
| `SIMLI_FACE_ID` | — | pre-filled: `5f911c8d-7b81-40f6-bed0-de435f02e10d`. Changing the face is a `.env` edit + `docker compose up -d` on the server — no rebuild. Check the new face's backdrop colour against the chroma-key in `SimliLiveKitPanel.tsx`. |
| `SIMLI_MAX_IDLE_TIME` | — | optional, default `180`s. Simli bills render time, so the avatar disconnects after this much silence. The plugin's own default is 30s, far too short for a kiosk. |
| `SIMLI_MAX_SESSION_LENGTH` | — | optional, default `1800`s. Backstop so a wedged session can't bill overnight. |
| `GOOGLE_API_KEY` | [aistudio.google.com](https://aistudio.google.com) → "Get API key" | **not** your Workspace/Gemini Pro sub — a separate AI Studio key |
| `DEEPGRAM_API_KEY` | [console.deepgram.com](https://console.deepgram.com) | one key = STT **and** TTS; $200 free credit |
| `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | [cloud.livekit.io](https://cloud.livekit.io) → project → Settings → Keys | free tier |

The **same** LiveKit project must be used by the Next.js token route
(`/api/livekit/token`), so the worker and browser land in the same room.

---

## 1. Test on your PC first

Requires **Python 3.9+** (3.11+ ideal).

```bash
cd agent-worker
python -m venv .venv
# Windows (PowerShell):
.venv\Scripts\Activate.ps1
# macOS/Linux:
# source .venv/bin/activate

pip install -r requirements.txt
cp env.example .env          # then edit .env and paste your keys
                             # (Windows: copy env.example .env)

python worker.py dev
```

`dev` mode connects to LiveKit and hot-reloads on file changes. To **see the
avatar talk**, open the **Agents Sandbox** in your LiveKit Cloud dashboard
(Agents → Sandbox / "Hosted token"), join a room, and confirm:

1. the worker auto-joins the room,
2. the **Trinity face renders** (not a white frame),
3. she greets you unprompted ("Hi there! Welcome to Mobile Apps Labs…"),
4. talking to her gets a Gemini reply, spoken via Deepgram, lip-synced.

If that works, the whole AI pipeline is proven. Then start the Next.js app and
open `/receptionist-embed` with `NEXT_PUBLIC_AVATAR_PROVIDER=simli-livekit` to
test the real kiosk UI (keep this worker running while you do).

> Pin versions once it works: `pip freeze > requirements.lock.txt` so the server
> install matches exactly.

---

## 2. Deploy to the server — Docker Hub build/push/pull

Flow: **build + push from your PC → pull + run on the server.** No source code on
the server; only `docker-compose.yml` + `.env` live in `/var/www/officeMal`.
Docker Hub account: **elieabdomal**, image **`elieabdomal/simli-worker:latest`**.

### 2a. On your PC — build for the server's arch and push

The server is **linux/amd64**. Build for that explicitly (works even if your PC is
arm64) and push in one step:

```bash
cd agent-worker
docker login                      # once
export DOCKERHUB_USER=elieabdomal
./build-and-push.sh               # = docker buildx build --platform linux/amd64 -t elieabdomal/simli-worker:latest --push .
```

(On Windows without bash, run the buildx line directly in PowerShell — drop the
`./build-and-push.sh` and use the command shown in that file.)

### 2b. On the server (Debian, via PuTTY) — one-time setup

```bash
sudo mkdir -p /var/www/officeMal && sudo chown eabdo:eabdo /var/www/officeMal
cd /var/www/officeMal

# copy ONLY these two onto the server (WinSCP, or scp from your PC):
#   agent-worker/docker-compose.server.yml  ->  /var/www/officeMal/docker-compose.yml
#   (then create .env here)
cp env.example .env   # or create it; paste the 6 keys (Simli, Google, Deepgram, 3x LiveKit)
nano .env

docker login                      # once, same Docker Hub account
docker compose pull
docker compose up -d
docker compose logs -f            # confirm it registers with LiveKit
```

> Note: rename `docker-compose.server.yml` to `docker-compose.yml` on the server
> (it's the pull-only version — no `build:` section, just `image:`).

### 2c. Updating later — fully automatic (Watchtower)

The server compose file also runs **Watchtower**, which checks Docker Hub every
2 minutes and auto-pulls + restarts `simli-worker` when a new image appears. So
your whole update cycle is just **one command on your PC**:

```bash
./build-and-push.sh      # PC: build + push. Server updates itself within ~2 min.
```

Watchtower is **scoped by label** (`--label-enable`) so it only manages
`simli-worker` — it will **never** touch `looking4-api`, `l4-api-db`, or any other
container on the host.

`restart: unless-stopped` keeps the worker alive through crashes and reboots.

### Alternative: systemd service (no Docker)

Create `/etc/systemd/system/simli-worker.service`:

```ini
[Unit]
Description=Simli Trinity receptionist (LiveKit Agents worker)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=eabdo
WorkingDirectory=/home/eabdo/officemal/agent-worker
EnvironmentFile=/home/eabdo/officemal/agent-worker/.env
ExecStart=/home/eabdo/officemal/agent-worker/.venv/bin/python worker.py start
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now simli-worker
sudo systemctl status simli-worker
journalctl -u simli-worker -f          # watch live logs
```

To deploy an update later:

```bash
cd ~/officemal && git pull              # (or scp the folder again)
~/officemal/agent-worker/.venv/bin/pip install -r agent-worker/requirements.txt
sudo systemctl restart simli-worker
journalctl -u simli-worker -f
```

---

## Notes

- The worker reads `LIVEKIT_URL/API_KEY/API_SECRET` from the environment
  automatically — no token minting here (the Next.js route does that for the
  browser).
- `WorkerType.ROOM` (the default) means **automatic dispatch**: the worker joins
  every new room on the LiveKit project. Keep only this one agent on the project,
  or switch to explicit dispatch.
- The system prompt and first message are duplicated from
  `src/app/api/simli/session/route.ts` (`DEFAULT_SYSTEM_PROMPT` /
  `DEFAULT_FIRST_MESSAGE`). If you change Mia's persona, update both.
