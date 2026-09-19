import crypto from 'node:crypto';

const bool = (v, dflt = false) => {
  if (v === undefined || v === '') return dflt;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
};
const num = (v, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : dflt;
};
const list = (v) =>
  String(v || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const publicUrl = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');

// The KAILASA channel network. Handles resolve to UC... ids at boot.
const DEFAULT_YOUTUBE_CHANNELS = [
  '@kailasasanjoseus',
  '@KailasaLA',
  '@kailasahouston9302',
  '@kailasaohio7452',
  '@kailasatoronto8217',
  '@KailasaSG',
];

// YOUTUBE_CHANNELS is the current variable; YOUTUBE_CHANNEL (singular) is the
// one this project shipped with and is unioned in rather than replaced, so an
// existing deployment's env keeps working. Neither set means watch the network.
const youtubeChannels = [
  ...new Set([...list(process.env.YOUTUBE_CHANNELS), ...list(process.env.YOUTUBE_CHANNEL)]),
];

export const config = {
  port: num(process.env.PORT, 3000),
  publicUrl,
  dataDir: process.env.DATA_DIR || './data',
  logLevel: process.env.LOG_LEVEL || 'info',

  slack: {
    botToken: process.env.SLACK_BOT_TOKEN || '',
    channel: process.env.SLACK_CHANNEL_ID || '',
    webhookUrl: process.env.SLACK_WEBHOOK_URL || '',
    startupPing: bool(process.env.SLACK_STARTUP_PING, false),
  },

  youtube: {
    enabled: bool(process.env.YOUTUBE_ENABLED, true),
    // Each entry is a handle (@name), a channel URL, or a raw UC... id.
    channels: youtubeChannels.length ? youtubeChannels : DEFAULT_YOUTUBE_CHANNELS,
    apiKey: process.env.YOUTUBE_API_KEY || '',
    // Secret used for the WebSub HMAC. Auto-generated if unset (regenerates on
    // restart, which only means the next re-subscribe rotates it).
    websubSecret: process.env.YOUTUBE_WEBSUB_SECRET || crypto.randomBytes(24).toString('hex'),
    hubUrl: process.env.YOUTUBE_HUB_URL || 'https://pubsubhubbub.appspot.com/subscribe',
    leaseSeconds: num(process.env.YOUTUBE_LEASE_SECONDS, 432000),
    resubscribeSeconds: num(process.env.YOUTUBE_RESUBSCRIBE_SECONDS, 12 * 3600),
    livePollSeconds: num(process.env.YOUTUBE_LIVE_POLL_SECONDS, 20),
    // One channel is checked per tick, round-robin, so the API cost of
    // discovery is fixed no matter how many channels are watched — what grows
    // is the time to come back round to any one of them
    // (uploadsPollSeconds x channel count). See the quota note in api.js
    // before shortening this.
    uploadsPollSeconds: num(process.env.YOUTUBE_UPLOADS_POLL_SECONDS, 30),
    websubEnabled: bool(process.env.YOUTUBE_WEBSUB_ENABLED, false),
    shortMaxSeconds: num(process.env.YOUTUBE_SHORT_MAX_SECONDS, 180),
    // A finished video this old is history, not news, whatever the dedupe
    // store believes. Discovery reads the newest 50 uploads, so any gap in
    // that store — a wiped volume, a channel seeded from a smaller window,
    // keys pruned — would otherwise replay the back catalogue into Slack.
    // Live and upcoming streams are exempt: a broadcast can be created weeks
    // before it starts.
    maxAgeHours: num(process.env.YOUTUBE_MAX_AGE_HOURS, 24),
    // One card per stream, fired when it actually goes live. A scheduled
    // stream is still watched either way — this only controls whether its
    // announcement also gets a card.
    notifyUpcoming: bool(process.env.YOUTUBE_NOTIFY_UPCOMING, false),
  },

  facebook: {
    // Graph API path. Requires a Page access token — no cookies, no scraping.
    enabled: bool(process.env.FACEBOOK_ENABLED, false),
    pageId: process.env.FACEBOOK_PAGE_ID || '',
    pageToken: process.env.FACEBOOK_PAGE_ACCESS_TOKEN || '',
    appSecret: process.env.FACEBOOK_APP_SECRET || '',
    verifyToken: process.env.FACEBOOK_VERIFY_TOKEN || '',
    graphVersion: process.env.FACEBOOK_GRAPH_VERSION || 'v21.0',
    pollSeconds: num(process.env.FACEBOOK_POLL_SECONDS, 60),
    pollEnabled: bool(process.env.FACEBOOK_POLL_ENABLED, true),
  },

  // Token-protected generic inbox so anything (Zapier / Make / IFTTT / a curl
  // from another box) can push an event into the same Slack pipeline.
  ingest: {
    tokens: list(process.env.INGEST_TOKENS),
  },

  admin: {
    token: process.env.ADMIN_TOKEN || '',
  },
};

export function configProblems() {
  const p = [];
  if (!config.slack.botToken && !config.slack.webhookUrl) {
    p.push('No Slack destination: set SLACK_BOT_TOKEN (+ SLACK_CHANNEL_ID) or SLACK_WEBHOOK_URL.');
  }
  if (config.slack.botToken && !config.slack.channel) {
    p.push('SLACK_BOT_TOKEN is set but SLACK_CHANNEL_ID is missing.');
  }
  if (config.youtube.enabled && !config.youtube.apiKey) {
    p.push('YOUTUBE_API_KEY is now required when YouTube is enabled.');
  }
  if (config.youtube.enabled) {
    // playlistItems (1 unit/tick, round-robin) + videos.list on the watchlist
    // (1 unit/tick). The default 10,000 units/day is the ceiling; going over
    // means 403 for the rest of the day, not slower polling.
    const daily =
      86400 / config.youtube.uploadsPollSeconds + 86400 / config.youtube.livePollSeconds;
    if (daily > 9000) {
      p.push(
        `YouTube polling intervals imply ~${Math.round(daily)} quota units/day, close to or over ` +
          'the 10,000/day default. Raise YOUTUBE_UPLOADS_POLL_SECONDS / YOUTUBE_LIVE_POLL_SECONDS.',
      );
    }
  }
  if (config.youtube.enabled && config.youtube.websubEnabled && !config.publicUrl) {
    p.push('PUBLIC_URL is not set — YouTube WebSub push cannot be subscribed; falling back to polling only.');
  }
  if (config.facebook.enabled && (!config.facebook.pageId || !config.facebook.pageToken)) {
    p.push('FACEBOOK_ENABLED=true but FACEBOOK_PAGE_ID / FACEBOOK_PAGE_ACCESS_TOKEN are missing.');
  }
  return p;
}
