"""Build a reel from your own machine, with no server involved.

    python -m app.cli                 walks you through it
    python -m app.cli --event <link>  skips straight to a folder

The edge proxy on the Dokploy host only serves two hostnames and cannot be
changed through the Dokploy API, so the hosted UI is unreachable from a network
that blocks bare IPs. This is the same pipeline behind the same menus, run
locally: it downloads from Drive, curates, renders, uploads the reel back into
the event folder and posts to Slack, exactly as the server would.
"""
from __future__ import annotations

import argparse
import logging
import os
import subprocess
import sys
import time

from . import config as config_module
from . import drive, elements, jobs, library, sequence
from .config import config


# ------------------------------------------------------------------ menus

def _ask(prompt: str) -> str:
    try:
        return input(prompt).strip()
    except (EOFError, KeyboardInterrupt):
        print()
        raise SystemExit(1)


def choose(title: str, rows: list[dict], *, none_label: str | None = None) -> dict | None:
    """A numbered list. `rows` are dicts with at least id and name."""
    print(f"\n{title}")
    if none_label:
        print(f"   0. {none_label}")
    for index, row in enumerate(rows, start=1):
        print(f"  {index:2d}. {row['name']}")
    while True:
        answer = _ask("\n  number > ")
        if answer == "0" and none_label:
            return None
        if answer.isdigit() and 1 <= int(answer) <= len(rows):
            return rows[int(answer) - 1]
        print("  not one of those.")


def pick_event() -> dict:
    """Walk down from Vision Pics. The archive nests year / month / event, and
    an event folder can hold photos directly as well as temple sub-folders, so
    'use this one' is offered at every level rather than at a fixed depth."""
    here = drive.get_file(library.root_id())
    trail: list[dict] = []
    while True:
        folders = drive.list_children(here["id"], folders_only=True)
        skip = {config.drive.songs_folder.lower(), config.drive.elements_folder.lower(),
                config.drive.reels_folder.lower()}
        folders = [f for f in folders if f["name"].lower() not in skip]

        path = " / ".join([*(t["name"] for t in trail), here["name"]])
        print(f"\n  {path}")
        print("   0. ** use this folder **")
        if trail:
            print("   u. go back up")
        for index, folder in enumerate(folders, start=1):
            print(f"  {index:2d}. {folder['name']}")

        answer = _ask("\n  number > ")
        if answer == "0":
            return here
        if answer == "u" and trail:
            here = trail.pop()
            continue
        if answer.isdigit() and 1 <= int(answer) <= len(folders):
            trail.append(here)
            here = folders[int(answer) - 1]
            continue
        print("  not one of those.")


def pick_song() -> str:
    tracks = library.songs()
    if not tracks:
        folder = library.songs_folder()
        where = folder["name"] if folder else config.drive.songs_folder
        print(f"\n  (nothing in {where} yet — the reel will be silent)")
        return ""
    # Newest first, so today's upload is option 1.
    chosen = choose("Song  (newest first)", tracks, none_label="no music")
    return chosen["id"] if chosen else ""


LENGTHS = [15.0, 20.0, 30.0, 45.0, 60.0, 90.0]


def pick_length(*, seconds_per_image: float, transition_seconds: float) -> float:
    """Reels are cut to a platform's expectations, not to how many photographs
    arrived, so the length is asked for every run rather than set once in .env.

    It is also the one setting that changes how long the run takes: the pool of
    images that gets scored is sized from it.
    """
    default = config.render.target_seconds
    if config.render.shot_count:
        # An explicit SHOT_COUNT wins over any length, and silently asking for
        # one that will be ignored is worse than not asking.
        print(f"\n  (SHOT_COUNT={config.render.shot_count} is set, so the length is fixed by it)")
        return default

    print("\nReel length")
    for index, seconds in enumerate(LENGTHS, start=1):
        shots = sequence.shot_count(target_seconds=seconds, seconds_per_image=seconds_per_image,
                                    transition_seconds=transition_seconds)
        mark = "   <- current default" if abs(seconds - default) < 0.01 else ""
        print(f"  {index:2d}. {seconds:>3.0f}s  — about {shots} photos{mark}")
    print("      or type any length in seconds (10-300)")

    while True:
        answer = _ask("\n  number > ")
        if answer.isdigit():
            value = int(answer)
            if 1 <= value <= len(LENGTHS):
                return LENGTHS[value - 1]
            if 10 <= value <= 300:
                return float(value)
        print("  a menu number, or a length between 10 and 300 seconds.")


