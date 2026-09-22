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


# ---------------------------------------------------------------- caption

# Where to look when the Elements folder carries no font. Present in the image
# because the Dockerfile installs fonts-dejavu-core; a caption in the wrong face
# is a worse reel, but no caption at all is a missing requirement.
FALLBACK_FONTS = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "C:/Windows/Fonts/arialbd.ttf",
]


def _escape_filter_path(path: str) -> str:
    """A path ffmpeg's filtergraph parser will read back as itself.

    Windows paths are the reason this exists: a drive letter's colon separates
    options inside a filter, and every backslash is an escape. Forward slashes
    are accepted on both platforms, so the separator is normalised first and
    only the genuinely special characters are escaped.
    """
    out = path.replace("\\", "/")
    for char in (":", "'", ",", ";", "[", "]", "\\"):
        out = out.replace(char, "\\" + char)
    return out


def _text_width(text: str, font, size: int) -> float:
    if font is not None:
        try:
            return font.getlength(text)
        except Exception:
            pass
    # No font to measure against — a rough average advance keeps the wrap
    # sensible rather than exact, which is the right failure here.
    return len(text) * size * 0.55


def _fit_caption(text: str, font_path: str | None, *, max_width: int,
                 max_lines: int, size: int, min_size: int) -> tuple[list[str], int]:
    """Wrap the caption and shrink it until it fits the frame.

    Measured against the real font rather than a character count: Mart is a
    display face and its advances are nothing like an average, so a
    characters-per-line rule overflows on some words and wastes the frame on
    others. The size is a ceiling and this walks down from it.
    """
    paragraphs = [p.strip() for p in text.replace("\r", "").split("\n")]
    paragraphs = [p for p in paragraphs if p]
    if not paragraphs:
        return [], size

    for candidate in range(size, min_size - 1, -2):
        font = None
        if font_path:
            try:
                from PIL import ImageFont
                font = ImageFont.truetype(font_path, candidate)
            except Exception:
                font = None
        lines: list[str] = []
        for paragraph in paragraphs:
            current = ""
            for word in paragraph.split():
                trial = f"{current} {word}".strip()
                if current and _text_width(trial, font, candidate) > max_width:
                    lines.append(current)
                    current = word
                else:
                    current = trial
            if current:
                lines.append(current)
        if len(lines) <= max_lines and all(
            _text_width(line, font, candidate) <= max_width for line in lines
        ):
            return lines, candidate

    # Nothing fits even at the floor. Keep the floor size and the lines that fit
    # the frame — a clipped last word is better than type running off the edge.
    return lines[:max_lines], min_size


