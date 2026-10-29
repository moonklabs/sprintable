"""story 4796 (AC3, PO 2026-10-27) — the dev build stops building and deploying the Cloud Run frontend/backend and stops running the Cloud SQL migrate job; prod and the VM bundle's inputs stay exactly as they were.

One switch: `_CLOUD_RUN_APP_SKIP` (cloudbuild.yaml, default "false"; cloud-build.yml writes "true" for dev only, an empty value becomes "false"). Exactly "true" skips; every other value deploys as before.
Six steps carry it: build-frontend, push-frontend, update-migrate-job, run-migrate-job, deploy-frontend, deploy-backend. The steps that wait for them keep waiting (a skipping step ends 0), and the images the VM
bundle reads (backend build and push) are untouched. The Cloud Scheduler step reads its Authorization value from the VM's declaration once the Cloud Run backend is gone.

Run for real: every skipping step is executed against fake docker / gcloud / bash shims; what the fakes saw is what is asserted. For prod, «unchanged» is shown by running the step with and without the guard
line and comparing the argument lists the real tools would have received.
"""
from __future__ import annotations

import importlib.util
import os
import re
import stat
import subprocess
from pathlib import Path

import pytest
import yaml

_ROOT = Path(__file__).resolve().parents[2]
_CLOUDBUILD = (_ROOT / "cloudbuild.yaml").read_text()
_STEPS = {s["id"]: s for s in yaml.safe_load(_CLOUDBUILD)["steps"]}
_WORKFLOW = (_ROOT / ".github/workflows/cloud-build.yml").read_text()
SKIPPING = ("build-frontend", "push-frontend", "update-migrate-job", "run-migrate-job", "deploy-frontend", "deploy-backend")
KEPT_FOR_THE_VM = ("build-backend", "push-backend")
NOT_TRUE = ["", "false", "True", "TRUE", "1", "yes", "x", " true", "true "]


