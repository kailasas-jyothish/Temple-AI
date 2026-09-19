"""Slack delivery.

Same shape as the notifier's src/slack.js — Block Kit cards over a bot token,
with the one non-obvious rule that Slack answers HTTP 200 for failures, so
success is `body["ok"]` and not the status code.
"""
from __future__ import annotations

import logging
import os
import time

import httpx

from .config import config

log = logging.getLogger(__name__)

API = "https://slack.com/api"


def configured() -> bool:
    return bool(config.slack.bot_token and config.slack.channel)


def _call(method: str, payload: dict, *, attempts: int = 3) -> dict:
    token = config.slack.bot_token
    with httpx.Client(timeout=30) as client:
        for attempt in range(attempts):
            res = client.post(
                f"{API}/{method}",
                json=payload,
                headers={"Authorization": f"Bearer {token}",
                         "Content-Type": "application/json; charset=utf-8"},
            )
            body = res.json() if res.content else {}
            if body.get("ok"):
                return body
            # Only rate limits are worth retrying; a bad token or a channel the
            # bot was never invited into will not fix itself.
            if body.get("error") == "ratelimited" or res.status_code == 429:
                time.sleep(float(res.headers.get("retry-after") or 2))
                continue
            raise RuntimeError(f"slack {method} failed: {body.get('error') or res.status_code}")
    raise RuntimeError(f"slack {method} failed: rate limited after {attempts} attempts")


def _escape(text: str) -> str:
    return str(text).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _truncate(text: str, limit: int) -> str:
    text = str(text)
    return f"{text[:limit - 1]}…" if len(text) > limit else text


def post_success(job: dict) -> None:
    if not configured():
        log.info("slack not configured; skipping the completion notice")
        return

    event = job.get("event_name") or "Event"
    stats = job.get("stats", {})
    used = stats.get("used", 0)
    considered = stats.get("considered", 0)
    temples = stats.get("temples", 0)
    duration = stats.get("duration_seconds", 0)
    render_seconds = stats.get("render_seconds", 0)
    mode = {"llm": "LLM", "mixed": "LLM (some batches fell back)", "heuristic": "heuristics only"}.get(
        stats.get("curation_mode", ""), stats.get("curation_mode", "")
    )
    url = job.get("reel_url") or ""

    facts = [
        f"*{used}* of {considered} photos",
        f"{temples} temple{'s' if temples != 1 else ''}",
        f"{duration:.0f}s reel",
        f"rendered in {render_seconds:.0f}s",
    ]

    blocks = [
        {
            "type": "section",
            "text": {"type": "mrkdwn",
                     "text": f"*🎬 Reel ready — {_escape(_truncate(event, 150))}*\n<{url}|Open in Drive>"},
        },
        {"type": "section", "text": {"type": "mrkdwn", "text": "  •  ".join(facts)}},
        {"type": "context", "elements": [
            {"type": "mrkdwn", "text": f"selection: {mode}  •  song: {_escape(job.get('song_name') or '—')}"}
        ]},
    ]
    _call("chat.postMessage", {
        "channel": config.slack.channel,
        "text": f"Reel ready — {event}: {url}",
        "unfurl_links": False,
        "blocks": blocks,
    })

    poster = job.get("poster_path")
    if config.slack.upload_poster and poster and os.path.exists(poster):
        try:
            upload_file(poster, title=f"{event} — first frame")
        except Exception as err:
            # A thumbnail is a nicety; the card that matters has already landed.
            log.warning("poster upload failed: %s", err)


def post_failure(job: dict) -> None:
    if not configured():
        return
    event = job.get("event_name") or "Event"
    stage = job.get("stage", "unknown")
    detail = _truncate(job.get("error", "") or "no detail", 900)
    blocks = [
        {"type": "section",
         "text": {"type": "mrkdwn",
                  "text": f"*⚠️ Reel failed — {_escape(_truncate(event, 150))}*\nStage: `{_escape(stage)}`"}},
        {"type": "section", "text": {"type": "mrkdwn", "text": f"```{_escape(detail)}```"}},
    ]
    if config.public_url:
        blocks.append({"type": "context", "elements": [
            {"type": "mrkdwn", "text": f"<{config.public_url}|Open the reel builder>"}
        ]})
    _call("chat.postMessage", {
        "channel": config.slack.channel,
        "text": f"Reel failed — {event} ({stage})",
        "blocks": blocks,
    })


def upload_file(path: str, *, title: str = "") -> None:
    """Slack's two-step external upload; files.upload itself is retired."""
    size = os.path.getsize(path)
    name = os.path.basename(path)
    token = config.slack.bot_token
    with httpx.Client(timeout=60) as client:
        res = client.get(
            f"{API}/files.getUploadURLExternal",
            params={"filename": name, "length": str(size)},
            headers={"Authorization": f"Bearer {token}"},
        )
        body = res.json()
        if not body.get("ok"):
            raise RuntimeError(f"slack files.getUploadURLExternal failed: {body.get('error')}")
        with open(path, "rb") as handle:
            put = client.post(body["upload_url"], files={"file": (name, handle)})
        put.raise_for_status()
    _call("files.completeUploadExternal", {
        "files": [{"id": body["file_id"], "title": title or name}],
        "channel_id": config.slack.channel,
    })


def auth_test() -> dict:
    return _call("auth.test", {})
