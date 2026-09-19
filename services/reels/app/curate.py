"""The LLM's only job: decide which images are worth using.

It scores and rejects. It never chooses a transition, a duration, an effect or
an order of effects — that is ffmpeg's job, and keeping the boundary sharp is a
requirement of this project, not an implementation detail.
"""
from __future__ import annotations

import base64
import io
import itertools
import json
import logging
import re
import threading
import time

import httpx
from PIL import Image, ImageOps

from .config import config

log = logging.getLogger(__name__)

ENDPOINT = "https://api.groq.com/openai/v1/chat/completions"

# Small enough to keep a batch far under the 20MB request cap, large enough that
# focus and framing are still judgeable.
SEND_PX = 512

SYSTEM = (
    "You are a photo editor selecting stills for a short vertical highlight reel "
    "of a Hindu temple ritual. You judge images only. You never describe video "
    "effects, transitions or edits.\n"
    "Reply with JSON only — no prose, no code fences."
)

RUBRIC = """Score each image 0-10 for how well it would work as a full-screen shot in the reel.

Reward: a sharp, well-framed subject; the deity, priest, offering or ritual action clearly legible; good light; genuine moments; faces that are open and not cut off by the frame edge.
Penalise: soft focus or motion blur; heavy clutter with no clear subject; backs of heads filling the frame; blown highlights or crushed shadows; screenshots, posters, flyers, banners of text, or photos of a screen; accidental floor/ceiling shots.
A vertical or square image suits this reel better than a very wide one, but do not reject a strong wide image for that alone.

Mark usable=false only for images that should never appear: unusable technically, or not a photograph of the event.

Return a JSON array with one object per image, in the order given:
[{"i": <index>, "score": <0-10 number>, "subject": "deity|priest|crowd|offering|decor|other", "usable": true|false, "why": "<at most 12 words>"}]"""


class KeyRotation:
    """Several keys share the load; a rate-limited one steps aside for the next.

    Keys are consumed round-robin rather than always starting at the first, so
    a long run spreads its requests instead of exhausting key one and then
    discovering key two.
    """

    def __init__(self, keys: list[str]):
        self._keys = list(keys)
        self._lock = threading.Lock()
        self._cycle = itertools.cycle(range(len(keys))) if keys else None

    def __bool__(self) -> bool:
        return bool(self._keys)

    def __len__(self) -> int:
        return len(self._keys)

    def next(self) -> str:
        with self._lock:
            return self._keys[next(self._cycle)]


def _data_uri(path: str) -> str:
    with Image.open(path) as im:
        im = ImageOps.exif_transpose(im).convert("RGB")
        im.thumbnail((SEND_PX, SEND_PX), Image.Resampling.LANCZOS)
        buf = io.BytesIO()
        im.save(buf, format="JPEG", quality=82, optimize=True)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


def _parse(content: str, size: int) -> list[dict]:
    """Models fence their JSON, prepend "Here is", or return an object wrapping
    the array. Recover from all three rather than losing the batch."""
    text = content.strip()
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.IGNORECASE).strip()
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\[.*\]", text, re.DOTALL)
        if not match:
            raise
        data = json.loads(match.group(0))
    if isinstance(data, dict):
        for key in ("images", "results", "scores", "data"):
            if isinstance(data.get(key), list):
                data = data[key]
                break
    if not isinstance(data, list):
        raise ValueError("expected a JSON array")
    out: list[dict] = []
    for position, row in enumerate(data):
        if not isinstance(row, dict):
            continue
        index = row.get("i", position)
        try:
            index = int(index)
        except (TypeError, ValueError):
            index = position
        if 0 <= index < size:
            out.append({**row, "i": index})
    return out


def _request(client: httpx.Client, keys: KeyRotation, payload: dict) -> dict:
    """One batch, retried across keys. Rate limits rotate; other 4xx do not."""
    attempts = max(3, len(keys) * 2)
    last = ""
    for attempt in range(attempts):
        key = keys.next()
        try:
            res = client.post(
                ENDPOINT,
                json=payload,
                headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
            )
        except httpx.HTTPError as err:
            last = f"{err.__class__.__name__}: {err}"
            time.sleep(min(2 ** attempt, 20))
            continue
        if res.status_code == 200:
            return res.json()
        last = f"HTTP {res.status_code}: {res.text[:200]}"
        if res.status_code == 429 or res.status_code >= 500:
            wait = float(res.headers.get("retry-after") or 0)
            # A rotation is usually enough; only sleep once every key has been tried.
            time.sleep(wait if wait else (min(2 ** attempt, 20) if attempt >= len(keys) else 0))
            continue
        break
    raise RuntimeError(f"Groq request failed after {attempts} attempts — {last}")


def curate(candidates: list[dict], *, on_progress=None) -> str:
    """Annotate candidates with llm_score/subject/usable/why.

    Returns the mode actually used: "llm", "mixed" (some batches fell back) or
    "heuristic" (no key, or disabled). A Groq outage degrades the selection but
    must never mean no reel at all — a heuristic pick is a worse reel, no reel
    is a failed daily job.
    """
    cfg = config.groq
    for item in candidates:
        item.setdefault("usable", True)
        item.setdefault("subject", "")
        item.setdefault("why", "")
        item["score"] = item["heuristic_score"]
        item["scored_by"] = "heuristic"

    if not cfg.enabled or not cfg.api_keys:
        log.info("curation: heuristic only (%s)", "disabled" if not cfg.enabled else "no GROQ_API_KEYS")
        return "heuristic"

    keys = KeyRotation(cfg.api_keys)
    batches = [candidates[i: i + cfg.batch_size] for i in range(0, len(candidates), cfg.batch_size)]
    failures = 0

    with httpx.Client(timeout=cfg.timeout_seconds) as client:
        for number, batch in enumerate(batches, start=1):
            content: list[dict] = [{"type": "text", "text": RUBRIC}]
            for index, item in enumerate(batch):
                content.append({"type": "text", "text": f"Image index {index}:"})
                content.append({"type": "image_url", "image_url": {"url": _data_uri(item["path"])}})
            payload = {
                "model": cfg.model,
                "temperature": 0,
                "max_tokens": 900,
                "messages": [
                    {"role": "system", "content": SYSTEM},
                    {"role": "user", "content": content},
                ],
            }
            try:
                body = _request(client, keys, payload)
                rows = _parse(body["choices"][0]["message"]["content"], len(batch))
                if not rows:
                    raise ValueError("no usable rows in response")
                for row in rows:
                    item = batch[row["i"]]
                    try:
                        item["score"] = max(0.0, min(10.0, float(row.get("score", item["score"]))))
                    except (TypeError, ValueError):
                        pass
                    item["usable"] = bool(row.get("usable", True))
                    item["subject"] = str(row.get("subject", ""))[:24]
                    item["why"] = str(row.get("why", ""))[:120]
                    item["scored_by"] = "llm"
            except Exception as err:
                # This batch keeps its heuristic scores; the run continues.
                failures += 1
                log.warning("curation batch %d/%d fell back to heuristics: %s", number, len(batches), err)

            if on_progress:
                on_progress(number, len(batches))

    if failures == len(batches):
        return "heuristic"
    return "mixed" if failures else "llm"
