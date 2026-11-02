# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Create a new Temple AI service and wire it into the repo.

    uv run .claude/skills/new-temple-service/scaffold.py <id> "<one-line description>" [--state] [--title "Nice Name"]

Creates services/<id>/ from templates/ (uv-managed FastAPI + CLI + UI), runs
`uv lock`, then patches the five shared places a service must appear:
scripts/dokploy.mjs, services/dashboard/src/services.js, the dashboard's
.env.example, docker-compose.yml and README.md. Every patch is anchored; if an
anchor has moved the script stops and says which one, rather than guessing.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]


def read(path: Path) -> str:
    # newline="" keeps the file's own line endings; the repo mixes them.
    with open(path, encoding="utf-8", newline="") as f:
        return f.read()


def write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(text)


def render(text: str, values: dict[str, str]) -> str:
    for key, value in values.items():
        text = text.replace("{{" + key + "}}", value)
    return text


def insert_before(text: str, anchor: str, block: str, what: str) -> str:
    """Insert block before the last match of the regex `anchor`, in the file's own line endings."""
    matches = list(re.finditer(anchor, text, re.M))
    if not matches:
        sys.exit(f"cannot patch {what}: anchor not found: {anchor!r}. The file changed shape; edit it by hand.")
    nl = "\r\n" if "\r\n" in text else "\n"
    index = matches[-1].start()
    return text[:index] + block.replace("\r\n", "\n").replace("\n", nl) + text[index:]


