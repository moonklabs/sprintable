"""story 4798 (AC15) — the dev backend's admin-operator allowlist names the dev admin screen's OWN account.

The dev admin screen used to run as an account it shared with the prod admin screen, and the dev backend's allowlist named that shared address. Now the dev screen runs as `run-admin-ui-dev` and the allowlist names only it, so the account of the
prod screen is not accepted by the dev backend. The value is ONE address: the build passes env values through a comma-separated list, so a second address would not survive. These tests read the substitution, run the REAL `deploy-backend` step
for dev and prod with only `gcloud` recorded, and scan the tracked deploy files for the shared address."""
from __future__ import annotations

import subprocess
from pathlib import Path

from tests.test_4798_memo_bucket_per_env import _CLOUDBUILD, _env_vars

_ROOT = Path(__file__).resolve().parents[2]
_NEW = "run-admin-ui-dev@sprintable-494803.iam.gserviceaccount.com"
_SHARED_WITH_PROD = "sprintable-admin-web@sprintable-494803.iam.gserviceaccount.com"


def test_the_allowlist_substitution_is_the_dev_screen_account_alone():
    value = _CLOUDBUILD["substitutions"]["_ADMIN_OPERATOR_ALLOWLIST"]
    assert value == _NEW
    # (the exact equality above already says: one address, not the shared one, not the compute account — a list would be split by the env-variable assembly)


def test_the_dev_backend_step_hands_that_one_address_to_the_service():
    assert _env_vars("deploy-backend", "dev")["ADMIN_OPERATOR_ALLOWLIST"] == _NEW


def test_the_prod_backend_step_carries_no_operator_allowlist_at_all():
    assert "ADMIN_OPERATOR_ALLOWLIST" not in _env_vars("deploy-backend", "prod")
    assert "ADMIN_OPERATOR_AUDIENCE" not in _env_vars("deploy-backend", "prod")


def test_no_tracked_deploy_file_names_the_account_the_prod_screen_runs_as():
    raw = subprocess.run(["git", "-C", str(_ROOT), "ls-files", "-z"], capture_output=True, check=True, timeout=60).stdout
    hits = []
    for n in (x.decode() for x in raw.split(b"\0") if x):
        if not ("/" not in n and n.startswith("cloudbuild") or n.startswith((".github/", "deploy/", "infra/", "backend/scripts/"))):  # every build file at the root (cloudbuild.yaml, cloudbuild-vm.yaml …) and the deploy folders
            continue
        try:
            text = (_ROOT / n).read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        if _SHARED_WITH_PROD in text:
            hits.append(n)
    assert hits == [], hits