def _caption_filters(source: str, *, work_dir: str, lines: list[str], font_path: str,
                     size: int, window: tuple[float, float], fade: float,
                     width: int, height: int) -> tuple[list[str], str]:
    """One drawtext per line, each centred on its own.

    drawtext only learned `text_align` in ffmpeg 7.1 and the container runs 5.1,
    so centring a block of lines is done here instead: every line is its own
    filter with its own x expression, stacked on a fixed line box so the
    baselines cannot jitter between lines of differing height.
    """
    r = config.render
    start, end = window
    line_height = size + r.caption_line_spacing
    block_bottom = height - r.caption_bottom_margin

    # Fading with the scrim rather than cutting: the caption appears during the
    # transition out of the intro card, where a hard cut reads as a fault.
    hold = max(0.0, end - fade)
    alpha = (f"if(lt(t,{start:.3f}),0,"
             f"if(lt(t,{start + fade:.3f}),(t-{start:.3f})/{fade:.3f},"
             f"if(lt(t,{hold:.3f}),1,"
             f"if(lt(t,{end:.3f}),({end:.3f}-t)/{fade:.3f},0))))")

    filters: list[str] = []
    chain = source
    for index, line in enumerate(lines):
        # The text goes to a file so that nothing in it — colons, quotes,
        # percent signs, commas — has to survive two levels of filter escaping.
        path = os.path.join(work_dir, f"caption-{index + 1}.txt")
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(line)
        y = block_bottom - (len(lines) - index) * line_height + r.caption_line_spacing
        out = f"cap{index}"
        filters.append(
            f"[{chain}]drawtext=fontfile={_escape_filter_path(font_path)}:"
            f"textfile={_escape_filter_path(path)}:"
            # Without this, drawtext runs the caption through strftime and its
            # own %{…} expansion: a caption reading "100% attendance" fails the
            # whole render, and one containing "%d" would silently become a
            # date. The text is the user's, so none of it is an expression.
            f"expansion=none:"
            f"fontcolor={r.caption_color}:fontsize={size}:"
            f"x=(w-text_w)/2:y={y}:fix_bounds=1:alpha='{alpha}'[{out}]"
        )
        chain = out
    return filters, chain


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
    gradient_path: str | None = None,
    font_path: str | None = None,
    caption: str = "",
    seconds_per_image: float | None = None,
    transition_seconds: float | None = None,
    song_start: float | None = None,
    on_note=None,
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

    # The caption is only drawn over the photographs, so the window it occupies
    # has to be known before any of it is built.
    caption = (caption or "").strip()
    wants_caption = bool(caption) and bool(shots)

    # Input indices are positional, so the extras are appended in a fixed order
    # and their indices derived from the segment count.
    next_index = len(segments)
    gradient_index = None
    if wants_caption and gradient_path:
        gradient_index = next_index
        next_index += 1
    logo_index = next_index if logo_path else None
    if logo_path:
        next_index += 1
    audio_index = next_index if song_path else None
    if gradient_index is not None:
        args += ["-loop", "1", "-framerate", str(fps), "-i", gradient_path]
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
    segments[0]["start"] = 0.0
    for i in range(1, len(segments)):
        offset = total - xt
        # Where this segment lands on the finished timeline, which is what the
        # caption window is expressed in.
        segments[i]["start"] = offset
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

    # The scrim and the caption sit above the photographs and below the
    # copyright frame, so they go on here — after the xfade chain, before the
    # logo overlay.
    if wants_caption:
        first = 1 if intro_path else 0
        last = first + len(shots) - 1
        start = segments[first]["start"]
        end = segments[last]["start"] + segments[last]["duration"]
        # A fade longer than a third of the window would never reach full
        # opacity, which looks like a mistake rather than a choice.
        fade = max(0.1, min(r.caption_fade_seconds, (end - start) / 3))

        if gradient_index is not None:
            filters.append(
                f"[{gradient_index}:v]scale={width}:{height}:flags=lanczos,format=rgba,"
                f"setpts=PTS-STARTPTS,"
                f"fade=t=in:st={start:.3f}:d={fade:.3f}:alpha=1,"
                f"fade=t=out:st={max(0.0, end - fade):.3f}:d={fade:.3f}:alpha=1[grad]"
            )
            filters.append(f"[{chain}][grad]overlay=0:0:format=auto[scrim]")
            chain = "scrim"
        elif on_note:
            on_note("no gradient overlay in Elements — the caption is drawn straight onto the photographs")

        usable = font_path or next((f for f in FALLBACK_FONTS if os.path.exists(f)), None)
        if not usable:
            if on_note:
                on_note("caption skipped — no font file in Elements and no system font to fall back on")
        else:
            lines, size = _fit_caption(
                caption, usable,
                max_width=width - 2 * r.caption_side_margin,
                max_lines=r.caption_max_lines,
                size=r.caption_font_size,
                min_size=r.caption_min_font_size,
            )
            # Three lines at the minimum size is a hard ceiling, and dropping
            # the end of someone's caption without saying so is how a reel goes
            # out reading "…day three of the".
            if len(" ".join(lines).split()) < len(caption.split()) and on_note:
                on_note(f"caption too long for {r.caption_max_lines} lines — it was cut to "
                        f"{' / '.join(lines)!r}")
            if lines:
                text_filters, chain = _caption_filters(
                    chain, work_dir=os.path.dirname(os.path.abspath(output_path)),
                    lines=lines, font_path=usable, size=size,
                    window=(start, end), fade=fade, width=width, height=height,
                )
                filters += text_filters
                if on_note:
                    on_note(f"caption: {len(lines)} line(s) at {size}px, "
                            f"{start:.1f}s–{end:.1f}s, font {os.path.basename(usable)}")

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
        # Which part of the song to use is only answerable once the reel's exact
        # length is known, which is here.
        offset = song_start
        if offset is None and r.music_pick == "auto":
            from . import music
            offset = music.best_window(song_path, total, on_note=on_note)
        offset = max(0.0, float(offset or 0.0))
        fade_out_at = max(0.0, total - 2.0)
        filters.append(
            f"[{audio_index}:a]atrim={offset:.4f}:{offset + total:.4f},asetpts=PTS-STARTPTS,"
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
