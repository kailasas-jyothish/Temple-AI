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

def follow(job_id: str) -> dict:
    """Stream the job's own log rather than inventing a second one."""
    seen = 0
    while True:
        job = jobs.get(job_id) or {}
        lines = job.get("log", [])
        for line in lines[seen:]:
            print(f"  {line.split('  ', 1)[-1]}")
        seen = len(lines)
        if job.get("state") in ("done", "failed"):
            return job
        time.sleep(1)


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
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.WARNING, format="%(levelname)-5s %(name)s  %(message)s")

    problems = config_module.problems()
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
    target = args.target or config.render.target_seconds
    wanted = sequence.shot_count(target_seconds=target, seconds_per_image=per,
                                 transition_seconds=xt, override=args.shots)

    print(f"\n  event    {event['name']}")
    print(f"  song     {drive.get_file(song)['name'] if song else '(silent)'}")
    print(f"  end card {drive.get_file(endcard)['name'] if endcard else '(default)'}")
    print(f"  length   about {sequence.duration_for(wanted, seconds_per_image=per, transition_seconds=xt):.0f}s "
          f"from {wanted} photos")
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
        print(f"\nFAILED: {finished.get('error', '')[:800]}")
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
