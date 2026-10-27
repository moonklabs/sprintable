#!/usr/bin/env bash
# front-door.sh passthrough --host <public API host> --upstream <https://….run.app> | stop | status        (RUNBOOK §7 «Phase 1 — front door first»)
# A temporary front door for the API host that hands every request on to the CLOUD RUN backend, while the data is still on Cloud SQL — so clients can move to the new address
# (dev-api.sprintable.ai → this VM) long before the database moves. At the real cutover it is stopped and the stack's own Caddy (deployer.py) takes over the SAME data folder, so the
# certificates it obtained here are reused (no certificate gap).
#   • one throw-away container of the SAME image as the stack's Caddy (compose.yml), ports 80/443, restart unless-stopped, its own Caddyfile in /opt/sprintable/runtime/front-door/;
#   • certificates and the ACME account live in the stack's Caddy data folder (/srv/sprintable/caddy), as for the stack's own Caddy;
#   • refuses to start while the stack's Caddy runs (same ports); the upstream must be a Cloud Run backend address of ours and the host a sprintable.ai name — the values go into a file, so they are checked first;
#   • streams are not buffered (flush_interval -1) and the Host header is the upstream's, which Cloud Run needs.
# Start it only after the DNS record of --host already points at this VM: before that Caddy can not obtain a certificate and every try counts against the CA's failed-validation limit.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$here/lib.sh"

name="sprintable-front-door"
image="caddy:2.8.4-alpine"   # the same pinned image as the stack's Caddy (compose.yml; a test keeps them equal)
# the same folders the deployer uses: its configuration keys (defaults as in deployer.py) — no environment override that could point the certificate store somewhere else than the stack's Caddy looks
cfg_opt() { python3 -c 'import json, sys; print(json.load(open(sys.argv[1])).get(sys.argv[2], sys.argv[3]))' "$SPRINTABLE_CONFIG" "$1" "$2"; }
install_dir="$(cfg_opt install_dir /opt/sprintable)"
data_dir="$(cfg_opt data_dir /srv/sprintable)"
dir="$install_dir/runtime/front-door"

usage() { echo "usage: $0 passthrough --host <name>.sprintable.ai --upstream https://sprintable-backend-<env>-<id>.<region>.run.app | stop | status" >&2; exit 2; }
cmd="${1:-}"; [ -n "$cmd" ] || usage; shift

stack_caddy_running() { [ -n "$(docker ps -q --filter label=com.docker.compose.project=sprintable --filter label=com.docker.compose.service=caddy)" ]; }
mine() { docker ps -aq --filter "name=^${name}$"; }

case "$cmd" in
  passthrough)
    host=""; upstream=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --host) host="${2:-}"; shift 2 ;;
        --upstream) upstream="${2:-}"; shift 2 ;;
        *) usage ;;
      esac
    done
    [[ "$host" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.sprintable\.ai$ ]] || { echo "--host must be a name under sprintable.ai" >&2; exit 2; }
    env_name="$(cfg environment)"
    [[ "$env_name" =~ ^(dev|prod)$ ]] || { echo "the VM configuration names no known environment" >&2; exit 1; }
    [[ "$upstream" =~ ^https://sprintable-backend-${env_name}-[a-z0-9]+(-[a-z0-9]+)?\.(asia-northeast3\.run\.app|a\.run\.app)$ ]] || { echo "--upstream must be the https address of this environment's ($env_name) Cloud Run backend (sprintable-backend-$env_name-…run.app), no path: requests carry users' credentials" >&2; exit 2; }
    email="$(cfg acme_email)"
    [[ "$email" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || { echo "acme_email in the VM configuration is not an e-mail address" >&2; exit 1; }
    stack_caddy_running && { echo "the stack's own Caddy is running (same ports 80/443): this temporary front door is for the time BEFORE the stack takes over" >&2; exit 1; }
    mountpoint -q "$data_dir" || { echo "$data_dir is not a mounted data disk: the certificates would not be where the stack's Caddy looks" >&2; exit 1; }
    install -d -m 0755 "$dir" "$data_dir/caddy"
    tmp="$dir/.Caddyfile.new"
    cat > "$tmp" <<EOF
# written by front-door.sh — a temporary pass-through, see RUNBOOK
{
	email $email
	servers {
		protocols h1 h2
	}
}

$host {
	# no \`encode\`: compressing would hold stream frames back; flush_interval -1 sends every chunk as it arrives
	reverse_proxy $upstream {
		flush_interval -1
		header_up Host {upstream_hostport}
	}
}
EOF
    chmod 0644 "$tmp"
    docker run --rm -v "$tmp:/tmp/Caddyfile.check:ro" "$image" caddy validate --config /tmp/Caddyfile.check --adapter caddyfile > /dev/null \
      || { rm -f "$tmp"; echo "the generated Caddyfile does not validate" >&2; exit 1; }
    mv "$tmp" "$dir/Caddyfile"
    [ -z "$(mine)" ] || docker rm -f "$name" > /dev/null
    docker run -d --name "$name" --restart unless-stopped -p 80:80 -p 443:443 \
      -v "$dir:/etc/caddy:ro" -v "$data_dir/caddy:/data" \
      --log-driver json-file --log-opt max-size=10m --log-opt max-file=5 "$image" > /dev/null
    wait_seconds="${FRONT_DOOR_WAIT:-30}"
    [[ "$wait_seconds" =~ ^[0-9]{1,3}$ ]] || wait_seconds=30
    for _ in $(seq 1 "$wait_seconds"); do
      if docker exec "$name" wget -q -O /dev/null http://127.0.0.1:2019/config/ 2> /dev/null; then
        log "front door up: https://$host → $upstream (certificates are requested now; the DNS record must already point at this VM)"
        exit 0
      fi
      sleep 1
    done
    echo "the front door did not become ready in $wait_seconds s — see: docker logs $name" >&2
    exit 1
    ;;
  stop)
    [ "$#" -eq 0 ] || usage
    if [ -n "$(mine)" ]; then docker rm -f "$name" > /dev/null; log "front door stopped (certificates stay in $data_dir/caddy)"; else log "no front door was running"; fi
    ;;
  status)
    [ "$#" -eq 0 ] || usage
    [ -n "$(docker ps -q --filter "name=^${name}$")" ] || { echo "not running"; exit 1; }
    echo "running"
    grep -E '^[a-z0-9.-]+\.sprintable\.ai \{|reverse_proxy ' "$dir/Caddyfile" || true
    ;;
  *) usage ;;
esac
