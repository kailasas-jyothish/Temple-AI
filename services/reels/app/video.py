"""Find the parts of a video clip worth putting in the reel.

A clip is not a candidate; a *window* of a clip is. This extracts frames once,
measures how steady and how sharp each moment is, and returns the best
non-overlapping windows as ordinary candidates carrying a representative still.

That last part is the whole design: from the moment this returns, a clip window
is indistinguishable from a photograph. It has a `path` to a JPEG, so the
prefilter measures it, the dHash collapses it against a near-identical
photograph, the model scores it against the same rubric, and `sequence.py`
ranks it on the same scale. Nothing downstream needs to know it came from
video, except `render.py`, which plays the clip instead of panning the still.

Shake is measured here rather than judged by the model. It is a measurement -
how much the frame's velocity changes from moment to moment - and so it belongs
on the ffmpeg side of the split, like the music window in music.py.
"""
from __future__ import annotations

import json
import logging
import os
import subprocess

import numpy as np
from PIL import Image

from . import prefilter
from .config import config

log = logging.getLogger(__name__)

VIDEO_EXTS = {".mp4", ".mov", ".m4v", ".avi", ".mkv", ".webm", ".3gp", ".mpg", ".mpeg", ".wmv"}

# Frames are analysed at this height, aspect preserved. Big enough for the
# Laplacian to mean something, small enough that phase correlation over a few
# hundred frames costs no real time.
ANALYSIS_HEIGHT = 180


def is_video_name(name: str) -> bool:
    return os.path.splitext(name)[1].lower() in VIDEO_EXTS


def upscale(width: int, height: int) -> float:
    """How far a crop-to-fill has to stretch this source to reach the frame.

    The binding dimension is not the short edge and not the height — it is
    whichever side runs out first once the source is scaled to cover 1080x1920.
    For the portrait phone video that makes up most of the archive that is the
    width; for landscape footage it is the height.
    """
    if width <= 0 or height <= 0:
        return 0.0  # unknown: let the clip through and judge it on its frames
    r = config.render
    return max(r.width / width, r.height / height)


def probe(path: str) -> dict:
    """Duration, dimensions and frame rate, or an empty dict if unreadable."""
    try:
        out = subprocess.run(
            [config.render.ffprobe, "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=width,height,avg_frame_rate:format=duration",
             "-of", "json", path],
            capture_output=True, text=True, check=True, timeout=60,
        )
        data = json.loads(out.stdout)
        stream = (data.get("streams") or [{}])[0]
        num, _, den = str(stream.get("avg_frame_rate", "0/1")).partition("/")
        fps = float(num) / float(den) if den and float(den) else 0.0
        return {
            "duration": float(data.get("format", {}).get("duration") or 0.0),
            "width": int(stream.get("width") or 0),
            "height": int(stream.get("height") or 0),
            "fps": fps,
        }
    except Exception as err:
        log.warning("ffprobe failed on %s: %s", os.path.basename(path), err)
        return {}


# ------------------------------------------------------------------ frames


def _extract_frames(path: str, out_dir: str, *, fps: float, seconds: float) -> list[str]:
    """One ffmpeg pass for the whole analysis. Frames land as small JPEGs."""
    os.makedirs(out_dir, exist_ok=True)
    argv = [
        config.render.ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
        "-t", f"{seconds:.3f}", "-i", path,
        "-vf", f"fps={fps},scale=-2:{ANALYSIS_HEIGHT}",
        "-q:v", "6", os.path.join(out_dir, "f%05d.jpg"),
    ]
    subprocess.run(argv, check=True, capture_output=True,
                   timeout=max(120.0, seconds * 4))
    return sorted(
        os.path.join(out_dir, f) for f in os.listdir(out_dir)
        if f.startswith("f") and f.endswith(".jpg")
    )


def _grays(paths: list[str]) -> list[np.ndarray]:
    out = []
    for p in paths:
        try:
            with Image.open(p) as im:
                out.append(np.asarray(im.convert("L"), dtype=np.float32))
        except Exception:
            out.append(None)
    return out


