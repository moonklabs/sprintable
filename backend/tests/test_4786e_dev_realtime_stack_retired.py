"""story 4786 (E-INFRA-DIET) — the dev GCE realtime gateways and realtime-dev (Cloud Run) are RETIRED, and there is no switch to bring them back. Prod is not part of it. Redis and PG LISTEN are NOT part of it.

History: PR 5252 put them behind one switch, default off. The PO then removed the resources by hand (gateway VM group · templates · load balancer · certificate · IP · DNS `dev-realtime` · the realtime-dev service) and decided the switch goes
too — the dev move to VMs (story 4796) replaces this path, so nothing is left to turn back on. Now: the dev frontend's stream address is always empty (it streams through backend-dev), the two deploy steps never deploy (on any environment,
whatever a leftover substitution says), and the workflow and cloudbuild.yaml carry no trace of the switch. The REAL dev branch of the workflow step and the REAL steps are run in bash.
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


def _dev_outputs() -> dict[str, str]:
    """run the REAL dev branch of the workflow's «Set deploy environment» step (gcloud stubbed) and read what it wrote to $GITHUB_OUTPUT"""
    with tempfile.TemporaryDirectory() as d:
        out = Path(d) / "out"
        # the slice ends with the `fi` that closes the step's if/else, so it is wrapped in the same shape; the first branch (prod) never runs
        script = "set -eo pipefail\ngcloud() { echo stub-value; }\nif false; then\n:\nelse\n" + _DEV
        subprocess.run(["bash", "-c", script], check=True, env={**os.environ, "GITHUB_OUTPUT": str(out)}, capture_output=True)
        return dict(line.split("=", 1) for line in out.read_text().splitlines() if "=" in line)


def test_the_switch_is_gone_everywhere():
    """no `DEV_REALTIME_STACK` in the workflow, in cloudbuild.yaml, or as a substitution name: nothing can bring the retired stack back without a code change in the deploy steps themselves"""
    for text in ("DEV_REALTIME_STACK", "dev_realtime_stack", "S_REALTIME_URL"):
        assert text not in _WORKFLOW, text
        assert text not in _CLOUDBUILD, text


def test_the_dev_stream_address_is_always_empty_so_the_frontend_streams_through_backend_dev():
    assert _dev_outputs()["realtime_url"] == ""
    code = "\n".join(line for line in _DEV.splitlines() if not line.lstrip().startswith("#"))  # comments may still tell the history
    assert 'echo "realtime_url=" >> "$GITHUB_OUTPUT"' in code and "dev-realtime" not in code


def test_the_dev_branch_leaves_redis_pg_listen_the_rate_limiter_and_pgbouncer_alone():
    """the relay contract (one receiver, takeover) needs the Redis SSE lease; dev backend runs 2+ instances: these values are the ones the file had before the retirement"""
    out = _dev_outputs()
    for flag in _REDIS_FLAGS:
        assert out[flag] == "true", flag
    assert out["backend_pg_listen_enabled"] == "false" and out["redis_url"].startswith("redis://")
    assert out["backend_db_pgbouncer"] == "true"  # dev stays behind PgBouncer (PO 10-26: going direct was weighed and left out)


def test_prod_has_no_part_in_it():
    assert 'echo "realtime_url=https://realtime.sprintable.ai"' in _PROD and 'echo "backend_db_pgbouncer=true"' in _PROD


def test_one_substitution_assignment_carries_every_item():
    """a second `SUBST=` line would silently replace the first (a merge once kept both: the later one dropped `_MINS_EXPLICIT` and every prod build would have failed its own guard)"""
    assigns = [line for line in _WORKFLOW.splitlines() if line.lstrip().startswith('SUBST="')]
    assert len(assigns) == 1, len(assigns)
    for name in ("_MINS_EXPLICIT", "_CPU_FLAGS", "_BACKEND_RESOURCES", "_FRONTEND_RESOURCES", "_BACKEND_MIN_INSTANCES", "_FRONTEND_MIN_INSTANCES", "_REALTIME_MIN_INSTANCES"):
        # the EXACT mapping, not a `V_` prefix: a substitution wired to another variable would pass a prefix check (codex 4786)
        assert f'{name}=\\"${{V{name}}}\\"' in assigns[0], name


def _run_step(step_id: str, *, deploy_env: str = "dev", realtime_url: str = "x", leftover: dict[str, str] | None = None) -> subprocess.CompletedProcess:
    """run a bash step of cloudbuild.yaml with gcloud and bash(deploy script) intercepted; `leftover` = substitutions an old caller might still send"""
    script = _apply_cloudbuild_escaping(_extract_step_script(step_id))
    names = set(re.findall(r"\$\{([A-Z_][A-Z0-9_]*)\}", script))  # the substitutions (`_X`) and the built-in variables (PROJECT_ID · COMMIT_SHA): set -u
    env = {**os.environ, **{n: "x" for n in names}, "_DEPLOY_ENV": deploy_env, "_REALTIME_URL": realtime_url, "_REALTIME_CLOUDRUN_SKIP": "false", "_REALTIME_GCE_SKIP": "false", **(leftover or {})}
    stub = 'gcloud() { echo "CALLED gcloud $1 $2 $3"; }\nbash() { echo "CALLED bash $1 $2"; }\n'
    return subprocess.run(["bash", "-c", stub + script], capture_output=True, text=True, env=env)


