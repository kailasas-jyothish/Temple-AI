"""Spot-check a timings.json against the audio, independently of the aligner.

python verify.py <timings.json> <audio> <ffmpeg> <model> [n]

For n words spread evenly through the chant, cuts out exactly the audio the
timeline gives that word and greedy-decodes it with no text supplied. If the
timing is right, the decode reads as the word. Prints expected vs heard.
"""
import json
import subprocess
import sys

import torch
from ctc_forced_aligner import load_alignment_model

tpath, audio, ffmpeg, model_id = sys.argv[1:5]
n = int(sys.argv[5]) if len(sys.argv) > 5 else 16
words = json.load(open(tpath, encoding="utf-8"))["words"]
model, tok = load_alignment_model("cpu", model_id, dtype=torch.float32)
inv = {v: k for k, v in tok.get_vocab().items()}

raw = subprocess.run([ffmpeg, "-nostdin", "-v", "error", "-i", audio, "-f", "s16le", "-ac", "1", "-ar", "16000", "-"],
                     capture_output=True, check=True).stdout
wave = torch.frombuffer(bytearray(raw), dtype=torch.int16).float() / 32768.0


def decode(a, b):
    seg = wave[int(a * 16000):int(b * 16000)]
    seg = (seg - seg.mean()) / (seg.std() + 1e-7)
    with torch.inference_mode():
        logits = model(seg.unsqueeze(0)).logits[0]
    blank = int(torch.mode(logits.argmax(-1)).values)
    out, prev = [], None
    for i in logits.argmax(-1).tolist():
        if i != prev and i != blank:
            out.append(inv[i])
        prev = i
    return "".join(out).replace("|", " ").strip()


shift = float(sys.argv[6]) if len(sys.argv) > 6 else 0.0  # try e.g. -0.1 to test an onset offset
step = max(1, len(words) // n)
for w in words[::step][:n]:
    a, b = w["start"] + shift, w["end"] + shift
    print(f"{a:7.2f}-{b:6.2f}  {w['text']:<22} heard: {decode(a, b + 0.05)}")
