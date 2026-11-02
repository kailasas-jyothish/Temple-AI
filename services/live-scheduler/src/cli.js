#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiError, deviceLogin, loadClient, makeApi } from './youtube.js';
import { loadSchedule, localLabel } from './schedule.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.resolve(ROOT, process.env.DATA_DIR || 'data');
const CLIENT_FILE = path.resolve(ROOT, process.env.OAUTH_CLIENT_FILE || 'oauth-client.json');
const TOKEN_FILE = path.join(DATA_DIR, 'token.json');
const EXPECTED = (process.env.EXPECTED_CHANNEL_ID || '').trim();

const USAGE = `live-scheduler — schedule YouTube live streams from a schedule file

  login                    sign in by code (google.com/device) and save the token
  whoami                   which channel the saved sign-in acts for
  streams                  list the channel's stream keys (titles only, never the key)
  create-stream "<title>"  make a reusable stream key; the key goes to data/, not the screen
  plan <schedule.json>     check the file and show what apply would do (changes nothing)
  apply <schedule.json> --yes
                           create / update / bind / set thumbnails, as plan showed
  test [--thumb <file>]    create a PRIVATE broadcast, set its thumbnail, delete it
  delete <broadcastId>...  delete scheduled broadcasts`;

const write = (s = '') => process.stdout.write(`${s}\n`);

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function api() {
  const saved = readJson(TOKEN_FILE, null);
  if (!saved?.refresh_token) throw new Error('not signed in — run `login` first');
  return makeApi(loadClient(CLIENT_FILE), saved.refresh_token);
}

/**
 * Every write checks the channel first. The sign-in can belong to whoever
 * approved the code, and a login that lands on someone's personal channel
 * would otherwise schedule Navaratri there.
 */
async function requireChannel(yt) {
  const ch = await yt.myChannel();
  if (!ch) throw new Error('this sign-in has no YouTube channel');
  if (!EXPECTED) throw new Error(`EXPECTED_CHANNEL_ID is not set; this sign-in is ${ch.id} (${ch.snippet.title})`);
  if (ch.id !== EXPECTED) {
    throw new Error(
      `this sign-in acts for ${ch.id} (${ch.snippet.title}), not ${EXPECTED}. ` +
        'Sign in again and pick the right channel when Google asks.',
    );
  }
  return ch;
}

// ------------------------------------------------------------------ commands

async function login() {
  const client = loadClient(CLIENT_FILE);
  const tok = await deviceLogin(client, (c) => {
    write(`Open ${c.verification_url} and enter:  ${c.user_code}`);
    write(`Sign in, pick the channel if Google asks, and press Allow. (expires in ${Math.round(c.expires_in / 60)} min)`);
    write('Waiting…');
  });
  const yt = makeApi(client, tok.refresh_token);
  const ch = await yt.myChannel();
  writeJson(TOKEN_FILE, {
    refresh_token: tok.refresh_token,
    scope: tok.scope,
    obtainedAt: new Date().toISOString(),
    channel: ch ? { id: ch.id, title: ch.snippet.title } : null,
  });
  write(`Signed in. Token saved to ${path.relative(process.cwd(), TOKEN_FILE)}`);
  reportChannel(ch);
}

function reportChannel(ch) {
  if (!ch) return write('This account has no YouTube channel.');
  write(`Acts for: ${ch.snippet.title}  ${ch.snippet.customUrl || ''}  (${ch.id})`);
  if (!EXPECTED) write('EXPECTED_CHANNEL_ID is not set.');
  else if (ch.id === EXPECTED) write('✓ This is the expected channel.');
  else write(`✗ Not the expected channel (${EXPECTED}). apply and test will refuse to run.`);
}

async function whoami() {
  reportChannel(await api().myChannel());
}

async function streams() {
  const yt = api();
  await requireChannel(yt);
  const list = await yt.streams();
  if (!list.length) return write('No stream keys. Make one with: create-stream "<title>"');
  for (const s of list) {
    write(
      `${s.snippet.title}  [${s.status?.streamStatus || '?'}${s.contentDetails?.isReusable ? ', reusable' : ''}]  id ${s.id}`,
    );
  }
}

