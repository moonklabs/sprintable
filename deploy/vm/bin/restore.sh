#!/usr/bin/env bash
# restore.sh <dump-file | gs://…/db-….dump> — load a pg_dump -Fc into the (EMPTY) application database of this VM. Used once for the move from Cloud SQL,
# and for a real disaster restore. It refuses a database that already has tables: wipe deliberately with `RESTORE_WIPE=yes`.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$here/lib.sh"

src="${1:?usage: restore.sh <dump-file | gs://…dump>}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
if [[ "$src" == gs://* ]]; then
  gcloud storage cp --quiet "$src" "$src.sha256" "$work/"
  sha256_verify "$work" "$(basename "$src").sha256" || { echo "checksum of $src does not match" >&2; exit 1; }
  src="$work/$(basename "$src")"
fi
[ -s "$src" ] || { echo "no such dump: $src" >&2; exit 1; }

user="$(db_user)"; name="$(db_name)"; role="$(app_role)"
if [ -n "$role" ] && ! [[ "$role" =~ ^[a-z_][a-z0-9_]{0,62}$ ]]; then echo "unexpected application role name" >&2; exit 1; fi
restore_role=(); [ -z "$role" ] || restore_role=(--role "$role")
# a dump that cannot even be listed must not cost the database it was meant to replace
listing="$(in_db pg_restore --list < "$src")" || { echo "not a readable pg_dump -Fc archive: $src" >&2; exit 1; }
grep -q 'TABLE DATA' <<< "$listing" || { echo "the archive holds no table data: $src" >&2; exit 1; }
# the application's database is restored with the backend stopped; the gateway's own database (DB_SERVICE=gateway-db) has nothing of the backend in it
if [ "$(db_service)" = db ] && [ -n "$(docker ps -q --filter label=com.docker.compose.project=sprintable --filter label=com.docker.compose.service=backend)" ]; then
  echo "the backend is running — stop it first (docker compose stop backend frontend) so nothing writes during the restore" >&2
  exit 1
fi
if [ "$(db_service)" = gateway-db ]; then
  # the gateway runs on Cloud Run, not here: no container can be looked at, so the open sessions on its database are what shows it is still writing (a wipe would cut them and lose what they wrote)
  sessions="$(in_db psql -U "$user" -d postgres -X -A -t -c "select count(*) from pg_stat_activity where datname = '$name' and pid <> pg_backend_pid()")"
  if [ "$sessions" != "0" ]; then
    echo "$sessions session(s) are open on $name — the gateway is still connected: stop its Cloud Run traffic and wait until the sessions are gone (RUNBOOK section 13) before restoring" >&2
    exit 1
  fi
fi
existing="$(in_db psql -U "$user" -d "$name" -X -A -t -c "select count(*) from information_schema.tables where table_schema not in ('pg_catalog','information_schema')")"
if [ "$existing" != "0" ]; then
  if [ "${RESTORE_WIPE:-}" != "yes" ]; then
    echo "database $name already has $existing tables — set RESTORE_WIPE=yes to drop and recreate it" >&2
    exit 1
  fi
  if [ -n "$role" ]; then   # the gateway's database: owned by its application role, only that role may connect (what the first start of the server set up)
    in_db psql -U "$user" -d postgres -X -q -v ON_ERROR_STOP=1 -c "DROP DATABASE \"$name\" WITH (FORCE)" -c "CREATE DATABASE \"$name\" OWNER \"$role\"" \
      -c "REVOKE ALL ON DATABASE \"$name\" FROM PUBLIC" -c "GRANT CONNECT ON DATABASE \"$name\" TO \"$role\""
  else
    in_db psql -U "$user" -d postgres -X -q -v ON_ERROR_STOP=1 -c "DROP DATABASE \"$name\" WITH (FORCE)" -c "CREATE DATABASE \"$name\""
  fi
fi

log "restore start"
start="$(date +%s)"
in_db pg_restore -U "$user" -d "$name" --no-owner --no-privileges --exit-on-error --single-transaction ${restore_role[@]+"${restore_role[@]}"} < "$src"
log "restore done in $(( $(date +%s) - start )) s"
"$here/rowcounts.sh" "$name"