def pick_endcard() -> str:
    folder = library.elements_folder()
    if not folder:
        return ""
    options = elements.available(folder["id"]).get("endcard", [])
    if not options:
        return ""
    default = elements._find_by_name(folder["id"], "endcard")
    label = f"default ({default['name']})" if default else "no end card"
    chosen = choose("End card", options, none_label=label)
    return chosen["id"] if chosen else ""


# ------------------------------------------------------------------- run

SPINNER = "|/-\\"


def follow(job_id: str) -> dict:
    """Stream the job's own log, under a status line that always moves.

    Downloading a large event is several hundred files and can run for many
    minutes with nothing to say. Without a visible heartbeat that is
    indistinguishable from a hang, which is exactly how it was first read.
    """
    seen = 0
    tick = 0
    started = time.time()
    last_progress = -1.0
    last_change = time.time()
    width = 0

    def clear() -> None:
        nonlocal width
        if width:
            print("\r" + " " * width + "\r", end="", flush=True)
            width = 0

    while True:
        job = jobs.get(job_id) or {}

        lines = job.get("log", [])
        if len(lines) > seen:
            clear()
            for line in lines[seen:]:
                print(f"  {line.split('  ', 1)[-1]}")
            seen = len(lines)

        state = job.get("state")
        if state in ("done", "failed"):
            clear()
            return job

        progress = float(job.get("progress") or 0.0)
        if abs(progress - last_progress) > 0.0001:
            last_progress, last_change = progress, time.time()

        elapsed = int(time.time() - started)
        stalled = int(time.time() - last_change)
        detail = job.get("detail") or ""
        status = (f"  {SPINNER[tick % len(SPINNER)]} {job.get('stage', '')} "
                  f"{progress * 100:5.1f}%  {detail}  [{elapsed // 60}m{elapsed % 60:02d}s]")
        # Five minutes without the number moving is worth flagging, but it is a
        # slow stage rather than proof of a hang, so it says so plainly.
        if stalled > 300:
            status += f"  (no change for {stalled // 60}m — still running, Ctrl+C to stop)"

        clear()
        print(status, end="", flush=True)
        width = len(status)
        tick += 1
        time.sleep(1)