async function createStream(title) {
  if (!title) throw new Error('create-stream needs a title');
  const yt = api();
  await requireChannel(yt);
  const s = await yt.createStream(title);
  const info = s.cdn.ingestionInfo;
  // The key is a credential: whoever has it can broadcast as the channel.
  // It goes to a file for the encoder operator, not into a terminal log.
  const file = path.join(DATA_DIR, `stream-key-${s.id}.txt`);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(file, `${s.snippet.title}\nServer: ${info.ingestionAddress}\nKey:    ${info.streamName}\n`);
  write(`Created stream key "${s.snippet.title}" (id ${s.id}).`);
  write(`Server URL and key written to ${path.relative(process.cwd(), file)}`);
}

/** What apply would do for each event, decided from the ledger and the channel. */
function decide(ev, entry, upcoming, stream) {
  const live = entry?.broadcastId && upcoming.find((b) => b.id === entry.broadcastId);
  if (entry?.broadcastId && !live) {
    return { action: 'gone', entry, note: 'no longer upcoming on the channel (started, ended or deleted); left alone' };
  }
  if (live) {
    const steps = [];
    if (entry.contentHash !== ev.contentHash) steps.push('update');
    if (stream && live.contentDetails?.boundStreamId !== stream.id) steps.push('bind');
    if (ev.thumbHash && entry.thumbHash !== ev.thumbHash) steps.push('thumbnail');
    return { action: steps.length ? steps.join('+') : 'ok', entry, steps, broadcast: live };
  }
  // Not in the ledger: a crash between insert and ledger write, or someone
  // scheduled it by hand. Same title at the same minute is the same seva.
  const twin = upcoming.find(
    (b) => b.snippet.title === ev.title && Date.parse(b.snippet.scheduledStartTime) === ev.startMs,
  );
  if (twin) {
    const steps = [];
    if (stream && !twin.contentDetails?.boundStreamId) steps.push('bind');
    if (ev.thumbHash) steps.push('thumbnail');
    return { action: `adopt${steps.length ? `+${steps.join('+')}` : ''}`, adopt: twin, steps, broadcast: twin };
  }
  const steps = ['create'];
  if (stream) steps.push('bind');
  if (ev.thumbHash) steps.push('thumbnail');
  return { action: 'create', steps };
}

function ledgerFile(scheduleFile) {
  return path.join(DATA_DIR, 'ledger', `${path.basename(scheduleFile, path.extname(scheduleFile))}.json`);
}

