FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3400 DATA_DIR=/data
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund
COPY src ./src
COPY public ./public
COPY prompts ./prompts
VOLUME /data
EXPOSE 3400
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -qO- http://127.0.0.1:3400/healthz >/dev/null || exit 1
CMD ["node", "src/index.js"]
