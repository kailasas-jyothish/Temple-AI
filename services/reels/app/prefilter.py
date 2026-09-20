"""Cheap local triage, run before any LLM token is spent.

Temple teams upload in bursts — six near-identical frames of the same arati —
and a fair number of the files are screenshots, accidental shots or too small to
survive a 1080x1920 crop. Rejecting those here typically halves the pool, which
halves the curation cost and stops the model wasting its judgement on obvious
discards.
"""
from __future__ import annotations

import logging
import math
import os
import threading
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from PIL import Image, ImageOps

from .config import config

log = logging.getLogger(__name__)

# Phones shoot HEIC and the teams upload it straight through — on one September
# event it was 10 of 21 files. Pillow needs this to open them at all, and ffmpeg
# cannot read HEIC whatever we do, so ensure_readable() transcodes as well.
try:
    import pillow_heif

    pillow_heif.register_heif_opener()
    HEIF_AVAILABLE = True
except Exception as _err:  # pragma: no cover - depends on the wheel being installed
    HEIF_AVAILABLE = False
    log.warning("pillow-heif unavailable (%s); HEIC uploads will be skipped", _err)

HEIF_EXTS = {".heic", ".heif"}

# The blur and exposure measures only need a small image, and downscaling first
# also normalises the sharpness scale across a 48MP phone and a 6MP camera.
ANALYSIS_PX = 512


def _load_gray(path: str) -> tuple[np.ndarray, tuple[int, int]]:
    with Image.open(path) as im:
        im = ImageOps.exif_transpose(im)
        size = im.size
        gray = im.convert("L")
        gray.thumbnail((ANALYSIS_PX, ANALYSIS_PX), Image.Resampling.BILINEAR)
        return np.asarray(gray, dtype=np.float32), size


def laplacian_variance(gray: np.ndarray) -> float:
    """Variance of the Laplacian — the standard cheap focus measure.

    High on a crisp image, near zero on a soft or motion-blurred one.
    """
    if gray.shape[0] < 3 or gray.shape[1] < 3:
        return 0.0
    lap = (
        gray[:-2, 1:-1]
        + gray[2:, 1:-1]
        + gray[1:-1, :-2]
        + gray[1:-1, 2:]
        - 4.0 * gray[1:-1, 1:-1]
    )
    return float(lap.var())


def dhash(path: str) -> int:
    """64-bit difference hash: robust to resize and mild exposure drift, which
    is exactly what separates burst frames from genuinely different shots."""
    with Image.open(path) as im:
        im = ImageOps.exif_transpose(im).convert("L").resize((9, 8), Image.Resampling.BILINEAR)
        px = np.asarray(im, dtype=np.int16)
    bits = px[:, 1:] > px[:, :-1]
    value = 0
    for bit in bits.flatten():
        value = (value << 1) | int(bit)
    return value


def hamming(a: int, b: int) -> int:
    return bin(a ^ b).count("1")


def exposure_penalty(gray: np.ndarray) -> float:
    """0 for a well-exposed frame, up to 1 for one that is crushed or blown."""
    mean = float(gray.mean()) / 255.0
    clipped = float(((gray < 4) | (gray > 251)).mean())
    # A mean far from mid-grey is suspicious; clipping is worse.
    return min(1.0, abs(mean - 0.5) * 1.2 + clipped * 1.5)


def ensure_readable(path: str) -> str:
    """Transcode formats ffmpeg cannot open, returning the path to use.

    HEIC is the only one that matters in practice. Doing it here rather than at
    render time means the prefilter, the model and ffmpeg all see one file, and
    a format problem surfaces as a rejection reason rather than as a filtergraph
    error forty minutes later.
    """
    stem, ext = os.path.splitext(path)
    if ext.lower() not in HEIF_EXTS:
        return path
    if not HEIF_AVAILABLE:
        raise RuntimeError("HEIC needs pillow-heif")
    target = f"{stem}.jpg"
    with Image.open(path) as im:
        ImageOps.exif_transpose(im).convert("RGB").save(target, format="JPEG", quality=92)
    return target


def measure(path: str) -> dict:
    gray, (width, height) = _load_gray(path)
    sharpness = laplacian_variance(gray)
    penalty = exposure_penalty(gray)
    # Sharpness spans orders of magnitude, so score it on a log curve: the
    # interesting difference is between 20 and 200, not between 800 and 900.
    sharp_score = max(0.0, min(1.0, math.log10(max(sharpness, 1.0)) / 2.7))
    return {
        "width": width,
        "height": height,
        "short_edge": min(width, height),
        "sharpness": sharpness,
        "exposure_penalty": penalty,
        "heuristic_score": round(10.0 * max(0.0, sharp_score * (1.0 - 0.6 * penalty)), 2),
    }


def triage(candidates: list[dict], *, cap: int | None = None, on_progress=None) -> tuple[list[dict], list[dict]]:
    """Annotate every candidate, then split into keepers and rejects.

    `candidates` are dicts with at least `path`; they are mutated in place with
    the measurements so later stages and the job log can see why something went.

    Measurement runs on a pool: it is decode-bound, Pillow and numpy both drop
    the GIL while they work, and four hundred photographs one at a time is a
    minute and a half of a run looking like it has stopped.
    """
    cfg = config.curation
    kept: list[dict] = []
    rejected: list[dict] = []

    done = 0
    lock = threading.Lock()

    def inspect(item: dict) -> None:
        nonlocal done
        try:
            item["path"] = ensure_readable(item["path"])
            item.update(measure(item["path"]))
            item["hash"] = dhash(item["path"])
        except Exception as err:  # a corrupt upload must not kill the run
            item["reject"] = f"unreadable ({err.__class__.__name__})"
        with lock:
            done += 1
            if on_progress:
                on_progress(done, len(candidates))

    workers = max(1, min(cfg.prefilter_workers, len(candidates) or 1))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        list(pool.map(inspect, candidates))

    for item in candidates:
        if item.get("reject"):
            rejected.append(item)
            continue

        if item["short_edge"] < cfg.min_image_px:
            item["reject"] = f"too small ({item['width']}x{item['height']})"
            rejected.append(item)
        elif item["sharpness"] < cfg.blur_threshold:
            item["reject"] = f"blurry (laplacian var {item['sharpness']:.0f})"
            rejected.append(item)
        else:
            kept.append(item)

    kept, duplicates = _collapse_bursts(kept, cfg.dhash_distance)
    rejected.extend(duplicates)

    # Hard cap so a 600-photo event does not become a 150-request LLM run.
    limit = cfg.max_candidates if cap is None else max(2, min(cap, cfg.max_candidates))
    kept.sort(key=lambda c: c["heuristic_score"], reverse=True)
    if len(kept) > limit:
        for extra in kept[limit:]:
            extra["reject"] = "over the candidate cap"
        rejected.extend(kept[limit:])
        kept = kept[:limit]

    return kept, rejected


def _collapse_bursts(items: list[dict], distance: int) -> tuple[list[dict], list[dict]]:
    """Keep the sharpest member of each near-duplicate group.

    Greedy and O(n*groups) rather than O(n^2) over every pair: with a few
    hundred candidates that is immaterial, and it keeps the grouping stable.
    """
    keep: list[dict] = []
    dropped: list[dict] = []
    for item in sorted(items, key=lambda c: c["sharpness"], reverse=True):
        twin = next((k for k in keep if hamming(k["hash"], item["hash"]) <= distance), None)
        if twin is None:
            keep.append(item)
        else:
            item["reject"] = f"near-duplicate of {twin['name']}"
            dropped.append(item)
    return keep, dropped