@pytest.mark.parametrize("step_id", ["deploy-realtime", "deploy-realtime-gce"])
def test_the_two_steps_never_deploy_on_any_environment(step_id):
    dev = _run_step(step_id)
    assert dev.returncode == 0 and "CALLED" not in dev.stdout and "retired" in dev.stdout, dev
    prod = _run_step(step_id, deploy_env="prod")  # prod: the older gate exits first
    assert prod.returncode == 0 and "CALLED" not in prod.stdout, prod
    # an old caller still sending the switch (or an empty stream address, which used to fail fast) changes nothing
    old_on = _run_step(step_id, leftover={"_DEV_REALTIME_STACK": "on"})
    assert old_on.returncode == 0 and "CALLED" not in old_on.stdout, old_on
    empty_url = _run_step(step_id, realtime_url="")
    assert empty_url.returncode == 0 and "CALLED" not in empty_url.stdout and "FAIL" not in empty_url.stdout, empty_url


def test_dev_keeps_the_redis_rate_limiter_and_prod_has_none_of_it():
    """the rate limiter's backend is a Redis flag too (codex 4786): the switch leaves it, and its address, on dev; prod does not get it"""
    dev = _run_env_vars_assembly("dev", "redis://example:6379").split(",")
    assert "RATE_LIMIT_BACKEND=redis" in dev and "REDIS_URL=redis://example:6379" in dev
    prod = _run_env_vars_assembly("prod", "").split(",")
    assert not any(item.startswith(("RATE_LIMIT_BACKEND=", "REDIS_URL=")) for item in prod)


def _assembled_skips(gce: str, cloudrun: str, leftover: str = "") -> dict[str, str]:
    """run the REAL «assemble substitutions» step of the workflow (from the `:-false` defaults to the line that writes the output) and read the two skip substitutions it sends"""
    start = _WORKFLOW.index('V_REALTIME_GCE_SKIP="${V_REALTIME_GCE_SKIP:-false}"')
    script = _WORKFLOW[start:_WORKFLOW.index('echo "substitutions=', start)] + 'printf "%s" "$SUBST"\n'
    env = {**os.environ, "V_DEV_REALTIME_STACK": leftover, "V_REALTIME_GCE_SKIP": gce, "V_REALTIME_CLOUDRUN_SKIP": cloudrun}
    out = subprocess.run(["bash", "-c", script], check=True, capture_output=True, text=True, env=env).stdout
    return {name: re.search(rf'{name}="([^"]*)"', out).group(1) for name in ("_REALTIME_GCE_SKIP", "_REALTIME_CLOUDRUN_SKIP")}


def test_the_path_filter_skips_pass_through_unchanged_and_a_leftover_variable_forces_nothing():
    """the forced «deploy both when the switch is on» line is gone: the filter's answers reach Cloud Build as they are (empty → false, the fail-safe direction)"""
    assert _assembled_skips("true", "true") == {"_REALTIME_GCE_SKIP": "true", "_REALTIME_CLOUDRUN_SKIP": "true"}
    assert _assembled_skips("true", "true", leftover="on") == {"_REALTIME_GCE_SKIP": "true", "_REALTIME_CLOUDRUN_SKIP": "true"}
    assert _assembled_skips("", "") == {"_REALTIME_GCE_SKIP": "false", "_REALTIME_CLOUDRUN_SKIP": "false"}


def test_dev_and_prod_both_stay_behind_pgbouncer():
    """PO 10-26: going direct on dev was weighed and left out (one VM, ≈ $15/month, against a connection budget with no room for a third overlapping revision). The flag and the secret move together, so both are pinned"""
    assert re.search(r'echo "backend_db_pgbouncer=true"', _DEV) and 'echo "backend_db_pgbouncer=false"' not in _DEV
    dev_items = _run_env_vars_assembly("dev", "", var="SECRETS_FLAG").removeprefix("--update-secrets=").split(",")
    # exactly ONE binding of each name: a later duplicate `DATABASE_URL=…DIRECT…` would still contain the right item
    assert [i for i in dev_items if i.startswith("DATABASE_URL=")] == ["DATABASE_URL=DATABASE_URL_DEV_PGBOUNCER_SPRINTABLE:latest"]
    assert [i for i in dev_items if i.startswith("DATABASE_URL_DIRECT=")] == ["DATABASE_URL_DIRECT=DATABASE_URL_DIRECT_DEV_SPRINTABLE:latest"]  # the LISTEN connection stays direct
    # prod is untouched: PgBouncer in front, the direct secret behind it
    prod_items = _run_env_vars_assembly("prod", "", var="SECRETS_FLAG").removeprefix("--update-secrets=").split(",")
    assert [i for i in prod_items if i.startswith("DATABASE_URL=")] == ["DATABASE_URL=DATABASE_URL_PROD_PGBOUNCER:latest"]
    assert [i for i in prod_items if i.startswith("DATABASE_URL_DIRECT=")] == ["DATABASE_URL_DIRECT=DATABASE_URL_PROD:latest"]
