FROM node:22-alpine

WORKDIR /app

# Build context is this directory, not the repo root: Dokploy resolves the
# context from the Dockerfile's own location (CLAUDE.md §11).
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src
COPY public ./public

ENV NODE_ENV=production \
    PORT=3300

EXPOSE 3300

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3300/healthz || exit 1

CMD ["node", "src/index.js"]
