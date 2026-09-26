"""Switch the WireGuard tunnel to another server when YouTube flags the exit.

A VPN hostname such as nl-ams.prod.surfshark.com resolves to many servers
that share one peer key, and each server has its own exit IP. YouTube
bot-checks by IP, so when one exit gets flagged, moving the peer to a
different server IP is usually enough.

The tunnel is never torn down for this: `wg setconf` swaps the peer's server
in place. The kill switch stays up, and nothing ever leaves on the
host IP. The candidate IPs were resolved at boot (entrypoint.sh writes
/run/wg-endpoints) because the hostname can't be resolved outside the tunnel
once the kill switch is on.
"""

import logging
import os
import socket
import subprocess
import threading
import time
import urllib.request

log = logging.getLogger("uvicorn.error")

ENDPOINTS_FILE = "/run/wg-endpoints"
HOST_FILE = "/run/wg-endpoint-host"
# A rotation this recent counts for every request that fails in the meantime,
# so a burst of bot_blocked responses moves the tunnel once, not N times.
ROTATE_COOLDOWN = int(os.environ.get("VPN_ROTATE_COOLDOWN_SECONDS", "30"))
HANDSHAKE_WAIT = 20

_lock = threading.Lock()
_last_rotation = 0.0
state = {"rotations": 0, "endpoint": None, "egress_ip": None, "last_rotation": None}


def _wg(*args: str) -> str:
    return subprocess.run(["wg", *args], capture_output=True, text=True, check=True).stdout.strip()


def _candidates() -> list[str]:
    """Servers resolved at boot plus a fresh lookup made now.

    The provider's DNS returns a couple of servers per query, so the boot list
    is short. DNS works through the tunnel, so each rotation asks again and
    the pool grows over time.
    """
    found: list[str] = []
    try:
        with open(ENDPOINTS_FILE) as f:
            found = [line.strip() for line in f if line.strip()]
    except FileNotFoundError:
        pass
    try:
        with open(HOST_FILE) as f:
            host, port = f.read().strip().rsplit(":", 1)
        for info in socket.getaddrinfo(host, int(port), socket.AF_INET, socket.SOCK_DGRAM):
            ep = f"{info[4][0]}:{port}"
            if ep not in found:
                found.append(ep)
        with open(ENDPOINTS_FILE, "w") as f:
            f.write("\n".join(found) + "\n")
    except (OSError, ValueError):
        pass  # an IP endpoint, or DNS hiccup: the boot list still works
    return found


def egress_ip() -> str | None:
    try:
        return urllib.request.urlopen("https://ipinfo.io/ip", timeout=10).read().decode().strip()
    except Exception:
        return None


def current_endpoint() -> str | None:
    try:
        # "<peer key>\t<ip:port>"
        return _wg("show", "wg0", "endpoints").split("\t")[1]
    except Exception:
        return None


def rotate(reason: str) -> bool:
    """Move the tunnel to the next server. True if the exit IP changed.

    If another request rotated within the cooldown, return True without
    rotating again, so the caller retries on that fresh exit.
    """
    global _last_rotation
    with _lock:
        if time.time() - _last_rotation < ROTATE_COOLDOWN:
            return True

        candidates = _candidates()
        current = current_endpoint()
        others = [c for c in candidates if c != current]
        if not others:
            log.warning("vpn: no other endpoint to rotate to (%d known)", len(candidates))
            return False

        # Round-robin from the current position, so repeated flags walk the
        # whole list instead of bouncing between two servers.
        start = candidates.index(current) + 1 if current in candidates else 0
        target = next(c for c in candidates[start:] + candidates[:start] if c != current)

        before_ip = egress_ip()
        before_hs = int(_wg("show", "wg0", "latest-handshakes").split("\t")[1] or 0)

        # `wg set ... endpoint` alone does not stick: the old server keeps
        # sending on the live session, and WireGuard roams the endpoint back
        # to whoever sent the last authenticated packet (seen in testing).
        # setconf replaces the peer outright, dropping the session keys, so the
        # only server that can talk to us is the new one. Routes and the kill
        # switch belong to wg0, which stays up throughout.
        conf = _wg("showconf", "wg0")
        conf = "\n".join(
            f"Endpoint = {target}" if line.startswith("Endpoint") else line for line in conf.splitlines()
        )
        path = "/run/wg0-rotate.conf"
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(conf + "\n")
        try:
            _wg("setconf", "wg0", path)
        finally:
            os.remove(path)

        # The new server needs a fresh handshake; traffic triggers it. Wait
        # for it before reporting success.
        deadline = time.time() + HANDSHAKE_WAIT
        while time.time() < deadline:
            egress_ip()  # nudge traffic through the tunnel
            hs = int(_wg("show", "wg0", "latest-handshakes").split("\t")[1] or 0)
            if hs > before_hs:
                break
            time.sleep(1)

        after_ip = egress_ip()
        _last_rotation = time.time()
        state.update(
            rotations=state["rotations"] + 1,
            endpoint=target,
            egress_ip=after_ip,
            last_rotation=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        )
        log.warning("vpn: rotated %s -> %s (%s), exit %s -> %s", current, target, reason, before_ip, after_ip)
        return bool(after_ip) and after_ip != before_ip and after_ip != os.environ.get("HOST_IP")