def next_port() -> int:
    ports = [int(p) for p in re.findall(r"publishedPort:\s*(\d+)", read(ROOT / "scripts" / "dokploy.mjs"))]
    return max(ports, default=8481) + 1


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("id", help="kebab-case service id, e.g. seva-planner")
    ap.add_argument("description", help="one sentence: what it does for the temple")
    ap.add_argument("--title", help="display name (default: id, title-cased)")
    ap.add_argument("--state", action="store_true", help="service keeps files: gets a /data volume")
    ap.add_argument("--port", type=int, help="published host port (default: next free after the highest in dokploy.mjs)")
    a = ap.parse_args()

    if not re.fullmatch(r"[a-z][a-z0-9]*(-[a-z0-9]+)*", a.id):
        sys.exit("id must be lowercase kebab-case, e.g. seva-planner")
    service_dir = ROOT / "services" / a.id
    if service_dir.exists():
        sys.exit(f"{service_dir} already exists")
    dokploy = read(ROOT / "scripts" / "dokploy.mjs")
    if re.search(rf"^\s*['\"]?{re.escape(a.id)}['\"]?\s*:\s*\{{", dokploy, re.M):
        sys.exit(f"{a.id} is already registered in scripts/dokploy.mjs")

    port = a.port or next_port()
    title = a.title or a.id.replace("-", " ").title()
    appname = f"Temple-{a.id}"
    values = {
        "id": a.id,
        "title": title,
        "description": a.description.replace('"', "'"),
        "port": str(port),
        "appname": appname,
        "ID_UPPER": a.id.upper().replace("-", "_"),
    }

    # Nothing is written until every anchor below has matched, so a failure
    # leaves the repo untouched.
    patched: list[tuple[Path, str]] = []

    # 1. the service itself
    files: list[tuple[Path, str]] = []
    for tpl in sorted((HERE / "templates").rglob("*.tpl")):
        rel = tpl.relative_to(HERE / "templates").as_posix().removesuffix(".tpl")
        name = {"cmd": f"{a.id}.cmd", "env.example": ".env.example", "dockerignore": ".dockerignore"}.get(rel, rel)
        files.append((service_dir / name, render(read(tpl), values)))
    files.append((service_dir / ".python-version", "3.12\n"))

    # 2. dokploy.mjs registry
    entry = (
        f"  // {'Keeps files under /data.' if a.state else 'Stateless.'}\n"
        f"  '{a.id}': {{\n"
        f"    dir: 'services/{a.id}',\n"
        f"    appName: env.DOKPLOY_{values['ID_UPPER']}_APP_NAME || '{appname}',\n"
        f"    dockerfile: 'services/{a.id}/Dockerfile',\n"
        f"    volumeName: {repr('temple-' + a.id + '-data') if a.state else 'null'},\n"
        f"    defaultPort: 8000,\n"
        f"    publishedPort: {port},\n"
        f"  }},\n"
    )
    entry = entry.replace('"', "'")
    patched.append((ROOT / "scripts" / "dokploy.mjs", insert_before(dokploy, r"^\};\r?\n\r?\nconst argv", entry, "scripts/dokploy.mjs")))

    # 3. dashboard card
    svc_path = ROOT / "services" / "dashboard" / "src" / "services.js"
    card = (
        "  {\n"
        f"    id: '{a.id}',\n"
        f"    name: '{title}',\n"
        f"    description: {a.description!r},\n"
        f"    port: {port},\n"
        "    healthPath: '/healthz',\n"
        "    async read(health) {\n"
        "      return { facts: [{ label: 'Up for', value: duration(Number(health.uptime) || 0) }], problems: problemsOf(health.problems) };\n"
        "    },\n"
        "  },\n"
    )
    patched.append((svc_path, insert_before(read(svc_path), r"^\];", card, "services/dashboard/src/services.js")))

    # 4. dashboard probe env (the Swarm name is filled in after the first deploy)
    env_ex = ROOT / "services" / "dashboard" / ".env.example"
    text = read(env_ex)
    probe_lines = list(re.finditer(r"^PROBE_URL_\w+=.*$", text, re.M))
    if not probe_lines:
        sys.exit("cannot patch services/dashboard/.env.example: no PROBE_URL_ lines found")
    end = probe_lines[-1].end()
    env_nl = "\r\n" if "\r\n" in text else "\n"
    patched.append((env_ex, text[:end] + f"{env_nl}PROBE_URL_{values['ID_UPPER']}=" + text[end:]))

    # 5. docker-compose.yml (local runs; build context is the service directory)
    compose_path = ROOT / "docker-compose.yml"
    compose = read(compose_path)
    block = (
        f"  {a.id}:\n"
        f"    build:\n"
        f"      context: services/{a.id}\n"
        f"    restart: unless-stopped\n"
        f"    env_file: services/{a.id}/.env\n"
        f"    ports:\n"
        f"      - \"{port}:8000\"\n"
    )
    if a.state:
        block += f"    volumes:\n      - {a.id}-data:/data\n"
    block += "\n"
    compose = insert_before(compose, r"^volumes:", block, "docker-compose.yml")
    if a.state:
        cnl = "\r\n" if "\r\n" in compose else "\n"
        compose = compose.rstrip("\r\n") + f"{cnl}  {a.id}-data:{cnl}"
    patched.append((compose_path, compose))

    # 6. README service index
    readme_path = ROOT / "README.md"
    readme = read(readme_path)
    rows = list(re.finditer(r"^\| \[`services/[^\r\n]*\|[ \t]*(?=\r?$)", readme, re.M))
    if not rows:
        sys.exit("cannot patch README.md: no service-table rows found")
    row = f"| [`services/{a.id}`](services/{a.id}) | {a.description} **http://157.180.15.165:{port}** | Python 3.12 (uv) | `{appname}` |"
    nl = "\r\n" if "\r\n" in readme else "\n"
    patched.append((readme_path, readme[: rows[-1].end()] + nl + row + readme[rows[-1].end():]))

    for path, text in [*files, *patched]:
        write(path, text)
    print(f"created services/{a.id}/ and patched {len(patched)} shared files")

    # 7. lockfile, then a smoke test so a broken template fails here and not in Docker
    for cmd in (["uv", "lock"], ["uv", "run", "pytest", "-q"]):
        print("+", " ".join(cmd))
        if subprocess.run(cmd, cwd=service_dir).returncode:
            sys.exit(f"`{' '.join(cmd)}` failed in services/{a.id}")

    print(
        f"\nscaffolded {a.id} on port {port} (app {appname}).\n"
        "Remaining, see SKILL.md: replace core.py, run dashboard tests, commit, then deploy."
    )


if __name__ == "__main__":
    main()
