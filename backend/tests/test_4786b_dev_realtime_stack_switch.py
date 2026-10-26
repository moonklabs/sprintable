"""story 4786 (E-INFRA-DIET) part B — the dev GCE realtime gateways and realtime-dev are ONE switch, default off, and prod is not part of it. Redis and PG LISTEN are NOT part of it.

Why a behavioural guard: the stream address the frontend gets and the two deploy steps that would re-create the gateways live in two files and are only right TOGETHER (REALTIME_URL pointing at stopped gateways is a dead
stream; the steps running with the address empty fail). Redis stays on because the desktop relay's one-receiver / takeover contract rests on the Redis SSE lease on 2+ backend instances (found by the codex read of the
first version of this PR, which switched Redis off too): the guard pins that the switch does not touch it. The REAL dev branch of the workflow step is run in bash for both values.
"""
from __future__ import annotations

import os
import re
import subprocess
import tempfile
from pathlib import Path

import pytest

from tests.test_4786_dev_scale_to_zero import _CLOUDBUILD, _DEV, _PROD, _WORKFLOW
from tests.test_deploy_backend_redis_secret_conflict import (
    _apply_cloudbuild_escaping,
    _extract_step_script,
    _run_env_vars_assembly,
)

_REDIS_FLAGS = (
    "backend_redis_consume_enabled", "backend_redis_dispatch_enabled", "backend_redis_dual_publish_enabled", "backend_fanout_wake_redis_enabled",
    "backend_presence_redis_enabled", "backend_presence_online_redis_enabled", "backend_sse_lease_redis_enabled", "backend_sse_transient_replay_enabled",
)
_ON = {"dev_realtime_stack": "on", "realtime_url": "https://dev-realtime.sprintable.ai"}
_OFF = {"dev_realtime_stack": "off", "realtime_url": ""}


def _outputs_for(mode: str) -> dict[str, str]:
    """run the REAL dev branch of the workflow's «Set deploy environment» step (gcloud stubbed) with the switch set to `mode`, and read what it wrote to $GITHUB_OUTPUT"""
    dev = _DEV.replace("DEV_REALTIME_STACK=off", f"DEV_REALTIME_STACK={mode}", 1)
    with tempfile.TemporaryDirectory() as d:
        out = Path(d) / "out"
        # the slice ends with the `fi` that closes the step's if/else, so it is wrapped in the same shape; the first branch (prod) never runs
        script = "set -eo pipefail\ngcloud() { echo stub-value; }\nif false; then\n:\nelse\n" + dev
        subprocess.run(["bash", "-c", script], check=True, env={**os.environ, "GITHUB_OUTPUT": str(out)}, capture_output=True)
        return dict(line.split("=", 1) for line in out.read_text().splitlines() if "=" in line)


def test_the_switch_is_found_and_defaults_to_off():
    assert _DEV.count("DEV_REALTIME_STACK=off") == 1
    assert re.search(r"^\s+DEV_REALTIME_STACK=off$", _DEV, flags=re.M)


@pytest.mark.parametrize("mode,expected", [("off", _OFF), ("on", _ON)])
def test_the_stream_address_moves_with_the_switch(mode, expected):
    out = _outputs_for(mode)
    assert {k: out[k] for k in expected} == expected


@pytest.mark.parametrize("mode", ["off", "on"])
def test_the_switch_leaves_redis_pg_listen_the_rate_limiter_and_pgbouncer_alone(mode):
    """the relay contract (one receiver, takeover) needs the Redis SSE lease; dev backend runs 2+ instances: these values are the same in both modes — and are the values the file had before"""
    out = _outputs_for(mode)
    for flag in _REDIS_FLAGS:
        assert out[flag] == "true", flag
    assert out["backend_pg_listen_enabled"] == "false" and out["redis_url"].startswith("redis://")
    assert out["backend_db_pgbouncer"] == "false"  # dev is direct in both modes (the secret in cloudbuild.yaml moves with it)


def test_prod_has_no_part_in_the_switch():
    for text in ("DEV_REALTIME_STACK", "S_REALTIME_URL", "dev_realtime_stack"):
        assert text not in _PROD, text
    assert 'echo "realtime_url=https://realtime.sprintable.ai"' in _PROD and 'echo "backend_db_pgbouncer=true"' in _PROD


