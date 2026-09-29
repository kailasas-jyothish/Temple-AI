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
      python3 python3-venv python3-dev build-essential git ca-certificates \
 && fc-cache -f \
 && rm -rf /var/lib/apt/lists/*

# CPU-only torch keeps the image ~1 GB smaller than the default CUDA wheels.
# Debian's pip (23.0) resolves every dependency against --index-url alone and
# fails on the PyTorch index's typing_extensions, so upgrade pip first and let
# everything but torch come from PyPI. build-essential/python3-dev: the aligner
# compiles a small C++ extension on Linux.
COPY aligner/requirements.txt ./aligner/requirements.txt
RUN python3 -m venv /app/aligner/.venv \
 && /app/aligner/.venv/bin/pip install --no-cache-dir --upgrade pip \
 && /app/aligner/.venv/bin/pip install --no-cache-dir torch torchaudio --index-url https://download.pytorch.org/whl/cpu --extra-index-url https://pypi.org/simple \
 && /app/aligner/.venv/bin/pip install --no-cache-dir -r aligner/requirements.txt

# Zero Node runtime deps (node:http + stdlib), so there is nothing to npm install.
COPY package.json ./
COPY src ./src
COPY public ./public
COPY aligner/*.py ./aligner/
COPY assets ./assets

# No bundles ship in the image: they are content, not code, and are made in the
# UI. They live on the volume so they survive a redeploy.
# HF_HOME on the volume: the Sanskrit model downloads once, not on every deploy.
ENV NODE_ENV=production \
    PORT=3200 \
    DATA_DIR=/data \
    MANTRAS_DIR=/data/mantras \
    HF_HOME=/data/hf \
    BROWSER_PATH=/usr/bin/chromium \
    FFMPEG_PATH=/usr/bin/ffmpeg

RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 3200

# bookworm-slim has no wget or curl, and a missing binary fails every check, so
# Swarm replaced the container about once a minute. Node's own fetch is always there.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3200/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

CMD ["node", "src/index.js"]
