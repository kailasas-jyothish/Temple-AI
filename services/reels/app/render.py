"""Everything visual, done in ffmpeg.

The LLM picks the images and stops there. Motion, transitions, timing, branding
and audio are all decided here, deterministically: the same shot list renders
the same reel every time, which makes a bad-looking result reproducible and
therefore fixable.
"""
from __future__ import annotations

import json
import logging
import os
import subprocess
import threading

from .config import config

log = logging.getLogger(__name__)

# Chosen deliberately: each is available in stock ffmpeg, reads as intentional
# at 0.5s, and none of them flash or invert colour. Cycled by index rather than
# picked at random so a re-run is identical.
TRANSITIONS = ["fade", "dissolve", "slideleft", "wipeup", "circleopen", "smoothright"]

# zoompan drifts by a pixel per frame when it scales up from the source, so the
# frame is pre-scaled to twice the output and zoompan only ever samples down.
SUPERSAMPLE = 2

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".heic", ".bmp", ".gif", ".tif", ".tiff"}


class RenderError(RuntimeError):
    def __init__(self, message: str, stderr: str = ""):
        super().__init__(message)
        self.stderr = stderr


def probe_duration(path: str) -> float:
    out = subprocess.run(
        [config.render.ffprobe, "-v", "error", "-show_entries", "format=duration",
         "-of", "json", path],
        capture_output=True, text=True, check=False,
    )
    try:
        return float(json.loads(out.stdout)["format"]["duration"])
    except Exception:
        return 0.0


def is_video(path: str) -> bool:
    return os.path.splitext(path)[1].lower() not in IMAGE_EXTS


# ------------------------------------------------------------------ motion

def _ken_burns(index: int, frames: int) -> tuple[str, str, str]:
    """A zoom and pan expression trio for one still.

    Expressions are written against `on`, the output frame index, rather than
    accumulating `zoom` frame by frame: accumulation rounds, and the rounding
    shows up as a visible stutter halfway through a slow zoom.
    """
    last = max(frames - 1, 1)
    p = f"(on/{last})"
    amount = 0.14

    variant = index % 4
    if variant == 0:      # zoom in, centred
        z = f"(1+{amount}*{p})"
        x, y = f"(iw-iw/zoom)/2", f"(ih-ih/zoom)/2"
    elif variant == 1:    # zoom out, centred
        z = f"({1 + amount}-{amount}*{p})"
        x, y = f"(iw-iw/zoom)/2", f"(ih-ih/zoom)/2"
    elif variant == 2:    # zoom in while panning left to right
        z = f"(1+{amount}*{p})"
        x, y = f"(iw-iw/zoom)*{p}", f"(ih-ih/zoom)/2"
    else:                 # zoom in while panning top to bottom
        z = f"(1+{amount}*{p})"
        x, y = f"(iw-iw/zoom)/2", f"(ih-ih/zoom)*{p}"
    return z, x, y


def _logo_xy(position: str, margin: int) -> str:
    return {
        "top-left": f"{margin}:{margin}",
        "top-right": f"W-w-{margin}:{margin}",
        "bottom-left": f"{margin}:H-h-{margin}",
        "bottom-right": f"W-w-{margin}:H-h-{margin}",
    }.get(position, f"W-w-{margin}:{margin}")


def _is_full_frame(path: str, width: int, height: int, tolerance: float = 0.02) -> bool:
    """Is this overlay a whole-screen frame rather than a corner mark?

    The real branding asset here is a 1080x1920 transparent PNG carrying marks
    in two corners. Scaling that to a 110px logo and tucking it in a corner
    would be wrong in a way that is obvious on screen and easy to ship by
    accident, so the shape of the file decides rather than a setting nobody
    remembers to change.
    """
    try:
        from PIL import Image
        with Image.open(path) as im:
            w, h = im.size
    except Exception:
        return False
    if not h or not w:
        return False
    target = width / height
    return abs((w / h) - target) / target <= tolerance


# ------------------------------------------------------------------ build

