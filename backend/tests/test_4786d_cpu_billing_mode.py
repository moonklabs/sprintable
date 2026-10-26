"""story 4786 (E-INFRA-DIET) — the CPU billing mode of the DEV Cloud Run services the pipeline deploys is STATED in the repository, not inherited from whatever the live service has.

Why (PO measurement, last 6 h): backend and frontend are always working — a never-ending stream sits on every instance — so request-based CPU billing ran around the clock at the higher per-second rate (Seoul: request-based
$0.0000336 · instance-based $0.0000216 per vCPU-second). dev backend + frontend bill per INSTANCE (`--no-cpu-throttling`); the services that sit idle most of the time (realtime-dev · mcp-dev · office-converter-dev ·
support-gateway-dev) bill per REQUEST (`--cpu-throttling`). A deploy step that does not pass the flag leaves the live value alone, so a hand-set value survives — but only until someone sets the other one by hand.
The prod lines are NOT part of this change (prod sends nothing and keeps whatever it has; a later change states it). This file runs the real steps and reads the real files; a new Cloud Run deploy command without a stated mode fails here.
"""
from __future__ import annotations

import os
import re
import subprocess

import yaml

from tests.test_4786_dev_scale_to_zero import _CLOUDBUILD, _DEV, _PROD, _ROOT, _WORKFLOW
from tests.test_deploy_backend_redis_secret_conflict import _apply_cloudbuild_escaping, _extract_step_script

# service (as written in the `gcloud run deploy|services update` line) -> the token that states its mode inside that command
_EXPECTED_MODE = {
    "sprintable-frontend-${_DEPLOY_ENV}": "${_CPU_FLAGS}",  # the substitution carries --no-cpu-throttling on dev, nothing on prod
    "sprintable-backend-${_DEPLOY_ENV}": "${_CPU_FLAGS}",
    "sprintable-mcp-${_DEPLOY_ENV}": "$${MCP_CPU_FLAG}",  # --cpu-throttling on dev, nothing on prod (set just above the command)
    "sprintable-realtime-${_DEPLOY_ENV}": "--cpu-throttling",  # dev only (its step exits first for any other environment)
    "office-converter-${_DEPLOY_ENV}": "--cpu-throttling",  # dev only (its step exits first for any other environment)
    "support-gateway-${_DEPLOY_ENV}": "$${CPU_FLAG}",  # --cpu-throttling on dev, nothing on prod
}


def _positional_after(args: list[str], i: int) -> str | None:
    """the first token from `i` on that is not a flag (a service name)"""
    for a in args[i:]:
        if not a.startswith("-"):
            return a
    return None


# `gcloud [global flags] [alpha|beta] run deploy <svc>` / `… run services update|replace <svc>` ANYWHERE in a line (after `&&`, `;`, `|`, `$(`, …), not only at its start. A comment that merely mentions it matches too:
# that can only make the closed-set check RED (an unknown name), never let a real command slip past.
_GCLOUD_RUN = re.compile(r"\bgcloud(?:\s+-\S+(?:\s+[^-\s]\S*)?)*\s+(?:(?:alpha|beta)\s+)?run\s+(?:deploy|services\s+(?:update|replace))\s+(\S+)")


