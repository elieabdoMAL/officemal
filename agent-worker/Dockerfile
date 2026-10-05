# Simli Trinity receptionist worker. Build/run on the Debian server (Docker
# 29.4.3 is already installed there).
#
#   docker build -t simli-worker .
#   docker run -d --name simli-worker --env-file .env --restart unless-stopped simli-worker
#
# Or use docker-compose.yml (docker compose up -d --build).
FROM python:3.11-slim

# Silero VAD (via livekit-plugins-silero) pulls in torch/onnx; ffmpeg/libsndfile
# cover audio handling for the STT/TTS plugins.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first so the layer caches across code changes.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY worker.py team_messages.py mia_prompt.txt team.json ./

# Keep STDOUT/STDERR unbuffered so `docker logs` is live.
ENV PYTHONUNBUFFERED=1

CMD ["python", "worker.py", "start"]
