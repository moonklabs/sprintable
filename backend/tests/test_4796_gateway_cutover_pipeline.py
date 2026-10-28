"""story 4796 (D2, PO 2026-10-28) — the dev build can put the support gateway's DATABASE on the VM (the gateway itself stays on Cloud Run), behind ONE switch.

`_SUPPORT_GATEWAY_DB_ON_VM` (cloudbuild.yaml, default "false"; cloud-build.yml: dev states it, prod states nothing and an empty value becomes "false"). Exactly "true":
  · the gateway service loses its Cloud SQL socket (`--clear-cloudsql-instances` — gcloud KEEPS an instance that is only left out) and runs on the gateway's OWN subnet `support-gateway-<env>` (a network tag cannot be the source of an ingress firewall rule for Direct VPC egress, so the VM's firewall names the subnet's range);
  · its migrate job does the same (`jobs deploy` has no --clear-cloudsql-instances: `--set-cloudsql-instances=` with an empty list replaces it) — both checked against the real gcloud parser below;
  · the service gets the pool (3 + 2 from the workflow), sent ONLY when both values are non-empty; one without the other stops the step.
Every other value leaves the argument lists exactly as they were: the «off» lists are written out here in full.

Run for real: the step's script and the provisioning script are executed against a fake gcloud that records each argument; the real `gcloud` (when installed) is asked to PARSE the on-lists with an empty
configuration directory, so it stops at «no active account» before any request could be made.
"""
from __future__ import annotations

import re
import shutil
import stat
import subprocess
from pathlib import Path

import pytest
import yaml

from tests import _real_gcloud as _gcloud

_ROOT = Path(__file__).resolve().parents[2]
_CLOUDBUILD = (_ROOT / "cloudbuild.yaml").read_text()
_STEPS = {s["id"]: s for s in yaml.safe_load(_CLOUDBUILD)["steps"]}
_WORKFLOW = (_ROOT / ".github/workflows/cloud-build.yml").read_text()
_PROVISION = _ROOT / "support-gateway/scripts/provision_migrate_job.sh"
NOT_TRUE = ["", "false", "True", "TRUE", "1", "yes", " true", "true "]
SA = "support-gateway-dev@p.iam.gserviceaccount.com"


def _sub(text: str, values: dict[str, str]) -> str:
    for k, v in values.items():
        text = text.replace("${" + k + "}", v)
    return text.replace("$$", "$")


def _fake_gcloud(tmp: Path) -> tuple[Path, Path]:
    b = tmp / "bin"
    b.mkdir(exist_ok=True)
    log = tmp / "calls.log"
    log.write_text("")
    shim = b / "gcloud"
    shim.write_text('#!/bin/sh\nfor a in "$@"; do printf "%s\\n" "$a" >> "$FAKE_LOG"; done\nprintf -- "--END--\\n" >> "$FAKE_LOG"\n')
    shim.chmod(shim.stat().st_mode | stat.S_IEXEC)
    return b, log


def _calls(log: Path) -> list[list[str]]:
    out, cur = [], []
    for line in log.read_text().splitlines():
        if line == "--END--":
            out.append(cur)
            cur = []
        else:
            cur.append(line)
    return out


def _values(switch: str, env: str = "dev", pool: str = "", overflow: str = "") -> dict[str, str]:
    return {"_SUPPORT_GATEWAY_DB_ON_VM": switch, "_SUPPORT_GATEWAY_DB_POOL_SIZE": pool, "_SUPPORT_GATEWAY_DB_MAX_OVERFLOW": overflow, "_DEPLOY_ENV": env, "_AR_REGION": "r", "_AR_REPO": "repo",
            "PROJECT_ID": "p", "COMMIT_SHA": "abc", "_FASTAPI_URL": "https://dev-api.sprintable.ai", "_SUPPORT_GATEWAY_DEPLOY_ENABLED": "true", "_SUPPORT_GATEWAY_SERVICE_ACCOUNT": SA,
            "_SUPPORT_GATEWAY_MIN_INSTANCES": "0", "_SUPPORT_GATEWAY_MAX_INSTANCES": "2", "_SUPPORT_GATEWAY_CORS_ORIGINS": ""}


def _run_service_step(tmp: Path, **kw) -> tuple[int, list[list[str]], str]:
    step = _STEPS["deploy-support-gateway"]
    args = [_sub(a, _values(**kw)) for a in step["args"]]
    assert step["entrypoint"] == "bash" and args[0] == "-c"
    b, log = _fake_gcloud(tmp)
    p = subprocess.run(["/bin/bash", "-c", args[1]], capture_output=True, text=True, timeout=30, cwd=tmp, env={"PATH": f"{b}:/usr/bin:/bin", "FAKE_LOG": str(log), "HOME": str(tmp)})
    return p.returncode, _calls(log), p.stderr


