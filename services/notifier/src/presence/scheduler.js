import { minutesLate } from './schedule.js';

/**
 * The decisions a check makes after each attempt, kept pure so the selftest
 * can walk a slot through its whole grace window without a clock or a sheet.
 */

export const STATUS = {
  present: 'Present',
  late: (n) => `Late (${n} min)`,
  absent: 'Absent',
  noStream: 'No stream',
  error: 'Error',
};

// However generous the grace window, a slot never costs more than this many
// frames and vision calls.
export const MAX_ATTEMPTS = 12;

/**
 * `check`: { scheduledAt, graceEndsAt, attempts (including this one), sawNegative }
 * `outcome.kind`: present | absent | no_stream | error
 *
 * Returns { retryAt } to try again, or { status, minutesLate, basis } to stop.
 * `basis` is 'this' when the outcome in hand is the evidence, 'earlier' when
 * the answer rests on a negative verdict from a previous attempt.
 */
export function nextStep(check, outcome, now, retryMs) {
  if (outcome.kind === 'no_stream') return { status: STATUS.noStream, minutesLate: null, basis: 'this' };

  if (outcome.kind === 'present') {
    // Only a retry can be late. A first look that lands a minute after the
    // scheduled time is the 30s tick, not the pujari.
    if (check.attempts <= 1) return { status: STATUS.present, minutesLate: 0, basis: 'this' };
    const n = minutesLate(check.scheduledAt, outcome.checkedAt ?? now);
    return { status: STATUS.late(n), minutesLate: n, basis: 'this' };
  }

  const retryAt = now + retryMs;
  if (retryAt <= check.graceEndsAt && check.attempts < MAX_ATTEMPTS) return { retryAt };

  if (outcome.kind === 'absent') return { status: STATUS.absent, minutesLate: null, basis: 'this' };
  // The last attempt failed, but an earlier one saw the altar without a
  // pujari: that is an answer, and a truer one than "Error".
  if (check.sawNegative) return { status: STATUS.absent, minutesLate: null, basis: 'earlier' };
  return { status: STATUS.error, minutesLate: null, basis: 'this' };
}

/** Drop fired-slot keys older than `keepMs`; they can never be due again. */
export function pruneFired(fired, now, keepMs = 3 * 86400_000) {
  const out = {};
  for (const [k, t] of Object.entries(fired || {})) if (now - t < keepMs) out[k] = t;
  return out;
}
