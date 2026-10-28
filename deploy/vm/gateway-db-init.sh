#!/bin/bash
# story 4796 — the support gateway's own database server: what happens on its FIRST start only (the image runs every file of /docker-entrypoint-initdb.d when the data folder is empty).
#
# The server's superuser (POSTGRES_USER) is never given a password and never leaves the container: it is reachable over the unix socket inside the container (docker exec) and over no network
# address at all (the hba file below). The application's role is an ordinary role — it owns the gateway's database and can do nothing outside it: no superuser, no program execution, no server files,
# no other database. Its password reaches the server through this script's standard input only, with the statement logging switched off for the session first (a statement that is slow or fails is
# otherwise written to the server's log WITH its text, password included).
set -Eeuo pipefail

: "${POSTGRES_USER:?}" "${POSTGRES_DB:?}" "${GATEWAY_APP_USER:?}" "${GATEWAY_APP_PASSWORD:?}"
[[ "$POSTGRES_USER" =~ ^[a-z_][a-z0-9_]{0,62}$ && "$POSTGRES_DB" =~ ^[a-z_][a-z0-9_]{0,62}$ && "$GATEWAY_APP_USER" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || { echo "gateway-db-init: a name is not a plain identifier" >&2; exit 1; }
[[ "$GATEWAY_APP_PASSWORD" =~ ^[A-Za-z0-9_-]{16,}$ ]] || { echo "gateway-db-init: the application password is not letters, digits, _ or - (16 or more)" >&2; exit 1; }
[ "$GATEWAY_APP_USER" != "$POSTGRES_USER" ] || { echo "gateway-db-init: the application role must not be the superuser" >&2; exit 1; }

psql -v ON_ERROR_STOP=1 -X -q --username "$POSTGRES_USER" --dbname postgres <<SQL
SET log_min_duration_statement = -1;
SET log_min_error_statement = 'panic';
SET log_statement = 'none';
CREATE ROLE "$GATEWAY_APP_USER" LOGIN PASSWORD '$GATEWAY_APP_PASSWORD' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 24;
ALTER DATABASE "$POSTGRES_DB" OWNER TO "$GATEWAY_APP_USER";
REVOKE ALL ON DATABASE "$POSTGRES_DB" FROM PUBLIC;
GRANT CONNECT ON DATABASE "$POSTGRES_DB" TO "$GATEWAY_APP_USER";
REVOKE ALL ON DATABASE postgres FROM PUBLIC;
REVOKE ALL ON DATABASE template1 FROM PUBLIC;
SQL

# the data folder's own hba file (the image wrote «trust» for every address when it was told not to ask for a password) is replaced by the strict one before the server ever listens: even if the
# server were started without the mounted file, no address would be trusted
install -m 0600 /etc/postgresql/pg_hba.conf "$PGDATA/pg_hba.conf"
