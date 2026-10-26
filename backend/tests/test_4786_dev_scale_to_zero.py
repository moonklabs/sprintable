"""story 4786 (E-INFRA-DIET) — dev keeps no idle capacity it does not need: realtime-dev 2 → 0 (it receives no requests) · frontend-dev 1 → 0 (2 s start) · backend-dev 3 → 2 (PO, after the lens on PR 5244: a new backend
instance takes ≈31 s to start and the long streams, not CPU, bind it, so 0 is not safe at a deploy — story 4789 lifts that); CPU on dev is billed only while a request is served (it already is Cloud Run's default —
the flag writes it down); the prod lines are not touched and a prod build that does not state its minimums fails first.

Why a static check: the effective dev value is NOT the default in cloudbuild.yaml — the GitHub workflow's dev branch (`.github/workflows/cloud-build.yml`) overrides it on every deploy, so a hand-set value (or a default
changed alone) comes back. Both files are read here, and the hops between them (the workflow's env mapping, the substitution list, the deploy step's flag) are checked, not only the two ends.
"""
from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path

import yaml

_ROOT = Path(__file__).resolve().parents[2]
_WORKFLOW = (_ROOT / ".github/workflows/cloud-build.yml").read_text()
_CLOUDBUILD = (_ROOT / "cloudbuild.yaml").read_text()

_PROD_MARK = 'echo "target=prod"'
_DEV_MARK = 'echo "target=dev"'
_NEXT_STEP = "\n      - name: Resolve realtime deploy path-filter"


def _branch(mark: str, end: str) -> str:
    start = _WORKFLOW.index(mark)
    return _WORKFLOW[start:_WORKFLOW.index(end, start)]


_PROD = _branch(_PROD_MARK, _DEV_MARK)
_DEV = _branch(_DEV_MARK, _NEXT_STEP)

_DEV_MINS = {"backend_min_instances": 2, "realtime_min_instances": 0, "frontend_min_instances": 0}
_DEFAULTS = {"_BACKEND_MIN_INSTANCES": "2", "_REALTIME_MIN_INSTANCES": "0", "_FRONTEND_MIN_INSTANCES": "0"}


def _outputs(branch: str, name: str) -> list[int]:
    return [int(v) for v in re.findall(rf'echo "{name}=(\d+)"', branch)]


def test_the_branch_slices_are_the_real_prod_and_dev_branches():
    """a slicer that silently reads the wrong part would make every check below vacuous"""
    assert _PROD.startswith(_PROD_MARK) and _DEV.startswith(_DEV_MARK)
    assert _outputs(_PROD, "backend_max_instances") and _outputs(_DEV, "backend_max_instances")
    assert 'echo "target=dev"' not in _PROD and 'echo "target=prod"' not in _DEV


def test_dev_minimum_instances_in_the_workflow_that_overrides_the_defaults():
    for name, value in _DEV_MINS.items():
        assert _outputs(_DEV, name) == [value], (name, _outputs(_DEV, name))


def test_prod_minimum_instances_are_exactly_what_the_operator_set():
    """prod's minimums pinned literally (codex 4786): a story that changes prod changes these two numbers on purpose, here, in the same PR — never by a stray edit. Story 4790 (2026-10-26, the teacher: «prod도 지금 줄이기»):
    3 · 3 → 1 · 1, the values the operator set by hand at 09:07Z; the repository follows so the next prod deploy cannot put 3 back (the sizes and the maximum are pinned in test_4790_prod_matches_hand_values.py)."""
    assert _outputs(_PROD, "backend_min_instances") == [1] and _outputs(_PROD, "frontend_min_instances") == [1]


def test_cloudbuild_defaults_for_the_dev_safe_fallback():
    for name, value in _DEFAULTS.items():
        assert re.findall(rf"^  {name}: '(\d+)'$", _CLOUDBUILD, flags=re.M) == [value], name