def build_command(
    shots: list[dict],
    output_path: str,
    *,
    song_path: str | None = None,
    logo_path: str | None = None,
    endcard_path: str | None = None,
    intro_path: str | None = None,
    seconds_per_image: float | None = None,
    transition_seconds: float | None = None,
) -> tuple[list[str], float]:
    """Assemble the whole render as one filter graph.

    Returns the argv and the exact output duration. A single graph rather than
    per-shot intermediate files: no generation loss, and nothing to clean up if
    the render dies halfway.
    """
    r = config.render
    width, height, fps = r.width, r.height, r.fps
    per = seconds_per_image if seconds_per_image is not None else r.seconds_per_image
    xt = transition_seconds if transition_seconds is not None else r.transition_seconds

    if not shots:
        raise RenderError("nothing to render — the shot list is empty")
    if per <= xt:
        raise RenderError(f"seconds_per_image ({per}) must exceed transition_seconds ({xt})")

    # A segment is anything that occupies screen time: the optional intro card,
    # every chosen still, and the optional end card.
    segments: list[dict] = []
    if intro_path:
        segments.append({"path": intro_path, "duration": _card_duration(intro_path, r.intro_seconds),
                         "motion": False, "video": is_video(intro_path)})
    for shot in shots:
        segments.append({"path": shot["path"], "duration": per, "motion": True, "video": False})
    if endcard_path:
        segments.append({"path": endcard_path, "duration": _card_duration(endcard_path, r.endcard_seconds),
                         "motion": False, "video": is_video(endcard_path)})

    short = [s for s in segments if s["duration"] <= xt]
    if short:
        raise RenderError(
            f"{len(short)} segment(s) are shorter than the {xt}s transition; "
            "shorten TRANSITION_SECONDS or lengthen the card"
        )

    args: list[str] = [r.ffmpeg, "-hide_banner", "-loglevel", "error", "-nostats", "-y"]
    for seg in segments:
        if seg["video"]:
            args += ["-i", seg["path"]]
        else:
            # -framerate makes the looped still produce exactly duration*fps
            # frames, which is what the zoompan expressions are written against.
            args += ["-loop", "1", "-framerate", str(fps), "-t", f"{seg['duration']:.4f}", "-i", seg["path"]]

    # Input indices are positional, so the extras are appended in a fixed order
    # and their indices derived from the segment count.
    logo_index = len(segments) if logo_path else None
    audio_index = (len(segments) + (1 if logo_path else 0)) if song_path else None
    if logo_path:
        args += ["-i", logo_path]
    if song_path:
        # Loop the song rather than leaving the tail of the reel silent when
        # someone drops in a 30s clip.
        args += ["-stream_loop", "-1", "-i", song_path]

    filters: list[str] = []
    big_w, big_h = width * SUPERSAMPLE, height * SUPERSAMPLE

    for i, seg in enumerate(segments):
        if seg["motion"]:
            frames = max(1, round(seg["duration"] * fps))
            z, x, y = _ken_burns(i, frames)
            filters.append(
                f"[{i}:v]scale={big_w}:{big_h}:force_original_aspect_ratio=increase:flags=lanczos,"
                f"crop={big_w}:{big_h},"
                f"zoompan=z='{z}':x='{x}':y='{y}':d=1:s={width}x{height}:fps={fps},"
                f"setsar=1,format=yuv420p,setpts=PTS-STARTPTS[v{i}]"
            )
        else:
            # Branding cards are letterboxed rather than cropped — a logo with
            # its edge sliced off is worse than a black bar. The exception is a
            # card already cut to roughly the output shape (the real end cards
            # are 941x1672 against a 9:16 frame), where padding would leave a
            # 3px hairline that reads as a rendering fault.
            if seg["video"] or not _is_full_frame(seg["path"], width, height, tolerance=0.05):
                fit = (f"scale={width}:{height}:force_original_aspect_ratio=decrease:flags=lanczos,"
                       f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black")
            else:
                fit = (f"scale={width}:{height}:force_original_aspect_ratio=increase:flags=lanczos,"
                       f"crop={width}:{height}")
            filters.append(
                f"[{i}:v]{fit},fps={fps},setsar=1,format=yuv420p,setpts=PTS-STARTPTS[v{i}]"
            )

    # Chain the segments with xfade. Each transition overlaps the tail of what
    # has been built so far with the head of the next segment, so the offset is
    # the running total minus one transition.
    chain = "v0"
    total = segments[0]["duration"]
    for i in range(1, len(segments)):
        offset = total - xt
        # Plain fades top and tail the reel; the varied transitions belong
        # between photographs, where they read as pacing rather than noise.
        is_card_join = (i == 1 and intro_path) or (endcard_path and i == len(segments) - 1)
        name = "fade" if is_card_join else TRANSITIONS[(i - 1) % len(TRANSITIONS)]
        out = f"x{i}"
        filters.append(
            f"[{chain}][v{i}]xfade=transition={name}:duration={xt}:offset={offset:.4f}[{out}]"
        )
        chain = out
        total += segments[i]["duration"] - xt

    if logo_index is not None:
        mode = r.logo_mode
        if mode == "auto":
            mode = "frame" if _is_full_frame(logo_path, width, height) else "corner"
        # The frame carries its own alpha; fading it again would wash out the
        # marks it exists to show.
        fade = "" if r.logo_opacity >= 1.0 else f",colorchannelmixer=aa={r.logo_opacity}"
        if mode == "frame":
            filters.append(f"[{logo_index}:v]scale={width}:{height}:flags=lanczos,format=rgba{fade}[logo]")
            position = "0:0"
        else:
            filters.append(f"[{logo_index}:v]scale=-1:{r.logo_height}:flags=lanczos,format=rgba{fade}[logo]")
            position = _logo_xy(r.logo_position, r.logo_margin)
        filters.append(f"[{chain}][logo]overlay={position}:format=auto[vout]")
    else:
        filters.append(f"[{chain}]null[vout]")

    maps = ["-map", "[vout]"]
    if audio_index is not None:
        fade_out_at = max(0.0, total - 2.0)
        filters.append(
            f"[{audio_index}:a]atrim=0:{total:.4f},asetpts=PTS-STARTPTS,"
            f"afade=t=in:st=0:d=1,afade=t=out:st={fade_out_at:.4f}:d=2,"
            f"loudnorm=I=-16:TP=-1.5:LRA=11[aout]"
        )
        maps += ["-map", "[aout]"]

    args += ["-filter_complex", ";".join(filters), *maps]
    args += [
        "-c:v", "libx264", "-profile:v", "high", "-preset", r.preset, "-crf", str(r.crf),
        "-pix_fmt", "yuv420p", "-r", str(fps), "-movflags", "+faststart",
    ]
    if audio_index is not None:
        args += ["-c:a", "aac", "-b:a", r.audio_bitrate, "-ar", "48000", "-ac", "2"]
    args += ["-t", f"{total:.4f}", "-progress", "pipe:1", output_path]
    return args, total


def _card_duration(path: str, fallback: float) -> float:
    if is_video(path):
        found = probe_duration(path)
        if found > 0.2:
            return found
    return fallback


# ------------------------------------------------------------------- run

def run(argv: list[str], total_seconds: float, *, on_progress=None, on_log=None) -> None:
    """Run ffmpeg, reporting progress from -progress rather than parsing stats.

    stderr is drained on its own thread: a filter graph this size can emit more
    than a pipe buffer holds, and a full pipe deadlocks the process.
    """
    if on_log:
        on_log(" ".join(argv))

    try:
        proc = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)
    except FileNotFoundError as err:
        # The bare OSError names no file at all, which is useless when the
        # missing thing is the one program this service depends on.
        raise RenderError(
            f"ffmpeg could not be run as '{argv[0]}'. Install it and make sure it is on PATH, "
            f"or set FFMPEG_BIN to its full path."
        ) from err
    errors: list[str] = []
    # ffmpeg has no timeout of its own. Killing it turns "the job never came
    # back" into a failure with a reason, which is the whole point.
    limit = config.render.timeout_seconds
    timed_out = threading.Event()

    def give_up():
        timed_out.set()
        proc.kill()

    killer = threading.Timer(limit, give_up) if limit > 0 else None
    if killer:
        killer.daemon = True
        killer.start()

    def drain():
        for line in proc.stderr:
            line = line.rstrip()
            if line:
                errors.append(line)
    pump = threading.Thread(target=drain, daemon=True)
    pump.start()

    for line in proc.stdout:
        key, _, value = line.strip().partition("=")
        if key == "out_time_ms" and on_progress and total_seconds > 0:
            try:
                done = int(value) / 1_000_000.0
            except ValueError:
                continue
            on_progress(max(0.0, min(1.0, done / total_seconds)))

    code = proc.wait()
    if killer:
        killer.cancel()
    pump.join(timeout=5)
    if timed_out.is_set():
        raise RenderError(
            f"ffmpeg was still running after {limit:.0f}s and was stopped. "
            f"Raise RENDER_TIMEOUT_SECONDS, or ask for a shorter reel.",
            "\n".join(errors[-20:]),
        )
    if code != 0:
        tail = "\n".join(errors[-20:])
        raise RenderError(f"ffmpeg exited {code}", tail)


def render(shots: list[dict], output_path: str, *, on_progress=None, on_log=None, **kwargs) -> float:
    argv, total = build_command(shots, output_path, **kwargs)
    run(argv, total, on_progress=on_progress, on_log=on_log)
    return total


def poster(video_path: str, image_path: str, at_seconds: float = 1.0) -> str | None:
    """A still for the Slack card. Best effort — a missing thumbnail is not a
    reason to fail a finished reel."""
    try:
        subprocess.run(
            [config.render.ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
             "-ss", str(at_seconds), "-i", video_path, "-frames:v", "1", "-q:v", "3", image_path],
            check=True, capture_output=True,
        )
        return image_path
    except Exception as err:
        log.warning("poster frame failed: %s", err)
        return None
