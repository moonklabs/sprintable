#!/usr/bin/env bash
# dump-source.sh --host <private ip of the source database> [--label <word>] [--upload]
# Dumps the SOURCE database (Cloud SQL dev: private IP only, no public address) from this VM and measures it — RUNBOOK §7. Run as root; the database container of this VM must be up.
#   • the source connection URL (a Secret Manager value) is read from STANDARD INPUT, one line, and lives in this process's memory only: never in an argument list, a file, the shell history or the output;
#   • the password is NOT exported: it is handed to exactly one command — the throw-away container of the SAME image as this VM's database (same major version) that runs pg_dump / psql — as an environment
#     variable NAME (`docker run -e NAME`), so no other child process (docker inspect, gcloud, python, …) ever has it in its environment;
#   • everything lands on the data disk, /srv/sprintable/import/<env>-<label>-<UTC time>-<pid>.{dump,dump.sha256,counts.tsv} (a name that exists is never reused); --upload also copies them to
#     gs://<backups bucket>/import/ with --no-clobber (create only).
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
# a private IPv4 address only (10/8, 172.16/12, 192.168/16): the password goes to this host and nowhere else
private_ipv4() {
  local ip="$1" a b c d octet
  # no leading zeros: libpq / inet_aton read 010 as octal
  [[ "$ip" =~ ^(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})$ ]] || return 1
  a="${BASH_REMATCH[1]}"; b="${BASH_REMATCH[2]}"; c="${BASH_REMATCH[3]}"; d="${BASH_REMATCH[4]}"
  for octet in "$a" "$b" "$c" "$d"; do [ "$((10#$octet))" -le 255 ] || return 1; done
  a=$((10#$a)); b=$((10#$b))
  [ "$a" -eq 10 ] || { [ "$a" -eq 172 ] && [ "$b" -ge 16 ] && [ "$b" -le 31 ]; } || { [ "$a" -eq 192 ] && [ "$b" -eq 168 ]; }
}
private_ipv4 "$host" || { echo "--host must be the private IPv4 address (10.x, 172.16-31.x or 192.168.x) of the source database" >&2; exit 2; }
[[ "$label" =~ ^[a-z0-9-]{1,20}$ ]] || { echo "--label: lower-case letters, digits and - only (at most 20)" >&2; exit 2; }
[ ! -t 0 ] || { echo "the source connection URL is read from standard input (pipe it in; do not type it)" >&2; exit 2; }

IFS= read -r source_url || true
[ -n "$source_url" ] || { echo "no connection URL on standard input" >&2; exit 2; }
# user, password, port, database, sslmode — one per line, decoded; the URL is never printed (not even on an error). Plain shell variables, NOT exported.
{ IFS= read -r src_user; IFS= read -r src_password; IFS= read -r src_port; IFS= read -r src_db; IFS= read -r src_sslmode; } < <(
  printf '%s' "$source_url" | python3 -c '
import re, sys
from urllib.parse import parse_qs, unquote, urlsplit

def fail():
    sys.exit("the connection URL is not a postgresql:// URL with user, password and database")

try:
    u = urlsplit(sys.stdin.read().strip())
    port = u.port or 5432
    user, pw, db = unquote(u.username or ""), unquote(u.password or ""), unquote(u.path.lstrip("/"))
    ssl = parse_qs(u.query).get("sslmode", [""])[0]
except Exception:
    fail()
fields = (user, pw, str(port), db, ssl)
if not re.fullmatch(r"postgres(ql)?(\+\w+)?", u.scheme):
    fail()
if not (user and pw and db) or any(c in f for f in fields for c in "\r\n"):
    fail()
if not re.fullmatch(r"[a-z-]*", ssl):
    fail()
print("\n".join(fields))
'
)
unset source_url
[ -n "${src_user:-}" ] && [ -n "${src_password:-}" ] && [ -n "${src_db:-}" ] || { echo "could not read the connection URL" >&2; exit 2; }

env_name="$(cfg environment)"
dir="${IMPORT_DIR:-/srv/sprintable/import}"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
base="$dir/$env_name-$label-$stamp-$$"
mkdir -p "$dir"
chmod 700 "$dir"
for f in "$base.dump" "$base.dump.sha256" "$base.counts.tsv"; do
  [ ! -e "$f" ] || { echo "$f already exists — nothing is overwritten" >&2; exit 1; }
done
cleanup() { rm -f "$base.dump.partial" "$base.counts.partial"; }
trap cleanup EXIT

image="$(docker inspect --format '{{.Config.Image}}' "$(db_container)")"
# the connection settings reach ONE command, as variable names for docker (-e NAME): the values are in that command's environment only
pg() {
  local ssl_arg=()
  [ -z "$src_sslmode" ] || ssl_arg=(-e PGSSLMODE)
  PGHOST="$host" PGPORT="$src_port" PGUSER="$src_user" PGPASSWORD="$src_password" PGDATABASE="$src_db" PGSSLMODE="$src_sslmode" \
    docker run --rm -i -e PGHOST -e PGPORT -e PGUSER -e PGPASSWORD -e PGDATABASE ${ssl_arg[@]+"${ssl_arg[@]}"} --entrypoint "$1" "$image" "${@:2}"
}

log "source $host:$src_port database $src_db user $src_user (password not shown) — row counts"
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
  gcloud storage cp --quiet --no-clobber --project "$(cfg project)" "$base.dump" "$base.dump.sha256" "$base.counts.tsv" "gs://$bucket/import/"
  log "uploaded to gs://$bucket/import/$(basename "$base.dump") (+ .sha256, .counts.tsv)"
fi
echo "dump:   $base.dump"
echo "counts: $base.counts.tsv"
printf '%s\n' "next:   sudo env RESTORE_WIPE=yes /opt/sprintable/bin/restore.sh $base.dump > counts-vm.tsv   then   sudo bash -c \"diff $base.counts.tsv <(grep -P '^\\S+\\t\\d+\\\$' counts-vm.tsv)\""
