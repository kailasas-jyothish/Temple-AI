#!/usr/bin/env python
"""Credential and environment check, with no side effects on Drive.

    python scripts/selftest.py

Reads; never writes. Says plainly which half of the pipeline is ready, in the
same spirit as the notifier's scripts/selftest.mjs.
"""
from __future__ import annotations

import base64
import io
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import config as config_module  # noqa: E402
from app.config import config  # noqa: E402

FAILURES = 0


def ok(label: str, detail: str = "") -> None:
    print(f"  ok   {label:<32} {detail}")


def skip(label: str, detail: str = "") -> None:
    print(f"  --   {label:<32} {detail}")


def bad(label: str, detail: str = "") -> None:
    global FAILURES
    FAILURES += 1
    print(f"  FAIL {label:<32} {detail}")


def check_config() -> None:
    problems = config_module.problems()
    if problems:
        for line in problems:
            bad("configuration", line)
    else:
        ok("configuration", "no blocking problems")
    for line in config_module.warnings():
        skip("configuration warning", line)


def check_ffmpeg() -> None:
    for binary in (config.render.ffmpeg, config.render.ffprobe):
        try:
            out = subprocess.run([binary, "-version"], capture_output=True, text=True, check=True)
            ok(os.path.basename(binary), out.stdout.splitlines()[0][:70])
        except Exception as err:
            bad(os.path.basename(binary), f"not runnable ({err.__class__.__name__})")

    # Captions are drawn by drawtext, which is only compiled in when the build
    # has libfreetype. A build without it renders every reel perfectly and
    # silently drops the text, which is the kind of thing to learn here.
    try:
        out = subprocess.run([config.render.ffmpeg, "-hide_banner", "-filters"],
                             capture_output=True, text=True, check=True)
        if " drawtext " in out.stdout:
            ok("caption support", "drawtext present")
        else:
            bad("caption support", "this ffmpeg has no drawtext — captions will not render")
    except Exception as err:
        bad("caption support", f"could not list filters ({err.__class__.__name__})")


def check_drive() -> None:
    if not (config.google.refresh_token and config.drive.root_folder_id):
        skip("Google Drive", "skipped (no refresh token or root folder id)")
        return
    try:
        from app import drive, library
        root = drive.get_file(library.root_id())
        ok("Drive root folder", f"{root['name']} ({root['id']})")
    except Exception as err:
        bad("Drive root folder", f"{err.__class__.__name__}: {str(err)[:120]}")
        return

    # Reads cannot see this, so only an upload would have found it — which is
    # once a day, after a reel has already been rendered. Checking it here costs
    # nothing. See drive.service() for what 308 means to a resumable upload.
    try:
        codes = drive.service()._http.http.redirect_codes
        if 308 in codes:
            bad("resumable uploads", "httplib2 still treats 308 as a redirect; every upload over 8MB will fail")
        else:
            ok("resumable uploads", "308 excluded from redirect_codes")
    except AttributeError:
        skip("resumable uploads", "this httplib2 has no redirect_codes")

    try:
        songs = library.songs()
        folder = library.songs_folder()
        if folder:
            ok("Songs folder", f"{len(songs)} track(s)" + (f", newest: {songs[0]['name']}" if songs else ""))
        else:
            skip("Songs folder", f"no '{config.drive.songs_folder}' folder yet")
    except Exception as err:
        bad("Songs folder", str(err)[:120])

    try:
        from app import elements
        folder = library.elements_folder()
        if not folder:
            skip("Elements folder", f"no '{config.drive.elements_folder}' folder yet")
        else:
            found = []
            for kind in elements.KINDS:
                file_id = elements.configured_id(kind)
                match = elements._find_by_name(folder["id"], kind) if not file_id else {"name": file_id}
                if file_id or match:
                    found.append(f"{kind}={match['name'] if match else file_id}")
            ok("Elements folder", ", ".join(found) or "present but empty")
    except Exception as err:
        bad("Elements folder", str(err)[:120])

    try:
        events = drive.list_children(library.root_id(), folders_only=True)
        skipped = {config.drive.songs_folder.lower(), config.drive.elements_folder.lower()}
        events = [e for e in events if e["name"].lower() not in skipped]
        ok("Event folders", f"{len(events)} found"
                            + (f", newest: {events[-1]['name']}" if events else ""))
    except Exception as err:
        bad("Event folders", str(err)[:120])


def _probe_image() -> bytes:
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", (64, 64), (180, 90, 40)).save(buf, format="JPEG")
    return buf.getvalue()


def check_groq() -> None:
    if not config.groq.api_keys:
        skip("Groq vision", "skipped (GROQ_API_KEYS unset)")
        return
    try:
        import httpx
        uri = "data:image/jpeg;base64," + base64.b64encode(_probe_image()).decode()
        payload = {
            "model": config.groq.model,
            "max_tokens": 20,
            "messages": [{"role": "user", "content": [
                {"type": "text", "text": "Reply with the single word: ok"},
                {"type": "image_url", "image_url": {"url": uri}},
            ]}],
        }
        working = 0
        for index, key in enumerate(config.groq.api_keys, start=1):
            res = httpx.post(
                "https://api.groq.com/openai/v1/chat/completions",
                json=payload, timeout=60,
                headers={"Authorization": f"Bearer {key}"},
            )
            if res.status_code == 200:
                working += 1
            else:
                bad(f"Groq key {index}", f"HTTP {res.status_code}: {res.text[:120]}")
        if working:
            ok("Groq vision", f"{working}/{len(config.groq.api_keys)} key(s) answered, model {config.groq.model}")
    except Exception as err:
        bad("Groq vision", f"{err.__class__.__name__}: {str(err)[:120]}")


def check_gemini() -> None:
    if not config.gemini.api_keys:
        skip("Gemini vision", "skipped (GEMINI_API_KEYS unset — no fallback provider)")
        return
    try:
        import httpx
        payload = {
            "contents": [{"role": "user", "parts": [
                {"text": "Reply with the single word: ok"},
                {"inline_data": {"mime_type": "image/jpeg",
                                 "data": base64.b64encode(_probe_image()).decode()}},
            ]}],
            "generationConfig": {"temperature": 0},
        }
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{config.gemini.model}:generateContent"
        working = 0
        for index, key in enumerate(config.gemini.api_keys, start=1):
            res = httpx.post(url, json=payload, timeout=60, headers={"x-goog-api-key": key})
            if res.status_code == 200:
                working += 1
            else:
                bad(f"Gemini key {index}", f"HTTP {res.status_code}: {res.text[:120]}")
        if working:
            ok("Gemini vision", f"{working}/{len(config.gemini.api_keys)} key(s) answered, model {config.gemini.model}")
    except Exception as err:
        bad("Gemini vision", f"{err.__class__.__name__}: {str(err)[:120]}")


def check_slack() -> None:
    from app import slack
    if not slack.configured():
        skip("Slack", "skipped (no bot token or channel)")
        return
    try:
        body = slack.auth_test()
        ok("Slack", f"{body.get('user')} in {body.get('team')} -> {config.slack.channel}")
    except Exception as err:
        bad("Slack", str(err)[:140])


def main() -> int:
    print(f"temple-reels selftest  (data dir {config.data_dir})\n")
    check_config()
    check_ffmpeg()
    check_drive()
    check_groq()
    check_gemini()
    check_slack()
    print()
    if FAILURES:
        print(f"{FAILURES} check(s) failed.")
        return 1
    print("All checks passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