def show_status() -> int:
    """What the last run is doing, read from disk.

    A running job writes its state at every stage change, so this answers
    "is it stuck?" from a second window without disturbing the run.
    """
    rows = jobs.snapshot()
    if not rows:
        print("No runs recorded yet.")
        return 0
    job = rows[0]
    print(f"  event    {job.get('event_name') or job.get('event_folder_id')}")
    print(f"  state    {job.get('state')}  ({job.get('stage')}, {float(job.get('progress') or 0) * 100:.0f}%)")
    print(f"  started  {job.get('started_at') or job.get('created_at')}")
    if job.get("error"):
        print(f"  error    {job['error'][:500]}")
    if job.get("reel_url"):
        print(f"  reel     {job['reel_url']}")
    print("\n  last lines:")
    for line in (job.get("log") or [])[-10:]:
        print(f"    {line}")

    work = os.path.join(config.work_dir, job["id"])
    if os.path.isdir(work):
        files = [os.path.join(work, f) for f in os.listdir(work)]
        newest = max((os.path.getmtime(f) for f in files), default=0)
        size = sum(os.path.getsize(f) for f in files) / 1_048_576
        age = int(time.time() - newest) if newest else -1
        moving = 0 <= age < 120
        print(f"\n  work dir: {len(files)} files, {size:.0f} MB, last written {age}s ago")
        # The recorded state only updates at stage boundaries, and a download
        # stage can run for many minutes. Files still appearing is the better
        # evidence that work is happening.
        print(f"  verdict:  {'running — files are still arriving' if moving else 'nothing written recently'}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="app.cli", description="Build one reel.")
    parser.add_argument("--event", default="", help="event folder id or Drive link (skips the menu)")
    parser.add_argument("--song", default=None, help="song file id or link; omit to be asked")
    parser.add_argument("--endcard", default=None, help="end card file id or link; omit to be asked")
    parser.add_argument("--target", type=float, default=None, help="target length in seconds")
    parser.add_argument("--per", type=float, default=None, help="seconds per photo")
    parser.add_argument("--transition", type=float, default=None)
    parser.add_argument("--shots", type=int, default=None)
    parser.add_argument("--no-upload", action="store_true",
                        help="render to ./reel.mp4 and stop, without writing to Drive or Slack")
    parser.add_argument("--yes", action="store_true", help="do not ask for confirmation")
    parser.add_argument("--status", action="store_true",
                        help="print the last job's state and exit (run this in a second window)")
    args = parser.parse_args(argv)

    if args.status:
        return show_status()

    # Everything internal goes to a file: the console belongs to the job log and
    # the status line, and a stray log record in the middle of them is how a
    # readable run turns into noise. The file is what to read after a failure.
    os.makedirs(config.data_dir, exist_ok=True)
    log_path = os.path.join(config.data_dir, "reels.log")
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)-5s %(name)s  %(message)s",
        handlers=[logging.FileHandler(log_path, encoding="utf-8")],
    )

    problems = config_module.problems()
    # Check the tools before the network: discovering ffmpeg is missing after
    # downloading four hundred photographs is a long way to go for that news.
    for binary in (config.render.ffmpeg, config.render.ffprobe):
        try:
            subprocess.run([binary, "-version"], capture_output=True, check=True)
        except Exception:
            problems.append(f"'{binary}' could not be run — install ffmpeg, or set FFMPEG_BIN/FFPROBE_BIN.")
    if problems:
        print("Cannot start:")
        for line in problems:
            print(f"  - {line}")
        return 1

    print("Temple Reels")

    event = drive.get_file(drive.parse_id(args.event)) if args.event else pick_event()
    song = drive.parse_id(args.song) if args.song is not None else pick_song()
    endcard = drive.parse_id(args.endcard) if args.endcard is not None else pick_endcard()

    per = args.per or config.render.seconds_per_image
    xt = args.transition if args.transition is not None else config.render.transition_seconds
    if args.target:
        target = args.target
    elif args.shots:
        target = config.render.target_seconds
    else:
        target = pick_length(seconds_per_image=per, transition_seconds=xt)
    wanted = sequence.shot_count(target_seconds=target, seconds_per_image=per,
                                 transition_seconds=xt, override=args.shots)

    # Listing is cheap; downloading is not. A day's event can be several hundred
    # photographs and close to a gigabyte, and knowing that up front is the
    # difference between a long wait and an apparent hang.
    groups = drive.walk_event(event["id"])
    photos = [f for g in groups for f in g["images"]]
    megabytes = sum(int(f.get("size") or 0) for f in photos) / 1_048_576
    if not photos:
        print(f"\n  {event['name']} has no photographs in it — pick a different folder.")
        return 1

    pool = jobs._pool_size(wanted)
    cap = min(config.curation.download_cap, max(120, pool * 5)) if config.curation.download_cap else 0
    print(f"\n  event    {event['name']}")
    if cap and len(photos) > cap:
        print(f"  photos   {len(photos)} across {len(groups)} folder(s) — sampling {cap} evenly, "
              f"about {megabytes * cap / len(photos):.0f} MB")
    else:
        print(f"  photos   {len(photos)} across {len(groups)} folder(s), about {megabytes:.0f} MB")
    print(f"  song     {drive.get_file(song)['name'] if song else '(silent)'}")
    print(f"  end card {drive.get_file(endcard)['name'] if endcard else '(default)'}")
    print(f"  length   about {sequence.duration_for(wanted, seconds_per_image=per, transition_seconds=xt):.0f}s "
          f"from {wanted} photos, chosen by the model from {pool}")
    print(f"  upload   {'no — local file only' if args.no_upload else 'yes, into ' + config.drive.reels_folder}")

    if not args.yes and _ask("\n  go? [Y/n] > ").lower() in ("n", "no"):
        return 1

    jobs.load()
    job = jobs.submit(
        event_folder_id=event["id"],
        song_file_id=song,
        options={
            "endcard_file_id": endcard,
            "target_seconds": target,
            "seconds_per_image": per,
            "transition_seconds": xt,
            "shot_count": args.shots or 0,
            "skip_upload": args.no_upload,
        },
    )
    print()
    finished = follow(job["id"])

    if finished.get("state") == "failed":
        print("\n" + "=" * 60)
        print("FAILED at stage: " + str(finished.get("stage")))
        print("=" * 60)
        print(finished.get("error", "") [:2000] or "(no detail recorded)")
        print(f"\nFull log: {log_path}")
        return 1

    stats = finished.get("stats", {})
    print(f"\nDone — {stats.get('used')} of {stats.get('considered')} photos, "
          f"{stats.get('duration_seconds')}s, selection by {stats.get('curation_mode')}")
    if finished.get("reel_url"):
        print(f"  {finished['reel_url']}")
    if finished.get("local_path"):
        print(f"  {finished['local_path']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
