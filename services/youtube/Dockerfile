FROM python:3.12-slim-bookworm

# Everything that talks to youtube.com lives in this one image, behind a small
# HTTP API, so no other service needs yt-dlp, a VPN or a PO token:
#   wireguard-tools + iptables  egress through the VPN, with a kill switch
#   deno                        yt-dlp's JS challenge solver (EJS) and the
#                               runtime for the bgutil PO-token server
#   bgutil server (native)      PO tokens on 127.0.0.1:4416, no sidecar
#   yt-dlp + bgutil plugin      resolves the live HLS manifest
#   ffmpeg                      takes the frame
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl unzip git ffmpeg tini \
      wireguard-tools iproute2 iptables \
 && rm -rf /var/lib/apt/lists/*

ENV DENO_INSTALL=/usr/local
RUN curl -fsSL https://deno.land/install.sh | sh -s -- -y --no-modify-path \
 && deno --version

# The server version must match the pip plugin version in requirements.txt.
ARG BGUTIL_VERSION=2.0.0
RUN git clone --depth 1 --single-branch --branch ${BGUTIL_VERSION} \
      https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git /opt/bgutil \
 && cd /opt/bgutil/server \
 && deno install --allow-scripts=npm:canvas --frozen

WORKDIR /app

# Build context is this directory, not the repo root: Dokploy resolves the
# context from the Dockerfile's own location.
COPY requirements.txt ./
# yt-dlp is installed from pre-releases on purpose: YouTube breaks extraction
# often and fixes land in nightlies first. Rebuild the image to pick them up.
RUN pip install --no-cache-dir --pre -r requirements.txt

COPY app ./app
COPY entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=8090

EXPOSE 8090

# python:slim has no wget; the probe is the interpreter. /healthz is local-only
# (VPN interface up + PO-token server answering), it never calls out.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8090/healthz', timeout=4).status == 200 else 1)"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/app/entrypoint.sh"]
