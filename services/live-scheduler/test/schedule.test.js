import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadSchedule, zonedTimeToUtc } from '../src/schedule.js';

const NOW = Date.parse('2026-10-06T00:00:00Z');

function fixture(doc, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-sched-'));
  for (const [name, bytes] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), bytes);
  const file = path.join(dir, 'schedule.json');
  fs.writeFileSync(file, JSON.stringify(doc));
  return file;
}

const base = (events, extra = {}) => ({ timezone: 'America/Los_Angeles', events, ...extra });
const ev = (over = {}) => ({ date: '2026-10-11', start: '06:00', title: 'Day 1', description: 'd', ...over });

test('wall clock converts across DST', () => {
  // PDT (UTC-7) before 1 Nov 2026, PST (UTC-8) after.
  assert.equal(new Date(zonedTimeToUtc('2026-10-11', 360, 'America/Los_Angeles')).toISOString(), '2026-10-11T13:00:00.000Z');
  assert.equal(new Date(zonedTimeToUtc('2026-11-02', 360, 'America/Los_Angeles')).toISOString(), '2026-11-02T14:00:00.000Z');
  assert.equal(new Date(zonedTimeToUtc('2026-10-11', 360, 'Asia/Kolkata')).toISOString(), '2026-10-11T00:30:00.000Z');
});

test('a valid event loads with a thumbnail', () => {
  const file = fixture(base([ev({ thumbnail: 'a.jpg', end: '08:00' })]), { 'a.jpg': Buffer.alloc(100) });
  const r = loadSchedule(file, NOW);
  assert.deepEqual(r.errors, []);
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].endMs - r.events[0].startMs, 2 * 3600 * 1000);
  assert.equal(r.options.privacy, 'public');
  assert.ok(r.events[0].thumbHash);
});

test('an end before the start runs past midnight', () => {
  const r = loadSchedule(fixture(base([ev({ start: '22:00', end: '01:00' })])), NOW);
  assert.equal(r.events[0].endMs - r.events[0].startMs, 3 * 3600 * 1000);
});

test('every problem is reported, nothing is half-loaded', () => {
  const big = Buffer.alloc(2 * 1024 * 1024 + 1);
  const r = loadSchedule(
    fixture(
      base([
        ev({ title: 'x'.repeat(101) }),
        ev({ start: '6am', date: '2026-10-12' }),
        ev({ date: '2026-10-01' }),
        ev({ date: '2026-10-13', title: 'a <b>' }),
        ev({ date: '2026-10-14', thumbnail: 'missing.jpg' }),
        ev({ date: '2026-10-15', thumbnail: 'big.jpg' }),
        ev({ date: '2026-10-16', thumbnail: 'a.gif' }),
      ]),
      { 'big.jpg': big, 'a.gif': Buffer.alloc(10) },
    ),
    NOW,
  );
  assert.equal(r.errors.length, 7, r.errors.join('\n'));
  assert.equal(r.events.length, 0);
});

test('two events at the same slot need ids', () => {
  const dup = loadSchedule(fixture(base([ev(), ev({ title: 'Other' })])), NOW);
  assert.match(dup.errors.join(), /share the key/);
  const ok = loadSchedule(fixture(base([ev({ id: 'a' }), ev({ id: 'b', title: 'Other' })])), NOW);
  assert.deepEqual(ok.errors, []);
});

test('a content change changes the hash, a thumbnail does not', () => {
  const a = loadSchedule(fixture(base([ev()])), NOW).events[0];
  const b = loadSchedule(fixture(base([ev({ description: 'changed' })])), NOW).events[0];
  assert.notEqual(a.contentHash, b.contentHash);
  assert.equal(a.key, b.key);
});

test('bad timezone and privacy stop the load', () => {
  assert.match(loadSchedule(fixture(base([ev()], { timezone: 'Mars/Base' })), NOW).errors.join(), /unknown timezone/);
  assert.match(loadSchedule(fixture(base([ev()], { privacy: 'secret' })), NOW).errors.join(), /privacy/);
});
