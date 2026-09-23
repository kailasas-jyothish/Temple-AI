FROM node:22-alpine

WORKDIR /app

# For the attendance snapshot only: yt-dlp resolves the live HLS manifest and
# ffmpeg takes one frame off it. Both are optional at runtime — the capture
# falls back to the Data API thumbnail — but youtube.com is hostile to this
# host (see CLAUDE.md §9), so having them here is what makes trying possible.
RUN apk add --no-cache yt-dlp ffmpeg

# Build context is this directory, not the repo root: Dokploy resolves the
# context from the Dockerfile's own location, so repo-root-relative COPY paths
# fail there with "not found" even though the files are in the repo.
# Dependencies first so Docker layer caching survives source edits.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src
COPY scripts ./scripts
COPY temples.json ./temples.json

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data

RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1

CMD ["node", "src/index.js"]
