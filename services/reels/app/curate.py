"""The LLM's only job: decide which images are worth using.

It scores and rejects. It never chooses a transition, a duration, an effect or
an order of effects — that is ffmpeg's job, and keeping the boundary sharp is a
requirement of this project, not an implementation detail.

Two providers, tried in order, then heuristics. A batch that fails everywhere
keeps its prefilter score and the run continues: a weaker reel is a bad day, no
reel at all is a failed daily job.
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

# Small enough to keep a batch far under either provider's request cap, large
# enough that focus and framing are still judgeable.
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

    Keys are consumed round-robin rather than always starting at the first, so a
    long run spreads its requests instead of exhausting key one and only then
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


def _jpeg_bytes(path: str) -> bytes:
    with Image.open(path) as im:
        im = ImageOps.exif_transpose(im).convert("RGB")
        im.thumbnail((SEND_PX, SEND_PX), Image.Resampling.LANCZOS)
        buf = io.BytesIO()
        im.save(buf, format="JPEG", quality=82, optimize=True)
    return buf.getvalue()


def _parse(content: str, size: int) -> list[dict]:
    """Models fence their JSON, prepend "Here is", or wrap the array in an
    object. Recover from all three rather than losing the batch."""
    text = (content or "").strip()
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


# ---------------------------------------------------------------- providers


class Provider:
    name = "provider"
    batch_size = 4

    def __bool__(self) -> bool:
        raise NotImplementedError

    def score(self, client: httpx.Client, batch: list[dict]) -> list[dict]:
        raise NotImplementedError

    def _retry(self, send, keys: KeyRotation):
        """One batch, retried across keys. Rate limits rotate; other 4xx do not."""
        attempts = max(3, len(keys) * 2)
        last = ""
        for attempt in range(attempts):
            key = keys.next()
            try:
                res = send(key)
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
        raise RuntimeError(f"{self.name} failed after {attempts} attempts — {last}")


class GroqProvider(Provider):
    name = "groq"
    ENDPOINT = "https://api.groq.com/openai/v1/chat/completions"

    def __init__(self):
        self.keys = KeyRotation(config.groq.api_keys)
        self.model = config.groq.model
        self.batch_size = config.groq.batch_size
        self.timeout = config.groq.timeout_seconds

    def __bool__(self) -> bool:
        return bool(self.keys)

    def score(self, client: httpx.Client, batch: list[dict]) -> list[dict]:
        content: list[dict] = [{"type": "text", "text": RUBRIC}]
        for index, item in enumerate(batch):
            content.append({"type": "text", "text": f"Image index {index}:"})
            uri = "data:image/jpeg;base64," + base64.b64encode(_jpeg_bytes(item["path"])).decode("ascii")
            content.append({"type": "image_url", "image_url": {"url": uri}})
        payload = {
            "model": self.model,
            "temperature": 0,
            "max_tokens": 900,
            "messages": [
                {"role": "system", "content": SYSTEM},
                {"role": "user", "content": content},
            ],
        }
        body = self._retry(
            lambda key: client.post(
                self.ENDPOINT, json=payload, timeout=self.timeout,
                headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
            ),
            self.keys,
        )
        return _parse(body["choices"][0]["message"]["content"], len(batch))


class GeminiProvider(Provider):
    name = "gemini"
    BASE = "https://generativelanguage.googleapis.com/v1beta/models"

    def __init__(self):
        self.keys = KeyRotation(config.gemini.api_keys)
        self.model = config.gemini.model
        self.batch_size = config.gemini.batch_size
        self.timeout = config.gemini.timeout_seconds

    def __bool__(self) -> bool:
        return bool(self.keys)

    def score(self, client: httpx.Client, batch: list[dict]) -> list[dict]:
        parts: list[dict] = [{"text": f"{SYSTEM}\n\n{RUBRIC}"}]
        for index, item in enumerate(batch):
            parts.append({"text": f"Image index {index}:"})
            parts.append({"inline_data": {
                "mime_type": "image/jpeg",
                "data": base64.b64encode(_jpeg_bytes(item["path"])).decode("ascii"),
            }})
        payload = {
            "contents": [{"role": "user", "parts": parts}],
            # Asking for JSON directly removes the fence-stripping guesswork.
            "generationConfig": {"temperature": 0, "responseMimeType": "application/json"},
        }
        body = self._retry(
            lambda key: client.post(
                f"{self.BASE}/{self.model}:generateContent", json=payload, timeout=self.timeout,
                headers={"x-goog-api-key": key, "Content-Type": "application/json"},
            ),
            self.keys,
        )
        candidates = body.get("candidates") or []
        if not candidates:
            raise RuntimeError(f"gemini returned no candidates: {str(body)[:200]}")
        text = "".join(p.get("text", "") for p in candidates[0].get("content", {}).get("parts", []))
        return _parse(text, len(batch))


PROVIDERS = {"groq": GroqProvider, "gemini": GeminiProvider}


def _chain() -> list[Provider]:
    """Configured provider first, then the fallback, skipping any without keys."""
    order = [config.curation_provider, config.curation_fallback]
    chain: list[Provider] = []
    for name in order:
        factory = PROVIDERS.get(name)
        if not factory or any(p.name == name for p in chain):
            continue
        provider = factory()
        if provider:
            chain.append(provider)
    return chain


# ------------------------------------------------------------------ curate


def curate(candidates: list[dict], *, on_progress=None) -> str:
    """Annotate candidates with score/subject/usable/why.

    Returns the mode actually used, e.g. "groq", "groq+gemini" when the fallback
    covered some batches, or "heuristic".
    """
    for item in candidates:
        item.setdefault("usable", True)
        item.setdefault("subject", "")
        item.setdefault("why", "")
        item["score"] = item["heuristic_score"]
        item["scored_by"] = "heuristic"

    chain = _chain() if config.groq.enabled else []
    if not chain:
        log.info("curation: heuristic only (no provider keys, or curation disabled)")
        return "heuristic"

    primary = chain[0]
    batches = [candidates[i: i + primary.batch_size]
               for i in range(0, len(candidates), primary.batch_size)]
    used: set[str] = set()
    failed = 0

    with httpx.Client() as client:
        for number, batch in enumerate(batches, start=1):
            rows = None
            for provider in chain:
                try:
                    rows = provider.score(client, batch)
                    if not rows:
                        raise ValueError("no usable rows in the response")
                    used.add(provider.name)
                    break
                except Exception as err:
                    log.warning("curation batch %d/%d: %s failed — %s",
                                number, len(batches), provider.name, err)
                    rows = None

            if rows is None:
                # This batch keeps its heuristic scores; the run continues.
                failed += 1
            else:
                for row in rows:
                    item = batch[row["i"]]
                    try:
                        item["score"] = max(0.0, min(10.0, float(row.get("score", item["score"]))))
                    except (TypeError, ValueError):
                        pass
                    item["usable"] = bool(row.get("usable", True))
                    item["subject"] = str(row.get("subject", ""))[:24]
                    item["why"] = str(row.get("why", ""))[:120]
                    item["scored_by"] = row.get("_by", "llm")

            if on_progress:
                on_progress(number, len(batches))

    if not used:
        return "heuristic"
    mode = "+".join(p.name for p in chain if p.name in used)
    return f"{mode} (+heuristics on {failed} batch{'es' if failed != 1 else ''})" if failed else mode
