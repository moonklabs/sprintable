#!/usr/bin/env bash
# rowcounts.sh [database] — exact row counts of every table in the VM database (default: the application database), «table<TAB>count» per line.
# The Cloud SQL side runs the same rowcounts.sql with psql; `diff` the two outputs = «row counts equal».
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$here/lib.sh"
db="${1:-$(db_name)}"
in_db psql -U "$(db_user)" -d "$db" -X -A -t -F $'\t' -v ON_ERROR_STOP=1 < "$here/rowcounts.sql"