def test_the_minimums_reach_cloud_build_through_the_env_mapping_and_the_substitution_list():
    """the two middle hops: `V_*` takes the workflow output, and the substitution list sends it (a hard-coded `_BACKEND_MIN_INSTANCES="3"` there would pass the two ends and still deploy 3)"""
    for var, output in (("BACKEND", "backend"), ("REALTIME", "realtime"), ("FRONTEND", "frontend")):
        assert f"V_{var}_MIN_INSTANCES: ${{{{ steps.env.outputs.{output}_min_instances }}}}" in _WORKFLOW, var
        assert f'_{var}_MIN_INSTANCES=\\"${{V_{var}_MIN_INSTANCES}}\\"' in _WORKFLOW, var


def _deploy_block(service: str) -> str:
    start = _CLOUDBUILD.index(f"gcloud run deploy sprintable-{service}-${{_DEPLOY_ENV}}")
    return _CLOUDBUILD[start:_CLOUDBUILD.index("--quiet", start)]


def _step_script(step_id: str) -> str:
    doc = yaml.safe_load(_CLOUDBUILD)
    return next(s for s in doc["steps"] if s["id"] == step_id)["args"][1].replace("$$", "$")


def test_the_deploy_steps_send_their_minimum_and_the_dev_cpu_flag_as_arguments():
    """the real steps run with gcloud intercepted: the substitution value becomes `--min-instances=<value>`; dev's `--cpu-throttling` is exactly one argument, prod's empty flag is no argument at all"""
    from tests.test_deploy_backend_redis_secret_conflict import _run_backend_deploy_argv, _run_frontend_deploy_argv

    backend_dev = _run_backend_deploy_argv("dev", _CPU_FLAGS="--cpu-throttling", _BACKEND_MIN_INSTANCES="2")
    assert "--min-instances=2" in backend_dev and backend_dev.count("--cpu-throttling") == 1, backend_dev
    backend_prod = _run_backend_deploy_argv("prod", _CPU_FLAGS="", _BACKEND_MIN_INSTANCES="3")
    assert "--min-instances=3" in backend_prod and "--cpu-throttling" not in backend_prod and "" not in backend_prod, backend_prod
    frontend_dev = _run_frontend_deploy_argv("dev", "--cpu-throttling")
    assert frontend_dev.count("--cpu-throttling") == 1 and "--cpu-boost" in frontend_dev, frontend_dev
    frontend_prod = _run_frontend_deploy_argv("prod", "")
    assert "--cpu-throttling" not in frontend_prod and "" not in frontend_prod, frontend_prod
    assert "--min-instances=${_FRONTEND_MIN_INSTANCES}" in _deploy_block("frontend")
    assert "--min-instances=${_REALTIME_MIN_INSTANCES}" in _deploy_block("realtime")


def test_dev_cpu_is_billed_only_while_a_request_is_served():
    """backend + frontend are deployed for both environments, so the flag travels as a substitution: the workflow's dev branch sends `--cpu-throttling`, the prod branch sends nothing (prod keeps whatever it has);
    realtime is deployed on dev only (its step exits first for any other environment) and names the flag itself"""
    assert "--no-cpu-throttling" not in _CLOUDBUILD and "--no-cpu-throttling" not in _WORKFLOW
    assert re.findall(r"^  _CPU_FLAGS: '(.*)'$", _CLOUDBUILD, flags=re.M) == [""]  # a manual submit never inherits it
    for service in ("frontend", "backend"):
        assert "${_CPU_FLAGS}" in _deploy_block(service), service
    assert 'echo "cpu_flags=--cpu-throttling"' in _DEV
    assert "cpu_flags" not in _PROD
    assert "V_CPU_FLAGS: ${{ steps.env.outputs.cpu_flags }}" in _WORKFLOW
    assert '_CPU_FLAGS=\\"${V_CPU_FLAGS}\\"' in _WORKFLOW  # the value reaches Cloud Build (prod: empty)
    realtime = _deploy_block("realtime")
    assert "--cpu-throttling \\" in realtime
    assert 'if [ "${_DEPLOY_ENV}" != "dev" ]; then' in _CLOUDBUILD[: _CLOUDBUILD.index("gcloud run deploy sprintable-realtime-")]


