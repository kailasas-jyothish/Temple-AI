FROM node:22-alpine

WORKDIR /app

# Build context is this directory, not the repo root: Dokploy resolves the
# context from the Dockerfile's own location (CLAUDE.md §11).
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# Self-signed origin cert for the TLS listener. Cloudflare in Full (not strict)
# mode accepts it; visitors only ever see Cloudflare's certificate.
RUN apk add --no-cache openssl \
 && mkdir -p /app/tls \
 && openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=temple.unclutch.dev" \
      -keyout /app/tls/key.pem -out /app/tls/cert.pem

COPY src ./src
COPY public ./public

ENV NODE_ENV=production \
    PORT=3300 \
    TLS_PORT=3443

EXPOSE 3300 3443

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3300/healthz || exit 1

CMD ["node", "src/index.js"]