def test_one_substitution_assignment_carries_every_item():
    """a second `SUBST=` line would silently replace the first (a merge once kept both: the later one dropped `_MINS_EXPLICIT` and every prod build would have failed its own guard)"""
    assigns = [line for line in _WORKFLOW.splitlines() if line.lstrip().startswith('SUBST="')]
    assert len(assigns) == 1, len(assigns)
    for name in ("_MINS_EXPLICIT", "_CPU_FLAGS", "_DEV_REALTIME_STACK", "_BACKEND_RESOURCES", "_FRONTEND_RESOURCES", "_BACKEND_MIN_INSTANCES", "_FRONTEND_MIN_INSTANCES", "_REALTIME_MIN_INSTANCES"):
        assert f'{name}=\\"${{V_' in assigns[0], name


def test_the_switch_reaches_cloud_build():
    assert "V_DEV_REALTIME_STACK: ${{ steps.env.outputs.dev_realtime_stack }}" in _WORKFLOW
    assert re.findall(r"^  _DEV_REALTIME_STACK: '(.*)'$", _CLOUDBUILD, flags=re.M) == ["off"]


def _run_step(step_id: str, stack: str, *, deploy_env: str = "dev", realtime_url: str = "x") -> subprocess.CompletedProcess:
    """run a bash step of cloudbuild.yaml with gcloud and bash(deploy script) intercepted"""
    script = _apply_cloudbuild_escaping(_extract_step_script(step_id))
    names = set(re.findall(r"\$\{([A-Z_][A-Z0-9_]*)\}", script))  # the substitutions (`_X`) and the built-in variables (PROJECT_ID · COMMIT_SHA): set -u
    env = {**os.environ, **{n: "x" for n in names}, "_DEPLOY_ENV": deploy_env, "_DEV_REALTIME_STACK": stack, "_REALTIME_URL": realtime_url, "_REALTIME_CLOUDRUN_SKIP": "false", "_REALTIME_GCE_SKIP": "false"}
    stub = 'gcloud() { echo "CALLED gcloud $1 $2 $3"; }\nbash() { echo "CALLED bash $1 $2"; }\n'
    return subprocess.run(["bash", "-c", stub + script], capture_output=True, text=True, env=env)


@pytest.mark.parametrize("step_id", ["deploy-realtime", "deploy-realtime-gce"])
def test_the_stack_steps_deploy_only_when_the_switch_is_on_and_never_off_dev(step_id):
    off = _run_step(step_id, "off")
    assert off.returncode == 0 and "CALLED" not in off.stdout and "dev realtime stack is off" in off.stdout, off
    on = _run_step(step_id, "on")
    assert on.returncode == 0 and "CALLED" in on.stdout, on
    prod = _run_step(step_id, "on", deploy_env="prod")  # prod: the older gate exits first, whatever the switch says
    assert prod.returncode == 0 and "CALLED" not in prod.stdout
    empty = _run_step(step_id, "", deploy_env="dev")  # a manual submit that does not send it = off
    assert empty.returncode == 0 and "CALLED" not in empty.stdout


def test_the_off_skip_comes_before_the_empty_url_fail_fast():
    """with the switch off the stream address IS empty (the frontend falls back to the backend): deploy-realtime must skip, not fail on its old «empty URL» check; with the switch on that check still holds"""
    off = _run_step("deploy-realtime", "off", realtime_url="")
    assert off.returncode == 0 and "CALLED" not in off.stdout, off
    on_without_url = _run_step("deploy-realtime", "on", realtime_url="")
    assert on_without_url.returncode != 0 and "FAIL" in on_without_url.stdout, on_without_url


def test_the_dev_database_url_is_direct_exactly_when_pgbouncer_is_off():
    assert re.search(r'echo "backend_db_pgbouncer=false"', _DEV)
    dev_secrets = _run_env_vars_assembly("dev", "", var="SECRETS_FLAG")
    assert "DATABASE_URL=DATABASE_URL_DIRECT_DEV_SPRINTABLE:latest" in dev_secrets.removeprefix("--update-secrets=").split(",")
    assert "PGBOUNCER" not in dev_secrets
    # prod is untouched: PgBouncer in front, the direct secret behind it
    prod_secrets = _run_env_vars_assembly("prod", "", var="SECRETS_FLAG")
    assert "DATABASE_URL=DATABASE_URL_PROD_PGBOUNCER:latest" in prod_secrets.removeprefix("--update-secrets=").split(",")
