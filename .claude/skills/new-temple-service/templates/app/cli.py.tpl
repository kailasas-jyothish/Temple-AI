"""Command line front end. Same core.run() the web UI calls."""

from __future__ import annotations

import argparse
import json
import sys

from . import config, core


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="{{id}}", description="{{description}}")
    sub = parser.add_subparsers(dest="command", required=True)

    run = sub.add_parser("run", help="run the job once and print the result")
    run.add_argument("--text", required=True)

    sub.add_parser("info", help="show configuration problems")
    sub.add_parser("serve", help="start the web UI on this machine")

    args = parser.parse_args(argv)

    if args.command == "run":
        result = core.run(args.text, progress=lambda m: print(f"  {m}", file=sys.stderr))
        print(json.dumps(result, indent=2, ensure_ascii=False))
        return 0
    if args.command == "info":
        problems = config.problems()
        print("\n".join(problems) if problems else "no problems")
        return 1 if problems else 0
    if args.command == "serve":
        import uvicorn

        uvicorn.run("app.main:app", host="127.0.0.1", port=config.PORT, workers=1)
        return 0
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
