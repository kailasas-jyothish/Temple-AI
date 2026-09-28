"""Forced alignment of known Devanagari text to a chant recording.

Called by src/align.js as a subprocess:  python align.py <request.json> <result.json>

request.json  {"audio": path, "ffmpeg": path, "model": hf id or local path,
               "words": ["ॐ", "यद्गुह्यं", ...], "breaks": [indices of line-initial words]}
result.json   {"model": ..., "frames_ms": 20.0, "duration": s,
               "words": [{"start": s, "end": s, "score": logprob, "chars": n}, ...]}

The alignment itself is ctc-forced-aligner (BSD-2); the acoustic model is a
Devanagari-vocabulary wav2vec2 CTC model. The default is Vakyansh's Sanskrit
model (Open-Speech-EkStep, MIT; 60h of Sanskrit). The library's own default
(MMS) is CC-BY-NC and is deliberately not used. Text is never romanised: the
model's vocabulary is Devanagari, so the exact written words are aligned, not an
ASR guess of them.
"""
import json
import subprocess
import sys
import unicodedata

import numpy as np
import torch
from ctc_forced_aligner import generate_emissions, get_alignments, get_spans, load_alignment_model
from transformers import AutoFeatureExtractor

SR = 16000


def load_audio(path, ffmpeg):
    cmd = [ffmpeg, "-nostdin", "-v", "error", "-i", path, "-f", "s16le", "-ac", "1",
           "-acodec", "pcm_s16le", "-ar", str(SR), "-"]
    out = subprocess.run(cmd, capture_output=True, check=True).stdout
    return torch.frombuffer(bytearray(out), dtype=torch.int16).float() / 32768.0


def tokens_for(word, vocab):
    # The library asserts on any character outside the model vocabulary, so each
    # word is reduced to the characters the model can actually emit. A word with
    # none left (e.g. a lone avagraha) borrows the inherent vowel so it still
    # occupies a slot and the word indices stay aligned with the caller's.
    # ॐ is one codepoint but is chanted "om"; ASR vocabularies spell it out.
    word = unicodedata.normalize("NFC", word).replace("ॐ", "ओम्")
    chars = [c for c in word if c in vocab and c != "|"]
    if not chars:
        chars = ["अ"] if "अ" in vocab else [next(iter(vocab))]
    return chars


def main():
    req = json.load(open(sys.argv[1], encoding="utf-8"))
    model, tokenizer = load_alignment_model("cpu", req["model"], dtype=torch.float32)
    vocab = {k.lower() for k in tokenizer.get_vocab()} - {"<pad>", "<s>", "</s>", "<unk>", "[pad]", "[unk]"}

    wave = load_audio(req["audio"], req.get("ffmpeg") or "ffmpeg")
    # The library feeds raw samples; models trained with do_normalize expect
    # zero-mean unit-variance input and hear noticeably worse without it.
    if getattr(AutoFeatureExtractor.from_pretrained(req["model"]), "do_normalize", False):
        wave = (wave - wave.mean()) / (wave.std() + 1e-7)
    emissions, stride = generate_emissions(model, wave, window_length=30, context_length=2, batch_size=2)

    # The library takes the CTC blank to be the pad token. Models converted from
    # fairseq (Vakyansh among them) use <s> at index 0 instead, and aligning
    # against the wrong blank silently produces garbage. The blank is by far the
    # most frequent frame-level argmax, so read it off the emissions.
    blank_id = int(torch.mode(emissions[:, :-1].argmax(-1)).values)
    if blank_id != tokenizer.pad_token_id:
        tokenizer.pad_token = tokenizer.convert_ids_to_tokens(blank_id)
    vocab.discard(tokenizer.pad_token.lower())

    words = req["words"]
    toks = [" ".join(tokens_for(w, vocab)) for w in words]
    # <star> matches anything at no cost. Placed at line breaks (the caller's
    # `breaks`: indices of words that begin a line) it absorbs the pauses,
    # instrumental passages and breaths between lines. It is deliberately NOT
    # put between every word: then it swallows the chanting itself and each
    # word collapses to a few frames.
    breaks = set(req.get("breaks") or [])
    starred, index = ["<star>"], []
    for i, t in enumerate(toks):
        if i in breaks and i > 0:
            starred.append("<star>")
        index.append(len(starred))
        starred.append(t)
    starred.append("<star>")

    segments, scores, blank = get_alignments(emissions, starred, tokenizer)
    spans = get_spans(starred, segments, blank)
    scores = np.asarray(scores).reshape(-1)

    out = []
    for i in range(len(words)):
        span = spans[index[i]]
        # Speech-only bounds: trim the blank padding get_spans adds either side,
        # so a word's end is when its last character stops, not mid-silence.
        core = [s for s in span if s.label != blank] or span
        a, b = core[0].start, core[-1].end + 1
        out.append({
            "start": round(a * stride / 1000, 3),
            "end": round(b * stride / 1000, 3),
            "score": round(float(scores[a:b].mean()), 3) if b > a else None,
            "chars": len(toks[i].split(" ")),
        })
    json.dump({"model": req["model"], "frames_ms": stride, "duration": round(len(wave) / SR, 3), "words": out},
              open(sys.argv[2], "w", encoding="utf-8"), ensure_ascii=False)


if __name__ == "__main__":
    main()
