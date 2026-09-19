"""Turn scores into an ordered shot list.

Two things matter here beyond picking high scores: every temple that turned up
should be visible in the reel, and the result should read as a tour rather than
a shuffle.
"""
from __future__ import annotations

import logging

from .config import config

log = logging.getLogger(__name__)


def shot_count(*, target_seconds: float | None = None, seconds_per_image: float | None = None,
               transition_seconds: float | None = None, override: int | None = None) -> int:
    """How many stills fit in the target runtime.

    Each xfade overlaps the tail of one shot with the head of the next, so the
    reel is shorter than n x seconds_per_image:
        total = n * (d - t) + t   =>   n = (total - t) / (d - t)
    """
    r = config.render
    if override:
        return max(2, int(override))
    if r.shot_count:
        return max(2, r.shot_count)
    total = target_seconds if target_seconds is not None else r.target_seconds
    d = seconds_per_image if seconds_per_image is not None else r.seconds_per_image
    t = transition_seconds if transition_seconds is not None else r.transition_seconds
    if d <= t:
        raise ValueError("seconds_per_image must exceed transition_seconds")
    return max(2, round((total - t) / (d - t)))


def duration_for(n: int, *, seconds_per_image: float, transition_seconds: float) -> float:
    return n * (seconds_per_image - transition_seconds) + transition_seconds


def build(candidates: list[dict], wanted: int, *, min_per_temple: int | None = None) -> list[dict]:
    """Select `wanted` shots and put them in screening order."""
    floor = config.curation.min_per_temple if min_per_temple is None else min_per_temple
    usable = [c for c in candidates if c.get("usable", True)]
    if not usable:
        # Everything was marked unusable — rather than produce nothing, fall
        # back to the raw scores. A weak reel beats a failed job.
        log.warning("every candidate was marked unusable; ignoring the flag")
        usable = list(candidates)

    by_temple: dict[str, list[dict]] = {}
    for item in usable:
        by_temple.setdefault(item.get("temple", ""), []).append(item)
    for shots in by_temple.values():
        shots.sort(key=lambda c: c["score"], reverse=True)

    # A temple with one enthusiastic photographer would otherwise take the whole
    # reel, so each gets a floor before anything is allocated on merit.
    chosen: list[dict] = []
    seen: set[str] = set()
    for shots in by_temple.values():
        for item in shots[:floor]:
            chosen.append(item)
            seen.add(item["id"])

    if len(chosen) > wanted:
        # More temples than slots: keep the best one from each, best temples first.
        chosen.sort(key=lambda c: c["score"], reverse=True)
        chosen = chosen[:wanted]
        seen = {c["id"] for c in chosen}
    else:
        rest = sorted((c for c in usable if c["id"] not in seen), key=lambda c: c["score"], reverse=True)
        for item in rest[: wanted - len(chosen)]:
            chosen.append(item)
            seen.add(item["id"])

    return _order(chosen)


def _order(chosen: list[dict]) -> list[dict]:
    """Group by temple so the reel reads as a tour, strongest temple first, and
    lead with the single best frame as the hook."""
    groups: dict[str, list[dict]] = {}
    for item in chosen:
        groups.setdefault(item.get("temple", ""), []).append(item)

    ordered: list[dict] = []
    for temple in sorted(groups, key=lambda t: max(c["score"] for c in groups[t]), reverse=True):
        ordered.extend(sorted(groups[temple], key=lambda c: (c.get("createdTime") or "", c["name"])))

    best = max(ordered, key=lambda c: c["score"])
    ordered.remove(best)
    ordered.insert(0, best)
    return ordered