def _shift(a: np.ndarray, b: np.ndarray) -> tuple[float, float]:
    """Translation from frame a to frame b, by phase correlation.

    Phase correlation rather than a shift search: it is one FFT pair per frame
    instead of a few hundred subtractions, and it does not care about exposure
    changing between frames, which it does constantly on auto-exposure phone
    footage.
    """
    if a is None or b is None or a.shape != b.shape:
        return 0.0, 0.0
    # A window taper: without it the frame edges act as a hard step and the
    # correlation locks onto them instead of onto the picture.
    h, w = a.shape
    taper = np.outer(np.hanning(h), np.hanning(w))
    fa = np.fft.rfft2(a * taper)
    fb = np.fft.rfft2(b * taper)
    cross = fa * np.conj(fb)
    magnitude = np.abs(cross)
    magnitude[magnitude < 1e-9] = 1e-9
    surface = np.fft.irfft2(cross / magnitude, s=a.shape)
    dy, dx = np.unravel_index(int(np.argmax(surface)), surface.shape)
    # The correlation surface wraps, so the top-left quadrant is a positive
    # shift and the bottom-right is a negative one.
    if dy > h // 2:
        dy -= h
    if dx > w // 2:
        dx -= w
    return float(dx), float(dy)


def measure_frames(paths: list[str]) -> dict:
    """Per-frame sharpness, exposure and inter-frame motion."""
    grays = _grays(paths)
    height = next((g.shape[0] for g in grays if g is not None), ANALYSIS_HEIGHT)

    sharpness = np.array([
        prefilter.laplacian_variance(g) if g is not None else 0.0 for g in grays
    ], dtype=np.float64)
    exposure = np.array([
        prefilter.exposure_penalty(g) if g is not None else 1.0 for g in grays
    ], dtype=np.float64)

    # Velocity between consecutive frames, as a fraction of frame height so the
    # numbers mean the same thing for a 4K clip and a 720p one.
    velocity = np.zeros((max(len(grays) - 1, 0), 2), dtype=np.float64)
    for i in range(len(grays) - 1):
        dx, dy = _shift(grays[i], grays[i + 1])
        velocity[i] = (dx / height, dy / height)

    # Shake is change in velocity, not velocity itself. A steady pan has a large
    # constant velocity and should pass; handheld jitter has a small average
    # velocity that reverses constantly and should not.
    if len(velocity) >= 2:
        jerk = np.linalg.norm(np.diff(velocity, axis=0), axis=1)
    else:
        jerk = np.zeros(0, dtype=np.float64)

    return {"sharpness": sharpness, "exposure": exposure,
            "velocity": velocity, "jerk": jerk, "count": len(grays)}


# ----------------------------------------------------------------- windows


def _window_stats(measures: dict, start_index: int, frames: int) -> dict:
    end = start_index + frames
    sharp = measures["sharpness"][start_index:end]
    expo = measures["exposure"][start_index:end]
    jerk = measures["jerk"][max(0, start_index - 1):max(0, end - 2)]
    speed = np.linalg.norm(measures["velocity"][start_index:max(start_index, end - 1)], axis=1) \
        if len(measures["velocity"]) else np.zeros(0)

    return {
        "sharpness": float(sharp.mean()) if len(sharp) else 0.0,
        "exposure_penalty": float(expo.mean()) if len(expo) else 1.0,
        # Percent of frame height per frame-step: the headline shake number.
        "shake": float(jerk.mean() * 100.0) if len(jerk) else 0.0,
        "shake_peak": float(jerk.max() * 100.0) if len(jerk) else 0.0,
        "pan_speed": float(speed.mean() * 100.0) if len(speed) else 0.0,
    }


