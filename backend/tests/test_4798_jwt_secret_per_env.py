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


@pytest.fixture(scope="module")
def _no_gcloud(tmp_path_factory):
    """a `gcloud` that answers nothing and never touches the network (the frontend script's dry run still calls `gcloud run services describe`)"""
    d = tmp_path_factory.mktemp("bin")
    g = d / "gcloud"
    g.write_text("#!/bin/sh\nexit 0\n")
    g.chmod(0o755)
    return str(d)


@pytest.fixture(autouse=True)
def _stub(monkeypatch, _no_gcloud):
    monkeypatch.setenv("PATH", _no_gcloud + os.pathsep + os.environ["PATH"])


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


def test_the_template_name_follows_the_secret_name_it_is_built_with(tmp_path):
    """a copy of the scripts folder with the prod secret name put back to the old shared one builds a DIFFERENT template name than the real script: the name carries a hash of the generated startup script"""
    import shutil

    copy = tmp_path / "scripts"
    shutil.copytree(_SCRIPTS, copy, ignore=shutil.ignore_patterns("__pycache__", "jobs"))
    src = (copy / "deploy_realtime_gce.sh").read_text()
    assert src.count('JWT_SECRET_NAME="JWT_SECRET_PROD"') == 1
    (copy / "deploy_realtime_gce.sh").write_text(src.replace('JWT_SECRET_NAME="JWT_SECRET_PROD"', 'JWT_SECRET_NAME="JWT_SECRET"'))
    proc = subprocess.run(["bash", str(copy / "deploy_realtime_gce.sh"), "prod"], capture_output=True, text=True, check=True, timeout=120, env={**os.environ, "DRY_RUN": "1", "COMMIT_SHA": "dryrun"})
    old = dict(l.partition("=")[::2] for l in proc.stdout.splitlines() if "=" in l)["TEMPLATE_NAME"]
    assert old != _dry_run("deploy_realtime_gce.sh", "prod")["TEMPLATE_NAME"]


def test_the_gateway_startup_script_names_the_new_secret_so_its_template_is_a_new_one():
    """the template's name carries a hash of the generated startup script: the secret names written into that script are part of what is hashed. The block the script generates to fetch the secrets
    lists the names; for prod it must hold `JWT_SECRET_PROD` (so the hash — and with it the template — differs from the one built with the old shared name), as the env variable `JWT_SECRET`."""
    import base64

    for env in ("dev", "prod"):
        block = base64.b64decode(_dry_run("deploy_realtime_gce.sh", env)["GENERATED_FETCH_SECRETS_BLOCK_B64"]).decode()
        names = re.search(r"_secret_names=\((.*?)\)", block, re.S).group(1)
        env_names = re.search(r"_secret_env_names=\((.*?)\)", block, re.S).group(1)
        assert f"'JWT_SECRET_{env.upper()}'" in names
        assert "'JWT_SECRET'" not in names
        assert "'JWT_SECRET'" in env_names  # the variable the gateway's process reads keeps its name


_BARE_BINDING = re.compile(
    r"""(JWT_SECRET=JWT_SECRET(?![A-Za-z0-9_])|\bJWT_SECRET:\s*JWT_SECRET(?![A-Za-z0-9_])|--secret[= ]["']?JWT_SECRET["']?(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])JWT_SECRET:(latest|[0-9]+)\b"""
    r"""|\bcreate_secret\s+["']?JWT_SECRET["']?(?![A-Za-z0-9_])|\bsecrets\s+(create|describe|delete|get-iam-policy|add-iam-policy-binding|remove-iam-policy-binding|versions\s+\w+)\s+["']?JWT_SECRET["']?(?![A-Za-z0-9_]))"""
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
    assert "JWT_SECRET" in names  # the shared secret stays (nobody binds it) until the operator deletes it and drops the name in the same change
