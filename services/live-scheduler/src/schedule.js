import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The schedule file: one JSON document per event (Navaratri, Brahmotsavam…),
 * written by hand or converted from the content document. Times are the
 * temple's wall clock in `timezone`; only this module turns them into
 * instants, so nothing else has to think about DST.
 */

const PRIVACY = ['public', 'unlisted', 'private'];
// YouTube's own limits. Title is counted in characters, description in bytes,
// and neither may contain < or > — the API rejects the whole insert otherwise.
const TITLE_MAX = 100;
const DESCRIPTION_MAX_BYTES = 5000;
const THUMB_MAX_BYTES = 2 * 1024 * 1024;
const THUMB_EXT = /\.(jpe?g|png)$/i;

export function loadSchedule(file, now = Date.now()) {
  const raw = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    return { errors: [`${file} is not valid JSON: ${err.message}`], warnings: [], events: [] };
  }

  const errors = [];
  const warnings = [];
  const tz = doc.timezone;
  if (!tz) errors.push('`timezone` is required, e.g. "Asia/Kolkata" or "America/Los_Angeles"');
  else {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
    } catch {
      errors.push(`unknown timezone "${tz}"`);
    }
  }

  const options = {
    timezone: tz,
    privacy: doc.privacy || 'public',
    stream: doc.stream || '',
    autoStart: doc.autoStart ?? true,
    autoStop: doc.autoStop ?? true,
  };
  if (!PRIVACY.includes(options.privacy)) errors.push(`privacy must be one of ${PRIVACY.join(', ')}`);

  const thumbDir = path.resolve(path.dirname(file), doc.thumbnails || '.');
  const list = Array.isArray(doc.events) ? doc.events : [];
  if (!list.length) errors.push('`events` is empty');
  if (errors.length) return { errors, warnings, events: [], options };

  const events = [];
  const keys = new Set();
  list.forEach((raw, i) => {
    const where = `event ${i + 1}${raw.title ? ` ("${raw.title}")` : ''}`;
    const problems = [];
    const ev = {
      title: String(raw.title || '').trim(),
      description: String(raw.description || '').trim(),
      date: String(raw.date || '').trim(),
      start: String(raw.start || '').trim(),
      end: String(raw.end || '').trim(),
    };

    if (!ev.title) problems.push('no title');
    else if ([...ev.title].length > TITLE_MAX) problems.push(`title is ${[...ev.title].length} characters (max ${TITLE_MAX})`);
    if (/[<>]/.test(ev.title)) problems.push('title contains < or >, which YouTube rejects');
    if (Buffer.byteLength(ev.description) > DESCRIPTION_MAX_BYTES) {
      problems.push(`description is ${Buffer.byteLength(ev.description)} bytes (max ${DESCRIPTION_MAX_BYTES})`);
    }
    if (/[<>]/.test(ev.description)) problems.push('description contains < or >, which YouTube rejects');
    if (!ev.description) warnings.push(`${where}: no description`);

    if (!/^\d{4}-\d{2}-\d{2}$/.test(ev.date)) problems.push(`date "${ev.date}" is not YYYY-MM-DD`);
    const startMin = minutesOf(ev.start);
    if (startMin === null) problems.push(`start "${ev.start}" is not HH:MM (24h)`);
    const endMin = ev.end ? minutesOf(ev.end) : null;
    if (ev.end && endMin === null) problems.push(`end "${ev.end}" is not HH:MM (24h)`);

    if (!problems.length) {
      ev.startMs = zonedTimeToUtc(ev.date, startMin, tz);
      if (endMin !== null) {
        // An end at or before the start means the seva runs past midnight.
        const endDate = endMin <= startMin ? shiftDate(ev.date, 1) : ev.date;
        ev.endMs = zonedTimeToUtc(endDate, endMin, tz);
      }
      if (ev.startMs <= now) problems.push(`starts ${ev.date} ${ev.start}, which is already past`);
    }

    if (raw.thumbnail) {
      ev.thumbnail = path.resolve(thumbDir, raw.thumbnail);
      if (!THUMB_EXT.test(ev.thumbnail)) problems.push(`thumbnail ${raw.thumbnail} must be .jpg or .png`);
      else if (!fs.existsSync(ev.thumbnail)) problems.push(`thumbnail ${raw.thumbnail} not found in ${thumbDir}`);
      else {
        const size = fs.statSync(ev.thumbnail).size;
        if (size > THUMB_MAX_BYTES) problems.push(`thumbnail ${raw.thumbnail} is ${(size / 1048576).toFixed(1)} MB (max 2 MB)`);
        else ev.thumbHash = fileHash(ev.thumbnail);
      }
    } else {
      warnings.push(`${where}: no thumbnail, YouTube will use a default frame`);
    }

    // The key is what makes a re-run update rather than duplicate. An explicit
    // id survives a change of time; date+start is the fallback.
    ev.key = String(raw.id || `${ev.date} ${ev.start}`);
    if (keys.has(ev.key)) problems.push(`two events share the key "${ev.key}"; give one an "id"`);
    keys.add(ev.key);

    if (problems.length) errors.push(`${where}: ${problems.join('; ')}`);
    else {
      ev.contentHash = hash([ev.title, ev.description, ev.startMs, ev.endMs || 0].join('\u0000'));
      events.push(ev);
    }
  });

  events.sort((a, b) => a.startMs - b.startMs);
  return { errors, warnings, events, options };
}

function minutesOf(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

const hash = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
const fileHash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16);

// ------------------------------------------------------------------ clock
// Same algorithm as services/notifier/src/presence/schedule.js; services do
// not share code (each one's build context is its own directory).

function partsIn(ms, tz) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour) % 24,
    minute: Number(p.minute),
    second: Number(p.second),
  };
}

function offsetAt(ms, tz) {
  const p = partsIn(ms, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** Two passes, because the first guess can land on the far side of a DST change. */
export function zonedTimeToUtc(dateStr, minutes, tz) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const naive = Date.UTC(y, m - 1, d, Math.floor(minutes / 60), minutes % 60);
  let t = naive - offsetAt(naive, tz);
  const second = naive - offsetAt(t, tz);
  if (second !== t) t = second;
  return t;
}

function shiftDate(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** "Sun 11-Oct 06:00 IST" in the schedule's own timezone. */
export function localLabel(ms, tz) {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'short',
  });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.weekday} ${p.day}-${p.month} ${p.hour}:${p.minute} ${p.timeZoneName}`;
}
