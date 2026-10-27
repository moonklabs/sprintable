"""story 4798 (AC7, the end state) — nothing of the repository's deploy paths runs as the default compute account: the dev MCP service and the dev document converter get their own accounts.

`run-mcp-dev` (the same recipe as the prod MCP service: no project role, one secret) and `run-converter-dev` (the public Gotenberg image that opens documents users uploaded: NOTHING — no project role, no secret). These tests run the
REAL `deploy-mcp` and `deploy-office-converter` steps with only `gcloud` recorded, the manual dev MCP script with `gcloud` and `curl` recorded, and `setup_iam.sh` with a recording `gcloud`; they keep the four dedicated accounts apart."""
from __future__ import annotations

import os
import re
import subprocess

import pytest

from tests.test_4798_run_mcp_prod_account import (  # noqa: F401  (the fixtures and runners of the prod MCP file, reused)
    _CLOUDBUILD,
    _ROOT,
    _SCRIPTS,
    _STUB,
    _build_calls,
    _calls,
    _run_script,
    _setup,
    _step,
    _update_call,
    recorders,
)


def _step_calls(step_id: str, deploy_env: str) -> list[list[str]]:
    """the gcloud calls the REAL step makes (one list of arguments per call)"""
    subs = {k: str(v) for k, v in (_CLOUDBUILD.get("substitutions") or {}).items()}
    subs["_DEPLOY_ENV"] = deploy_env
    script = re.sub(r"\$\{(_[A-Z0-9_]+)\}", lambda m: subs.get(m.group(1), ""), _step(step_id)).replace("$$", "$")
    names = set(re.findall(r"\$\{([A-Za-z][A-Za-z0-9_]*)\}", script))
    env = {**os.environ, **{n: "x" for n in names}, "PROJECT_ID": "p", "COMMIT_SHA": "c", "SHORT_SHA": "c", "BUILD_ID": "b"}
    out = subprocess.run(["bash", "-c", _STUB + script], capture_output=True, text=True, env=env, cwd=_ROOT, timeout=60)
    return [[a[4:] for a in c.splitlines() if a.startswith("ARG=")] for c in out.stdout.split("ENDCALL\n") if "ARG=" in c]


# ── the dev MCP service ──


def test_the_dev_build_deploys_the_mcp_service_as_the_dev_account():
    argv = _update_call("dev")
    assert [a for a in argv if a.startswith("--service-account")] == ["--service-account=run-mcp-dev@p.iam.gserviceaccount.com"], argv
    assert argv[3] == "sprintable-mcp-dev"


def test_the_two_builds_name_two_different_mcp_accounts():
    dev = [a for a in _update_call("dev") if a.startswith("--service-account=")]
    prod = [a for a in _update_call("prod") if a.startswith("--service-account=")]
    assert dev and prod and dev != prod


def test_the_manual_dev_mcp_script_names_the_dev_account(recorders):
    _, calls = _run_script("deploy_mcp_dev.sh", [], recorders)
    deploys = [c for c in calls if c[:3] == ["run", "deploy", "sprintable-mcp-dev"]]
    assert len(deploys) == 1, calls
    assert [a for a in deploys[0] if a.startswith("--service-account")] == ["--service-account=run-mcp-dev@sprintable-494803.iam.gserviceaccount.com"], deploys[0]


# ── the dev document converter ──


def test_the_dev_converter_is_deployed_as_the_converter_account():
    calls = _step_calls("deploy-office-converter", "dev")
    deploys = [c for c in calls if c[:3] == ["run", "deploy", "office-converter-dev"]]
    assert len(deploys) == 1, calls
    assert [a for a in deploys[0] if a.startswith("--service-account")] == ["--service-account=run-converter-dev@p.iam.gserviceaccount.com"], deploys[0]
    assert "--image=gotenberg/gotenberg:8.36" in deploys[0] and "--no-allow-unauthenticated" in deploys[0]
    assert "" not in deploys[0]


