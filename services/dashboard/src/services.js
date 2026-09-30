// @ts-check

/**
 * @typedef {{ label: string, value: string | number, tone?: 'good' | 'warn' | 'bad' }} Fact
 * @typedef {{ facts: Fact[], problems?: string[], items?: { title: string, detail?: string, href?: string }[], itemsLabel?: string }} Details
 * @typedef {(path: string, headers?: Record<string, string>) => Promise<any>} GetJson
 * @typedef {{
 *   id: string,
 *   name: string,
 *   description: string,
 *   port: number,
 *   healthPath: string,
 *   read: (health: any, get: GetJson, config: typeof import('./config.js').config) => Promise<Details>,
 * }} Service
 */

/** @param {number} seconds */
export function duration(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  if (s < 172800) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

/** @param {unknown} list */
const problemsOf = (list) => (Array.isArray(list) ? list.map(String) : []);

/**
 * Adding a service to the dashboard is one entry here and nothing else. Keep
 * ports in step with SERVICES in scripts/dokploy.mjs.
 * @type {Service[]}
 */
export const SERVICES = [
  {
    id: 'notifier',
    name: 'Notifier',
    description: 'New YouTube videos, Shorts and live streams across the temple channels, posted to Slack. Marks Garbha Mandir attendance in the sheet.',
    port: 8478,
    healthPath: '/healthz',
    async read(health, get, config) {
      /** @type {Fact[]} */
      const facts = [{ label: 'Up for', value: duration(Number(health.uptime) || 0) }];
      if (!config.notifierAdminToken) return { facts, problems: ['NOTIFIER_ADMIN_TOKEN not set on the dashboard: showing health only'] };

      const auth = { 'x-admin-token': config.notifierAdminToken };
      const [status, attendance] = await Promise.all([get('/status', auth), get('/admin/attendance', auth).catch(() => null)]);
      const configured = status.youtube?.configured?.length ?? 0;
      const resolved = status.youtube?.channels?.length ?? 0;
      const upcoming = Object.values(status.state?.watch || {}).filter((w) => /** @type {any} */ (w).scheduledStartTime).length;
      facts.push(
        { label: 'Channels', value: resolved === configured ? String(configured) : `${resolved} of ${configured}`, tone: resolved === configured ? undefined : 'warn' },
        { label: 'Scheduled streams', value: upcoming },
      );

      /** @type {string[]} */
      const problems = [];
      if (!status.youtube?.apiKey) problems.push('YouTube API key missing');
      if (resolved < configured) problems.push(`${configured - resolved} channel(s) not resolved yet`);

      /** @type {Details['items']} */
      let items;
      if (attendance?.enabled) {
        const live = Object.entries(attendance.live || {});
        facts.push({ label: `Live today (${attendance.today})`, value: live.length, tone: live.length ? 'good' : undefined });
        if (attendance.queued?.length) problems.push(`${attendance.queued.length} attendance write(s) waiting to retry`);
        items = live.map(([temple, s]) => ({
          title: temple.replace(/\b\w/g, (c) => c.toUpperCase()),
          detail: s.startedAt ? `live since ${new Date(s.startedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC` : '',
          href: s.videoId ? `https://www.youtube.com/watch?v=${s.videoId}` : undefined,
        }));
      }
      return { facts, problems, items, itemsLabel: 'Garbha Mandir streams live now' };
    },
  },
  {
    id: 'reels',
    name: 'Reels',
    description: 'Turns a day’s ritual photos and clips from Google Drive into a branded vertical reel, files it back into Drive and pings Slack.',
    port: 8479,
    healthPath: '/healthz',
    async read(health) {
      const queue = Number(health.queue) || 0;
      return { facts: [{ label: 'Jobs queued', value: queue, tone: queue ? 'good' : undefined }], problems: problemsOf(health.problems) };
    },
  },
  {
    id: 'mantra-tutorials',
    name: 'Mantra tutorials',
    description: 'Background slide, Devanagari and chant audio in; a 1080p tutorial video out, with the transliteration underlined word by word.',
    port: 8481,
    healthPath: '/healthz',
    async read(health) {
      const mantras = Array.isArray(health.mantras) ? health.mantras.length : 0;
      const busy = health.busy ? String(health.busy) : '';
      return {
        facts: [
          { label: 'Mantras', value: mantras },
          { label: 'Rendering', value: busy || 'idle', tone: busy ? 'good' : undefined },
        ],
        problems: problemsOf(health.problems),
      };
    },
  },
  {
    id: 'panchaloha',
    name: 'Panchaloha calculator',
    description: 'Manufacturing cost per kg of a Panchaloha murthy, with AI-researched, source-checked material rates that a person approves.',
    port: 8480,
    healthPath: '/healthz',
    async read() {
      return { facts: [] };
    },
  },
];
