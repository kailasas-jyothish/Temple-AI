// @ts-check

/**
 * @typedef {'up' | 'degraded' | 'down' | 'unknown'} State
 * @typedef {{
 *   id: string, name: string, description: string, url: string,
 *   state: State, error?: string, ms?: number,
 *   checkedAt?: string, lastUpAt?: string,
 *   details?: import('./services.js').Details,
 * }} Result
 */

/**
 * Probes run on a timer, never per page view: the page is cheap to refresh and
 * a slow service cannot hold it up.
 * @param {{ config: typeof import('./config.js').config, services: import('./services.js').Service[], fetchImpl?: typeof fetch }} deps
 */
export function createProber({ config, services, fetchImpl = fetch }) {
  /** @type {Map<string, Result>} */
  const results = new Map(
    services.map((s) => [s.id, { id: s.id, name: s.name, description: s.description, url: `${config.publicHost}:${s.port}`, state: /** @type {State} */ ('unknown') }]),
  );

  /** @param {import('./services.js').Service} service */
  async function probe(service) {
    const base = probeBase(config, service);
    /** @type {import('./services.js').GetJson} */
    const get = async (path, headers = {}) => {
      const res = await fetchImpl(base + path, { headers, signal: AbortSignal.timeout(config.probeTimeoutMs) });
      if (!res.ok) throw new Error(`${path} answered ${res.status}`);
      return res.json();
    };

    const previous = /** @type {Result} */ (results.get(service.id));
    const started = Date.now();
    /** @type {Result} */
    const next = { ...previous, checkedAt: new Date().toISOString() };
    delete next.error;
    try {
      const health = await get(service.healthPath);
      next.ms = Date.now() - started;
      next.lastUpAt = next.checkedAt;
      try {
        next.details = await service.read(health, get, config);
      } catch (err) {
        // Health answered; only the extra numbers failed. Say so, keep it up.
        next.details = { facts: [], problems: [`details unavailable: ${message(err)}`] };
      }
      next.state = health.ok === false || next.details.problems?.length ? 'degraded' : 'up';
    } catch (err) {
      next.state = 'down';
      next.error = message(err);
      delete next.ms;
      delete next.details;
    }
    results.set(service.id, next);
  }

  const probeAll = () => Promise.all(services.map(probe));

  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  return {
    probeAll,
    start() {
      probeAll();
      timer = setInterval(probeAll, config.probeIntervalMs);
    },
    stop() {
      clearInterval(timer);
    },
    snapshot() {
      return { intervalSeconds: config.probeIntervalMs / 1000, services: services.map((s) => results.get(s.id)) };
    },
  };
}

/**
 * A container cannot reach its own host's public IP (no hairpin NAT), so on
 * Dokploy each service is probed by its Swarm service name over
 * dokploy-network: PROBE_URL_NOTIFIER=http://<swarm name>:3000, and so on.
 * @param {typeof import('./config.js').config} config
 * @param {import('./services.js').Service} service
 */
export function probeBase(config, service) {
  const override = config.env[`PROBE_URL_${service.id.toUpperCase().replace(/-/g, '_')}`];
  return override ? override.replace(/\/+$/, '') : `${config.probeHost}:${service.port}`;
}

/** @param {unknown} err */
function message(err) {
  if (err instanceof Error) {
    if (err.name === 'TimeoutError') return 'no answer (timed out)';
    const cause = /** @type {any} */ (err).cause;
    if (cause?.code === 'ECONNREFUSED') return 'connection refused — not running';
    if (cause?.code === 'ENOTFOUND' || cause?.code === 'EAI_AGAIN') return 'service name not found — not running, or not on dokploy-network';
    if (cause?.code) return `${err.message} (${cause.code})`;
    return err.message || err.name;
  }
  return String(err);
}
