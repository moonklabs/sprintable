#!/usr/bin/env bash
# story 4869 (AC5) — put the Ops Agent configuration of deploy/vm/ops-agent/config.yaml in place, and be sure the agent still works with it.
#   install-ops-agent-config.sh <config file to install>
# A configuration the agent cannot read stops its LOG component — and with it the syslog and the health lines that were the only things in Cloud Logging. So: back up what is there, install, restart, wait for the
# component to be up, and put the old file back (or remove ours when there was none) if it is not. Same content already in place = nothing to do, no restart.
# Settings for a test: OPS_AGENT_CONFIG (target file), OPS_AGENT_UNITS (units that must be active, default the log component), OPS_AGENT_TRIES / OPS_AGENT_WAIT (default 12 × 5 s).
# Exit codes: 0 in place and working (or already) · 1 the agent did not come up with it (old state restored) · 2 bad usage.
set -uo pipefail

[ "$#" -eq 1 ] && [ -f "$1" ] || { echo "usage: $0 <config file to install>" >&2; exit 2; }
src="$1"
target="${OPS_AGENT_CONFIG:-/etc/google-cloud-ops-agent/config.yaml}"
units="${OPS_AGENT_UNITS:-google-cloud-ops-agent-fluent-bit}"
tries="${OPS_AGENT_TRIES:-12}"
wait_s="${OPS_AGENT_WAIT:-5}"
case "$tries" in '' | *[!0-9]* | 0) echo "OPS_AGENT_TRIES must be a whole number >= 1 (got '$tries')" >&2; exit 2 ;; esac
case "$wait_s" in '' | *[!0-9]*) echo "OPS_AGENT_WAIT must be a whole number of seconds (got '$wait_s')" >&2; exit 2 ;; esac

if [ -f "$target" ] && cmp -s "$src" "$target"; then
  echo "ops agent config: already in place ($target) — nothing to do"
  exit 0
fi

backup=""
if [ -f "$target" ]; then
  backup="$(mktemp "${target}.previous.XXXXXX")" || { echo "ops agent config: cannot make a backup next to $target" >&2; exit 1; }
  cp -p "$target" "$backup"
fi
mkdir -p "$(dirname "$target")"
install -m 0644 "$src" "$target"

units_up() {
  local u
  for u in $units; do
    systemctl is-active --quiet "$u" || return 1
  done
}

restore() {
  if [ -n "$backup" ]; then
    cp -p "$backup" "$target"
  else
    rm -f "$target"
  fi
  systemctl restart google-cloud-ops-agent || true
}

systemctl restart google-cloud-ops-agent || true
attempt=1
while :; do
  sleep "$wait_s"
  units_up && break
  if [ "$attempt" -ge "$tries" ]; then
    echo "OPS AGENT CONFIG FAILED: with the new configuration the unit(s) [$units] did not come up within $((tries * wait_s)) s — the previous state is put back and the agent restarted." >&2
    echo "  Look: sudo journalctl -u google-cloud-ops-agent-fluent-bit -n 50 --no-pager   (the configuration is deploy/vm/ops-agent/config.yaml)" >&2
    restore
    exit 1
  fi
  attempt=$((attempt + 1))
done

[ -n "$backup" ] && rm -f "$backup"
echo "ops agent config: installed ($target), unit(s) [$units] active"
exit 0
