# Debian (not alpine): this service shells out to ffmpeg for the encode, to a
# headless Chromium for Devanagari shaping + box measurement, and to Python for
# forced alignment. Chromium, complex-text fonts and torch wheels are all painful
# on musl. Build context is this directory, not the repo root. Dokploy resolves
# the context from the Dockerfile's own location (CLAUDE.md §11), so every COPY
# below is relative to services/mantra-tutorials/.
FROM node:22-bookworm-slim

WORKDIR /app

# ffmpeg   the encode, and libass for the ASS underline overlay.
# chromium headless HTML->PNG and layout read-back (src/browser.js finds /usr/bin/chromium).
# fonts    Chromium needs real Devanagari + Latin faces for shaping/fallback.
# python3  the forced aligner (aligner/align.py); git for its pip install.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ffmpeg \
      chromium \
      fonts-deva fonts-lohit-deva fonts-noto-core fonts-dejavu-core \
      fontconfig \
      python3 python3-venv git ca-certificates \
 && fc-cache -f \
 && rm -rf /var/lib/apt/lists/*

# CPU-only torch keeps the image ~1 GB smaller than the default CUDA wheels.
COPY aligner/requirements.txt ./aligner/requirements.txt
RUN python3 -m venv /app/aligner/.venv \
 && /app/aligner/.venv/bin/pip install --no-cache-dir torch torchaudio --index-url https://download.pytorch.org/whl/cpu \
 && /app/aligner/.venv/bin/pip install --no-cache-dir -r aligner/requirements.txt

# Zero Node runtime deps (node:http + stdlib), so there is nothing to npm install.
COPY package.json ./
COPY src ./src
COPY public ./public
COPY aligner/*.py ./aligner/
COPY prototype/assets ./prototype/assets
# The mantra bundles' committed inputs (text, background, fonts). The chant
# audio (*.mp3) is gitignored, so a real build needs it mounted or added.
COPY mantras ./mantras

# HF_HOME on the volume: the Sanskrit model downloads once, not on every deploy.
ENV NODE_ENV=production \
    PORT=3200 \
    DATA_DIR=/data \
    HF_HOME=/data/hf \
    BROWSER_PATH=/usr/bin/chromium \
    FFMPEG_PATH=/usr/bin/ffmpeg

RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 3200

# node:slim ships wget; the healthcheck hits the unauthenticated /healthz.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3200/healthz || exit 1

CMD ["node", "src/index.js"]
