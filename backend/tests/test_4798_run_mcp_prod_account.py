"""story 4798 (AC7, the prod MCP service) — `sprintable-mcp-prod` runs as its own account, `run-mcp-prod`, not as the default compute account.

The service forwards each request to the backend with the caller's own bearer and uses no Google API; the only thing it needs from the platform is the one fallback secret mounted at start. So its account holds NO project role. The build
(`deploy-mcp` step) and the manual prod deploy script now name the account; dev is not changed. These tests run the REAL build step with only `gcloud` recorded and the manual script with `gcloud` and `curl` recorded, read the arguments of
the call that deploys the service, run `setup_iam.sh` with a recording `gcloud` (the account created with exactly its grants; every failure ends the script), and keep the account apart from the other dedicated and shared accounts."""
from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path

import pytest

from tests.test_4798_memo_bucket_per_env import _CLOUDBUILD, _STUB, _step

_ROOT = Path(__file__).resolve().parents[2]
_SCRIPTS = _ROOT / "backend" / "scripts"
_PROJECT = "sprintable-494803"
_NEW = f"run-mcp-prod@{_PROJECT}.iam.gserviceaccount.com"


def _build_calls(deploy_env: str) -> list[list[str]]:
    """the gcloud calls the REAL `deploy-mcp` step makes, one list of arguments per call"""
    subs = {k: str(v) for k, v in (_CLOUDBUILD.get("substitutions") or {}).items()}
    subs["_DEPLOY_ENV"] = deploy_env
    script = re.sub(r"\$\{(_[A-Z0-9_]+)\}", lambda m: subs.get(m.group(1), ""), _step("deploy-mcp")).replace("$$", "$")
    names = set(re.findall(r"\$\{([A-Za-z][A-Za-z0-9_]*)\}", script))
    env = {**os.environ, **{n: "x" for n in names}, "PROJECT_ID": "p", "COMMIT_SHA": "c", "SHORT_SHA": "c", "BUILD_ID": "b"}
    out = subprocess.run(["bash", "-c", _STUB + script], capture_output=True, text=True, env=env, cwd=_ROOT, timeout=60)
    # the step ends with a check of the served image: the stub's answer cannot match, so the step may exit non-zero AFTER the update call — the update call is what is judged
    chunks = out.stdout.split("ENDCALL\n")
    return [[a[4:] for a in c.splitlines() if a.startswith("ARG=")] for c in chunks if "ARG=" in c]


def _update_call(deploy_env: str) -> list[str]:
    calls = _build_calls(deploy_env)
    updates = [c for c in calls if c[:3] == ["run", "services", "update"]]
    assert len(updates) == 1, calls
    return updates[0]


def test_the_prod_build_deploys_the_mcp_service_as_the_dedicated_account():
    argv = _update_call("prod")
    assert [a for a in argv if a.startswith("--service-account")] == ["--service-account=run-mcp-prod@p.iam.gserviceaccount.com"], argv
    assert argv[3] == "sprintable-mcp-prod"


def test_the_dev_build_does_not_change_the_dev_mcp_service():
    argv = _update_call("dev")
    assert not [a for a in argv if a.startswith("--service-account")], argv
    assert argv[3] == "sprintable-mcp-dev"


def test_the_build_still_mounts_the_one_secret_and_removes_the_old_plain_variable():
    argv = _update_call("prod")
    assert "--update-secrets=AGENT_API_KEY=MCP_AGENT_API_KEY_PROD:latest" in argv, argv
    assert "--remove-env-vars=AGENT_API_KEY" in argv, argv


def test_no_other_gcloud_call_of_the_step_carries_an_account():
    calls = [c for c in _build_calls("prod") if c[:3] != ["run", "services", "update"]]
    assert calls, "the step's check calls were not seen"
    assert not [a for c in calls for a in c if a.startswith("--service-account")], calls


@pytest.fixture
def recorders(tmp_path):
    """a `gcloud` that records each call as ARG lines and answers a URL to `describe`, and a `curl` that answers 200"""
    log = tmp_path / "calls.txt"
    b = tmp_path / "bin"
    b.mkdir()
    g = b / "gcloud"
    g.write_text(f'#!/bin/sh\nfor a in "$@"; do printf "ARG=%s\\n" "$a" >> "{log}"; done\nprintf "ENDCALL\\n" >> "{log}"\nif [ -n "$K_FAIL" ] && echo "$*" | grep -q -- "$K_FAIL"; then exit 1; fi\ncase " $* " in *" describe "*) echo "https://x.run.app";; esac\nexit 0\n')
    g.chmod(0o755)
    c = b / "curl"
    c.write_text('#!/bin/sh\necho 200\nexit 0\n')
    c.chmod(0o755)
    return b, log


def _calls(log: Path) -> list[list[str]]:
    return [[a[4:] for a in chunk.splitlines() if a.startswith("ARG=")] for chunk in log.read_text().split("ENDCALL\n") if "ARG=" in chunk] if log.exists() else []


