"""story 4790 (E-INFRA-DIET) — the read replica `sprintable-prod-replica` was deleted on 2026-10-26 (09:29Z) and the prod binding of its secret was taken out of the deploy (PR 5246). What stayed behind in the repository
pointed at the deleted instance: the PgBouncer alias that routed `<db>_read` to the replica's address. It is gone; this keeps it gone, and keeps the build from binding the secret again.

Not here on purpose: (1) the `DATABASE_URL_READ` entry of the prod `--remove-secrets` list stays until a prod deploy has taken the binding off the running service; (2) the secret manifest keeps `DATABASE_URL_READ` while the
secret still exists in Secret Manager (the manifest is a read-only copy of the live secret names, checked daily against GCP) — the entry goes together with the deletion of the secret itself."""
from __future__ import annotations

import re
import subprocess
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[2]
_CLOUDBUILD = (_ROOT / "cloudbuild.yaml").read_text()
_PGBOUNCER = _ROOT / "infra/pgbouncer/deploy_prod.sh"


def test_the_build_binds_the_replica_secret_nowhere_it_only_names_it_to_remove_it():
    """no `X=DATABASE_URL_READ:latest` binding and no `DATABASE_URL_READ=` env mapping: the only mention is the `--remove-secrets` list (expires after a prod deploy has run)"""
    assert not re.search(r"DATABASE_URL_READ\s*(=|:latest)", _CLOUDBUILD)
    mentions = [line for line in _CLOUDBUILD.splitlines() if "DATABASE_URL_READ" in line and not line.lstrip().startswith("#")]
    assert mentions and all("--remove-secrets" in line for line in mentions), mentions


def test_pgbouncer_prod_has_no_route_to_the_deleted_replica():
    text = _PGBOUNCER.read_text()
    assert "REPLICA" not in text and "replica" not in text.lower()
    assert not re.search(r"^\$\{DB_NAME\}_read\s*=", text, flags=re.M)
    assert re.search(r"^\$\{DB_NAME\} = host=\$\{CLOUDSQL_PROD_IP\}", text, flags=re.M)  # positive control: the primary pool stays
    assert subprocess.run(["bash", "-n", str(_PGBOUNCER)], capture_output=True).returncode == 0  # still valid shell
