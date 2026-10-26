"""story 4790 (E-INFRA-DIET) — the secret `DATABASE_URL_READ` (the read replica's DSN) is gone from the repository's deploy wiring.
The replica was deleted on 2026-10-26 (09:29Z), PR 5246 took the binding out of the prod deploy, and the 2026-10-26 prod deploy (run 40350167707) left no service or job with the binding; this change then dropped the secret's name from the
prod `--remove-secrets` list and from the secret manifest. The secret itself is deleted by the operator after this change is merged.
This keeps the name from coming back into the build or the manifest without a reason."""
from __future__ import annotations

import re
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[2]
_CLOUDBUILD = (_ROOT / "cloudbuild.yaml").read_text()
_MANIFEST = (_ROOT / "infra/cloudbuild-secret-manifest.txt").read_text()


def test_the_build_names_the_replica_secret_nowhere():
    """not as a binding (`X=DATABASE_URL_READ:latest`), not in `--remove-secrets`, not as an env mapping — only a comment may mention it"""
    code = [line for line in _CLOUDBUILD.splitlines() if not line.lstrip().startswith("#")]
    assert [line for line in code if "DATABASE_URL_READ" in line] == []
    assert not re.search(r"DATABASE_URL_READ\s*(=|:latest)", _CLOUDBUILD)


def test_the_manifest_does_not_list_it_and_still_lists_the_live_secrets():
    names = [line.strip() for line in _MANIFEST.splitlines() if line.strip() and not line.startswith("#")]
    assert "DATABASE_URL_READ" not in names
    assert "DATABASE_URL_PROD" in names and "DATABASE_URL_PROD_PGBOUNCER" in names  # positive control: the list is read, and its neighbours are still there


def test_the_other_explicit_prod_removal_is_untouched():
    """the one `--remove-secrets` entry that is still needed (the edge client IP secret) is kept exactly"""
    assert 'RM_SECRETS="--remove-secrets=EDGE_CLIENT_IP_SECRET"' in _CLOUDBUILD
