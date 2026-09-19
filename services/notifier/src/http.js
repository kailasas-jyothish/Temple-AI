import { log } from './log.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/** fetch with a timeout, a browser UA, and one retry on transient failure. */
export async function get(url, opts = {}) {
  const { timeoutMs = 12000, retries = 1, headers = {}, ...rest } = opts;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: ac.signal,
        headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9', ...headers },
        ...rest,
      });
      return res;
    } catch (err) {
      lastErr = err;
      log.debug(`fetch failed (${attempt + 1}/${retries + 1}) ${url}: ${err.message}`);
      if (attempt < retries) await sleep(500 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

export async function getJson(url, opts = {}) {
  const res = await get(url, opts);
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`non-JSON response from ${url}: ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    const msg = body?.error?.message || body?.error || res.statusText;
    const err = new Error(`${res.status} ${msg}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

export async function getText(url, opts = {}) {
  const res = await get(url, opts);
  if (!res.ok) {
    const err = new Error(`${res.status} ${res.statusText} for ${url}`);
    err.status = res.status;
    throw err;
  }
  return res.text();
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run fn on an interval, never letting a rejection kill the timer.
 *
 * A missing config value would arrive here as undefined, and setInterval
 * clamps a NaN delay to 1ms — which would spend a whole day's API quota in
 * under a minute. Refuse instead: a detector that fails loudly at boot is
 * recoverable, one that silently hammers the API is not.
 */
export function every(seconds, name, fn) {
  const ms = Number(seconds) * 1000;
  if (!Number.isFinite(ms) || ms < 1000) {
    throw new Error(`[${name}] refusing interval of ${seconds}s — check the matching config value`);
  }
  const tick = async () => {
    try {
      await fn();
    } catch (err) {
      log.error(`[${name}] ${err.message}`);
    }
  };
  const t = setInterval(tick, ms);
  t.unref?.();
  return { stop: () => clearInterval(t), runNow: tick };
}