def _run_job_script(tmp: Path, switch: str | None, env: str = "dev", dry: bool = False) -> tuple[int, list[list[str]], str]:
    b, log = _fake_gcloud(tmp)
    e = {"PATH": f"{b}:/usr/bin:/bin", "FAKE_LOG": str(log), "HOME": str(tmp), "COMMIT_SHA": "abc", "SUPPORT_GATEWAY_SERVICE_ACCOUNT": SA, "GCP_PROJECT": "p", "GCP_REGION": "r", "AR_REPO": "repo"}
    if switch is not None:
        e["SUPPORT_GATEWAY_DB_ON_VM"] = switch
    if dry:
        e["DRY_RUN"] = "1"
    p = subprocess.run(["bash", str(_PROVISION), env], capture_output=True, text=True, timeout=30, cwd=tmp, env=e)
    return p.returncode, _calls(log), p.stdout


def _secrets(env: str) -> str:
    return (f"SUPPORT_GATEWAY_DATABASE_URL=SUPPORT_GATEWAY_DATABASE_URL_{env}:latest,SUPPORT_GATEWAY_TOKEN_SECRET=SUPPORT_GATEWAY_TOKEN_SECRET_{env}:latest,"
            f"SUPPORT_GATEWAY_ADMIN_TOKEN=SUPPORT_GATEWAY_ADMIN_TOKEN_{env}:latest")


def _service_off(env: str) -> list[str]:
    """the argument list of the gateway deploy before this change, written out"""
    envvars = f"^;^SUPPORT_GATEWAY_VERTEX_PROJECT=p;SUPPORT_GATEWAY_BACKEND_ESCALATION_EVENTS_URL=https://dev-api.sprintable.ai/api/v2/support/escalation-events"
    return ["run", "deploy", f"support-gateway-{env}", "--image=r-docker.pkg.dev/p/repo/support-gateway:abc", "--region=r", *(["--cpu-throttling"] if env == "dev" else []), f"--service-account={SA}",
            "--min-instances=0", "--max-instances=2", "--allow-unauthenticated", f"--add-cloudsql-instances=p:r:sprintable-{env}", "--network=default", "--subnet=default",
            "--vpc-egress=private-ranges-only", f"--update-env-vars={envvars}", f"--update-secrets={_secrets(env)}", "--quiet"]


# ── the switch and its wiring ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

def test_the_switch_defaults_to_cloud_sql_and_only_dev_states_it() -> None:
    assert re.search(r'^  _SUPPORT_GATEWAY_DB_ON_VM: "false"$', _CLOUDBUILD, flags=re.M) and re.search(r'^  _SUPPORT_GATEWAY_DB_POOL_SIZE: ""$', _CLOUDBUILD, flags=re.M)
    block = _WORKFLOW.split('if [[ "$REF_NAME" == "main" ]]; then')[1]
    prod, dev = re.split(r"^          else\n", block, maxsplit=1, flags=re.M)
    assert "support_gateway_db_on_vm" not in prod.replace("# story 4796 (D2): prod's gateway does not exist", ""), "prod states nothing"
    assert dev.count('echo "support_gateway_db_on_vm=true" >> "$GITHUB_OUTPUT"') == 1 and "support_gateway_db_on_vm=false" not in dev, "dev states it, on: the cutover flipped this one word"
    assert 'echo "support_gateway_db_pool_size=3"' in dev and 'echo "support_gateway_db_max_overflow=2"' in dev
    assert 'V_SUPPORT_GATEWAY_DB_ON_VM="${V_SUPPORT_GATEWAY_DB_ON_VM:-false}"' in _WORKFLOW, "an empty output becomes false"
    for name in ("DB_ON_VM", "DB_POOL_SIZE", "DB_MAX_OVERFLOW"):
        assert f'_SUPPORT_GATEWAY_{name}=\\"${{V_SUPPORT_GATEWAY_{name}}}\\"' in _WORKFLOW, name


def test_the_switch_is_read_by_the_service_step_and_the_job_step_only() -> None:
    users = sorted(i for i, s in _STEPS.items() if "_SUPPORT_GATEWAY_DB_ON_VM" in yaml.safe_dump(s))
    assert users == ["deploy-support-gateway", "update-support-gateway-migrate-job"], users


def test_the_order_of_the_gateway_steps_is_unchanged() -> None:
    assert _STEPS["update-support-gateway-migrate-job"]["waitFor"] == ["push-support-gateway"]
    assert _STEPS["run-support-gateway-migrate-job"]["waitFor"] == ["update-support-gateway-migrate-job"]
    assert _STEPS["deploy-support-gateway"]["waitFor"] == ["run-support-gateway-migrate-job"]


