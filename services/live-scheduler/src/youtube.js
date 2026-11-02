import fs from 'node:fs';

/**
 * YouTube Live over OAuth, with no SDK.
 *
 * An API key cannot do any of this: every liveBroadcasts call answers 401
 * "API keys are not supported by this API". It needs a user token from an
 * account that can act *as* the channel, i.e. its owner or a Brand Account
 * manager. YouTube Studio's own channel permissions (Editor, Manager) are
 * invisible to the API; a Studio editor's login reaches only their own
 * personal channel. That was proven on 2026-10-06, not assumed.
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DEVICE_URL = 'https://oauth2.googleapis.com/device/code';
const API = 'https://www.googleapis.com/youtube/v3';
const UPLOAD = 'https://www.googleapis.com/upload/youtube/v3';
// The device flow accepts only `youtube` and `youtube.readonly` from this API,
// and `youtube` is the one that covers liveBroadcasts and thumbnails.set.
const SCOPE = 'https://www.googleapis.com/auth/youtube';
const EARLY_RENEW_MS = 5 * 60 * 1000;

export class ApiError extends Error {
  constructor(status, reason, message) {
    super(`${status} ${reason ? `${reason}: ` : ''}${message}`);
    this.status = status;
    this.reason = reason;
  }
}

/** The client JSON as Cloud Console downloads it, either app type. */
export function loadClient(file) {
  if (!fs.existsSync(file)) throw new Error(`OAuth client file not found: ${file}`);
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const c = parsed.installed || parsed.web || parsed;
  if (!c.client_id || !c.client_secret) throw new Error(`${file} has no client_id / client_secret`);
  return { id: c.client_id, secret: c.client_secret };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Sign-in by code: the person opens google.com/device on any device. This is
 * the flow that works when the account holder is not at this machine, and it
 * needs the client to be of type "TVs and Limited Input devices".
 */
export async function deviceLogin(client, onCode) {
  const res = await fetch(DEVICE_URL, {
    method: 'POST',
    body: new URLSearchParams({ client_id: client.id, scope: SCOPE }),
  });
  const code = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`device code request failed: ${res.status} ${code.error || ''} ${code.error_description || ''}`);
  }
  onCode(code);

  let wait = (code.interval || 5) * 1000;
  const end = Date.now() + code.expires_in * 1000;
  while (Date.now() < end) {
    await sleep(wait);
    let r;
    try {
      r = await fetch(TOKEN_URL, {
        method: 'POST',
        body: new URLSearchParams({
          client_id: client.id,
          client_secret: client.secret,
          device_code: code.device_code,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
      });
    } catch {
      continue;
    }
    const b = await r.json().catch(() => ({}));
    if (r.ok) {
      if (!b.refresh_token) throw new Error('Google granted access but returned no refresh token');
      return b;
    }
    if (b.error === 'authorization_pending') continue;
    if (b.error === 'slow_down') {
      wait += 5000;
      continue;
    }
    throw new Error(`sign-in stopped: ${b.error} ${b.error_description || ''}`);
  }
  throw new Error('the sign-in code expired before it was approved');
}

export function makeApi(client, refreshToken) {
  let cached = null;

  async function token() {
    if (cached && cached.expiresAt - EARLY_RENEW_MS > Date.now()) return cached.token;
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      body: new URLSearchParams({
        client_id: client.id,
        client_secret: client.secret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    });
    const b = await res.json().catch(() => ({}));
    if (!res.ok || !b.access_token) {
      // invalid_grant here means the sign-in was revoked, or the person who
      // gave it lost their rights on the channel. Only a new `login` fixes it.
      throw new Error(`token refresh failed: ${res.status} ${b.error || ''} ${b.error_description || ''}`);
    }
    cached = { token: b.access_token, expiresAt: Date.now() + b.expires_in * 1000 };
    return cached.token;
  }

  async function call(method, url, { json, body, contentType } = {}) {
    const headers = { authorization: `Bearer ${await token()}` };
    if (json !== undefined) headers['content-type'] = 'application/json';
    if (contentType) headers['content-type'] = contentType;
    const res = await fetch(url, {
      method,
      headers,
      body: json !== undefined ? JSON.stringify(json) : body,
    });
    if (res.status === 204) return null;
    const b = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = b.error || {};
      throw new ApiError(res.status, e.errors?.[0]?.reason || e.status, e.message || res.statusText);
    }
    return b;
  }

  const q = (params) => new URLSearchParams(params).toString();

  return {
    async myChannel() {
      const b = await call('GET', `${API}/channels?${q({ part: 'snippet', mine: 'true' })}`);
      return b.items?.[0] || null;
    },

    async upcomingBroadcasts() {
      const out = [];
      let pageToken = '';
      do {
        const b = await call(
          'GET',
          `${API}/liveBroadcasts?${q({
            part: 'snippet,status,contentDetails',
            broadcastStatus: 'upcoming',
            broadcastType: 'all',
            maxResults: '50',
            ...(pageToken && { pageToken }),
          })}`,
        );
        out.push(...(b.items || []));
        pageToken = b.nextPageToken || '';
      } while (pageToken);
      return out;
    },

    async broadcast(id) {
      const b = await call('GET', `${API}/liveBroadcasts?${q({ part: 'snippet,status', id })}`);
      return b.items?.[0] || null;
    },

    async streams() {
      const b = await call(
        'GET',
        `${API}/liveStreams?${q({ part: 'snippet,cdn,status,contentDetails', mine: 'true', maxResults: '50' })}`,
      );
      return b.items || [];
    },

    createStream(title) {
      return call('POST', `${API}/liveStreams?${q({ part: 'snippet,cdn,contentDetails' })}`, {
        json: {
          snippet: { title },
          cdn: { ingestionType: 'rtmp', resolution: 'variable', frameRate: 'variable' },
          contentDetails: { isReusable: true },
        },
      });
    },

    insertBroadcast(ev, opts) {
      return call('POST', `${API}/liveBroadcasts?${q({ part: 'snippet,status,contentDetails' })}`, {
        json: {
          snippet: broadcastSnippet(ev),
          status: { privacyStatus: opts.privacy, selfDeclaredMadeForKids: false },
          contentDetails: {
            enableAutoStart: opts.autoStart,
            enableAutoStop: opts.autoStop,
            enableDvr: true,
            recordFromStart: true,
          },
        },
      });
    },

    // `update` replaces the whole snippet, so title and start time must be
    // sent even when only the description changed.
    updateBroadcast(id, ev) {
      return call('PUT', `${API}/liveBroadcasts?${q({ part: 'snippet' })}`, {
        json: { id, snippet: broadcastSnippet(ev) },
      });
    },

    bind(broadcastId, streamId) {
      return call('POST', `${API}/liveBroadcasts/bind?${q({ id: broadcastId, streamId, part: 'id,contentDetails' })}`);
    },

    setThumbnail(videoId, file) {
      const contentType = /\.png$/i.test(file) ? 'image/png' : 'image/jpeg';
      return call('POST', `${UPLOAD}/thumbnails/set?${q({ videoId, uploadType: 'media' })}`, {
        body: fs.readFileSync(file),
        contentType,
      });
    },

    deleteBroadcast(id) {
      return call('DELETE', `${API}/liveBroadcasts?${q({ id })}`);
    },
  };
}

function broadcastSnippet(ev) {
  return {
    title: ev.title,
    description: ev.description,
    scheduledStartTime: new Date(ev.startMs).toISOString(),
    ...(ev.endMs && { scheduledEndTime: new Date(ev.endMs).toISOString() }),
  };
}