def analyse(clip_path: str, work_dir: str, *, window_seconds: float,
            on_note=None) -> tuple[list[dict], str]:
    """Return the usable windows of one clip, best first, and a one-line reason.

    Windows never overlap, so the same moment cannot appear twice in a reel,
    and each carries a full-resolution still extracted at its sharpest frame -
    that still is what the prefilter and the model actually look at.
    """
    cfg = config.video
    info = probe(clip_path)
    duration = float(info.get("duration") or 0.0)
    if duration <= 0:
        return [], "unreadable"
    if duration < window_seconds:
        return [], f"shorter than one shot ({duration:.1f}s)"
    width, height = int(info.get("width") or 0), int(info.get("height") or 0)
    factor = upscale(width, height)
    if factor > cfg.max_upscale:
        return [], (f"{width}x{height} would be stretched {factor:.1f}x to fill the frame "
                    f"(limit {cfg.max_upscale:.1f})")

    looked_at = min(duration, cfg.max_analysis_seconds)
    frames_dir = os.path.join(work_dir, "frames")
    try:
        paths = _extract_frames(clip_path, frames_dir, fps=cfg.analysis_fps, seconds=looked_at)
    except Exception as err:
        return [], f"frame extraction failed ({err.__class__.__name__})"
    if len(paths) < 4:
        return [], "too few frames to judge"

    measures = measure_frames(paths)
    per_window = max(2, int(round(window_seconds * cfg.analysis_fps)))
    hop = max(1, int(round(cfg.window_hop_seconds * cfg.analysis_fps)))
    if measures["count"] < per_window:
        return [], "shorter than one shot"

    scored: list[dict] = []
    for start_index in range(0, measures["count"] - per_window + 1, hop):
        stats = _window_stats(measures, start_index, per_window)
        stats["start"] = start_index / cfg.analysis_fps
        stats["start_index"] = start_index
        scored.append(stats)

    steady = [w for w in scored
              if w["shake"] <= cfg.shake_threshold
              and w["shake_peak"] <= cfg.shake_peak_threshold
              and w["sharpness"] >= cfg.min_sharpness]
    if not steady:
        calmest = min(scored, key=lambda w: w["shake"]) if scored else None
        detail = f"steadiest window still {calmest['shake']:.1f}" if calmest else "no windows"
        return [], f"too shaky throughout ({detail} > {cfg.shake_threshold})"

    # Rank on the same shape of number the prefilter gives a photograph, so a
    # clip window and a still are comparable before either reaches the model.
    for w in steady:
        sharp_score = max(0.0, min(1.0, np.log10(max(w["sharpness"], 1.0)) / 2.7))
        steadiness = max(0.0, 1.0 - w["shake"] / max(cfg.shake_threshold, 0.01))
        w["window_score"] = round(10.0 * sharp_score * (1.0 - 0.6 * w["exposure_penalty"])
                                  * (0.6 + 0.4 * steadiness), 2)

    chosen: list[dict] = []
    for w in sorted(steady, key=lambda w: w["window_score"], reverse=True):
        if len(chosen) >= cfg.max_segments_per_clip:
            break
        # Non-overlapping, with a gap, so two picks from one clip are actually
        # different footage rather than the same second twice.
        if any(abs(w["start"] - c["start"]) < window_seconds + cfg.min_gap_seconds for c in chosen):
            continue
        if w["start"] + window_seconds > duration:
            continue
        chosen.append(w)

    if not chosen:
        return [], "no non-overlapping steady window"

    segments: list[dict] = []
    for index, w in enumerate(chosen):
        best = int(np.argmax(measures["sharpness"][w["start_index"]:w["start_index"] + per_window]))
        at = (w["start_index"] + best) / cfg.analysis_fps
        still = os.path.join(work_dir, f"still-{index + 1}.jpg")
        if not _grab_still(clip_path, at, still):
            continue
        segments.append({
            "path": still,
            "clip_path": clip_path,
            "clip_start": round(w["start"], 3),
            "is_video": True,
            "shake": round(w["shake"], 2),
            "pan_speed": round(w["pan_speed"], 2),
            "window_score": w["window_score"],
        })
    if not segments:
        return [], "could not extract a still from any window"
    if on_note:
        on_note(f"{len(segments)} window(s), shake "
                + ", ".join(f"{s['shake']:.1f}" for s in segments))
    return segments, "ok"


def _grab_still(clip_path: str, at_seconds: float, out_path: str) -> bool:
    """A full-resolution frame, which is what the model is actually shown."""
    try:
        subprocess.run(
            [config.render.ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
             "-ss", f"{at_seconds:.3f}", "-i", clip_path, "-frames:v", "1",
             "-q:v", "3", out_path],
            check=True, capture_output=True, timeout=120,
        )
        return os.path.exists(out_path) and os.path.getsize(out_path) > 0
    except Exception as err:
        log.warning("still extraction failed at %.1fs of %s: %s",
                    at_seconds, os.path.basename(clip_path), err)
        return False