def test_the_flip_is_one_word() -> None:
    dev = _WORKFLOW.split('if [[ "$REF_NAME" == "main" ]]; then')[1].split("          else\n", 1)[1]
    flipped_back = dev.replace('echo "support_gateway_db_on_vm=true"', 'echo "support_gateway_db_on_vm=false"')
    assert flipped_back != dev and flipped_back.count("support_gateway_db_on_vm=false") == 1 and len(flipped_back) == len(dev) + 1, "the way back is the same one word"


# ── the service step, run for real ──────────────────────────────────────────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("env", ["dev", "prod"])
@pytest.mark.parametrize("switch", NOT_TRUE)
def test_anything_but_true_leaves_the_gateway_deploy_exactly_as_it_was(tmp_path: Path, env: str, switch: str) -> None:
    rc, calls, _ = _run_service_step(tmp_path, switch=switch, env=env, pool="3", overflow="2")
    assert rc == 0 and calls == [_service_off(env)], "even with a pool on offer, nothing about it is sent while the switch is off"


def test_true_clears_the_cloud_sql_socket_moves_the_service_to_its_own_subnet_and_sends_the_pool(tmp_path: Path) -> None:
    rc, calls, _ = _run_service_step(tmp_path, switch="true", pool="3", overflow="2")
    assert rc == 0 and len(calls) == 1
    got, off = calls[0], _service_off("dev")
    assert "--add-cloudsql-instances=p:r:sprintable-dev" not in got and "--clear-cloudsql-instances" in got and "--subnet=support-gateway-dev" in got
    assert "--subnet=default" not in got and not [a for a in got if "network-tags" in a], "its own subnet instead of the default one, and no network tag"
    assert "--network=default" in got and "--vpc-egress=private-ranges-only" in got, "the VPC egress it needs for the VM's private address stays"
    env_arg = next(a for a in got if a.startswith("--update-env-vars="))
    assert env_arg.endswith(";SUPPORT_GATEWAY_DB_POOL_SIZE=3;SUPPORT_GATEWAY_DB_MAX_OVERFLOW=2") and env_arg.startswith("--update-env-vars=^;^SUPPORT_GATEWAY_VERTEX_PROJECT=p;")
    rest = [a for a in got if a not in ("--clear-cloudsql-instances", "--subnet=support-gateway-dev") and not a.startswith("--update-env-vars=")]
    assert rest == [a for a in off if a not in ("--add-cloudsql-instances=p:r:sprintable-dev", "--subnet=default") and not a.startswith("--update-env-vars=")], "nothing else changes"


def test_the_subnet_follows_the_environment(tmp_path: Path) -> None:
    rc, calls, _ = _run_service_step(tmp_path, switch="true", env="prod")
    assert rc == 0 and "--subnet=support-gateway-prod" in calls[0] and "--subnet=support-gateway-dev" not in calls[0]


@pytest.mark.parametrize("pool,overflow,sent,ok", [("", "", False, True), ("3", "2", True, True), ("3", "", False, False), ("", "2", False, False)])
def test_the_pool_is_sent_only_when_both_values_are_there_and_a_half_stops_the_step(tmp_path: Path, pool: str, overflow: str, sent: bool, ok: bool) -> None:
    rc, calls, err = _run_service_step(tmp_path, switch="true", pool=pool, overflow=overflow)
    assert (rc == 0) is ok
    if not ok:
        assert calls == [] and "must be set together" in err, "no deploy with a half pool"
        return
    env_arg = next(a for a in calls[0] if a.startswith("--update-env-vars="))
    assert ("SUPPORT_GATEWAY_DB_POOL_SIZE" in env_arg) is sent and ("SUPPORT_GATEWAY_DB_MAX_OVERFLOW" in env_arg) is sent


def test_the_step_still_skips_when_the_gateway_is_not_deployed(tmp_path: Path) -> None:
    step = _STEPS["deploy-support-gateway"]
    values = {**_values(switch="true", pool="3", overflow="2"), "_SUPPORT_GATEWAY_DEPLOY_ENABLED": "false"}
    b, log = _fake_gcloud(tmp_path)
    args = [_sub(a, values) for a in step["args"]]
    p = subprocess.run(["/bin/bash", "-c", args[1]], capture_output=True, text=True, timeout=30, cwd=tmp_path, env={"PATH": f"{b}:/usr/bin:/bin", "FAKE_LOG": str(log), "HOME": str(tmp_path)})
    assert p.returncode == 0 and _calls(log) == []


# ── the migrate job's provisioning script, run for real ─────────────────────────────────────────────────────────────────────────────────────

def _job_off(env: str) -> list[str]:
    return ["run", "jobs", "deploy", f"sprintable-support-gateway-migrate-{env}", "--image=r-docker.pkg.dev/p/repo/support-gateway:abc", "--region=r", "--project=p", "--command=/app/scripts/migrate.sh",
            f"--service-account={SA}", f"--set-secrets=SUPPORT_GATEWAY_DATABASE_URL=SUPPORT_GATEWAY_DATABASE_URL_{env}:latest", f"--set-cloudsql-instances=p:r:sprintable-{env}", "--network=default",
            "--subnet=default", "--vpc-egress=private-ranges-only", "--execution-environment=gen2", "--max-retries=1", "--task-timeout=300"]


