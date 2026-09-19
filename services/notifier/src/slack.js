import { config } from './config.js';
import { log } from './log.js';
import { sleep } from './http.js';

const API = 'https://slack.com/api/chat.postMessage';

async function postViaBotToken(payload) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(API, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.slack.botToken}`,
        'content-type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ channel: config.slack.channel, ...payload }),
    });
    const body = await res.json().catch(() => ({}));
    if (body.ok) return body;

    if (body.error === 'ratelimited' || res.status === 429) {
      const wait = Number(res.headers.get('retry-after') || 2);
      log.warn(`slack rate limited, retrying in ${wait}s`);
      await sleep(wait * 1000);
      continue;
    }
    throw new Error(`slack chat.postMessage failed: ${body.error || res.status}`);
  }
  throw new Error('slack chat.postMessage failed after retries');
}

async function postViaWebhook(payload) {
  const res = await fetch(config.slack.webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`slack webhook failed: ${res.status} ${await res.text()}`);
  return { ok: true };
}

export async function postMessage(payload) {
  if (config.slack.botToken && config.slack.channel) return postViaBotToken(payload);
  if (config.slack.webhookUrl) return postViaWebhook(payload);
  log.warn('no Slack destination configured; message dropped:', payload.text);
  return { ok: false, skipped: true };
}

export async function postPlain(text) {
  return postMessage({ text, unfurl_links: false, unfurl_media: false });
}

const STYLE = {
  live: { emoji: '🔴', label: 'LIVE NOW' },
  upcoming: { emoji: '🗓️', label: 'Scheduled / Premiere' },
  video: { emoji: '🎬', label: 'New video' },
  short: { emoji: '⚡', label: 'New Short' },
  reel: { emoji: '⚡', label: 'New Reel' },
  post: { emoji: '📝', label: 'New post' },
  photo: { emoji: '🖼️', label: 'New photo' },
  album: { emoji: '🖼️', label: 'New album' },
  link: { emoji: '🔗', label: 'New link post' },
  share: { emoji: '🔁', label: 'New share' },
  replay: { emoji: '⏪', label: 'Live replay available' },
};

const PLATFORM = {
  youtube: 'YouTube',
  facebook: 'Facebook',
};

/** Build and send a Block Kit card for one content event. */
export async function postEvent(event) {
  const style = STYLE[event.kind] || { emoji: '📣', label: event.kind };
  const platform = PLATFORM[event.platform] || event.platform;
  // Several channels feed one Slack channel, so the heading names the author:
  // "which of them is live" is the first question a reader has, and the small
  // grey context line is the wrong place to answer it.
  const who = (event.author || '').trim();
  const heading = `${style.emoji} ${platform}${who ? ` · ${who}` : ''} — ${style.label}`;
  const title = (event.title || '').trim() || event.url;

  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${escapeMrkdwn(heading)}*\n<${event.url}|${escapeMrkdwn(truncate(title, 200))}>`,
      },
      ...(event.thumbnail
        ? { accessory: { type: 'image', image_url: event.thumbnail, alt_text: truncate(title, 60) } }
        : {}),
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: event.url },
    },
  ];

  const contextBits = [];
  if (event.publishedAt) contextBits.push(`<!date^${Math.floor(new Date(event.publishedAt).getTime() / 1000)}^{date_short_pretty} {time}|${event.publishedAt}>`);
  if (event.source) contextBits.push(`via ${event.source}`);
  if (contextBits.length) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: contextBits.join('  •  ') }],
    });
  }

  return postMessage({
    text: `${heading}: ${title} ${event.url}`,
    blocks,
    unfurl_links: true,
    unfurl_media: true,
  });
}

const truncate = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const escapeMrkdwn = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
