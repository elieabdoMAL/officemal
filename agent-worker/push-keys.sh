#!/usr/bin/env bash
# Push the Simli + LiveKit keys from agent-worker/.env to everywhere they live:
#   1. checks them against Simli and LiveKit first (nothing is changed if bad)
#   2. Vercel (LIVEKIT_* only — the site never reads the Simli vars) + deploy
#   3. the server's /var/www/officeMal/agent-worker/.env, then restarts simli-worker
#
# Usage (from the repo root, in Git Bash):
#   bash agent-worker/push-keys.sh                    # check + Vercel only
#   bash agent-worker/push-keys.sh eabdo@<server-ip>  # check + Vercel + server
#   CHECK_ONLY=1 bash agent-worker/push-keys.sh       # just test the keys
#
# Optional: SSH_KEY=path/to/key (defaults to ~/.ssh/eabdo.key if present).
# Secrets go over stdin, never on a command line.
set -euo pipefail

cd "$(dirname "$0")/.."
ENV_FILE=agent-worker/.env
SERVER="${1:-}"
REMOTE_DIR=/var/www/officeMal/agent-worker
PROD_URL=officemal.mobileappslabs.ca

# Read KEY=value lines, ignoring comments and Windows line endings.
get() { grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d '\r' | sed 's/[[:space:]]*$//'; }

SIMLI_API_KEY=$(get SIMLI_API_KEY)
SIMLI_FACE_ID=$(get SIMLI_FACE_ID)
LIVEKIT_URL=$(get LIVEKIT_URL)
LIVEKIT_API_KEY=$(get LIVEKIT_API_KEY)
LIVEKIT_API_SECRET=$(get LIVEKIT_API_SECRET)

for v in SIMLI_API_KEY SIMLI_FACE_ID LIVEKIT_URL LIVEKIT_API_KEY LIVEKIT_API_SECRET; do
  [ -n "${!v}" ] || { echo "✗ $v is empty in $ENV_FILE"; exit 1; }
done

echo "== 1. Checking keys"
ok=1

# Simli: same endpoint + body shape the worker's plugin uses.
simli=$(curl -s -m 20 -w '\n%{http_code}' -X POST https://api.simli.ai/compose/token \
  -H "x-simli-api-key: $SIMLI_API_KEY" -H 'content-type: application/json' \
  -d "{\"faceId\":\"$SIMLI_FACE_ID\",\"handleSilence\":true,\"maxSessionLength\":10,\"maxIdleTime\":5}")
if [ "$(tail -1 <<<"$simli")" = 200 ]; then
  echo "  ✓ Simli key + face ID"
else
  echo "  ✗ Simli: $(head -1 <<<"$simli" | grep -oE '"detail": ?"[^"]+"' || echo "HTTP $(tail -1 <<<"$simli")")"
  ok=0
fi

# LiveKit: an authenticated API call proves the key/secret pair is live.
if LK_URL="$LIVEKIT_URL" LK_KEY="$LIVEKIT_API_KEY" LK_SECRET="$LIVEKIT_API_SECRET" node --input-type=module -e '
  import { RoomServiceClient } from "livekit-server-sdk";
  const { LK_URL, LK_KEY, LK_SECRET } = process.env;
  await new RoomServiceClient(LK_URL.replace(/^ws/, "http"), LK_KEY, LK_SECRET).listRooms();
' 2>/dev/null; then
  echo "  ✓ LiveKit key + secret"
else
  echo "  ✗ LiveKit rejected the key/secret (or URL)"
  ok=0
fi

[ "$ok" = 1 ] || { echo "Fix the values above in $ENV_FILE — nothing was changed."; exit 1; }
[ -z "${CHECK_ONLY:-}" ] || { echo "CHECK_ONLY set — stopping here."; exit 0; }

# The server must run a worker image that uses explicit dispatch before it gets
# keys for a shared LiveKit project — an older image joins every room on the
# project (expo360's too). Refuse unless Docker Hub's image is newer than the
# local worker.py and mia_prompt.txt, i.e. build-and-push.sh has run since.
if [ -n "$SERVER" ]; then
  pushed=$(curl -s -m 20 "https://hub.docker.com/v2/repositories/elieabdomal/simli-worker/tags/latest" \
    | grep -oE '"tag_last_pushed": ?"[^"]+"' | cut -d'"' -f4)
  pushed_s=$(date -d "$pushed" +%s 2>/dev/null || echo 0)
  newest=$(stat -c %Y agent-worker/worker.py agent-worker/mia_prompt.txt | sort -n | tail -1)
  if [ "$pushed_s" -lt "$newest" ]; then
    echo "✗ Docker Hub's worker image (pushed ${pushed:-unknown}) is older than worker.py / mia_prompt.txt."
    echo "  Run first:  cd agent-worker && bash build-and-push.sh"
    exit 1
  fi
  echo "  ✓ worker image on Docker Hub is up to date"
fi

echo "== 2. Vercel"
for v in LIVEKIT_URL LIVEKIT_API_KEY LIVEKIT_API_SECRET; do
  printf '%s' "${!v}" | vercel env add "$v" production --force --sensitive -y >/dev/null
  echo "  ✓ $v (production)"
done
# A fresh production deploy of this folder, not `vercel redeploy`: the token
# route has to ship with the code that dispatches the worker by name.
echo "  deploying this folder to production ($PROD_URL)…"
vercel deploy --prod

if [ -z "$SERVER" ]; then
  echo "== 3. Server skipped (pass user@host to update it)"
  exit 0
fi

echo "== 3. Server $SERVER"
SSH_OPTS=()
KEY="${SSH_KEY:-$HOME/.ssh/eabdo.key}"
[ -f "$KEY" ] && SSH_OPTS=(-i "$KEY")

# The remote script (with the values baked in) travels over stdin. It rewrites
# only these five lines, keeps a backup, and recreates the worker container.
{
  echo "set -e; cd $REMOTE_DIR; cp .env .env.bak.\$(date +%s)"
  for v in SIMLI_API_KEY SIMLI_FACE_ID LIVEKIT_URL LIVEKIT_API_KEY LIVEKIT_API_SECRET; do
    echo "grep -v '^$v=' .env > .env.tmp || true; echo '$v=${!v}' >> .env.tmp; mv .env.tmp .env"
  done
  echo "docker compose up -d --force-recreate simli-worker"
  echo "echo '--- worker logs (25s) ---'; timeout 25 docker compose logs -f --since 30s simli-worker || true"
} | ssh "${SSH_OPTS[@]}" "$SERVER" 'tr -d "\r" | bash -s'

echo "Done. Look above for 'registered worker' — and no INVALID_FACE_ID / invalid API key errors."
