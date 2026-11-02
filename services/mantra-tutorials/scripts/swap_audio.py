"""Swap each rendered video's audio for its audio-fx.mp3 (video stream copied,
no re-render). Reads data/<id>/<id>.mp4, writes data/final/<id>.mp4."""
import subprocess, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "final"
OUT.mkdir(parents=True, exist_ok=True)


def dur(p, sel):
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", sel, "-show_entries",
                        "stream=duration", "-of", "csv=p=0", str(p)], capture_output=True, text=True)
    return float(r.stdout.split()[0])


for b in sorted((ROOT / "mantras").iterdir()):
    fx, vid = b / "audio-fx.mp3", ROOT / "data" / b.name / f"{b.name}.mp4"
    if not fx.exists():
        continue
    if not vid.exists():
        print(f"SKIP {b.name}: no rendered video (parts only)")
        continue
    dest = OUT / f"{b.name}.mp4"
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(vid), "-i", str(fx), "-map", "0:v:0",
                    "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "256k",
                    "-movflags", "+faststart", "-shortest", str(dest)], check=True)
    dv, da = dur(dest, "v:0"), dur(dest, "a:0")
    flag = "" if abs(dv - da) < 0.6 else "  <-- LENGTH MISMATCH"
    print(f"{b.name}: video {dv:.1f}s audio {da:.1f}s{flag}", flush=True)
