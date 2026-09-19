FROM node:22-alpine

WORKDIR /app

# Build context is this directory, not the repo root: Dokploy resolves the
# context from the Dockerfile's own location, so repo-root-relative COPY paths
# fail there with "not found" even though the files are in the repo.
# Dependencies first so Docker layer caching survives source edits.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src
COPY scripts ./scripts

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data

RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1

CMD ["node", "src/index.js"]