@pytest.mark.parametrize("switch", [None, *NOT_TRUE])
def test_the_migrate_job_is_provisioned_as_before_unless_the_switch_is_exactly_true(tmp_path: Path, switch) -> None:
    rc, calls, _ = _run_job_script(tmp_path, switch)
    assert rc == 0 and calls == [_job_off("dev")]


def test_with_the_switch_the_migrate_job_loses_its_socket_and_moves_to_the_gateways_subnet(tmp_path: Path) -> None:
    rc, calls, _ = _run_job_script(tmp_path, "true")
    assert rc == 0 and len(calls) == 1
    off = _job_off("dev")
    expected = [("--set-cloudsql-instances=" if a.startswith("--set-cloudsql-instances=") else "--subnet=support-gateway-dev" if a == "--subnet=default" else a) for a in off]
    assert calls[0] == expected, calls[0]
    assert not [a for a in calls[0] if "network-tags" in a], "no network tag"
    assert "--clear-cloudsql-instances" not in calls[0], "`jobs deploy` has no such flag (checked against the real parser below)"


def test_the_dry_run_of_the_script_says_what_the_switch_does_and_is_unchanged_without_it(tmp_path: Path) -> None:
    rc0, _, out0 = _run_job_script(tmp_path, None, dry=True)
    (tmp_path / "x").mkdir()
    rc1, _, out1 = _run_job_script(tmp_path / "x", "true", dry=True)
    assert rc0 == rc1 == 0 and "DB_ON_VM" not in out0 and "CLOUD_SQL_INSTANCE=p:r:sprintable-dev" in out0
    assert "DB_ON_VM=true CLOUD_SQL=cleared SUBNET=support-gateway-dev" in out1 and "subnet=support-gateway-dev,egress=private-ranges-only" in out1 and "subnet=default,egress=private-ranges-only" in out0


def test_the_job_step_hands_the_switch_to_the_script() -> None:
    body = yaml.safe_dump(_STEPS["update-support-gateway-migrate-job"])
    assert 'SUPPORT_GATEWAY_DB_ON_VM="${_SUPPORT_GATEWAY_DB_ON_VM}"' in _STEPS["update-support-gateway-migrate-job"]["args"][1] and "provision_migrate_job.sh ${_DEPLOY_ENV}" in body


# ── the real gcloud parser ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

def _real_gcloud_parse(argv: list[str], tmp: Path) -> str:
    """what the real gcloud says about an argument list with NO credentials and an empty configuration directory: a usage error means the list is wrong; «no active account» means it parsed and stopped
    before any request. Nothing can reach Google."""
    return _gcloud.text(_gcloud.run(argv, tmp))


needs_gcloud = pytest.mark.skipif(shutil.which("gcloud") is None, reason="no gcloud on this machine")


@needs_gcloud
def test_the_real_gcloud_accepts_both_lists_with_the_switch_on(tmp_path: Path) -> None:
    _, svc_calls, _ = _run_service_step(tmp_path, switch="true", pool="3", overflow="2")
    (tmp_path / "j").mkdir()
    _, job_calls, _ = _run_job_script(tmp_path / "j", "true")
    for argv in (svc_calls[0], job_calls[0]):
        out = _real_gcloud_parse(argv, tmp_path)
        assert "do not currently have an active account" in out, f"{argv[:3]}: {out[:400]}"
        assert "unrecognized arguments" not in out and "Usage:" not in out


@needs_gcloud
def test_the_real_gcloud_has_no_clear_flag_for_jobs_but_does_for_services(tmp_path: Path) -> None:
    job = _real_gcloud_parse(["run", "jobs", "deploy", "j", "--image=x", "--region=r", "--clear-cloudsql-instances", "--quiet"], tmp_path)
    assert "unrecognized arguments: --clear-cloudsql-instances" in job
    svc = _real_gcloud_parse(["run", "deploy", "s", "--image=x", "--region=r", "--clear-cloudsql-instances", "--add-cloudsql-instances=p:r:i", "--quiet"], tmp_path)
    assert "At most one of --add-cloudsql-instances | --clear-cloudsql-instances" in svc, "and it is exclusive with --add: the switch swaps the flag, it never adds the clear next to the add"


@needs_gcloud
def test_the_real_gcloud_accepts_the_off_lists_too(tmp_path: Path) -> None:
    for argv in (_service_off("dev"), _job_off("dev")):
        out = _real_gcloud_parse(argv, tmp_path)
        assert "do not currently have an active account" in out, out[:300]
