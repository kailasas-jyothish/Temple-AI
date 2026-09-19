FROM node:22-alpine

WORKDIR /app

# Build context is the repo root, not this directory, so every service's
# Dockerfile addresses its own files by full path. Dokploy keeps
# customGitBuildPath at '/' and points at this file.
# Dependencies first so Docker layer caching survives source edits.
COPY services/notifier/package.json services/notifier/package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY services/notifier/src ./src
COPY services/notifier/scripts ./scripts

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data

RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1

CMD ["node", "src/index.js"]
