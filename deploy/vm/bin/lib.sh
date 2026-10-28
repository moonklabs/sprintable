#!/usr/bin/env bash
# shared by the operations scripts of the VM (story 4796). Sourced, never run.

SPRINTABLE_CONFIG="${SPRINTABLE_CONFIG:-/etc/sprintable/deployer.json}"

cfg() { # cfg <key> — one value of the VM configuration file
  python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])' "$SPRINTABLE_CONFIG" "$1"
}

# which database server the scripts talk to: «db» (the application's, the default) or «gateway-db» (the support gateway's own, story 4796) — chosen with DB_SERVICE=gateway-db
db_service() {
  case "${DB_SERVICE:-db}" in
    db | gateway-db) printf %s "${DB_SERVICE:-db}" ;;
    *) echo "DB_SERVICE must be db or gateway-db" >&2; return 1 ;;
  esac
}
dump_prefix() { # the file-name prefix of the dumps of that server: db-<env>-… (application) or db-gateway-<env>-… (gateway) — one bucket folder, one lifecycle rule
  if [ "$(db_service)" = gateway-db ]; then printf %s db-gateway; else printf %s db; fi
}

db_container() { # the running database container of the compose project
  local id service
  service="$(db_service)" || return 1
  id="$(docker ps -q --filter label=com.docker.compose.project=sprintable --filter "label=com.docker.compose.service=$service" | head -n1)"
  [ -n "$id" ] || { echo "no running $service container (is the stack up?)" >&2; return 1; }
  echo "$id"
}

# psql / pg_dump / pg_restore inside the database container; the container's own POSTGRES_USER is used (local socket, no password on the command line)
in_db() { # a server that cannot be found fails the call itself (a failing command substitution inside the argument list would not)
  local container
  container="$(db_container)" || return 1
  docker exec -i "$container" "$@"
}
# shellcheck disable=SC2016  # the variables are meant to expand INSIDE the container
db_user() { in_db sh -c 'printf %s "$POSTGRES_USER"'; }
# shellcheck disable=SC2016  # expands inside the container
db_name() { # the application database name, checked to be a plain identifier (it is placed inside SQL by restore.sh)
  local n
  n="$(in_db sh -c 'printf %s "$POSTGRES_DB"')"
  [[ "$n" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || { echo "unexpected database name" >&2; return 1; }
  printf %s "$n"
}

# the role that must OWN what a restore creates: the gateway's database belongs to its application role (the server's superuser would own it otherwise, and the gateway could use nothing in it)
app_role() {
  if [ "$(db_service)" = gateway-db ]; then
    # shellcheck disable=SC2016  # expands inside the container
    in_db sh -c 'printf %s "$GATEWAY_APP_USER"'
  fi
}

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

sha256_verify() { # sha256_verify <directory> <checksum file> — GNU sha256sum on the VM, shasum elsewhere
  if command -v sha256sum > /dev/null; then
    (cd "$1" && sha256sum -c "$2" > /dev/null)
  else
    (cd "$1" && shasum -a 256 -c "$2" > /dev/null)
  fi
}
