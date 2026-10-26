"""story 4786 (E-INFRA-DIET) — dev runs only when it is used: the three Cloud Run services this repo deploys (backend · realtime · frontend) have a minimum of 0 instances on dev, their CPU is
billed only while a request is being served, and the prod lines are not touched.

Why a static check: the effective dev value is NOT the default in cloudbuild.yaml — the GitHub workflow's dev branch (`.github/workflows/cloud-build.yml`) overrides it on every deploy, so a hand-set
value (or a default changed alone) comes back. Both files are read here; a change to only one of them, or a prod line dropped to 0 by mistake, turns this red.
"""
from __future__ import annotations

import re
from pathlib import Path

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


def _outputs(branch: str, name: str) -> list[int]:
    return [int(v) for v in re.findall(rf'echo "{name}=(\d+)"', branch)]


def test_the_branch_slices_are_the_real_prod_and_dev_branches():
    """a slicer that silently reads the wrong part would make every check below vacuous"""
    assert _PROD.startswith(_PROD_MARK) and _DEV.startswith(_DEV_MARK)
    assert _outputs(_PROD, "backend_max_instances") and _outputs(_DEV, "backend_max_instances")
    assert 'echo "target=dev"' not in _PROD and 'echo "target=prod"' not in _DEV


def test_dev_minimum_instances_are_zero_in_the_workflow_that_overrides_the_defaults():
    for name in ("backend_min_instances", "realtime_min_instances", "frontend_min_instances"):
        assert _outputs(_DEV, name) == [0], (name, _outputs(_DEV, name))


def test_prod_minimum_instances_are_still_set():
    """the prod lines are not part of this story: not dropped, not zeroed by a careless edit"""
    assert all(v >= 1 for v in _outputs(_PROD, "backend_min_instances")) and _outputs(_PROD, "backend_min_instances")
    assert all(v >= 1 for v in _outputs(_PROD, "frontend_min_instances")) and _outputs(_PROD, "frontend_min_instances")


def test_cloudbuild_defaults_for_the_dev_safe_fallback_are_zero_too():
    for name in ("_BACKEND_MIN_INSTANCES", "_REALTIME_MIN_INSTANCES", "_FRONTEND_MIN_INSTANCES"):
        assert re.findall(rf"^  {name}: '(\d+)'$", _CLOUDBUILD, flags=re.M) == ["0"], name


def _deploy_block(service: str) -> str:
    start = _CLOUDBUILD.index(f"gcloud run deploy sprintable-{service}-${{_DEPLOY_ENV}}")
    return _CLOUDBUILD[start:_CLOUDBUILD.index("--quiet", start)]


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


def test_the_manual_frontend_script_agrees_for_dev_and_leaves_prod_alone():
    script = (_ROOT / "backend/scripts/deploy_frontend.sh").read_text()
    dev = script[script.index("    dev)"):script.index("    prod)")]
    prod = script[script.index("    prod)"):]
    assert re.search(r"^\s+MIN_INSTANCES=0\b", dev, flags=re.M)
    assert re.search(r"^\s+MIN_INSTANCES=3\b", prod, flags=re.M)


def test_the_frontend_step_passes_the_flag_as_its_own_argument_only_when_it_is_given():
    """run the real deploy-frontend step with gcloud intercepted: dev (the workflow sends `--cpu-throttling`) gets the flag as one argument; prod (empty) gets nothing — not even an empty argument"""
    from tests.test_deploy_backend_redis_secret_conflict import _run_frontend_deploy_argv

    with_flag = _run_frontend_deploy_argv("dev", "--cpu-throttling")
    assert with_flag.count("--cpu-throttling") == 1 and "--cpu-boost" in with_flag
    without = _run_frontend_deploy_argv("prod", "")
    assert "--cpu-throttling" not in without and "" not in without
