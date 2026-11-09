#!/usr/bin/env bash
# story 4869 (AC5) — put the Ops Agent configuration of deploy/vm/ops-agent/config.yaml in place, and be sure the agent still works with it.
#   install-ops-agent-config.sh <config file to install>
# A configuration the agent cannot read stops its LOG component — and with it the syslog and the health lines that were the only things in Cloud Logging. So: back up what is there, install, restart, wait for the
# component to be up, and put the old file back (or remove ours when there was none) if it is not.
# Every step that can fail is checked (this script does not use `set -e`): a failed copy never reads as a success, the backup is deleted only after the old file is back, and what is said about the
# restore is what happened (a restore that failed says so and keeps the backup).
# Same content already in place is «nothing to do» ONLY if the log component is up AND this very file is known to have been loaded: a marker next to the target (`<target>.loaded`, the checksum of the file) is
# written once the agent has come up with it. A run that was cut off between writing the file and the restart (ssh drop, kill -9, power) leaves no marker, so the next run restarts the agent and converges —
# whatever the kind of interruption. Backups left by such a run (`<target>.previous.*`) are named in the output and never touched.
# Two copies at the same time are refused: a lock directory `<target>.lock.d` holds the pid of the one that runs (a lock whose process is gone is taken over; a lock with no pid yet is waited for up to 2 s; only its owner removes it). Known limits: two runs that find the SAME stale lock at the very same instant can both take it (a mkdir lock cannot do better without flock; bootstrap is run by one person); a recycled pid keeps a dead run's lock «alive» (the message says how to remove it); the units are asked once, not for a stretch of time; a symbolic link as the target is followed.
# Settings for a test: OPS_AGENT_CONFIG (target file), OPS_AGENT_UNITS (units that must be active, default the log component; must not be empty), OPS_AGENT_TRIES / OPS_AGENT_WAIT (default 12 × 5 s).
# Exit codes: 0 in place, loaded and working · 1 not in place or the agent did not come up (old state restored where there was one) · 2 bad usage.
set -uo pipefail

