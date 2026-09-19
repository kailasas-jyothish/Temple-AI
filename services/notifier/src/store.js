import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { log } from './log.js';

const FILE = path.join(config.dataDir, 'state.json');
// "Announce once, ever" only holds while the key outlives the discovery window.
// A pruned key on a video still inside the newest-N uploads reads as brand new
// and reposts it, so this must comfortably exceed the time the channel takes to
// publish N items. At ~40 bytes a key that is a few hundred KB a year.
const SEEN_TTL_MS = 400 * 24 * 3600 * 1000;

const empty = () => ({
  version: 1,
  seeded: {},        // { youtube: true, facebook: true }
  seen: {},          // { "<dedupe key>": epochMs }
  watch: {},         // youtube videoIds awaiting live start: { id: { addedAt, title } }
  meta: {},          // scratch: resolved channel id, last websub subscribe, etc.
});

let state = empty();
let dirty = false;
let writing = false;

export function load() {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    if (fs.existsSync(FILE)) {
      state = { ...empty(), ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
      log.info(`state loaded: ${Object.keys(state.seen).length} seen keys`);
    } else {
      log.info(`no existing state at ${FILE}; starting fresh`);
    }
  } catch (err) {
    log.error('failed to load state, starting fresh:', err.message);
    state = empty();
  }
  prune();
  return state;
}

function prune() {
  const cutoff = Date.now() - SEEN_TTL_MS;
  let removed = 0;
  for (const [k, ts] of Object.entries(state.seen)) {
    if (ts < cutoff) {
      delete state.seen[k];
      removed++;
    }
  }
  if (removed) dirty = true;
}

export function save() {
  if (writing) return;
  writing = true;
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, FILE);
    dirty = false;
  } catch (err) {
    log.error('failed to persist state:', err.message);
  } finally {
    writing = false;
  }
}

export function flushIfDirty() {
  if (dirty) save();
}

/** Returns true the first time a key is offered, false on every repeat. */
export function markSeen(key) {
  if (state.seen[key]) return false;
  state.seen[key] = Date.now();
  dirty = true;
  return true;
}

/** Undo a markSeen so a failed delivery can be retried by a later pass. */
export function unmarkSeen(key) {
  if (state.seen[key]) {
    delete state.seen[key];
    dirty = true;
  }
}

export function hasSeen(key) {
  return Boolean(state.seen[key]);
}

export function seenWithoutNotifying(key) {
  if (!state.seen[key]) {
    state.seen[key] = Date.now();
    dirty = true;
  }
}

export function isSeeded(platform) {
  return Boolean(state.seeded[platform]);
}

export function setSeeded(platform) {
  state.seeded[platform] = true;
  dirty = true;
}

export function addWatch(id, info = {}) {
  if (!state.watch[id]) {
    state.watch[id] = { addedAt: Date.now(), ...info };
    dirty = true;
  }
}

export function dropWatch(id) {
  if (state.watch[id]) {
    delete state.watch[id];
    dirty = true;
  }
}

export function watchIds() {
  return Object.keys(state.watch);
}

export function watchInfo(id) {
  return state.watch[id];
}

export function getMeta(key, dflt = undefined) {
  return key in state.meta ? state.meta[key] : dflt;
}

export function setMeta(key, value) {
  state.meta[key] = value;
  dirty = true;
}

export function snapshot() {
  return {
    seenCount: Object.keys(state.seen).length,
    watch: state.watch,
    meta: state.meta,
    seeded: state.seeded,
  };
}