def _commands(doc: dict | None = None) -> list[tuple[str, str]]:
    """every Cloud Run deploy / update command in cloudbuild.yaml: (service, full command text incl. continuation lines). Found (1) in every argument string that holds a script (`bash -c`, `sh -c`, …), anywhere on a line,
    with global flags and `alpha` / `beta` in front; (2) as a direct gcloud step — the entrypoint is absent (the cloud-sdk image's default) or any path ending in `gcloud` — where `run deploy` /
    `run services update|replace` are looked for ANYWHERE in the args (a global flag in front does not hide them; the service is the next non-flag token)."""
    out: list[tuple[str, str]] = []
    for step in (doc or yaml.safe_load(_CLOUDBUILD))["steps"]:
        args = [str(a) for a in (step.get("args") or [])]
        entry = step.get("entrypoint")
        if entry is None or os.path.basename(str(entry)) == "gcloud":
            for i in range(len(args) - 1):
                if args[i : i + 2] == ["run", "deploy"]:
                    name = _positional_after(args, i + 2)
                elif args[i : i + 3] in (["run", "services", "update"], ["run", "services", "replace"]):
                    name = _positional_after(args, i + 3)
                else:
                    continue
                if name:
                    out.append((name, "gcloud " + " ".join(args)))
        for arg in args:  # every argument that holds a script
            lines = arg.split("\n")  # the file's own text (escaped form): the checks below read it as written
            for i, line in enumerate(lines):
                if line.lstrip().startswith("#"):
                    continue
                for m in _GCLOUD_RUN.finditer(line):
                    text = [line[m.start():]]
                    j = i
                    while text[-1].rstrip().endswith("\\") and j + 1 < len(lines):
                        j += 1
                        text.append(lines[j])
                    out.append((m.group(1), "\n".join(text)))
    return out


def test_the_scan_also_finds_a_direct_gcloud_step():
    """a new service added as `args: [run, deploy, new-service, …]` (no bash), with global flags in front, behind another command on the same line, through `/usr/bin/gcloud`, or as `gcloud beta run deploy`,
    must not slip past the closed-set check (codex 4786, three rounds)"""
    sdk = "gcr.io/google.com/cloudsdktool/cloud-sdk"
    doc = {"steps": [
        {"name": sdk, "args": ["run", "deploy", "brand-new-service", "--image=x"]},
        {"name": sdk, "entrypoint": "gcloud", "args": ["run", "services", "update", "another-new", "--image=x"]},
        {"name": sdk, "entrypoint": "gcloud", "args": ["--project=p", "run", "deploy", "flag-first", "--image=x"]},
        {"name": sdk, "entrypoint": "gcloud", "args": ["--quiet", "--project", "p", "run", "services", "update", "flag-then-value", "--image=x"]},
        {"name": sdk, "entrypoint": "gcloud", "args": ["run", "deploy", "--image=x", "flag-between"]},
        {"name": sdk, "entrypoint": "/usr/bin/gcloud", "args": ["run", "deploy", "by-path", "--image=x"]},
        {"name": sdk, "entrypoint": "gcloud", "args": ["run", "services", "replace", "by-replace"]},
        {"name": "x", "entrypoint": "bash", "args": ["-c", "gcloud run deploy in-bash \\\n  --image=x \\\n  --quiet"]},
        {"name": "x", "entrypoint": "bash", "args": ["-c", "gcloud run deploy first --image=x && gcloud run deploy chained --image=x"]},
        {"name": "x", "entrypoint": "bash", "args": ["-c", "echo go; gcloud --project p beta run services update beta-one --image=x"]},
        {"name": "x", "entrypoint": "sh", "args": ["-c", "gcloud run deploy in-sh --image=x"]},
        {"name": "x", "entrypoint": "bash", "args": ["-c", "# gcloud run deploy only-a-comment\necho hi"]},
        {"name": "x", "entrypoint": "bash", "args": ["-c", "echo run deploy not-a-gcloud-step"]},
        {"name": "x", "entrypoint": "docker", "args": ["run", "deploy", "not-gcloud"]},
    ]}
    assert [s for s, _ in _commands(doc)] == [
        "brand-new-service", "another-new", "flag-first", "flag-then-value", "flag-between", "by-path", "by-replace",
        "in-bash", "first", "chained", "beta-one", "in-sh",
    ]


def test_every_cloud_run_deploy_command_states_its_billing_mode():
    """the set of services is closed: adding a Cloud Run deploy to the pipeline forces a decision here (per instance or per request)"""
    cmds = _commands()
    assert sorted(s for s, _ in cmds) == sorted(_EXPECTED_MODE), [s for s, _ in cmds]
    for service, text in cmds:
        token = _EXPECTED_MODE[service]
        assert text.count(token) == 1, (service, token)


