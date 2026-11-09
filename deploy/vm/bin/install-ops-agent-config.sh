#!/usr/bin/env bash
# story 4869 (AC5) — put the Ops Agent configuration of deploy/vm/ops-agent/config.yaml in place, and be sure the agent still works with it.
#   install-ops-agent-config.sh <config file to install>
# A configuration the agent cannot read stops its LOG component — and with it the syslog and the health lines that were the only things in Cloud Logging. So: back up what is there, install, restart, wait for the
# component to be up, and put the old file back (or remove ours when there was none) if it is not. Same content already in place: no restart, but the component must be up (a crashed agent is not a success).
# Every step that can fail is checked (this script does not use `set -e`): a failed copy never reads as a success, and the backup is deleted only after the old file is back.
# Known limit: two copies of this script at the same time are not guarded (bootstrap is run by one person, one at a time).
# Settings for a test: OPS_AGENT_CONFIG (target file), OPS_AGENT_UNITS (units that must be active, default the log component), OPS_AGENT_TRIES / OPS_AGENT_WAIT (default 12 × 5 s).
# Exit codes: 0 in place and working · 1 not in place or the agent did not come up (old state restored where there was one) · 2 bad usage.
set -uo pipefail

[ "$#" -eq 1 ] && [ -f "$1" ] || { echo "usage: $0 <config file to install>" >&2; exit 2; }
src="$1"
target="${OPS_AGENT_CONFIG:-/etc/google-cloud-ops-agent/config.yaml}"
units="${OPS_AGENT_UNITS:-google-cloud-ops-agent-fluent-bit}"
tries="${OPS_AGENT_TRIES-12}"
wait_s="${OPS_AGENT_WAIT-5}"
case "$tries" in '' | *[!0-9]* | 0) echo "OPS_AGENT_TRIES must be a whole number >= 1 (got '$tries')" >&2; exit 2 ;; esac
case "$wait_s" in '' | *[!0-9]*) echo "OPS_AGENT_WAIT must be a whole number of seconds (got '$wait_s')" >&2; exit 2 ;; esac

units_up() {
  local u
  for u in $units; do
    systemctl is-active --quiet "$u" || return 1
  done
}

agent_version="$(dpkg-query -W -f='${Version}' google-cloud-ops-agent 2> /dev/null || true)"
[ -n "$agent_version" ] && echo "ops agent version: $agent_version (the configuration uses exclude_logs and modify_fields — if the agent is too old to read it, the restore below puts the old file back)"

fail() {
  echo "OPS AGENT CONFIG FAILED: $1" >&2
  exit 1
}

if [ -e "$target" ] && [ ! -f "$target" ]; then
  fail "$target exists and is not a regular file — nothing was changed"
fi

if [ -f "$target" ] && cmp -s "$src" "$target"; then
  if units_up; then
    echo "ops agent config: already in place ($target), unit(s) [$units] active — nothing to do"
    exit 0
  fi
  echo "ops agent config: already in place but unit(s) [$units] are not active — restarting the agent" >&2
  systemctl restart google-cloud-ops-agent || fail "the agent could not be restarted (systemctl restart failed)"
  attempt=1
  while :; do
    sleep "$wait_s"
    units_up && { echo "ops agent config: unit(s) [$units] active after a restart"; exit 0; }
    [ "$attempt" -ge "$tries" ] && fail "the configuration is in place but unit(s) [$units] did not come up within $((tries * wait_s)) s — sudo journalctl -u google-cloud-ops-agent-fluent-bit -n 50 --no-pager"
    attempt=$((attempt + 1))
  done
fi

backup=""
if [ -f "$target" ]; then
  backup="$(mktemp "${target}.previous.XXXXXX")" || fail "cannot make a backup next to $target — nothing was changed"
  cp -p "$target" "$backup" || { rm -f "$backup"; fail "cannot copy $target to its backup — nothing was changed"; }
fi
if ! mkdir -p "$(dirname "$target")" || ! install -m 0644 "$src" "$target"; then
  if [ -n "$backup" ]; then
    cp -p "$backup" "$target" && rm -f "$backup"
  fi
  fail "cannot write $target — the previous file (if any) is back"
fi

restore() {
  local ok=1
  if [ -n "$backup" ]; then
    if cp -p "$backup" "$target"; then
      rm -f "$backup"
    else
      ok=0
      echo "  the previous configuration could NOT be copied back — it is kept as $backup" >&2
    fi
  else
    rm -f "$target" || { ok=0; echo "  $target (ours) could NOT be removed" >&2; }
  fi
  systemctl restart google-cloud-ops-agent || { ok=0; echo "  the agent could not be restarted after the restore" >&2; }
  [ "$ok" = 1 ]
}

give_up() {
  echo "OPS AGENT CONFIG FAILED: $1 — the previous state is put back and the agent restarted." >&2
  echo "  Look: sudo journalctl -u google-cloud-ops-agent-fluent-bit -n 50 --no-pager   (the configuration is deploy/vm/ops-agent/config.yaml)" >&2
  if ! restore; then
    echo "OPS AGENT CONFIG: the previous state is NOT fully back — see the lines above, look at $target by hand" >&2
  fi
  exit 1
}

systemctl restart google-cloud-ops-agent || give_up "systemctl restart google-cloud-ops-agent failed"
attempt=1
while :; do
  sleep "$wait_s"
  units_up && break
  [ "$attempt" -ge "$tries" ] && give_up "with the new configuration the unit(s) [$units] did not come up within $((tries * wait_s)) s"
  attempt=$((attempt + 1))
done

if [ -n "$backup" ] && ! rm -f "$backup"; then
  echo "ops agent config: warning — the backup $backup could not be removed (the new configuration works; delete it by hand)" >&2
fi
echo "ops agent config: installed ($target), unit(s) [$units] active"
exit 0
