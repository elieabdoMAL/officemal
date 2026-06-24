#!/usr/bin/env bash
# Build the worker image for the SERVER's architecture (linux/amd64) and push
# it to Docker Hub. Run from your PC (Git Bash / WSL / any shell with docker).
#
#   ./build-and-push.sh
#
# Prereqs: `docker login` done once. buildx ships with Docker Desktop.
set -euo pipefail

USER="${DOCKERHUB_USER:-elieabdomal}"
IMAGE="$USER/simli-worker:latest"

# --platform linux/amd64: the Debian server is amd64. Building for it explicitly
# means the image runs there even if your PC is arm64. --push builds + uploads
# in one step (buildx can't --load a cross-arch image, so we push directly).
docker buildx build --platform linux/amd64 -t "$IMAGE" --push .

echo "Pushed $IMAGE"
echo "On the server: docker compose pull && docker compose up -d"