def test_no_other_call_of_the_converter_step_carries_an_account_and_the_invoker_binding_is_unchanged():
    calls = [c for c in _step_calls("deploy-office-converter", "dev") if c[:3] != ["run", "deploy", "office-converter-dev"]]
    assert calls, "the step's other calls were not seen"
    assert not [a for c in calls for a in c if a.startswith("--service-account")], calls
    invoker = [c for c in calls if c[:3] == ["run", "services", "add-iam-policy-binding"]]
    assert len(invoker) == 1 and "--member=serviceAccount:cloudrun-runtime-dev@p.iam.gserviceaccount.com" in invoker[0] and "--role=roles/run.invoker" in invoker[0], invoker


def test_the_prod_converter_step_is_still_skipped_and_makes_no_gcloud_call():
    assert _step_calls("deploy-office-converter", "prod") == []


# ── both accounts are created reproducibly (setup_iam.sh) ──


def test_setup_iam_creates_the_dev_mcp_account_like_the_prod_one(recorders):
    proc, calls = _setup(recorders)
    joined = [" ".join(c) for c in calls]
    assert any(j.startswith("iam service-accounts create run-mcp-dev ") for j in joined), joined
    assert not [j for j in joined if j.startswith("projects add-iam-policy-binding") and "run-mcp-dev@" in j], joined
    assert any(j.startswith("iam service-accounts add-iam-policy-binding run-mcp-dev@proj-x") and "--member=serviceAccount:123456-compute@developer.gserviceaccount.com" in j and "--role=roles/iam.serviceAccountUser" in j for j in joined), joined
    grants = [j for j in joined if j.startswith("secrets add-iam-policy-binding") and "--member=serviceAccount:run-mcp-dev@proj-x.iam.gserviceaccount.com" in j]
    assert len(grants) == 1 and "MCP_AGENT_API_KEY_DEV" in grants[0] and "MCP_AGENT_API_KEY_PROD" not in grants[0], grants


def test_setup_iam_creates_the_converter_account_holding_nothing(recorders):
    proc, calls = _setup(recorders)
    joined = [" ".join(c) for c in calls]
    assert any(j.startswith("iam service-accounts create run-converter-dev ") for j in joined), joined
    # NOTHING: no project-level binding, no secret binding of any kind for this account
    assert not [j for j in joined if "run-converter-dev@" in j and ("projects add-iam-policy-binding" in j or j.startswith("secrets "))], joined
    # the only grant that mentions it: the build's account may deploy the service as it
    mentions = [j for j in joined if "run-converter-dev@" in j and "add-iam-policy-binding" in j]
    assert len(mentions) == 1 and mentions[0].startswith("iam service-accounts add-iam-policy-binding run-converter-dev@proj-x") and "--role=roles/iam.serviceAccountUser" in mentions[0], mentions


@pytest.mark.parametrize(
    "fail_on, said, named",
    [
        ("describe MCP_AGENT_API_KEY_DEV", "could not grant the secret", "run-mcp-dev failed"),
        ("add-iam-policy-binding run-mcp-dev@", "could not allow the build account", "run-mcp-dev failed"),
        ("add-iam-policy-binding run-converter-dev@", "could not allow the build account", "run-converter-dev failed"),
    ],
)
def test_setup_iam_fails_loudly_when_a_dev_account_grant_fails(recorders, fail_on, said, named):
    proc, _ = _setup(recorders, {"K_FAIL": fail_on}, expect_ok=False)
    assert proc.returncode != 0, (proc.stdout[-300:], proc.stderr[-300:])
    assert said in proc.stderr and named in proc.stderr, proc.stderr[-600:]


def test_the_four_dedicated_accounts_are_four_different_real_accounts_and_none_is_a_shared_one(recorders):
    proc, _ = _setup(recorders)
    values = re.findall(r"--service-account=(\S*)", proc.stdout)
    dedicated = {v.split("@")[0] for v in values if v.split("@")[0].startswith("run-")}
    assert dedicated == {"run-migrate-prod", "run-mcp-prod", "run-mcp-dev", "run-converter-dev"}, values
    assert not [v for v in values if v.endswith("-compute@developer.gserviceaccount.com")], values