def test_dev_backend_and_frontend_bill_per_instance_and_prod_states_nothing():
    """the dev branch of the workflow sends the flag; the prod branch sends nothing (separate change); the substitution reaches Cloud Build exactly; a manual submit that sends nothing leaves the live value alone"""
    assert _DEV.count('echo "cpu_flags=--no-cpu-throttling"') == 1
    assert "cpu_flags" not in _PROD
    assert "cpu_flags=--cpu-throttling" not in _WORKFLOW
    assert "V_CPU_FLAGS: ${{ steps.env.outputs.cpu_flags }}" in _WORKFLOW
    assert '_CPU_FLAGS=\\"${V_CPU_FLAGS}\\"' in _WORKFLOW
    assert re.findall(r"^  _CPU_FLAGS: '(.*)'$", _CLOUDBUILD, flags=re.M) == [""]


def test_the_real_steps_send_exactly_one_billing_flag_on_dev_and_none_on_prod():
    from tests.test_deploy_backend_redis_secret_conflict import _run_backend_deploy_argv, _run_frontend_deploy_argv

    backend = _run_backend_deploy_argv("dev", _CPU_FLAGS="--no-cpu-throttling", _BACKEND_MIN_INSTANCES="2")
    assert backend.count("--no-cpu-throttling") == 1 and "--cpu-throttling" not in backend, backend
    frontend = _run_frontend_deploy_argv("dev", "--no-cpu-throttling")
    assert frontend.count("--no-cpu-throttling") == 1 and "--cpu-throttling" not in frontend, frontend
    backend_prod = _run_backend_deploy_argv("prod", _CPU_FLAGS="", _BACKEND_MIN_INSTANCES="3")  # what the prod branch sends: nothing
    assert "--cpu-throttling" not in backend_prod and "--no-cpu-throttling" not in backend_prod and "" not in backend_prod, backend_prod
    frontend_prod = _run_frontend_deploy_argv("prod", "")
    assert "--cpu-throttling" not in frontend_prod and "--no-cpu-throttling" not in frontend_prod and "" not in frontend_prod, frontend_prod


def _step_call(step_id: str, deploy_env: str, call_pattern: str, extra_env: dict[str, str] | None = None) -> str:
    """run a REAL step of cloudbuild.yaml with gcloud stubbed; return the one `gcloud run …` call matching `call_pattern`"""
    script = _apply_cloudbuild_escaping(_extract_step_script(step_id))
    # only what Cloud Build supplies is pre-set (substitutions start with `_`; PROJECT_ID · COMMIT_SHA are built-ins). The script's OWN shell variables (MCP_CPU_FLAG · CPU_FLAG · ENV_VARS …) are left alone: pre-setting
    # them hid a removed `VAR=""` initialisation, which fails a real prod build under `set -u` (codex 4786)
    names = {n for n in re.findall(r"\$\{([A-Z_][A-Z0-9_]*)\}", script) if n.startswith("_") or n in ("PROJECT_ID", "COMMIT_SHA")}
    env = {**os.environ, **{n: "x" for n in names}, "_DEPLOY_ENV": deploy_env, "_MCP_ALLOWED_HOSTS": "", "_SUPPORT_GATEWAY_CORS_ORIGINS": "", **(extra_env or {})}
    # a variable the script assigns itself must come from the script, never from the caller's environment: a stray MCP_CPU_FLAG / CPU_FLAG there would hide a removed `VAR=""` initialisation (fails a real prod build under `set -u`)
    for own in set(re.findall(r"(?m)^\s*([A-Za-z_][A-Za-z0-9_]*)=", script)):
        env.pop(own, None)
    # the mcp step checks the served image against what it deployed: with every name set to "x" that is this string
    stub = (
        'gcloud() { if [ "$1 $2 $3" = "run services describe" ]; then echo "x-docker.pkg.dev/x/x/backend:x"; else printf "CALL"; for a in "$@"; do printf " [%s]" "$a"; done; echo; fi; }\n'
    )
    proc = subprocess.run(["bash", "-c", stub + script], capture_output=True, text=True, env=env)
    assert proc.returncode == 0, proc
    calls = [line for line in proc.stdout.splitlines() if re.match(call_pattern, line)]
    assert len(calls) == 1, proc.stdout
    assert "[]" not in calls[0], calls[0]  # no empty argument reaches gcloud (the unquoted empty flag expands to nothing)
    return calls[0]


