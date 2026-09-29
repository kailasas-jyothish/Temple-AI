"""Check an alignment against the chant's metre, independently of any model.

python meter.py <forced-request.json> <forced-result.json> [-v]

In metrical chant a word's span (onset to next onset) tracks its syllable weight:
laghu 1 matra, guru 2. Within each line the observed rate is fitted and every
word's span compared with its weight; a word outside 0.5x-2x is an outlier.
This needs no ground truth and no acoustic model, so it can judge aligners
against each other. On durga-kavacham (2026-09-28):

  ctc-forced-aligner + Vakyansh     0.9% outliers, median |log r| 0.065
  same, +/-250ms random jitter      8.9%,          0.168
  words spaced evenly per line     12.7%,          0.269
  IndicMFA Sanskrit (MFA 3.4)      31.2%,          0.420  (33.7% speaker-adapted)

A line's last word is skipped: its span includes the pause before the next line.
Deliberately drawn-out words (ॐ, a stotra's opening word) show up as outliers
and are expected to.
"""
import json
import math
import statistics
import sys

CONS = set(chr(c) for c in range(0x0915, 0x093A)) | set("क़ख़ग़ज़ड़ढ़फ़य़ळ")
NUKTA, VIRAMA = "़", "्"
LONG_SIGNS, SHORT_SIGNS = set("ाीूॄेैोौ"), set("िुृॢ")
LONG_IND, SHORT_IND = set("आईऊॠएऐओऔ"), set("अइउऋऌ")
MARKS = set("ंःँ")


def matras(word):
    """Syllable weight of a Devanagari word. A syllable is heavy (2) if its vowel
    is long, it carries anusvara/visarga, or a conjunct or final halant follows."""
    word = word.replace("ॐ", "ओम्")
    weights, i, n = [], 0, len(word)
    while i < n:
        c = word[i]
        if c in LONG_IND or c in SHORT_IND:
            weights.append(2 if c in LONG_IND else 1)
            i += 1
        elif c in CONS:
            j, k = i, 0
            while j < n and word[j] in CONS:
                k += 1
                j += 1
                if j < n and word[j] == NUKTA:
                    j += 1
                if j < n and word[j] == VIRAMA and j + 1 < n and word[j + 1] in CONS:
                    j += 1
                else:
                    break
            if j < n and word[j] == VIRAMA:
                if weights:
                    weights[-1] = 2
                i = j + 1
                continue
            w = 1
            if j < n and word[j] in LONG_SIGNS:
                w, j = 2, j + 1
            elif j < n and word[j] in SHORT_SIGNS:
                j += 1
            if weights and k > 1:
                weights[-1] = 2
            weights.append(w)
            i = j
        elif c in MARKS:
            if weights:
                weights[-1] = 2
            i += 1
        else:
            i += 1
    return sum(weights) or 1


def check(words, starts, breaks):
    edges = sorted(set(breaks) | {0, len(words)})
    ratios, outliers = [], []
    for a, b in zip(edges, edges[1:]):
        if b - a < 3:
            continue
        spans = [starts[i + 1] - starts[i] for i in range(a, b - 1)]
        weights = [matras(words[i]) for i in range(a, b - 1)]
        if sum(spans) <= 0:
            continue
        rate = sum(spans) / sum(weights)
        for k, (s, w) in enumerate(zip(spans, weights)):
            r = s / (w * rate)
            ratios.append(r)
            if not 0.5 <= r <= 2:
                outliers.append((a + k, words[a + k], round(s, 2), w, round(r, 2)))
    med = statistics.median(abs(math.log(r)) if r > 0 else 9.0 for r in ratios) if ratios else float("nan")
    return ratios, outliers, med


def main():
    req = json.load(open(sys.argv[1], encoding="utf-8"))
    res = json.load(open(sys.argv[2], encoding="utf-8"))
    ratios, outliers, med = check(req["words"], [w["start"] for w in res["words"]], req.get("breaks") or [])
    print(f"{len(ratios)} words checked, {len(outliers)} outliers "
          f"({100 * len(outliers) / max(1, len(ratios)):.1f}%), median |log r| {med:.3f}")
    if "-v" in sys.argv:
        for o in outliers:
            print("  #%d %s span=%ss matras=%d ratio=%s" % o)


if __name__ == "__main__":
    main()
