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
existing="$(in_db psql -U "$user" -d "$name" -X -A -t -c "select count(*) from information_schema.tables where table_schema not in ('pg_catalog','information_schema')")"
if [ "$existing" != "0" ]; then
  if [ "${RESTORE_WIPE:-}" != "yes" ]; then
    echo "database $name already has $existing tables — set RESTORE_WIPE=yes to drop and recreate it" >&2
    exit 1
  fi
  if [ -n "$role" ] && [ "${#name}" -gt 33 ]; then echo "database name too long to keep the old one beside the new one" >&2; exit 1; fi
fi
door_closed=""
if [ -n "$role" ]; then
  # the gateway runs on Cloud Run, not here: no container can be looked at. So the door is shut first (the role may no longer CONNECT: nobody new gets in), and then the open sessions are counted — they are what shows the gateway is still writing.
  # The door stays shut through the wipe and the restore and is opened after it; a restore that fails leaves it shut (the message below says how to open it).
  open_door() { in_db psql -U "$user" -d postgres -X -q -v ON_ERROR_STOP=1 -c "GRANT CONNECT ON DATABASE \"$name\" TO \"$role\""; }
  say_closed() { echo "the database $name is CLOSED to the gateway (restore did not finish). When it is right to open it: sudo docker exec sprintable-gateway-db-1 psql -U $user -d postgres -c 'GRANT CONNECT ON DATABASE \"$name\" TO \"$role\"'" >&2; }
  trap 'rm -rf "$work"; [ -z "$door_closed" ] || say_closed' EXIT
  in_db psql -U "$user" -d postgres -X -q -v ON_ERROR_STOP=1 -c "REVOKE CONNECT ON DATABASE \"$name\" FROM \"$role\""
  door_closed=yes
  sessions="$(in_db psql -U "$user" -d postgres -X -A -t -c "select count(*) from pg_stat_activity where datname = '$name' and pid <> pg_backend_pid()")"
  if [ "$sessions" != "0" ]; then
    open_door   # nothing was changed: the door is opened again
    door_closed=""
    echo "$sessions session(s) are open on $name — the gateway is still connected: stop its Cloud Run traffic and wait until the sessions are gone (RUNBOOK section 13) before restoring" >&2
    exit 1
  fi
fi
target="$name"; kept=""
if [ "$existing" != "0" ]; then
  if [ -n "$role" ]; then
    # the gateway's database is never dropped before its replacement has loaded (a DROP cannot be undone by --single-transaction): the dump loads into a database beside it, owned by the application role and shut like the rest,
    # and the two change names only when the load succeeded. The old one stays, under a new name, until somebody drops it.
    stamp="$(date -u +%Y%m%d%H%M%S)"; target="${name}_restore_${stamp}"; kept="${name}_before_restore_${stamp}"
    in_db psql -U "$user" -d postgres -X -q -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$target\" OWNER \"$role\"" \
      -c "REVOKE ALL ON DATABASE \"$target\" FROM PUBLIC" -c "REVOKE CONNECT ON DATABASE \"$target\" FROM \"$role\""
  else
    in_db psql -U "$user" -d postgres -X -q -v ON_ERROR_STOP=1 -c "DROP DATABASE \"$name\" WITH (FORCE)" -c "CREATE DATABASE \"$name\""
  fi
fi

log "restore start"
start="$(date +%s)"
if ! in_db pg_restore -U "$user" -d "$target" --no-owner --no-privileges --exit-on-error --single-transaction ${restore_role[@]+"${restore_role[@]}"} < "$src"; then
  if [ -n "$kept" ]; then
    in_db psql -U "$user" -d postgres -X -q -c "DROP DATABASE IF EXISTS \"$target\" WITH (FORCE)" || true
    open_door; door_closed=""
    echo "the restore failed; $name is untouched (the gateway may connect again)" >&2
  fi
  exit 1
fi
log "restore done in $(( $(date +%s) - start )) s"
if [ -n "$kept" ]; then
  in_db psql -U "$user" -d postgres -X -q -v ON_ERROR_STOP=1 -c "ALTER DATABASE \"$name\" RENAME TO \"$kept\"; ALTER DATABASE \"$target\" RENAME TO \"$name\""
  log "the database that was here before is kept as $kept (closed to the gateway) — drop it when the restored one has proven itself: DROP DATABASE \"$kept\""
fi
if [ -n "$role" ]; then
  open_door
  door_closed=""
fi
"$here/rowcounts.sh" "$name"
