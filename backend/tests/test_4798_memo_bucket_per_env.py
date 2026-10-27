"""story 4798 — the attachments bucket is per environment: dev has its own, prod keeps the one it always had.

Before: neither environment named `GCS_MEMO_ATTACHMENTS_BUCKET`, so both used the code default `sprintable-memo-attachments` — one bucket for both. Now the dev build names its own bucket on the backend AND the frontend (both read
the variable), applies the attachments CORS to that bucket, and prod names nothing: it keeps the code default, so its data, its stored paths and its asset rows are untouched.

These tests run the REAL `deploy-backend`, `deploy-frontend` and `apply-gcs-attachments-cors` steps of `cloudbuild.yaml` with only `gcloud` replaced by a recorder (substitutions filled from the file's own declared defaults), for dev
and for prod, and read what each would have told gcloud."""
from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path

import yaml

_ROOT = Path(__file__).resolve().parents[2]
_CLOUDBUILD = yaml.safe_load((_ROOT / "cloudbuild.yaml").read_text())
_PROD_BUCKET = "sprintable-memo-attachments"
_DEV_BUCKET = "sprintable-memo-attachments-dev"
_STUB = (
    'gcloud() { printf "ARG=%s\\n" "$@"; printf "ENDCALL\\n"; '
    'case " $* " in *" describe "*) echo "https://sprintable-frontend-dev-787818285179.asia-northeast3.run.app x-goog-if-generation-match";; esac; }\n'
)


def _step(step_id: str) -> str:
    return next(s for s in _CLOUDBUILD["steps"] if s["id"] == step_id)["args"][1]


def _run(step_id: str, deploy_env: str) -> list[str]:
    subs = {k: str(v) for k, v in (_CLOUDBUILD.get("substitutions") or {}).items()}
    subs["_DEPLOY_ENV"] = deploy_env
    script = re.sub(r"\$\{(_[A-Z0-9_]+)\}", lambda m: subs.get(m.group(1), ""), _step(step_id)).replace("$$", "$")
    names = set(re.findall(r"\$\{([A-Za-z][A-Za-z0-9_]*)\}", script))
    env = {**os.environ, **{n: "x" for n in names}, "PROJECT_ID": "p", "COMMIT_SHA": "c", "SHORT_SHA": "c", "BUILD_ID": "b"}
    out = subprocess.run(["bash", "-c", _STUB + script], capture_output=True, text=True, env=env, cwd=_ROOT, timeout=60)
    assert out.returncode == 0, (step_id, deploy_env, out.stderr[-300:])
    return [line[4:] for line in out.stdout.splitlines() if line.startswith("ARG=")]


def _env_vars(step_id: str, deploy_env: str) -> dict[str, str]:
    args = _run(step_id, deploy_env)
    value = next(a for a in args if a.startswith("--update-env-vars=")).split("=", 1)[1]
    return dict(kv.split("=", 1) for kv in value.split(",") if "=" in kv)


def test_the_dev_bucket_is_declared_and_is_not_the_one_prod_uses():
    declared = _CLOUDBUILD["substitutions"]["_GCS_MEMO_ATTACHMENTS_BUCKET"]
    assert declared == _DEV_BUCKET
    assert declared != _PROD_BUCKET


def test_dev_backend_and_dev_frontend_name_the_dev_bucket():
    assert _env_vars("deploy-backend", "dev")["GCS_MEMO_ATTACHMENTS_BUCKET"] == _DEV_BUCKET
    assert _env_vars("deploy-frontend", "dev")["GCS_MEMO_ATTACHMENTS_BUCKET"] == _DEV_BUCKET


def test_prod_backend_and_prod_frontend_name_nothing_and_keep_the_code_default():
    assert "GCS_MEMO_ATTACHMENTS_BUCKET" not in _env_vars("deploy-backend", "prod")
    assert "GCS_MEMO_ATTACHMENTS_BUCKET" not in _env_vars("deploy-frontend", "prod")
    # the thing prod relies on: both servers' code default is the prod bucket (so «names nothing» is a decision, not a gap)
    backend = (_ROOT / "backend/app/routers/attachments.py").read_text()
    assert f'os.environ.get("GCS_MEMO_ATTACHMENTS_BUCKET", "{_PROD_BUCKET}")' in backend
    web = (_ROOT / "apps/web/src/lib/storage/config.ts").read_text()
    assert f"process.env['GCS_MEMO_ATTACHMENTS_BUCKET'] ?? '{_PROD_BUCKET}'" in web


def test_the_cors_step_touches_the_bucket_of_its_own_environment_only():
    dev = _run("apply-gcs-attachments-cors", "dev")
    prod = _run("apply-gcs-attachments-cors", "prod")
    assert f"gs://{_DEV_BUCKET}" in dev and f"gs://{_PROD_BUCKET}" not in dev, dev  # a dev build never writes the prod bucket's configuration
    assert f"gs://{_PROD_BUCKET}" in prod and f"gs://{_DEV_BUCKET}" not in prod, prod


def test_no_environment_declares_the_other_environments_bucket():
    """the dev branch never names the prod bucket anywhere in the two deploy steps, and the prod branch never names the dev one"""
    for step in ("deploy-backend", "deploy-frontend"):
        dev_vars = _env_vars(step, "dev")
        prod_vars = _env_vars(step, "prod")
        assert dev_vars.get("GCS_MEMO_ATTACHMENTS_BUCKET") != _PROD_BUCKET
        assert _DEV_BUCKET not in prod_vars.values()
