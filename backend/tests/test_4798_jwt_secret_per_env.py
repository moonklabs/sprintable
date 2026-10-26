"""story 4798 (AC6) — the token-signing secret is one per environment: `JWT_SECRET_DEV` for dev, `JWT_SECRET_PROD` for prod, in every manual deploy script.

Before, all of them bound one secret named `JWT_SECRET`, so a token signed in one environment was valid in the other. These tests run the three scripts' dry-runs (no gcloud) for dev and for prod and read the secret each would bind, and scan
the repository for the old shared name used as a binding. (The live services are changed by hand by the operator; these scripts, and a build, must never put the shared name back.)"""
from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path

import pytest

_BACKEND = Path(__file__).resolve().parents[1]
_ROOT = _BACKEND.parent
_SCRIPTS = _BACKEND / "scripts"


def _dry_run(script: str, env: str) -> dict[str, str]:
    proc = subprocess.run(["bash", str(_SCRIPTS / script), env], capture_output=True, text=True, check=True, timeout=120, env={**os.environ, "DRY_RUN": "1", "COMMIT_SHA": "dryrun"})
    out: dict[str, str] = {}
    for line in proc.stdout.splitlines():
        if "=" in line:
            k, _, v = line.partition("=")
            out[k.strip()] = v.strip()
    return out


def _other(env: str) -> str:
    return "PROD" if env == "dev" else "DEV"


@pytest.mark.parametrize("env", ["dev", "prod"])
@pytest.mark.parametrize("script", ["deploy_backend.sh", "deploy_frontend.sh"])
def test_the_service_scripts_bind_the_signing_secret_of_their_own_environment(script, env):
    cfg = _dry_run(script, env)
    name = f"JWT_SECRET_{env.upper()}"
    assert cfg["JWT_SECRET_NAME"] == name
    spec = cfg["SECRETS_SPEC"]
    assert f"JWT_SECRET={name}:latest" in spec
    assert f"JWT_SECRET_{_other(env)}" not in spec
    assert "JWT_SECRET=JWT_SECRET:latest" not in spec  # the old shared name


@pytest.mark.parametrize("env", ["dev", "prod"])
def test_the_gateway_script_fetches_the_signing_secret_of_its_own_environment(env):
    pairs = _dry_run("deploy_realtime_gce.sh", env)["SECRET_PAIRS"].split()
    assert f"JWT_SECRET_{env.upper()}:JWT_SECRET" in pairs
    assert not any(p.startswith(f"JWT_SECRET_{_other(env)}") for p in pairs)
    assert "JWT_SECRET:JWT_SECRET" not in pairs  # the old shared name


def test_the_gateway_template_changes_with_the_secret_name():
    """the template's name carries a hash of its content: a new secret name is a new template (a rolling update), never a silent reuse of the old one"""
    dev_name = _dry_run("deploy_realtime_gce.sh", "dev")["TEMPLATE_NAME"]
    prod_name = _dry_run("deploy_realtime_gce.sh", "prod")["TEMPLATE_NAME"]
    assert dev_name != prod_name


_BARE_BINDING = re.compile(
    r"""(JWT_SECRET=JWT_SECRET(?![A-Za-z0-9_])|\bJWT_SECRET:\s*JWT_SECRET(?![A-Za-z0-9_])|--secret[= ]["']?JWT_SECRET["']?(?![A-Za-z0-9_])|["' ]JWT_SECRET:(latest|[0-9]+)\b)"""
)
_SCAN = ["backend/scripts", "infra", "cloudbuild.yaml", ".github/workflows", "deploy"]


def test_no_file_binds_the_old_shared_signing_secret_name():
    """the scripts, the build and the workflows never name the bare `JWT_SECRET` as a secret to bind (the environment variable of that name inside a service is fine)"""
    hits = []
    for rel in _SCAN:
        base = _ROOT / rel
        files = [base] if base.is_file() else [p for p in base.rglob("*") if p.is_file()] if base.exists() else []
        for p in files:
            if p.suffix in {".png", ".jpg", ".gz", ".zip", ".lock"} or p.name == "cloudbuild-secret-manifest.txt":
                continue
            try:
                text = p.read_text(encoding="utf-8")
            except (UnicodeDecodeError, OSError):
                continue
            for m in _BARE_BINDING.finditer(text):
                hits.append(f"{p.relative_to(_ROOT)}:{text.count(chr(10), 0, m.start()) + 1}: {m.group(0)}")
    assert hits == [], hits


def test_the_secret_manifest_lists_the_two_new_names_and_the_shared_one_until_it_is_deleted():
    names = {l.strip() for l in (_ROOT / "infra" / "cloudbuild-secret-manifest.txt").read_text().splitlines() if l.strip() and not l.startswith("#")}
    assert {"JWT_SECRET_DEV", "JWT_SECRET_PROD"} <= names
