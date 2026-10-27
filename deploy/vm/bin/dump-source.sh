#!/usr/bin/env bash
# dump-source.sh --host <private ip of the source database> [--label <word>] [--upload]
# Dumps the SOURCE database (Cloud SQL dev: private IP only, no public address) from this VM and measures it — RUNBOOK §7. Run as root; the database container of this VM must be up.
#   • the source connection URL (a Secret Manager value) is read from STANDARD INPUT, one line, and lives in this process's memory only: never in an argument list, a file, the shell history or the output;
#   • pg_dump / psql run in a throw-away container of the SAME image as this VM's database (same major version); their connection settings are handed over as environment variable NAMES;
#   • everything lands on the data disk, /srv/sprintable/import/<env>-<label>-<UTC time>.{dump,dump.sha256,counts.tsv}; --upload also copies them to gs://<backups bucket>/import/ (timestamped names: the VM may create, not overwrite).
# The row counts are taken just before the dump. With writers stopped (§7 step 2) they equal the dump; on a rehearsal against the live database tables written meanwhile will differ.
set -euo pipefail
umask 077
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$here/lib.sh"

host=""; label="rehearsal"; upload=no
while [ "$#" -gt 0 ]; do
  case "$1" in
    --host) host="${2:-}"; shift 2 ;;
    --label) label="${2:-}"; shift 2 ;;
    --upload) upload=yes; shift ;;
    *) echo "usage: $0 --host <private ip> [--label <word>] [--upload]   (the connection URL comes on standard input)" >&2; exit 2 ;;
  esac
done
[[ "$host" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || { echo "--host must be the private IPv4 address of the source database" >&2; exit 2; }
case "$host" in 0.*|127.*) echo "--host points at this machine, not at the source database" >&2; exit 2 ;; esac
[[ "$label" =~ ^[a-z0-9-]{1,20}$ ]] || { echo "--label: lower-case letters, digits and - only (at most 20)" >&2; exit 2; }
[ ! -t 0 ] || { echo "the source connection URL is read from standard input (pipe it in; do not type it)" >&2; exit 2; }

IFS= read -r source_url || true
[ -n "$source_url" ] || { echo "no connection URL on standard input" >&2; exit 2; }
# user, password, port, database, sslmode — one per line, decoded; the URL is never printed (not even on an error)
{ IFS= read -r PGUSER; IFS= read -r PGPASSWORD; IFS= read -r PGPORT; IFS= read -r PGDATABASE; IFS= read -r PGSSLMODE; } < <(
  printf '%s' "$source_url" | python3 -c '
import re, sys
from urllib.parse import parse_qs, unquote, urlsplit
try:
    u = urlsplit(sys.stdin.read().strip())
    assert re.fullmatch(r"postgres(ql)?(\+\w+)?", u.scheme)
    user, pw, db = unquote(u.username or ""), unquote(u.password or ""), unquote(u.path.lstrip("/"))
    port = u.port or 5432
    ssl = parse_qs(u.query).get("sslmode", [""])[0]
    fields = (user, pw, str(port), db, ssl)
    assert user and pw and db and not any(c in f for f in fields for c in "\r\n")
    assert re.fullmatch(r"[a-z-]*", ssl)
except Exception:
    sys.exit("the connection URL is not a postgresql:// URL with user, password and database")
print("\n".join(fields))
'
)
unset source_url
[ -n "${PGUSER:-}" ] && [ -n "${PGPASSWORD:-}" ] && [ -n "${PGDATABASE:-}" ] || { echo "could not read the connection URL" >&2; exit 2; }
export PGHOST="$host" PGPORT PGUSER PGPASSWORD PGDATABASE
if [ -z "$PGSSLMODE" ]; then unset PGSSLMODE; else export PGSSLMODE; fi

env_name="$(cfg environment)"
dir="${IMPORT_DIR:-/srv/sprintable/import}"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
base="$dir/$env_name-$label-$stamp"
mkdir -p "$dir"
chmod 700 "$dir"
cleanup() { rm -f "$base.dump.partial" "$base.counts.partial"; }
trap cleanup EXIT

image="$(docker inspect --format '{{.Config.Image}}' "$(db_container)")"
# the names only: docker reads the values from this process's environment, so they are not in any argument list
pg() { docker run --rm -i -e PGHOST -e PGPORT -e PGUSER -e PGPASSWORD -e PGDATABASE ${PGSSLMODE:+-e PGSSLMODE} --entrypoint "$1" "$image" "${@:2}"; }

log "source $PGHOST:$PGPORT database $PGDATABASE user $PGUSER (password not shown) — row counts"
t0="$(date +%s)"
pg psql -X -A -t -F $'\t' -v ON_ERROR_STOP=1 < "$here/rowcounts.sql" > "$base.counts.partial"
[ -s "$base.counts.partial" ] || { echo "the source returned no row counts" >&2; exit 1; }
t1="$(date +%s)"
log "row counts done in $((t1 - t0)) s"

log "dump start"
pg pg_dump -Fc --no-owner --no-privileges < /dev/null > "$base.dump.partial"
t2="$(date +%s)"
size="$(wc -c < "$base.dump.partial" | tr -d ' ')"
if [ "$size" -lt 1024 ]; then
  echo "the dump is only $size bytes — refusing to keep it" >&2
  exit 1
fi
listing="$(in_db pg_restore --list < "$base.dump.partial")" || { echo "the dump is not a readable pg_dump -Fc archive" >&2; exit 1; }
grep -q 'TABLE DATA' <<< "$listing" || { echo "the dump lists no table data — refusing to keep it" >&2; exit 1; }
mv "$base.dump.partial" "$base.dump"
mv "$base.counts.partial" "$base.counts.tsv"
if command -v sha256sum > /dev/null; then sum_cmd=(sha256sum); else sum_cmd=(shasum -a 256); fi  # GNU on the VM, shasum on a Mac (the tests run on both)
(cd "$dir" && "${sum_cmd[@]}" "$(basename "$base.dump")" > "$(basename "$base.dump.sha256")")
log "dump done in $((t2 - t1)) s, $size bytes, $(grep -c 'TABLE DATA' <<< "$listing") tables with data; checked readable, checksum written"

if [ "$upload" = yes ]; then
  bucket="$(cfg backups_bucket)"
  gcloud storage cp --quiet "$base.dump" "$base.dump.sha256" "$base.counts.tsv" "gs://$bucket/import/"
  log "uploaded to gs://$bucket/import/$(basename "$base.dump") (+ .sha256, .counts.tsv)"
fi
echo "dump:   $base.dump"
echo "counts: $base.counts.tsv"
printf '%s\n' "next:   sudo /opt/sprintable/bin/restore.sh $base.dump > counts-vm.tsv   then   diff $base.counts.tsv <(grep -P '^\\S+\\t\\d+\$' counts-vm.tsv)"
