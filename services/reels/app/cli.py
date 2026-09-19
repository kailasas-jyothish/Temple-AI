"""Run the pipeline from a terminal, writing the mp4 to disk.

    python -m app.cli --event <folder id or link> --song <file id or link> --out reel.mp4

Exists so a reel can be watched before anything is written to Drive — the render
is the part most likely to look wrong, and looking at it is the only way to know.
"""
from __future__ import annotations

import argparse
import logging
import os
import shutil
import sys
import tempfile
import time

from . import curate, drive, elements, library, prefilter, render, sequence
from .config import config


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="app.cli", description="Build one reel locally.")
    parser.add_argument("--event", required=True, help="event folder id or Drive link")
    parser.add_argument("--song", default="", help="song file id or Drive link")
    parser.add_argument("--out", default="reel.mp4")
    parser.add_argument("--target", type=float, default=None, help="target length in seconds")
    parser.add_argument("--per", type=float, default=None, help="seconds per photo")
    parser.add_argument("--transition", type=float, default=None)
    parser.add_argument("--shots", type=int, default=None)
    parser.add_argument("--no-curate", action="store_true", help="skip the LLM, use heuristics")
    parser.add_argument("--keep-work", action="store_true", help="leave the downloaded images behind")
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(levelname)-5s %(name)s  %(message)s")

    per = args.per or config.render.seconds_per_image
    xt = args.transition if args.transition is not None else config.render.transition_seconds
    wanted = sequence.shot_count(target_seconds=args.target, seconds_per_image=per,
                                 transition_seconds=xt, override=args.shots)

    work = tempfile.mkdtemp(prefix="reel-cli-")
    try:
        event = drive.get_file(drive.parse_id(args.event))
        print(f"event: {event['name']}")

        candidates = []
        for group in drive.walk_event(event["id"]):
            for f in group["images"]:
                candidates.append({"id": f["id"], "name": f["name"], "temple": group["temple"],
                                   "createdTime": f.get("createdTime", "")})
        if not candidates:
            print("no images found in that folder")
            return 1
        print(f"downloading {len(candidates)} images…")
        for index, item in enumerate(candidates, start=1):
            item["path"] = os.path.join(work, f"{index:04d}{os.path.splitext(item['name'])[1] or '.jpg'}")
            drive.download(item["id"], item["path"])

        kept, rejected = prefilter.triage(candidates)
        print(f"prefilter: kept {len(kept)}, dropped {len(rejected)}")
        for item in rejected[:15]:
            print(f"    - {item['name']}: {item.get('reject')}")

        if args.no_curate:
            for item in kept:
                item["score"] = item["heuristic_score"]
                item["usable"] = True
                item["scored_by"] = "heuristic"
            mode = "heuristic"
        else:
            mode = curate.curate(kept, on_progress=lambda d, t: print(f"  curating {d}/{t}", end="\r"))
        print(f"\ncuration: {mode}")

        shots = sequence.build(kept, wanted)
        for position, shot in enumerate(shots, start=1):
            print(f"  {position:2d}. [{shot['score']:4.1f}] {shot.get('temple') or '—':<24} "
                  f"{shot['name']}  {shot.get('why', '')}")

        folder = library.elements_folder()
        assets = elements.resolve_all(folder["id"] if folder else None)
        print("branding: " + ", ".join(f"{k}={os.path.basename(v) if v else 'none'}" for k, v in assets.items()))

        song_path = None
        if args.song:
            meta = drive.get_file(drive.parse_id(args.song))
            song_path = os.path.join(work, "song" + (os.path.splitext(meta["name"])[1] or ".mp3"))
            drive.download(meta["id"], song_path)
            print(f"song: {meta['name']}")

        started = time.time()
        total = render.render(
            shots, args.out, song_path=song_path, logo_path=assets.get("logo"),
            endcard_path=assets.get("endcard"), intro_path=assets.get("intro"),
            seconds_per_image=per, transition_seconds=xt,
            on_progress=lambda p: print(f"  rendering {p * 100:5.1f}%", end="\r"),
        )
        print(f"\nwrote {args.out} — {total:.1f}s in {time.time() - started:.0f}s")
        return 0
    finally:
        if args.keep_work:
            print(f"work dir kept at {work}")
        else:
            shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
