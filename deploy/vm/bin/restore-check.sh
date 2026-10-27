#!/usr/bin/env bash
# Restore the newest Cloud Storage backup (or the dump given as $1) into a SCRATCH database next to the real one, count rows, time it, drop the scratch database.
# Prints «restore_seconds=N tables=N rows=N». Proves the backup restores — not only that it exists.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$here/lib.sh"

bucket="$(cfg backups_bucket)"
env_name="$(cfg environment)"
work="$(mktemp -d /var/backups/sprintable-restore.XXXXXX 2>/dev/null || mktemp -d)"
scratch="restore_check_$(date -u +%Y%m%d%H%M%S)_$$_${RANDOM}"
user="$(db_user)"
cleanup() { in_db psql -U "$user" -d postgres -X -q -c "DROP DATABASE IF EXISTS $scratch" > /dev/null 2>&1 || true; rm -rf "$work"; }
trap cleanup EXIT

dump="${1:-}"
if [ -z "$dump" ]; then
  newest="$(gcloud storage ls "gs://$bucket/db/db-$env_name-*.dump" | sort | tail -n1)"
  [ -n "$newest" ] || { echo "no backup in gs://$bucket/db/" >&2; exit 1; }
  gcloud storage cp --quiet "$newest" "$newest.sha256" "$work/"
  sha256_verify "$work" "$(basename "$newest").sha256" || { echo "checksum of $newest does not match" >&2; exit 1; }
  dump="$work/$(basename "$newest")"
  log "restoring $newest"
fi

in_db psql -U "$user" -d postgres -X -q -v ON_ERROR_STOP=1 -c "CREATE DATABASE $scratch"
start="$(date +%s)"
in_db pg_restore -U "$user" -d "$scratch" --no-owner --no-privileges --exit-on-error --single-transaction < "$dump"
secs=$(( $(date +%s) - start ))
counts="$("$here/rowcounts.sh" "$scratch")"
tables="$(printf '%s\n' "$counts" | awk -F'\t' '$2 ~ /^[0-9]+$/ {n++} END {print n + 0}')"
rows="$(printf '%s\n' "$counts" | awk -F'\t' '$2 ~ /^[0-9]+$/ {s += $2} END {print s + 0}')"
echo "restore_seconds=$secs tables=$tables rows=$rows"
[ "$tables" -gt 0 ] || { echo "restored database has no tables" >&2; exit 1; }