def _sibling(name: str):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(f"{name}.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _sub(text: str, values: dict[str, str]) -> str:
    for k, v in values.items():
        text = text.replace("${" + k + "}", v)
    return text.replace("$$", "$")


def _fake_bin(tmp: Path) -> tuple[Path, Path]:
    b = tmp / "bin"
    b.mkdir(exist_ok=True)
    log = tmp / "calls.log"
    log.write_text("")
    for tool in ("docker", "gcloud", "bash"):
        shim = b / tool
        shim.write_text('#!/bin/sh\nprintf "%s" "' + tool + '" >> "$FAKE_LOG"; for a in "$@"; do printf " [%s]" "$a" >> "$FAKE_LOG"; done; printf "\\n" >> "$FAKE_LOG"\n')
        shim.chmod(shim.stat().st_mode | stat.S_IEXEC)
    return b, log


def _run_step(step_id: str, tmp: Path, *, skip: str, env: str = "dev") -> tuple[int, list[str], str]:
    """the step as Cloud Build runs it: substitutions and `$$` resolved in every argument, the entrypoint (or the builder's default) with those arguments"""
    step = _STEPS[step_id]
    values = {"_CLOUD_RUN_APP_SKIP": skip, "_DEPLOY_ENV": env, "_AR_REGION": "r", "_AR_REPO": "repo", "PROJECT_ID": "p", "COMMIT_SHA": "abc", "_FASTAPI_URL": "https://dev-api.sprintable.ai"}
    args = [_sub(a, values) for a in step["args"]]
    b, log = _fake_bin(tmp)
    assert step.get("entrypoint") == "bash" and args[0] == "-c", step_id
    p = subprocess.run(["/bin/bash", "-c", args[1], *args[2:]], capture_output=True, text=True, timeout=30, cwd=tmp,
                       env={"PATH": f"{b}:/usr/bin:/bin", "FAKE_LOG": str(log), "HOME": str(tmp)})
    return p.returncode, log.read_text().splitlines(), p.stdout


def _original_argv(step_id: str, values: dict[str, str]) -> list[str]:
    """what the step's tool received before this change: the old args list (docker build ... / gcloud run jobs execute ...) after the `docker` / `gcloud` placeholder that is now $0"""
    args = [_sub(a, values) for a in _STEPS[step_id]["args"]]
    return args[3:]


# ── the switch and its wiring ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

def test_the_switch_defaults_to_deploying_and_only_dev_and_since_p3_prod_turn_it_on() -> None:
    assert re.search(r'^  _CLOUD_RUN_APP_SKIP: "false"$', _CLOUDBUILD, flags=re.M), "the default deploys: a forgotten value can only mean «as before»"
    block = _WORKFLOW.split('if [[ "$REF_NAME" == "main" ]]; then')[1]
    prod, dev = re.split(r"^          else\n", block, maxsplit=1, flags=re.M)
    assert dev.count('echo "cloud_run_app_skip=true" >> "$GITHUB_OUTPUT"') == 1
    assert prod.count('echo "cloud_run_app_skip=true" >> "$GITHUB_OUTPUT"') == 1 and prod.count("cloud_run_app_skip") == 1, "prod states it too since P3 (story 4796 AC4): exactly one line, the same word as dev's"
    assert "Merge this ONLY after the cutover's unfreeze (step 8)" in prod and "Undo = delete this line" in prod, "the condition and the undo sit next to it"
    assert 'V_CLOUD_RUN_APP_SKIP="${V_CLOUD_RUN_APP_SKIP:-false}"' in _WORKFLOW, "an empty output (any build that does not state it) becomes false"
    assert '_CLOUD_RUN_APP_SKIP=\\"${V_CLOUD_RUN_APP_SKIP}\\"' in _WORKFLOW


def test_the_switch_is_read_by_exactly_the_steps_named_here() -> None:
    users = sorted(i for i, s in _STEPS.items() if "_CLOUD_RUN_APP_SKIP" in yaml.safe_dump(s))
    assert users == sorted((*SKIPPING, "apply-cloud-scheduler")), users


def test_the_images_the_vm_bundle_reads_are_still_built_and_pushed_for_dev() -> None:
    for step_id in KEPT_FOR_THE_VM:
        assert "_CLOUD_RUN_APP_SKIP" not in yaml.safe_dump(_STEPS[step_id]), step_id
    assert _STEPS["push-backend"]["args"] == ["push", "--all-tags", "${_AR_REGION}-docker.pkg.dev/${PROJECT_ID}/${_AR_REPO}/backend"]
    vm = (_ROOT / "cloudbuild-vm.yaml").read_text()
    assert 'backend:${COMMIT_SHA}' in vm, "the bundle build resolves the backend image of this sha, which the main build pushes"


def test_the_steps_that_wait_for_a_skipping_step_still_wait_for_it() -> None:
    assert _STEPS["deploy-backend"]["waitFor"] == ["run-migrate-job"] and _STEPS["run-migrate-job"]["waitFor"] == ["update-migrate-job"]
    assert _STEPS["update-migrate-job"]["waitFor"] == ["push-backend"] and _STEPS["push-frontend"]["waitFor"] == ["build-frontend"] and _STEPS["deploy-frontend"]["waitFor"] == ["push-frontend"]
    assert _STEPS["apply-cloud-scheduler"]["waitFor"] == ["deploy-backend"]
    for dependent in ("deploy-mcp", "deploy-realtime", "deploy-realtime-gce"):
        assert _STEPS[dependent]["waitFor"] == ["run-migrate-job"], dependent


def test_the_support_gateway_steps_are_not_touched_by_this_change() -> None:
    for step_id in ("build-support-gateway", "push-support-gateway", "update-support-gateway-migrate-job", "run-support-gateway-migrate-job", "deploy-support-gateway"):
        assert "_CLOUD_RUN_APP_SKIP" not in yaml.safe_dump(_STEPS[step_id]), step_id


# ── skipping, run for real ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("step_id", SKIPPING)
def test_with_the_switch_on_a_step_calls_no_tool_and_ends_zero(step_id: str, tmp_path: Path) -> None:
    rc, calls, out = _run_step(step_id, tmp_path, skip="true")
    assert rc == 0 and calls == [], (step_id, calls)
    assert f"skip {step_id}" in out and "story 4796" in out


@pytest.mark.parametrize("value", NOT_TRUE)
@pytest.mark.parametrize("step_id", ("build-frontend", "push-frontend", "run-migrate-job", "update-migrate-job"))
def test_any_value_but_exactly_true_runs_the_step_as_before(step_id: str, value: str, tmp_path: Path) -> None:
    rc, calls, _ = _run_step(step_id, tmp_path, skip=value, env="prod")
    assert rc == 0 and len(calls) == 1, (step_id, value, calls)


@pytest.mark.parametrize("env", ["dev", "prod"])
def test_the_wrapped_tools_receive_exactly_the_argument_lists_they_received_before(env: str, tmp_path: Path) -> None:
    values = {"_CLOUD_RUN_APP_SKIP": "false", "_DEPLOY_ENV": env, "_AR_REGION": "r", "_AR_REPO": "repo", "PROJECT_ID": "p", "COMMIT_SHA": "abc", "_FASTAPI_URL": "https://dev-api.sprintable.ai"}
    for step_id, tool in (("build-frontend", "docker"), ("push-frontend", "docker"), ("run-migrate-job", "gcloud")):
        _, calls, _ = _run_step(step_id, tmp_path, skip="false", env=env)
        assert calls == [tool + "".join(f" [{a}]" for a in _original_argv(step_id, values))], (step_id, calls)


@pytest.mark.parametrize("env", ["dev", "prod"])
def test_the_pushed_and_executed_commands_are_literally_the_ones_they_were(env: str, tmp_path: Path) -> None:
    """not derived from the file under test: the argument lists written out"""
    _, push, _ = _run_step("push-frontend", tmp_path, skip="false", env=env)
    assert push == ["docker [push] [--all-tags] [r-docker.pkg.dev/p/repo/frontend]"]
    _, job, _ = _run_step("run-migrate-job", tmp_path, skip="false", env=env)
    assert job == [f"gcloud [run] [jobs] [execute] [sprintable-migrate-{env}] [--region=r] [--wait]"]
    _, build, _ = _run_step("build-frontend", tmp_path, skip="false", env=env)
    assert len(build) == 1 and build[0].startswith("docker [build] [--no-cache] [-f] [apps/web/Dockerfile] [-t] [r-docker.pkg.dev/p/repo/frontend:abc] [-t] [r-docker.pkg.dev/p/repo/frontend:latest-" + env + "]")
    assert build[0].endswith(" [.]") and "[NEXT_PUBLIC_FASTAPI_URL=https://dev-api.sprintable.ai]" in build[0] and "[SPRINTABLE_DEPLOY_BUILD=1]" in build[0] and "[APP_COMMIT_SHA=abc]" in build[0]


def _workflow_step(step_id: str) -> dict:
    steps = yaml.safe_load(_WORKFLOW)["jobs"]["cloud-build"]["steps"]
    return next(s for s in steps if s.get("id") == step_id)


@pytest.mark.parametrize("output,expected", [("true", "true"), ("", "false"), ("false", "false")])
def test_the_workflow_hands_the_switch_to_the_substitutions_and_an_empty_output_means_deploy(output: str, expected: str, tmp_path: Path) -> None:
    step = _workflow_step("subst")
    assert step["env"]["V_CLOUD_RUN_APP_SKIP"] == "${{ steps.env.outputs.cloud_run_app_skip }}", "the output is mapped into the step"
    out = tmp_path / "out"
    out.write_text("")
    subprocess.run(["bash", "-c", step["run"]], env={**os.environ, "GITHUB_OUTPUT": str(out), "V_DEPLOY_ENV": "dev", "V_CLOUD_RUN_APP_SKIP": output}, check=True, capture_output=True, text=True, timeout=30)
    assert f'_CLOUD_RUN_APP_SKIP="{expected}"' in out.read_text()


def test_the_build_arguments_of_the_cloud_run_frontend_survive_the_wrapper() -> None:
    args = _STEPS["build-frontend"]["args"]
    assert args[:4] == ["-c", args[1], "docker", "build"] and "exec docker" in args[1]
    assert "--no-cache" in args and "NEXT_PUBLIC_FASTAPI_URL=${_FASTAPI_URL}" in args and "SPRINTABLE_DEPLOY_BUILD=1" in args and args[-1] == "."


@pytest.mark.parametrize("env", ["dev", "prod"])
def test_deploy_backend_and_frontend_with_the_switch_off_do_what_they_did_without_the_guard(env: str, monkeypatch: pytest.MonkeyPatch) -> None:
    mod = _sibling("test_deploy_backend_redis_secret_conflict")
    guard = re.compile(r'^\s*\[ "\$\{_CLOUD_RUN_APP_SKIP\}" = "true" \] && \{[^\n]*exit 0; \}\n', flags=re.M)
    with_guard_backend = mod._run_backend_deploy_argv(env)
    with_guard_frontend = mod._run_frontend_deploy_argv(env)
    original = mod._extract_step_script

    def without_guard(step_id: str) -> str:
        script = original(step_id)
        assert len(guard.findall(script)) == 1, step_id
        return guard.sub("", script)

    monkeypatch.setattr(mod, "_extract_step_script", without_guard)
    assert mod._run_backend_deploy_argv(env) == with_guard_backend and with_guard_backend, "the guard changes nothing while the switch is off"
    assert mod._run_frontend_deploy_argv(env) == with_guard_frontend and with_guard_frontend


def test_deploy_backend_stays_under_the_byte_headroom_the_repo_asks_for() -> None:
    assert len(_STEPS["deploy-backend"]["args"][1].encode()) < 6000, "story #3433: 60% of the step argument limit"


# ── the scheduler: its Authorization value no longer comes from a Cloud Run service ─────────────────────────────────────────────────────────

def _scheduler_script(skip: str, url: str = "https://dev-api.sprintable.ai") -> str:
    body = _STEPS["apply-cloud-scheduler"]["args"][1]
    return _sub(body, {"_FASTAPI_URL": url, "_DEPLOY_ENV": "dev", "_CLOUD_RUN_APP_SKIP": skip})


def _scheduler_calls(tmp: Path, skip: str, url: str = "https://dev-api.sprintable.ai") -> list[str]:
    b = tmp / "bin"
    b.mkdir(exist_ok=True)
    log = tmp / "py.log"
    log.write_text("")
    (b / "python3").write_text('#!/bin/sh\nprintf "%s\\n" "$*" >> "$FAKE_LOG"\n')
    (b / "python3").chmod(0o755)
    subprocess.run(["/bin/bash", "-c", _scheduler_script(skip, url)], env={"PATH": f"{b}:/usr/bin:/bin", "FAKE_LOG": str(log), "HOME": str(tmp)}, capture_output=True, text=True, timeout=30, check=True)
    return log.read_text().splitlines()


def test_the_scheduler_step_reads_the_vm_declaration_only_when_the_cloud_run_backend_is_skipped(tmp_path: Path) -> None:
    assert _scheduler_calls(tmp_path, "true") == ["infra/apply_cloud_scheduler.py --env dev --base-url https://dev-api.sprintable.ai --bearer-from-vm-env --apply"]
    for value in ("false", "", "x"):
        assert _scheduler_calls(tmp_path, value) == ["infra/apply_cloud_scheduler.py --env dev --base-url https://dev-api.sprintable.ai --apply"], value
    assert _scheduler_calls(tmp_path, "true", url="https://other.example") == ["infra/apply_cloud_scheduler.py --env dev --apply"], "the bearer flag needs the VM's address, so any other address passes neither"


def test_the_runbook_describes_the_switch_the_six_steps_the_scheduler_source_the_undo_and_the_order() -> None:
    runbook = (_ROOT / "deploy/vm/RUNBOOK.md").read_text()
    para = next(p for p in runbook.split("\n\n") if p.startswith("**The dev build without Cloud Run"))
    for step_id in SKIPPING:
        assert f"`{step_id}`" in para, step_id
    for token in ("cloud_run_app_skip=true", "_CLOUD_RUN_APP_SKIP", "--bearer-from-vm-env", "deploy/vm/env/dev.yaml", "Undo: delete the `cloud_run_app_skip` line", "before** `sprintable-backend-dev`"):
        assert token in para, token
    assert runbook.index(para) < runbook.index("## 11. Day-to-day on the VM")


def test_the_runbook_says_prod_states_the_switch_too_and_when_it_may_be_merged() -> None:
    text = (_ROOT / "deploy/vm/RUNBOOK.md").read_text()
    sec = text[text.index("**The dev build without Cloud Run"):]
    sec = sec[:sec.index("\n\n")]
    for needle in ("and, since P3 of the prod cutover", "for prod (under `mins_explicit`; merged right after the cutover's unfreeze, never before", "(or of the prod branch for prod)"):
        assert needle in sec, needle
    assert "prod states nothing" not in sec


def test_the_skip_lines_do_not_say_dev_because_prod_prints_them_too() -> None:
    """since P3 the prod build writes `cloud_run_app_skip=true` as well: a line that says «dev runs on the VM» in a prod log is wrong, so the six steps say «this environment»"""
    import re
    from pathlib import Path
    text = (Path(__file__).resolve().parents[2] / "cloudbuild.yaml").read_text()
    skips = re.findall(r'echo "skip ([a-z-]+): ([^"]*)"', text)
    steps = {name for name, _ in skips}
    assert steps >= {"build-frontend", "push-frontend", "update-migrate-job", "run-migrate-job", "deploy-frontend", "deploy-backend"}, steps
    for name, msg in skips:
        if name in {"build-frontend", "push-frontend", "update-migrate-job", "run-migrate-job", "deploy-frontend", "deploy-backend"}:
            assert msg == "this environment runs on the VM (story 4796)", (name, msg)
