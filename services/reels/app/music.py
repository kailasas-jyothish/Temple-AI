"""Choose which part of the song the reel uses.

The first N seconds of a track is almost always the worst possible choice: a
devotional recording opens with a slow alap or a solo instrument, and the sung
hook — the part anyone recognises — arrives a minute in.

This is measurement, not judgement, so no model is involved. ffmpeg's ebur128
filter reports perceived loudness every 100ms; the window with the loudest
sustained passage is the chorus in practically every piece of recorded music,
because that is what "chorus" means to a mastering engineer. Being arithmetic,
it also gives the same answer for the same song every time, which is what makes
a reel reproducible.
"""
from __future__ import annotations

import logging
import math
import re
import subprocess

from .config import config

log = logging.getLogger(__name__)

# ebur128 prints one of these per momentary block, on stderr:
#   [Parsed_ebur128_0 @ 0000] t: 12.3  TARGET:-23 LUFS  M:-18.4 S:-19.1  I: -20.4 LUFS ...
# The fields between t and M vary by build, and the space after each colon is
# not guaranteed, so each one is found on its own rather than in one pattern.
AT_TIME = re.compile(r"\bt:\s*(\d+(?:\.\d+)?)")
MOMENTARY = re.compile(r"\bM:\s*(-?\d+(?:\.\d+)?)")

# Below this a block is silence as far as anyone listening is concerned.
FLOOR_LUFS = -70.0

# How far apart candidate start points are considered. Finer than this measures
# nothing new — ebur128's own window is 400ms.
STEP_SECONDS = 0.5

# The opening of the reel carries the most weight: a window that starts quiet
# and only blooms later still opens weakly.
OPENING_SECONDS = 3.0

# How far the chosen start may slide to land in a dip between phrases.
SNAP_SECONDS = 0.8

ENVELOPE_TIMEOUT = 120


def loudness_envelope(path: str) -> list[tuple[float, float]]:
    """(time, momentary LUFS) for the whole track, or [] if it cannot be read."""
    argv = [
        config.render.ffmpeg, "-hide_banner", "-nostats", "-i", path,
        "-map", "a:0", "-af", "ebur128=peak=none", "-f", "null", "-",
    ]
    try:
        out = subprocess.run(argv, capture_output=True, text=True, timeout=ENVELOPE_TIMEOUT)
    except Exception as err:
        log.warning("loudness scan failed: %s", err)
        return []
    samples: list[tuple[float, float]] = []
    for line in out.stderr.splitlines():
        if "ebur128" not in line:
            continue
        when, level = AT_TIME.search(line), MOMENTARY.search(line)
        if when and level:
            samples.append((float(when.group(1)), float(level.group(1))))
    return samples


def _power(lufs: float) -> float:
    """LUFS to a linear power, so passages can be averaged meaningfully.

    Averaging decibels directly under-weights the loud parts, which are exactly
    the parts being looked for.
    """
    if lufs <= FLOOR_LUFS:
        return 0.0
    return 10.0 ** (lufs / 10.0)


def _mean_power(samples: list[tuple[float, float]], start: float, end: float) -> float:
    inside = [_power(m) for t, m in samples if start <= t < end]
    return sum(inside) / len(inside) if inside else 0.0


def best_window(path: str, need_seconds: float, *, on_note=None) -> float:
    """Where in `path` a `need_seconds` excerpt should start.

    Returns 0.0 whenever there is no better answer — a track shorter than the
    reel, an unreadable file, a silent one — because starting at the beginning
    is the honest fallback and the caller loops the song anyway.
    """
    def note(message: str) -> None:
        log.info("music: %s", message)
        if on_note:
            on_note(message)

    samples = loudness_envelope(path)
    if len(samples) < 4:
        note("could not measure the song's loudness; using it from the start")
        return 0.0

    duration = samples[-1][0]
    if duration <= need_seconds + STEP_SECONDS:
        note(f"song is {duration:.0f}s for a {need_seconds:.0f}s reel — using it from the start")
        return 0.0

    best_start, best_score = 0.0, -1.0
    start = 0.0
    while start + need_seconds <= duration:
        body = _mean_power(samples, start, start + need_seconds)
        opening = _mean_power(samples, start, start + OPENING_SECONDS)
        # Most of the score is the whole excerpt; the rest rewards opening on
        # something rather than fading up into it.
        score = 0.7 * body + 0.3 * opening
        if score > best_score:
            best_start, best_score = start, score
        start += STEP_SECONDS

    if best_score <= 0.0:
        note("the song measures as silent throughout; using it from the start")
        return 0.0

    # Land in the quietest moment nearby rather than halfway through a sung
    # word. A phrase boundary is a dip, and starting from one and rising is what
    # a person editing this by hand would do.
    window = [(t, m) for t, m in samples
              if max(0.0, best_start - SNAP_SECONDS) <= t <= best_start + SNAP_SECONDS]
    if window:
        best_start = min(window, key=lambda pair: pair[1])[0]

    loudest = max(m for _, m in samples)
    picked = _mean_power(samples, best_start, best_start + need_seconds)
    average_lufs = 10.0 * math.log10(picked) if picked > 0 else FLOOR_LUFS
    note(f"song: using {best_start:.1f}s–{best_start + need_seconds:.1f}s of {duration:.0f}s "
         f"({average_lufs:.1f} LUFS average, track peaks at {loudest:.1f})")
    return round(best_start, 2)
