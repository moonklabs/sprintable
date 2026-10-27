#!/usr/bin/env bash
# shared by the operations scripts of the VM (story 4796). Sourced, never run.

SPRINTABLE_CONFIG="${SPRINTABLE_CONFIG:-/etc/sprintable/deployer.json}"

cfg() { # cfg <key> — one value of the VM configuration file
  python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])' "$SPRINTABLE_CONFIG" "$1"
}

db_container() { # the running database container of the compose project
  local id
  id="$(docker ps -q --filter label=com.docker.compose.project=sprintable --filter label=com.docker.compose.service=db | head -n1)"
  [ -n "$id" ] || { echo "no running database container (is the stack up?)" >&2; return 1; }
  echo "$id"
}

# psql / pg_dump / pg_restore inside the database container; the container's own POSTGRES_USER is used (local socket, no password on the command line)
in_db() { docker exec -i "$(db_container)" "$@"; }
# shellcheck disable=SC2016  # the variables are meant to expand INSIDE the container
db_user() { in_db sh -c 'printf %s "$POSTGRES_USER"'; }
# shellcheck disable=SC2016  # expands inside the container
db_name() { # the application database name, checked to be a plain identifier (it is placed inside SQL by restore.sh)
  local n
  n="$(in_db sh -c 'printf %s "$POSTGRES_DB"')"
  [[ "$n" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || { echo "unexpected database name" >&2; return 1; }
  printf %s "$n"
}

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

sha256_verify() { # sha256_verify <directory> <checksum file> — GNU sha256sum on the VM, shasum elsewhere
  if command -v sha256sum > /dev/null; then
    (cd "$1" && sha256sum -c "$2" > /dev/null)
  else
    (cd "$1" && shasum -a 256 -c "$2" > /dev/null)
  fi
}
