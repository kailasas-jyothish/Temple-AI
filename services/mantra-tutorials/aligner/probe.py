"""Diagnostic: what does a CTC model hear in a slice of the chant?

python probe.py <model> <audio> <ffmpeg> <start_s> <dur_s>

Prints the model's vocabulary and a greedy (unconstrained) decode of the slice.
If the decode is gibberish, forced alignment with that model will be too — so
run this before trusting a new model on a new recording.
"""
import subprocess
import sys

import torch
from ctc_forced_aligner import load_alignment_model

model_id, audio, ffmpeg, start, dur = sys.argv[1:6]
model, tok = load_alignment_model("cpu", model_id, dtype=torch.float32)
vocab = tok.get_vocab()
print("vocab", len(vocab), "".join(sorted(k for k in vocab if len(k) == 1)))
raw = subprocess.run([ffmpeg, "-nostdin", "-v", "error", "-ss", start, "-t", dur, "-i", audio,
                      "-f", "s16le", "-ac", "1", "-ar", "16000", "-"], capture_output=True, check=True).stdout
wave = torch.frombuffer(bytearray(raw), dtype=torch.int16).float() / 32768.0
wave = (wave - wave.mean()) / (wave.std() + 1e-7)
with torch.inference_mode():
    ids = model(wave.unsqueeze(0)).logits.argmax(-1)[0].tolist()
inv = {v: k for k, v in vocab.items()}
out, prev = [], None
for i in ids:
    if i != prev and i != tok.pad_token_id:
        out.append(inv[i])
    prev = i
print("decode:", "".join(out).replace("|", " "))
