"""The work itself. Pure Python: no HTTP, no argparse. The CLI, the web UI and
the API all call run(), so there is exactly one implementation to keep right."""

from __future__ import annotations

from typing import Callable

Progress = Callable[[str], None]


def run(text: str, progress: Progress | None = None) -> dict:
    """Placeholder: replace with the service's real job."""
    say = progress or (lambda _msg: None)
    say("started")
    result = {"echo": text.strip(), "length": len(text.strip())}
    say("done")
    return result
