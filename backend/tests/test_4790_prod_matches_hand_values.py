"""story 4790 (E-INFRA-DIET) — the repository states prod's size the way the operator set it by hand (2026-10-26 09:07Z), so the next prod deploy cannot put it back:
backend-prod min 1 · 1 vCPU · 1Gi · max 10, frontend-prod min 1 · 1 vCPU · 512Mi · max 10.

Before this the repository said min 3 for both, max 18 for the backend (the service-level 10 the operator had set by hand on 2026-06-04 was the value in force), and said nothing about CPU or memory (`gcloud run deploy`
keeps a flag that is left out, so it never put them back — and never wrote them down either). The effective value is the GitHub workflow's prod branch, not the defaults in cloudbuild.yaml; the manual deploy scripts
(`backend/scripts/deploy_{backend,frontend}.sh`) carry their own prod numbers and must say the same. Every hop is read here, not only the two ends: the workflow output, its env mapping, the substitution list, the deploy step's
argument, and the script."""
from __future__ import annotations

import re

from tests import test_4786_dev_scale_to_zero as base
from tests.test_deploy_backend_redis_secret_conflict import _run_backend_deploy_argv, _run_frontend_deploy_argv

_ROOT = base._ROOT

# what the operator set by hand (PO 2026-10-26 09:07Z) — the repository follows it
HAND = {
    "backend": {"min": 1, "max": 10, "cpu": "1", "memory": "1Gi"},
    "frontend": {"min": 1, "max": 10, "cpu": "1", "memory": "512Mi"},
}


def _text_outputs(branch: str, name: str) -> list[str]:
    return re.findall(rf'echo "{name}=([^"]*)"', branch)


def _prod_problems(prod_branch: str) -> list[str]:
    """every way the workflow's prod branch can disagree with the hand values (empty = agrees) — a function, so a mutated copy can be shown to turn red"""
    problems: list[str] = []
    for service, want in HAND.items():
        for key in ("min", "max"):
            got = base._outputs(prod_branch, f"{service}_{key}_instances")
            if got != [want[key]]:
                problems.append(f"{service}_{key}_instances={got} != {want[key]}")
        res = _text_outputs(prod_branch, f"{service}_resources")
        if res != [f"--cpu {want['cpu']} --memory {want['memory']}"]:
            problems.append(f"{service}_resources={res}")
    return problems


def test_the_prod_branch_states_the_hand_values():
    assert _prod_problems(base._PROD) == []


def test_the_check_can_go_red():
    """positive control: the old numbers (min 3 · max 18 · no size) are reported, so a green above means something"""
    old = base._PROD.replace('echo "backend_min_instances=1"', 'echo "backend_min_instances=3"').replace('echo "backend_max_instances=10"', 'echo "backend_max_instances=18"')
    old = re.sub(r'\n\s*echo "(backend|frontend)_resources=[^"]*" >> "\$GITHUB_OUTPUT"', "", old)
    problems = _prod_problems(old)
    assert any("backend_min_instances" in p for p in problems) and any("backend_max_instances" in p for p in problems) and any("backend_resources" in p for p in problems), problems


def test_the_resource_strings_have_no_equals_sign_and_dev_sends_none():
    """the substitution list is split on commas and read as key=value: keep the value free of `=` (`--cpu 1 --memory 1Gi`), and dev sends nothing so its own size is kept"""
    for service in HAND:
        (value,) = _text_outputs(base._PROD, f"{service}_resources")
        assert "=" not in value and "," not in value, value
    assert "_resources" not in base._DEV


def test_the_sizes_reach_cloud_build_through_the_env_mapping_and_the_substitution_list():
    for var, output in (("BACKEND", "backend"), ("FRONTEND", "frontend")):
        assert f"V_{var}_RESOURCES: ${{{{ steps.env.outputs.{output}_resources }}}}" in base._WORKFLOW, var
        assert f'_{var}_RESOURCES=\\"${{V_{var}_RESOURCES}}\\"' in base._WORKFLOW, var
        assert re.findall(rf"^  _{var}_RESOURCES: '(.*)'$", base._CLOUDBUILD, flags=re.M) == [""], var  # a manual submit never inherits prod's size


def test_the_final_submit_hop_passes_the_substitution_string_to_cloud_build():
    """the last hop (codex 4790): `gcloud builds submit` must actually consume the string the workflow assembled; without it every hop before it would pass and nothing would reach Cloud Build"""
    submit = base._WORKFLOW[base._WORKFLOW.index("          gcloud builds submit \\\n"):]  # the real command (the earlier mentions are comments)
    assert "${{ steps.subst.outputs.substitutions }}" in submit.split("\n\n", 1)[0]  # the command ends at the next blank line
    assert 'echo "substitutions=${SUBST}" >> "$GITHUB_OUTPUT"' in base._WORKFLOW


def test_the_deploy_steps_send_the_size_as_arguments_and_dev_sends_none():
    """the real steps with only gcloud intercepted: prod's string becomes separate arguments (`--cpu` `1` `--memory` `1Gi`); an empty one is no argument at all"""
    assert "${_BACKEND_RESOURCES}" in base._deploy_block("backend") and "${_FRONTEND_RESOURCES}" in base._deploy_block("frontend")
    be_prod = _run_backend_deploy_argv("prod", _BACKEND_RESOURCES="--cpu 1 --memory 1Gi", _BACKEND_MIN_INSTANCES="1", _BACKEND_MAX_INSTANCES="10")
    i = be_prod.index("--cpu")
    assert be_prod[i:i + 4] == ["--cpu", "1", "--memory", "1Gi"] and "--min-instances=1" in be_prod and "--max-instances=10" in be_prod, be_prod
    fe_prod = _run_frontend_deploy_argv("prod", "", "--cpu 1 --memory 512Mi")
    j = fe_prod.index("--cpu")
    assert fe_prod[j:j + 4] == ["--cpu", "1", "--memory", "512Mi"], fe_prod
    be_dev, fe_dev = _run_backend_deploy_argv("dev", _CPU_FLAGS="--cpu-throttling"), _run_frontend_deploy_argv("dev", "--cpu-throttling")
    for argv in (be_dev, fe_dev):
        assert "--memory" not in argv and "--cpu" not in argv and "" not in argv, argv


def test_the_manual_deploy_scripts_say_the_same_for_prod():
    """`backend/scripts/deploy_{backend,frontend}.sh` carry prod numbers of their own; a manual run must not undo the hand values"""
    for service, want in HAND.items():
        script = (_ROOT / f"backend/scripts/deploy_{service}.sh").read_text()
        prod = script[script.index("    prod)"):]
        for var, key in (("MIN_INSTANCES", "min"), ("MAX_INSTANCES", "max")):
            assert re.search(rf"^\s+{var}={want[key]}\b", prod, flags=re.M), (service, var)
        assert re.search(rf'^\s+MEMORY="{want["memory"]}"', prod, flags=re.M), service
        assert re.search(rf'^\s+CPU="{want["cpu"]}"', prod, flags=re.M), service


def test_prod_minimums_stay_at_least_one():
    """the lowest prod is allowed to go in this story: never zero by a careless edit"""
    for name in ("backend_min_instances", "frontend_min_instances"):
        assert base._outputs(base._PROD, name) and all(v >= 1 for v in base._outputs(base._PROD, name)), name