def test_mcp_dev_bills_per_request_and_prod_states_nothing():
    dev = _step_call("deploy-mcp", "dev", r"^CALL \[run\] \[services\] \[update\] ")
    assert dev.count("[--cpu-throttling]") == 1 and "--no-cpu-throttling" not in dev, dev
    prod = _step_call("deploy-mcp", "prod", r"^CALL \[run\] \[services\] \[update\] ")
    assert "--cpu-throttling" not in prod and "--no-cpu-throttling" not in prod, prod


def test_support_gateway_dev_bills_per_request_and_prod_states_nothing():
    on = {"_SUPPORT_GATEWAY_DEPLOY_ENABLED": "true"}
    dev = _step_call("deploy-support-gateway", "dev", r"^CALL \[run\] \[deploy\] \[support-gateway-", on)
    assert dev.count("[--cpu-throttling]") == 1 and "--no-cpu-throttling" not in dev, dev
    prod = _step_call("deploy-support-gateway", "prod", r"^CALL \[run\] \[deploy\] \[support-gateway-", on)
    assert "--cpu-throttling" not in prod and "--no-cpu-throttling" not in prod, prod


def test_office_converter_and_realtime_run_on_dev_only_and_name_per_request_billing():
    """both steps exit first for any other environment, so the literal flag in their own command is dev-only"""
    by_service = dict(_commands())
    for service in ("office-converter-${_DEPLOY_ENV}", "sprintable-realtime-${_DEPLOY_ENV}"):
        assert " --cpu-throttling \\\n" in by_service[service] and "--no-cpu-throttling" not in by_service[service], service
    office = _extract_step_script("deploy-office-converter")
    assert 'if [ "${_DEPLOY_ENV}" != "dev" ]; then' in office[: office.index("gcloud run deploy office-converter-")]
    realtime = _extract_step_script("deploy-realtime")
    assert 'if [ "${_DEPLOY_ENV}" != "dev" ]; then' in realtime[: realtime.index("gcloud run deploy sprintable-realtime-")]


def test_the_manual_scripts_state_dev_per_instance_and_leave_prod_alone():
    for name in ("backend", "frontend"):
        script = (_ROOT / f"backend/scripts/deploy_{name}.sh").read_text()
        dev = script[script.index("    dev)"):script.index("    prod)")]
        prod = script[script.index("    prod)"):]
        assert 'CPU_FLAGS="--no-cpu-throttling"' in dev and "CPU_FLAGS=" not in prod, name
        assert 'CPU_FLAGS=""' in script and script.count("${CPU_FLAGS}") == 1, name  # the flag reaches the one gcloud call; prod keeps the empty default



def test_a_stray_environment_variable_cannot_stand_in_for_the_scripts_own_initialisation(monkeypatch):
    """with `MCP_CPU_FLAG` / `CPU_FLAG` set in the caller's environment the real prod runs still send no flag, and the dev runs send exactly the dev flag (the environment is cleaned of the script's own variables)"""
    monkeypatch.setenv("MCP_CPU_FLAG", "--bogus-from-the-environment")
    monkeypatch.setenv("CPU_FLAG", "--bogus-from-the-environment")
    on = {"_SUPPORT_GATEWAY_DEPLOY_ENABLED": "true"}
    mcp_pattern = r"^CALL \[run\] \[services\] \[update\] "
    sg_pattern = r"^CALL \[run\] \[deploy\] \[support-gateway-"
    for env, expect_flag in (("dev", True), ("prod", False)):
        for step, pattern, extra in (("deploy-mcp", mcp_pattern, None), ("deploy-support-gateway", sg_pattern, on)):
            call = _step_call(step, env, pattern, extra)
            assert "bogus" not in call, (step, env, call)
            assert call.count("[--cpu-throttling]") == (1 if expect_flag else 0), (step, env, call)
