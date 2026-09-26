#!/bin/sh
# Boot order matters: record the host's own IP, bring up the VPN, lock egress
# to it, then start the PO-token server and the API. If any step fails the
# container exits rather than serve requests from the datacenter IP, which
# YouTube bot-blocks and which we do not want to keep burning.
set -eu

log() { echo "[$(date -u +%FT%TZ)] $*"; }

# --- WireGuard ---------------------------------------------------------------
if [ "${VPN_ENABLED:-true}" = "true" ]; then
  mkdir -p /etc/wireguard
  if [ -n "${WG_PRIVATE_KEY:-}" ]; then
    # Field-by-field, so a location switch is just WG_ENDPOINT + WG_PEER_PUBLIC_KEY.
    for v in WG_ADDRESS WG_PEER_PUBLIC_KEY WG_ENDPOINT; do
      eval "val=\${$v:-}"
      if [ -z "$val" ]; then log "ERROR: WG_PRIVATE_KEY is set but $v is not"; exit 1; fi
    done
    {
      echo "[Interface]"
      echo "PrivateKey = $WG_PRIVATE_KEY"
      echo "Address = $WG_ADDRESS"
      [ -n "${WG_DNS:-}" ] && echo "DNS = $WG_DNS"
      echo "[Peer]"
      echo "PublicKey = $WG_PEER_PUBLIC_KEY"
      [ -n "${WG_PRESHARED_KEY:-}" ] && echo "PresharedKey = $WG_PRESHARED_KEY"
      echo "AllowedIPs = ${WG_ALLOWED_IPS:-0.0.0.0/0}"
      echo "Endpoint = $WG_ENDPOINT"
      echo "PersistentKeepalive = ${WG_KEEPALIVE:-25}"
    } > /etc/wireguard/wg0.conf
  elif [ -n "${WG_CONF_B64:-}" ]; then
    echo "$WG_CONF_B64" | base64 -d > /etc/wireguard/wg0.conf
  elif [ -n "${WG_CONF_FILE:-}" ] && [ -f "$WG_CONF_FILE" ]; then
    cp "$WG_CONF_FILE" /etc/wireguard/wg0.conf
  else
    log "ERROR: VPN_ENABLED but no WireGuard config (set WG_PRIVATE_KEY + fields, WG_CONF_B64 or WG_CONF_FILE)"
    exit 1
  fi
  chmod 600 /etc/wireguard/wg0.conf

  # DNS= needs resolvconf, which a container doesn't have; take the servers
  # from the config and write resolv.conf ourselves once the tunnel is up.
  VPN_DNS=$(grep -i '^DNS' /etc/wireguard/wg0.conf | cut -d= -f2 | tr ',' ' ')
  sed -i '/^DNS/Id' /etc/wireguard/wg0.conf

  HOST_IP=$(curl -s --max-time 10 https://ipinfo.io/ip || true)
  export HOST_IP
  log "host egress IP (must NOT be used): ${HOST_IP:-unknown}"

  # Every server behind the endpoint hostname, resolved now while plain DNS
  # still works. Once the kill switch is up, the hostname can't be resolved
  # outside the tunnel, so rotating to another exit (app/vpn.py, used when
  # YouTube flags the current one) swaps between these IPs with `wg set`.
  EP=$(grep -i '^Endpoint' /etc/wireguard/wg0.conf | cut -d= -f2- | tr -d ' ')
  EP_HOST=${EP%:*}
  EP_PORT=${EP##*:}
  # The provider's DNS hands out a couple of servers per query, a different
  # couple each time, so ask several times and keep the union.
  for _ in 1 2 3 4 5 6 7 8; do
    getent ahostsv4 "$EP_HOST" | awk '{print $1}'
  done | sort -u | sed "s/\$/:$EP_PORT/" > /run/wg-endpoints || true
  # Rotation looks the hostname up again through the tunnel for fresh servers.
  echo "$EP_HOST:$EP_PORT" > /run/wg-endpoint-host
  log "VPN endpoints available for rotation: $(wc -l < /run/wg-endpoints)"

  # wg-quick sets src_valid_mark via sysctl, which an unprivileged container
  # can't write. Pass it with --sysctl / compose sysctls instead; skip it here.
  sed -i 's/cmd sysctl -q net.ipv4.conf.all.src_valid_mark=1/true/' "$(command -v wg-quick)"
  wg-quick up wg0

  # Kill switch: anything leaving on a non-VPN interface is rejected, except
  # loopback, the tunnel's own encrypted packets (fwmark), and private ranges
  # so other containers can still reach the API and get replies.
  FWMARK=$(wg show wg0 fwmark)
  iptables -A OUTPUT -o lo -j ACCEPT
  iptables -A OUTPUT -o wg0 -j ACCEPT
  iptables -A OUTPUT -m mark --mark "$FWMARK" -j ACCEPT
  for net in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16; do
    iptables -A OUTPUT -d "$net" -j ACCEPT
  done
  iptables -A OUTPUT -j REJECT

  if [ -n "$VPN_DNS" ]; then
    : > /etc/resolv.conf
    for d in $VPN_DNS; do echo "nameserver $d" >> /etc/resolv.conf; done
  fi

  # Same idea as Youtube_Archiver's start.sh: give the handshake up to 30s
  # before declaring the tunnel dead (stale keys are the usual cause).
  VPN_IP=""
  n=0
  while [ $n -lt 30 ]; do
    VPN_IP=$(curl -s --max-time 5 https://ipinfo.io/ip || true)
    if [ -n "$VPN_IP" ] && [ "$VPN_IP" != "$HOST_IP" ]; then break; fi
    VPN_IP=""
    n=$((n + 1))
    sleep 1
  done
  if [ -z "$VPN_IP" ]; then
    log "ERROR: VPN never carried traffic after 30s (stale keys or endpoint unreachable)"
    exit 1
  fi
  log "VPN up, egress IP: $VPN_IP"
else
  log "WARNING: VPN_ENABLED=false, requests go out on the host IP"
fi

# --- Inbound allowlist -------------------------------------------------------
# Only the Temple AI services may call the API. The primary control is the
# network (the service joins only the temple-ai-internal overlay); this is the
# second layer, so a container that lands on a shared network with us, such as
# dokploy-network, is still dropped.
if [ -n "${ALLOWED_SOURCES:-}" ]; then
  API_PORT="${PORT:-8090}"
  iptables -A INPUT -i lo -j ACCEPT
  for src in $(echo "$ALLOWED_SOURCES" | tr ',' ' '); do
    iptables -A INPUT -p tcp --dport "$API_PORT" -s "$src" -j ACCEPT
  done
  iptables -A INPUT -p tcp --dport "$API_PORT" -j DROP
  log "API port $API_PORT accepts only: $ALLOWED_SOURCES"
else
  log "WARNING: ALLOWED_SOURCES unset, any container that can route here can reach the API"
fi

# --- PO-token server (bgutil, native, localhost only) ------------------------
(
  cd /opt/bgutil/server/node_modules
  exec deno run --allow-env --allow-net --allow-ffi=. --allow-read=. ../src/main.ts --port 4416
) &
log "bgutil PO-token server starting on 127.0.0.1:4416"

# --- API ---------------------------------------------------------------------
exec uvicorn app.main:app --host 0.0.0.0 --port "${PORT:-8090}" --workers 1
