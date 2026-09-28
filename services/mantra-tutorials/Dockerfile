# Debian (not alpine): this service shells out to ffmpeg for the encode and to a
# headless Chromium for Devanagari shaping + box measurement, and Chromium plus
# complex-text fonts are painful on musl. Build context is this directory, not the
# repo root — Dokploy resolves the context from the Dockerfile's own location
# (CLAUDE.md §11), so every COPY below is relative to services/mantra-tutorials/.
FROM node:22-bookworm-slim

WORKDIR /app

# ffmpeg  — the encode (libx264 + the sendcmd/drawbox underline).
# chromium — headless HTML→PNG and layout read-back (src/browser.js finds /usr/bin/chromium).
# fonts   — Chromium needs real Devanagari + Latin faces installed for correct
#           shaping/fallback; a bundle may ship its own, but these are the floor.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ffmpeg \
      chromium \
      fonts-deva fonts-lohit-deva fonts-noto-core fonts-dejavu-core \
      fontconfig \
 && fc-cache -f \
 && rm -rf /var/lib/apt/lists/*

# Zero runtime deps (node:http + node stdlib), so there is nothing to npm install;
# copying package.json alone keeps `node` happy about the ESM "type":"module".
COPY package.json ./
COPY src ./src
COPY public ./public
COPY prototype/assets ./prototype/assets
# The mantra bundles' committed inputs (text, deepgram cache, background, fonts).
# The chant audio (*.mp3) is gitignored, so a real build needs it mounted or added.
COPY mantras ./mantras

ENV NODE_ENV=production \
    PORT=3200 \
    DATA_DIR=/data \
    BROWSER_PATH=/usr/bin/chromium \
    FFMPEG_PATH=/usr/bin/ffmpeg

RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 3200

# node:slim ships wget; the healthcheck hits the unauthenticated /healthz.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3200/healthz || exit 1

CMD ["node", "src/index.js"]