async function planOrApply(file, { apply }) {
  if (!file) throw new Error('give the schedule file');
  const { errors, warnings, events, options } = loadSchedule(path.resolve(file));
  for (const w of warnings) write(`warning: ${w}`);
  if (errors.length) {
    for (const e of errors) write(`error: ${e}`);
    write(`\n${errors.length} problem(s); nothing was sent to YouTube.`);
    process.exitCode = 1;
    return;
  }

  const yt = api();
  const ch = await requireChannel(yt);
  let stream = null;
  if (options.stream) {
    const all = await yt.streams();
    stream = all.find((s) => s.snippet.title === options.stream) || null;
    if (!stream) {
      throw new Error(
        `no stream key titled "${options.stream}". Existing: ${all.map((s) => `"${s.snippet.title}"`).join(', ') || 'none'}`,
      );
    }
  } else {
    write('warning: no `stream` set — broadcasts will not be tied to a stream key, and each needs one picked in Studio');
  }

  const upcoming = await yt.upcomingBroadcasts();
  const ledgerPath = ledgerFile(file);
  const ledger = readJson(ledgerPath, {});

  write(`\n${ch.snippet.title} — ${events.length} event(s), ${options.privacy}, times in ${options.timezone}`);
  if (stream) write(`stream key: "${stream.snippet.title}"`);
  write('');

  const plan = events.map((ev) => ({ ev, ...decide(ev, ledger[ev.key], upcoming, stream) }));
  for (const p of plan) {
    const thumb = p.ev.thumbnail ? path.basename(p.ev.thumbnail) : '—';
    write(`${p.action.padEnd(22)} ${localLabel(p.ev.startMs, options.timezone).padEnd(24)} ${p.ev.title}   [${thumb}]`);
    if (p.note) write(`${''.padEnd(22)} ${p.note}`);
  }

  const todo = plan.filter((p) => p.steps?.length);
  if (!apply) {
    write(`\n${todo.length} to change. Nothing was sent. Run apply with --yes to do it.`);
    return;
  }
  if (!todo.length) return write('\nNothing to do.');

  write('');
  let failed = 0;
  for (const p of todo) {
    const { ev } = p;
    const entry = ledger[ev.key] || (p.adopt ? { broadcastId: p.adopt.id, adopted: true } : {});
    const save = () => {
      ledger[ev.key] = entry;
      writeJson(ledgerPath, ledger);
    };
    try {
      if (p.steps.includes('create')) {
        const b = await yt.insertBroadcast(ev, options);
        entry.broadcastId = b.id;
        entry.contentHash = ev.contentHash;
        save();
      } else if (p.adopt) {
        entry.contentHash = ev.contentHash;
        save();
      }
      if (p.steps.includes('update')) {
        await yt.updateBroadcast(entry.broadcastId, ev);
        entry.contentHash = ev.contentHash;
        save();
      }
      if (p.steps.includes('bind')) {
        await yt.bind(entry.broadcastId, stream.id);
        entry.streamId = stream.id;
        save();
      }
      if (p.steps.includes('thumbnail')) {
        await yt.setThumbnail(entry.broadcastId, ev.thumbnail);
        entry.thumbHash = ev.thumbHash;
        save();
      }
      write(`done   ${ev.title}  https://youtu.be/${entry.broadcastId}`);
    } catch (err) {
      failed++;
      write(`FAILED ${ev.title}: ${err.message}`);
      // Out of quota, every following call fails the same way until midnight
      // Pacific; stopping keeps the log readable and the ledger exact.
      if (err instanceof ApiError && /quota/i.test(err.reason || '')) {
        write('Daily API quota is used up. Re-run apply after midnight Pacific; it resumes where it stopped.');
        break;
      }
    }
  }
  write(`\n${todo.length - failed} done, ${failed} failed. Ledger: ${path.relative(process.cwd(), ledgerPath)}`);
  if (failed) {
    write('Re-running apply retries only what is unfinished.');
    process.exitCode = 1;
  }
}

async function test(thumb) {
  const yt = api();
  const ch = await requireChannel(yt);
  const startMs = Date.now() + 2 * 24 * 3600 * 1000;
  write(`Channel: ${ch.snippet.title}`);
  const b = await yt.insertBroadcast(
    {
      title: 'Temple AI scheduler test — safe to delete',
      description: 'Created and deleted automatically by the scheduler test.',
      startMs,
    },
    { privacy: 'private', autoStart: true, autoStop: true },
  );
  write(`✓ created private broadcast ${b.id}`);
  try {
    if (thumb) {
      await yt.setThumbnail(b.id, path.resolve(thumb));
      write('✓ thumbnail set');
    }
    const back = await yt.broadcast(b.id);
    write(`✓ read back: "${back.snippet.title}" at ${back.snippet.scheduledStartTime}, ${back.status.privacyStatus}`);
  } finally {
    await yt.deleteBroadcast(b.id);
    write('✓ deleted');
  }
}

async function remove(ids) {
  if (!ids.length) throw new Error('give one or more broadcast ids');
  const yt = api();
  await requireChannel(yt);
  for (const id of ids) {
    await yt.deleteBroadcast(id);
    write(`deleted ${id}`);
  }
}

// ------------------------------------------------------------------ main

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name) => {
  const i = rest.indexOf(name);
  return i === -1 ? undefined : rest[i + 1];
};
const positional = rest.filter((a, i) => !a.startsWith('--') && !rest[i - 1]?.startsWith('--thumb'));

const commands = {
  login,
  whoami,
  streams,
  'create-stream': () => createStream(positional.join(' ')),
  plan: () => planOrApply(positional[0], { apply: false }),
  apply: () => planOrApply(positional[0], { apply: rest.includes('--yes') }),
  test: () => test(flag('--thumb')),
  delete: () => remove(positional),
};

if (!commands[cmd]) {
  write(USAGE);
  process.exitCode = cmd ? 1 : 0;
} else {
  commands[cmd]().catch((err) => {
    write(`error: ${err.message}`);
    process.exitCode = 1;
  });
}