[ "$#" -eq 1 ] && [ -f "$1" ] || { echo "usage: $0 <config file to install>" >&2; exit 2; }
src="$1"
target="${OPS_AGENT_CONFIG:-/etc/google-cloud-ops-agent/config.yaml}"
marker="${target}.loaded"
units="${OPS_AGENT_UNITS-google-cloud-ops-agent-fluent-bit}"
tries="${OPS_AGENT_TRIES-12}"
wait_s="${OPS_AGENT_WAIT-5}"
case "$tries" in '' | *[!0-9]* | 0) echo "OPS_AGENT_TRIES must be a whole number >= 1 (got '$tries')" >&2; exit 2 ;; esac
case "$wait_s" in '' | *[!0-9]*) echo "OPS_AGENT_WAIT must be a whole number of seconds (got '$wait_s')" >&2; exit 2 ;; esac
tries=$((10#$tries)) # «08» is a number here, not a broken octal one
wait_s=$((10#$wait_s))
[ -n "${units//[[:space:]]/}" ] || { echo "OPS_AGENT_UNITS must name at least one unit (an empty or blank list would make «the agent is up» always true)" >&2; exit 2; }

mkdir -p "$(dirname "$target")" || { echo "OPS AGENT CONFIG FAILED: cannot write $target (its directory cannot be made) — nothing was changed" >&2; exit 1; }
lockdir="${target}.lock.d"
# shellcheck disable=SC2329 # called by the EXIT trap
release_lock() {
  # only the run that owns the lock removes it (a run that was wrongly judged stale must not remove the lock of the one that took over)
  [ "$(cat "$lockdir/pid" 2> /dev/null)" = "$$" ] || return 0
  rm -f "$lockdir/pid" 2> /dev/null
  rmdir "$lockdir" 2> /dev/null
}
if ! mkdir "$lockdir" 2> /dev/null; then
  holder="$(cat "$lockdir/pid" 2> /dev/null || true)"
  # the run that made the directory writes its pid a moment later: an empty lock is «being made», not «stale» — wait for the pid (up to 2 s) before judging
  waited=0
  while [ -z "$holder" ] && [ "$waited" -lt 10 ]; do
    sleep 0.2
    waited=$((waited + 1))
    holder="$(cat "$lockdir/pid" 2> /dev/null || true)"
  done
  if [ -n "$holder" ] && kill -0 "$holder" 2> /dev/null; then
    echo "OPS AGENT CONFIG FAILED: another run of this installer is in progress (pid $holder, lock $lockdir) — two runs would overwrite each other's backup and marker; if no installer is running, remove $lockdir and run again" >&2
    exit 1
  fi
  echo "ops agent config: taking over a stale lock $lockdir (its process${holder:+ $holder} is gone)" >&2
  rm -f "$lockdir/pid"
  rmdir "$lockdir" 2> /dev/null
  mkdir "$lockdir" 2> /dev/null || { echo "OPS AGENT CONFIG FAILED: cannot take the lock $lockdir" >&2; exit 1; }
fi
if ! echo "$$" > "$lockdir/pid"; then
  rmdir "$lockdir" 2> /dev/null
  echo "OPS AGENT CONFIG FAILED: cannot write the pid file of the lock $lockdir — nothing was changed" >&2
  exit 1
fi
trap release_lock EXIT

units_up() {
  local u
  for u in $units; do
    systemctl is-active --quiet "$u" || return 1
  done
}

sum_of() {
  cksum < "$1" | cut -d' ' -f1,2
}

fail() {
  echo "OPS AGENT CONFIG FAILED: $1" >&2
  exit 1
}

backup=""

restore() {
  local ok=1
  rm -f "$marker"
  if [ -n "$backup" ]; then
    if cp -p "$backup" "$target"; then
      rm -f "$backup" || echo "  warning — the backup $backup could not be removed after the restore (delete it by hand)" >&2
    else
      echo "  the previous configuration could NOT be copied back — it is kept as $backup" >&2
      echo "  the agent is NOT restarted: the file at $target may be half-written; the running agent keeps the configuration it already has in memory. Copy $backup over $target by hand, then: sudo systemctl restart google-cloud-ops-agent" >&2
      return 1
    fi
  else
    rm -f "$target" || { ok=0; echo "  $target (ours) could NOT be removed" >&2; }
  fi
  systemctl restart google-cloud-ops-agent || { ok=0; echo "  the agent could not be restarted after the restore" >&2; }
  [ "$ok" = 1 ]
}

give_up() {
  echo "OPS AGENT CONFIG FAILED: $1 — putting the previous state back." >&2
  echo "  Look: sudo journalctl -u google-cloud-ops-agent-fluent-bit -n 50 --no-pager   (the configuration is deploy/vm/ops-agent/config.yaml)" >&2
  if restore; then
    echo "  the previous state is back and the agent restarted." >&2
  else
    echo "OPS AGENT CONFIG: the previous state is NOT fully back — see the lines above, look at $target by hand" >&2
  fi
  exit 1
}

wait_for_units() {
  local attempt=1
  while :; do
    sleep "$wait_s"
    units_up && return 0
    [ "$attempt" -ge "$tries" ] && return 1
    attempt=$((attempt + 1))
  done
}

agent_version="$(dpkg-query -W -f='${Version}' google-cloud-ops-agent 2> /dev/null || true)"
[ -n "$agent_version" ] && echo "ops agent version: $agent_version (the configuration uses exclude_logs and modify_fields — if the agent is too old to read it, the restore puts the old file back)"

# what an interrupted earlier run left behind: named, not touched
for leftover in "${target}".previous.*; do
  [ -e "$leftover" ] && echo "ops agent config: a backup of an interrupted earlier run is still here: $leftover (the configuration that was in place before; delete it by hand when it is no longer needed)" >&2
done

if [ -e "$target" ] && [ ! -f "$target" ]; then
  fail "$target exists and is not a regular file — nothing was changed"
fi

if [ -f "$target" ] && cmp -s "$src" "$target"; then
  if units_up && [ -f "$marker" ] && [ "$(cat "$marker" 2> /dev/null)" = "$(sum_of "$target")" ]; then
    echo "ops agent config: already in place and loaded ($target), unit(s) [$units] active — nothing to do"
    exit 0
  fi
  echo "ops agent config: the file is in place but not known to be loaded (or the unit(s) [$units] are not active) — restarting the agent" >&2
  systemctl restart google-cloud-ops-agent || fail "the agent could not be restarted (systemctl restart failed)"
  wait_for_units || fail "the configuration is in place but unit(s) [$units] did not come up within $((tries * wait_s)) s — sudo journalctl -u google-cloud-ops-agent-fluent-bit -n 50 --no-pager"
  sum_of "$target" > "$marker" || echo "ops agent config: warning — the marker $marker could not be written (the next run will restart the agent again)" >&2
  echo "ops agent config: unit(s) [$units] active after a restart"
  exit 0
fi

if [ -f "$target" ]; then
  backup="$(mktemp "${target}.previous.XXXXXX")" || fail "cannot make a backup next to $target — nothing was changed"
  cp -p "$target" "$backup" || { rm -f "$backup"; fail "cannot copy $target to its backup — nothing was changed"; }
fi
rm -f "$marker"
if ! mkdir -p "$(dirname "$target")" || ! install -m 0644 "$src" "$target"; then
  give_up "cannot write $target"
fi

systemctl restart google-cloud-ops-agent || give_up "systemctl restart google-cloud-ops-agent failed"
wait_for_units || give_up "with the new configuration the unit(s) [$units] did not come up within $((tries * wait_s)) s"

sum_of "$target" > "$marker" || echo "ops agent config: warning — the marker $marker could not be written (the next run will restart the agent once more)" >&2
if [ -n "$backup" ] && ! rm -f "$backup"; then
  echo "ops agent config: warning — the backup $backup could not be removed (the new configuration works; delete it by hand)" >&2
fi
echo "ops agent config: installed ($target), unit(s) [$units] active"
exit 0
