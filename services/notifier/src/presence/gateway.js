import { config } from '../config.js';

/**
 * Live frames from services/youtube.
 *
 * This service never talks to youtube.com itself (CLAUDE.md §8, §13): the
 * gateway does, through a VPN, and hands back a JPEG. Its errors carry a
 * stable code, which is what decides between "No stream" and "try again".
 */

export class GatewayError extends Error {
  constructor(code, message, status = 0) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export async function fetchFrame(videoId, { width = 960 } = {}) {
  const { gatewayUrl, gatewayToken, gatewayTimeoutSeconds } = config.presence;
  if (!gatewayUrl || !gatewayToken) {
    throw new GatewayError('not_configured', 'YOUTUBE_GATEWAY_URL / YOUTUBE_GATEWAY_TOKEN are not set');
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), gatewayTimeoutSeconds * 1000);
  let res;
  try {
    res = await fetch(`${gatewayUrl}/v1/frame/${encodeURIComponent(videoId)}?width=${width}`, {
      signal: ac.signal,
      headers: { authorization: `Bearer ${gatewayToken}` },
    });
    if (res.ok) {
      const jpeg = Buffer.from(await res.arrayBuffer());
      if (!jpeg.length) throw new GatewayError('empty_frame', 'gateway returned an empty body', res.status);
      const captured = Date.parse(res.headers.get('x-captured-at') || '');
      return { jpeg, capturedAt: Number.isFinite(captured) ? captured : Date.now() };
    }

    // FastAPI wraps the body as {"detail": {"error": ..., "detail": ...}}.
    const body = await res.json().catch(() => ({}));
    const d = body?.detail && typeof body.detail === 'object' ? body.detail : body;
    const code = d?.error || `http_${res.status}`;
    const why = typeof d?.detail === 'string' ? `: ${d.detail.slice(0, 200)}` : '';
    throw new GatewayError(code, `gateway ${res.status} ${code}${why}`, res.status);
  } catch (err) {
    if (err instanceof GatewayError) throw err;
    if (err.name === 'AbortError') {
      throw new GatewayError('timeout', `gateway gave no frame within ${gatewayTimeoutSeconds}s`);
    }
    throw new GatewayError('unreachable', `gateway unreachable: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}