def _run_script(name: str, args: list[str], recorders, extra=None, expect_ok=True):
    b, log = recorders
    env = {**os.environ, "PATH": f"{b}{os.pathsep}{os.environ['PATH']}", **(extra or {})}
    proc = subprocess.run(["bash", str(_SCRIPTS / name), *args], capture_output=True, text=True, env=env, timeout=120)
    if expect_ok:
        assert proc.returncode == 0, proc.stderr[-400:]
    return proc, _calls(log)


def test_the_manual_prod_deploy_script_names_the_dedicated_account(recorders):
    _, calls = _run_script("deploy_mcp_prod.sh", [], recorders)
    deploys = [c for c in calls if c[:3] == ["run", "deploy", "sprintable-mcp-prod"]]
    assert len(deploys) == 1, calls
    assert [a for a in deploys[0] if a.startswith("--service-account")] == [f"--service-account={_NEW}"], deploys[0]


def test_the_manual_dev_deploy_script_is_not_changed():
    assert "--service-account" not in (_SCRIPTS / "deploy_mcp_dev.sh").read_text()


def test_the_dedicated_account_is_apart_from_every_other_account_the_scripts_name(recorders):
    """compared with what the REAL scripts name: the build's account, the manual script's account, the prod database jobs' account (the migrate script's dry run) are the MCP account — and not the database jobs' account, not the default compute account"""
    build_account = next(a for a in _update_call("prod") if a.startswith("--service-account=")).split("=", 1)[1]
    assert build_account == "run-mcp-prod@p.iam.gserviceaccount.com"
    _, calls = _run_script("deploy_mcp_prod.sh", [], recorders)
    manual = next(a for c in calls if c[:3] == ["run", "deploy", "sprintable-mcp-prod"] for a in c if a.startswith("--service-account=")).split("=", 1)[1]
    assert manual == _NEW
    dry = subprocess.run(["bash", str(_SCRIPTS / "provision_migrate_job.sh"), "prod"], capture_output=True, text=True, check=True, timeout=60, env={**os.environ, "DRY_RUN": "1"}).stdout
    migrate_account = next(l.split("=", 1)[1] for l in dry.splitlines() if l.startswith("SERVICE_ACCOUNT="))
    assert migrate_account, "the database jobs' account is not shown by the migrate script's dry run"
    for mcp in (build_account, manual):
        assert mcp.split("@")[0] != migrate_account.split("@")[0], (mcp, migrate_account)
        assert not mcp.endswith("-compute@developer.gserviceaccount.com")
        assert not mcp.startswith("cloudrun-runtime-")


# ── the account is created reproducibly (setup_iam.sh) with exactly the grants the service needs ──


def _setup(recorders, extra=None, expect_ok=True):
    return _run_script("setup_iam.sh", [], recorders, {"GCP_PROJECT": "proj-x", "PROJECT_NUMBER": "123456", **(extra or {})}, expect_ok)


def test_setup_iam_creates_the_mcp_account_with_no_project_role_and_one_secret(recorders):
    proc, calls = _setup(recorders)
    joined = [" ".join(c) for c in calls]
    assert any(j.startswith("iam service-accounts create run-mcp-prod ") for j in joined), joined
    # no project-level binding of any kind for this account
    assert not [j for j in joined if j.startswith("projects add-iam-policy-binding") and "run-mcp-prod@" in j], joined
    # the build's account may deploy the service as it — on this account only
    assert any(j.startswith("iam service-accounts add-iam-policy-binding run-mcp-prod@proj-x") and "--member=serviceAccount:123456-compute@developer.gserviceaccount.com" in j and "--role=roles/iam.serviceAccountUser" in j for j in joined), joined
    # exactly one secret, granted on the secret
    grants = [j for j in joined if j.startswith("secrets add-iam-policy-binding") and "--member=serviceAccount:run-mcp-prod@proj-x.iam.gserviceaccount.com" in j]
    assert len(grants) == 1 and "MCP_AGENT_API_KEY_PROD" in grants[0] and "--role=roles/secretmanager.secretAccessor" in grants[0], grants
    assert "--service-account=run-mcp-prod@proj-x.iam.gserviceaccount.com" in proc.stdout


@pytest.mark.parametrize(
    "fail_on, said",
    [
        ("describe MCP_AGENT_API_KEY_PROD", "could not grant the secret"),
        ("add-iam-policy-binding run-mcp-prod@", "could not allow the build account"),
    ],
)
def test_setup_iam_fails_loudly_when_a_grant_of_the_mcp_account_fails(recorders, fail_on, said):
    proc, _ = _setup(recorders, {"K_FAIL": fail_on}, expect_ok=False)
    assert proc.returncode != 0, (proc.stdout[-300:], proc.stderr[-300:])
    assert said in proc.stderr, proc.stderr[-500:]
    assert "run-mcp-prod failed" in proc.stderr


def test_the_helper_knows_the_mcp_target(recorders):
    _, calls = _run_script("grant_secret_access.sh", ["mcp-prod", "SECRET_A"], recorders, {"GCP_PROJECT": "proj-x"})
    assert any("--member=serviceAccount:run-mcp-prod@proj-x.iam.gserviceaccount.com" in " ".join(c) for c in calls), calls
