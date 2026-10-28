#!/usr/bin/env bash
# Daily database backup: pg_dump -Fc → checked (pg_restore --list shows table data, size, sha256) → Cloud Storage (gs://<backups bucket>/db/). Bucket lifecycle keeps 14 days (RUNBOOK).
# A backup that cannot be listed, holds no table data or is tiny is NOT uploaded and the unit fails. Whatever happens, no half-written dump is left on disk.
set -euo pipefail
umask 077
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$here/lib.sh"

env_name="$(cfg environment)"
bucket="$(cfg backups_bucket)"
dir="${BACKUP_DIR:-/var/backups/sprintable}"
data_dir="${DATA_DIR:-/srv/sprintable}"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$dir"
chmod 700 "$dir"

prune_local() { # keep the newest two finished dumps of each server, the bucket holds the history
  local prefix
  for prefix in db db-gateway; do
    # shellcheck disable=SC2012
    ls -1t "$dir/$prefix-$env_name-"*.dump 2>/dev/null | tail -n +3 | while read -r old; do rm -f "$old" "$old.sha256"; done || true  # nothing of that server yet is not an error
  done
}
cleanup() { rm -f "$dir"/*.partial; prune_local; }
trap cleanup EXIT

backup_one() { # backup_one <db | gateway-db>
  local file size listing sum
  export DB_SERVICE="$1"
  file="$dir/$(dump_prefix)-$env_name-$stamp.dump"
  log "dump start ($DB_SERVICE) → $file"
  # shellcheck disable=SC2016  # expands inside the container
  in_db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc --no-owner' > "$file.partial"
  size="$(wc -c < "$file.partial" | tr -d ' ')"
  if [ "$size" -lt 1024 ]; then
    echo "backup of $DB_SERVICE is only $size bytes — refusing to keep it" >&2
    return 1
  fi
  listing="$(in_db pg_restore --list < "$file.partial")"
  if ! grep -q 'TABLE DATA' <<< "$listing"; then
    echo "backup of $DB_SERVICE lists no table data — refusing to keep it" >&2
    return 1
  fi
  mv "$file.partial" "$file"
  sum="$(shasum -a 256 "$file" 2>/dev/null || sha256sum "$file")"
  printf '%s\n' "${sum%% *}  $(basename "$file")" > "$file.sha256"
  log "upload ($size bytes)"
  gcloud storage cp --quiet "$file" "$file.sha256" "gs://$bucket/db/"
  log "uploaded gs://$bucket/db/$(basename "$file")"
}

backup_one db
# the support gateway's own database, wherever this VM carries one: its data folder exists (the deployer makes it) — then a missing container is a failure, never a silent skip
if [ -d "$data_dir/gateway-postgres" ]; then
  backup_one gateway-db
fi