def _run_guard(deploy_env: str, explicit: str, backend_min: str = "3", frontend_min: str = "3") -> subprocess.CompletedProcess:
    env = {**os.environ, "_DEPLOY_ENV": deploy_env, "_MINS_EXPLICIT": explicit, "_BACKEND_MIN_INSTANCES": backend_min, "_FRONTEND_MIN_INSTANCES": frontend_min}
    return subprocess.run(["bash", "-c", _step_script("guard-prod-mins")], capture_output=True, text=True, env=env)


def test_a_prod_build_that_does_not_state_its_minimums_fails_first():
    """fail-closed: the dev-safe defaults must never reach prod by omission (a hand-run `gcloud builds submit`), nor by saying «explicit» while leaving a minimum at 0 or garbage"""
    steps = yaml.safe_load(_CLOUDBUILD)["steps"]
    assert steps[0]["id"] == "guard-prod-mins"
    assert _run_guard("prod", "").returncode != 0 and _run_guard("prod", "false").returncode != 0
    assert _run_guard("prod", "true").returncode == 0
    assert _run_guard("prod", "true", frontend_min="0").returncode != 0  # the dev-safe default of the frontend
    assert _run_guard("prod", "true", backend_min="0").returncode != 0
    assert _run_guard("prod", "true", backend_min="abc").returncode != 0  # fail closed on garbage too
    assert _run_guard("dev", "", backend_min="2", frontend_min="0").returncode == 0  # dev is what the defaults are for
    assert re.findall(r"^  _MINS_EXPLICIT: '(.*)'$", _CLOUDBUILD, flags=re.M) == [""]  # a manual submit never inherits `true`
    assert 'echo "mins_explicit=true"' in _PROD and "mins_explicit" not in _DEV
    assert "V_MINS_EXPLICIT: ${{ steps.env.outputs.mins_explicit }}" in _WORKFLOW
    assert '_MINS_EXPLICIT=\\"${V_MINS_EXPLICIT}\\"' in _WORKFLOW


def test_no_step_can_start_before_the_guard_has_passed():
    """Cloud Build starts a step with `waitFor: ['-']` at once, in parallel with the guard: such a step could apply its side effect (a prod bucket's CORS) before the guard fails. Every step must reach the guard
    through its dependencies (a step without waitFor waits for all earlier ones)."""
    steps = yaml.safe_load(_CLOUDBUILD)["steps"]
    ids = [s["id"] for s in steps]
    assert ids[0] == "guard-prod-mins"
    deps: dict[str, list[str]] = {}
    for i, step in enumerate(steps):
        wait = step.get("waitFor")
        assert wait != ["-"], f"{step['id']} starts at once"
        deps[step["id"]] = ids[:i] if wait is None else list(wait)

    def reaches_guard(step_id: str, seen: frozenset = frozenset()) -> bool:
        if step_id == "guard-prod-mins":
            return True
        return any(reaches_guard(d, seen | {step_id}) for d in deps[step_id] if d not in seen)

    assert [i for i in ids if not reaches_guard(i)] == []


def test_the_manual_scripts_agree_for_dev_and_leave_prod_alone():
    for name, dev_min, prod_min in (("frontend", 0, 1), ("backend", 2, 1)):  # story 4790: frontend prod 3 → 1 (the value the operator set by hand)
        script = (_ROOT / f"backend/scripts/deploy_{name}.sh").read_text()
        dev = script[script.index("    dev)"):script.index("    prod)")]
        prod = script[script.index("    prod)"):]
        assert re.search(rf"^\s+MIN_INSTANCES={dev_min}\b", dev, flags=re.M), name
        assert re.search(rf"^\s+MIN_INSTANCES={prod_min}\b", prod, flags=re.M), name
        assert 'CPU_FLAGS="--cpu-throttling"' in dev and "CPU_FLAGS=" not in prod, name
        assert script.count("${CPU_FLAGS}") == 1 and 'CPU_FLAGS=""' in script, name  # the flag reaches the one gcloud call
