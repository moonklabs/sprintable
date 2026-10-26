"""story 4790 (E-INFRA-DIET) — the read replica `sprintable-prod-replica` was deleted on 2026-10-26 (09:29Z). What stayed behind in the repository pointed at the deleted instance: the PgBouncer alias that routed `<db>_read` to the
replica's address. It is gone; this keeps it gone. (That the build and the secret manifest no longer name the replica's secret `DATABASE_URL_READ` is kept by `test_4790_read_secret_gone.py`.)"""
from __future__ import annotations

import re
import subprocess
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[2]
_PGBOUNCER = _ROOT / "infra/pgbouncer/deploy_prod.sh"


def test_pgbouncer_prod_has_no_route_to_the_deleted_replica():
    text = _PGBOUNCER.read_text()
    assert "REPLICA" not in text and "replica" not in text.lower()
    assert not re.search(r"^\$\{DB_NAME\}_read\s*=", text, flags=re.M)
    assert re.search(r"^\$\{DB_NAME\} = host=\$\{CLOUDSQL_PROD_IP\}", text, flags=re.M)  # positive control: the primary pool stays
    assert subprocess.run(["bash", "-n", str(_PGBOUNCER)], capture_output=True).returncode == 0  # still valid shell
