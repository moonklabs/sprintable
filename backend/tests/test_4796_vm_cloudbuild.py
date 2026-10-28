"""story 4796 — the dev VM's bundle is built by a build of its own (cloudbuild-vm.yaml), started by cloud-build.yml after the Cloud Run build, not waited for, never able to fail that run.

History this pins: the first version was two `allowFailure` steps at the end of cloudbuild.yaml. On its first real run the worker stopped answering during the Next.js type check (build 844cd9a1,
INTERNAL_ERROR on every step) — a dead worker ignores `allowFailure` and step timeouts. So: the Cloud Run build is exactly what it was before, and the bundle is a separate build on its own worker.

Pinned: the Cloud Run build and its GitHub job limit are untouched; the submission is async, tolerant, dev-only and passes the same public build values; the separate build states its machine and its
limit itself; it builds for dev only; it refuses a build value nobody passed; it never writes `desired.json`; and — run for real against a fake docker / gcloud, after the same substitution Cloud Build
does — the bundle and the candidate file go where they should and nothing is uploaded when anything is off.
"""
from __future__ import annotations

import json
import os
import re
import shlex
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

_ROOT = Path(__file__).resolve().parents[2]
_MAIN = yaml.safe_load((_ROOT / "cloudbuild.yaml").read_text())
_VM = yaml.safe_load((_ROOT / "cloudbuild-vm.yaml").read_text())
_WF = yaml.safe_load((_ROOT / ".github/workflows/cloud-build.yml").read_text())
_STEPS = {s["id"]: s for s in _VM["steps"]}
VM_STEPS = ("resolve-backend", "build-frontend-vm", "bundle-vm")
SHA = "0123456789abcdef0123456789abcdef01234567"
BACKEND_DIGEST = "sha256:" + "b" * 64
FRONTEND_DIGEST = "sha256:" + "f" * 64
GATEWAY_DIGEST = "sha256:" + "9" * 64
NOT_PASSED = "__not-passed__"
# cloudbuild-vm.yaml substitution → (the env name the workflow's main substitutions step uses, the env name of the VM submission step, the Dockerfile build argument)
BUILD_VALUES = {
    "_GA4_MEASUREMENT_ID": ("V_GA4_MEASUREMENT_ID", "VM_GA4_MEASUREMENT_ID", "NEXT_PUBLIC_GA4_MEASUREMENT_ID"),
    "_EE_ENABLED": ("V_EE_ENABLED", "VM_EE_ENABLED", "NEXT_PUBLIC_EE_ENABLED"),
    "_SUPPORT_WIDGET_ENABLED": ("V_SUPPORT_WIDGET_ENABLED", "VM_SUPPORT_WIDGET_ENABLED", "NEXT_PUBLIC_SUPPORT_WIDGET_ENABLED"),
    "_NEXT_PUBLIC_SUPPORT_GATEWAY_URL": ("V_NEXT_PUBLIC_SUPPORT_GATEWAY_URL", "VM_SUPPORT_GATEWAY_URL", "NEXT_PUBLIC_SUPPORT_GATEWAY_URL"),
    "_TOSS_CLIENT_KEY": ("V_TOSS_CLIENT_KEY", "VM_TOSS_CLIENT_KEY", "NEXT_PUBLIC_TOSS_CLIENT_KEY"),
}


def _seconds(v: str) -> int:
    m = re.fullmatch(r"(\d+)s", v)
    assert m, v
    return int(m.group(1))


def _job_steps() -> list[dict]:
    return _WF["jobs"]["cloud-build"]["steps"]


def _submit_vm() -> dict:
    found = [s for s in _job_steps() if s.get("name", "").startswith("Submit the dev VM bundle build")]
    assert len(found) == 1
    return found[0]


# ───────────────────────── the Cloud Run build is what it was ─────────────────────────

def test_the_cloud_run_build_has_no_vm_steps_no_failure_exemptions_and_no_new_time_limit() -> None:
    steps = _MAIN["steps"]
    ids = [s["id"] for s in steps]
    assert not set(ids) & set(VM_STEPS) and "build-frontend-vm" not in json.dumps(_MAIN)
    assert not [s["id"] for s in steps if s.get("allowFailure")]
    assert "timeout" not in _MAIN, "the Cloud Run build keeps its former time limit (it was never set here)"
    assert "_VM_DEPLOY_BUCKET" not in _MAIN["substitutions"]
    assert _WF["jobs"]["cloud-build"]["timeout-minutes"] == 30


def test_the_serving_reality_check_still_follows_the_cloud_run_job_only() -> None:
    assert _WF["jobs"]["serving-reality"]["needs"] == "cloud-build"


# ───────────────────────── the submission from the workflow ─────────────────────────

def test_the_vm_build_is_submitted_after_the_cloud_run_build_async_and_without_being_able_to_fail_the_run() -> None:
    names = [s.get("name", "") for s in _job_steps()]
    main_at, vm_at = names.index("Submit Cloud Build"), names.index(_submit_vm()["name"])
    assert vm_at == main_at + 1, "right after the Cloud Run build (its images are in the registry then)"
    step = _submit_vm()
    assert step["continue-on-error"] is True
    assert "success()" in step["if"] and "steps.env.outputs.target == 'dev'" in step["if"]
    run = step["run"]
    assert "--async" in run, "the run must not wait for it (no delay for serving-reality)"
    assert "--config=cloudbuild-vm.yaml" in run
    assert _VM["tags"] == ["vm-bundle"], "`gcloud builds submit` has no tags flag: the tag lives in the build file"
    assert "--config=cloudbuild.yaml" not in run
    assert step["timeout-minutes"] <= 10


def test_the_submission_passes_the_same_public_build_values_as_the_cloud_run_build() -> None:
    step = _submit_vm()
    main_env = next(s for s in _job_steps() if s.get("id") == "subst")["env"]
    cloud_run_args = next(s for s in _MAIN["steps"] if s["id"] == "build-frontend")["args"]
    for sub, (v_name, vm_name, build_arg) in BUILD_VALUES.items():
        assert step["env"][vm_name] == main_env[v_name], f"{sub}: the VM build must get what the Cloud Run build gets ({main_env[v_name]})"
        assert f'{sub}="${{{vm_name}}}"' in step["run"], sub
        assert f"{build_arg}=${{{sub}}}" in cloud_run_args, f"the Cloud Run frontend build takes {sub} for {build_arg}"
    assert 'COMMIT_SHA="${{ github.sha }}"' in step["run"] and '_DEPLOY_ENV="dev"' in step["run"]


@pytest.mark.skipif(shutil.which("gcloud") is None, reason="gcloud not installed here (GitHub runners have it)")
@pytest.mark.parametrize("which", ["Submit Cloud Build", "vm"])
def test_the_submit_command_lines_are_accepted_by_the_real_gcloud_flag_parser(which: str, tmp_path: Path) -> None:
    """a flag gcloud does not know (`--tags` once was one) makes the submission fail every time — and `continue-on-error` would hide it. Flags are parsed before anything is read or sent: the config is /dev/null, so it stops there."""
    step = _submit_vm() if which == "vm" else next(s for s in _job_steps() if s.get("name") == "Submit Cloud Build")
    text = step["run"].replace("\\\n", " ").replace("${{ secrets.GCP_PROJECT_ID }}", "test-project-123456")  # a real-looking project id: gcloud checks it before the flags
    text = text.replace("${{ steps.subst.outputs.substitutions }}", "_A=X")  # a KEY=VALUE list, as the assembled one is
    text = re.sub(r"\$\{\{[^}]*\}\}|\$\{\w+\}", "X", text)
    words = shlex.split(text)
    assert words[:3] == ["gcloud", "builds", "submit"]
    argv = [re.sub(r"^--config=.*", "--config=/dev/null", w) for w in words]
    p = subprocess.run(argv, capture_output=True, text=True, cwd=tmp_path, env={"PATH": os.environ["PATH"], "HOME": str(tmp_path), "CLOUDSDK_CONFIG": str(tmp_path / "gc")}, timeout=120)
    assert "unrecognized arguments" not in p.stderr and "usage:" not in p.stderr.lower(), p.stderr[:400]
    assert "parsing /dev/null" in p.stderr, f"the flags were accepted only if gcloud got as far as reading the (empty) config: {p.stderr[:400]}"


# ───────────────────────── the separate build ─────────────────────────

def test_the_vm_build_has_three_steps_in_a_chain() -> None:
    assert [s["id"] for s in _VM["steps"]] == list(VM_STEPS)
    assert "waitFor" not in _STEPS["resolve-backend"]
    assert _STEPS["build-frontend-vm"]["waitFor"] == ["resolve-backend"] and _STEPS["bundle-vm"]["waitFor"] == ["build-frontend-vm"]


def test_the_vm_build_states_its_own_machine_and_time_limits() -> None:
    assert _VM["options"]["machineType"] == "E2_HIGHCPU_8", "stated here, not borrowed from the Cloud Run build"
    assert _VM["options"]["logging"] == "CLOUD_LOGGING_ONLY"
    steps_total = sum(_seconds(_STEPS[s]["timeout"]) for s in VM_STEPS)
    assert _seconds(_VM["timeout"]) >= steps_total + 300, "the build limit covers every step limit with room"
    assert _seconds(_STEPS["build-frontend-vm"]["timeout"]) >= 900, "the frontend build took 6 minutes on a fresh worker"


def test_the_five_build_values_default_to_a_marker_so_a_forgotten_one_fails() -> None:
    for sub in BUILD_VALUES:
        assert _VM["substitutions"][sub] == NOT_PASSED, sub
    assert _VM["substitutions"]["_VM_DEPLOY_BUCKET"] == "sprintable-vm-dev-deploy"
    assert _VM["substitutions"]["_DEPLOY_ENV"] == "dev"


def test_every_step_is_dev_only_and_no_script_writes_desired_json() -> None:
    for sid in VM_STEPS:
        script = _STEPS[sid]["args"][1]
        assert re.search(r'if \[ "\$\{_DEPLOY_ENV\}" != "dev" \]; then\s+echo [^\n]*\n\s+exit 0\s+fi', script), sid
        assert not re.search(r"gs://\S*desired\.json", script), f"{sid} must not write the VM's desired.json (RUNBOOK §7 step 1 does)"


def test_the_images_live_in_our_registry_and_the_two_hosts_are_not_passed_from_here() -> None:
    script = _STEPS["build-frontend-vm"]["args"][1]
    assert '"${_AR_REGION}-docker.pkg.dev/${PROJECT_ID}/${_AR_REPO}"' in script and "frontend-vm:${COMMIT_SHA}" in script
    assert "NEXT_PUBLIC_FASTAPI_URL" not in script and "NEXT_PUBLIC_APP_URL" not in script


def test_the_runbook_describes_the_separate_build_and_the_desired_json_handover() -> None:
    text = (_ROOT / "deploy/vm/RUNBOOK.md").read_text()
    assert "`cloudbuild-vm.yaml`" in text and "tag `vm-bundle`" in text and "build 844cd9a1" in text
    assert "gcloud storage cp gs://$DEPLOY_BUCKET/candidates/$SHA.json gs://$DEPLOY_BUCKET/desired.json" in text


# ───────────────────────── the scripts, run for real ─────────────────────────

def _substitute(text: str, values: dict[str, str]) -> str:
    """what Cloud Build does to a step before the shell sees it: `$$` → `$`, `${_X}` / `${BUILTIN}` → value, any other `${…}` is an error."""
    marker = "\x00"
    text = text.replace("$$", marker)

    def sub(m: re.Match) -> str:
        if m.group(1) not in values:
            raise AssertionError(f"Cloud Build would reject ${{{m.group(1)}}} (not a substitution) — shell variables need $$")
        return values[m.group(1)]

    return re.sub(r"\$\{(\w+)\}", sub, text).replace(marker, "$")


_FAKE_DOCKER = r"""#!/bin/sh
echo "docker $*" >> "$FAKE_LOG"
case "$1" in
  run)
    case "$*" in
      *"-rlF"*) echo 1 ;;
      *"/web/public"*) echo 0 ;;
      *"-rlE"*) echo 0 ;;
    esac ;;
  image) echo "$FAKE_FRONTEND_REF" ;;
esac
exit 0
"""

_FAKE_GCLOUD = r"""#!/bin/sh
echo "gcloud $*" >> "$FAKE_LOG"
case "$*" in
  "artifacts docker images describe"*support-gateway*) echo "$FAKE_GATEWAY_DIGEST" ;;
  "artifacts docker images describe"*) echo "$FAKE_BACKEND_DIGEST" ;;
  "storage cp "*) : ;;
  *) echo "unexpected gcloud call: $*" >&2; exit 9 ;;
esac
exit 0
"""

_REPO = "asia-northeast3-docker.pkg.dev/proj-1/sprintable"


@pytest.fixture()
def box(tmp_path: Path):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    for name, body in (("docker", _FAKE_DOCKER), ("gcloud", _FAKE_GCLOUD)):
        (bin_dir / name).write_text(body)
        (bin_dir / name).chmod(0o755)
    log = tmp_path / "calls.log"
    log.write_text("")
    work = tmp_path / "workspace"
    work.mkdir()
    base = {
        **_VM["substitutions"], "PROJECT_ID": "proj-1", "COMMIT_SHA": SHA,
        "_GA4_MEASUREMENT_ID": "", "_EE_ENABLED": "true", "_SUPPORT_WIDGET_ENABLED": "true",
        "_NEXT_PUBLIC_SUPPORT_GATEWAY_URL": "https://gateway.example", "_TOSS_CLIENT_KEY": "toss-public-key",
    }

    def run(step: str, **over: str):
        vals = {**base, **{k: v for k, v in over.items() if k in base}}
        env = {"PATH": f"{bin_dir}:{Path(sys.executable).parent}:/usr/bin:/bin:/usr/local/bin", "HOME": os.environ["HOME"], "FAKE_LOG": str(log),
               "FAKE_FRONTEND_REF": over.get("FAKE_FRONTEND_REF", f"{_REPO}/frontend-vm@{FRONTEND_DIGEST}"),
               "FAKE_BACKEND_DIGEST": over.get("FAKE_BACKEND_DIGEST", BACKEND_DIGEST), "FAKE_GATEWAY_DIGEST": over.get("FAKE_GATEWAY_DIGEST", GATEWAY_DIGEST)}
        for e in _STEPS[step].get("env", []):
            k, v = _substitute(e, vals).split("=", 1)
            env[k] = v
        script = _substitute(_STEPS[step]["args"][1], vals).replace("/workspace/", f"{work}/")
        p = subprocess.run(["bash", "-c", script], env=env, cwd=_ROOT, capture_output=True, text=True, timeout=120)
        return p, log.read_text()

    run.work, run.repo = work, _REPO
    return run


def _docker_calls(calls: str) -> list[str]:
    return [c for c in calls.splitlines() if c.startswith("docker ")]


def _resolve_and_build(box) -> None:
    assert box("resolve-backend")[0].returncode == 0
    assert box("build-frontend-vm")[0].returncode == 0


def test_prod_runs_no_step(box) -> None:
    for step in VM_STEPS:
        p, calls = box(step, _DEPLOY_ENV="prod")
        assert p.returncode == 0 and "dev only" in p.stdout
        assert calls == ""
    assert not (box.work / "vm-out").exists()


def test_the_backend_digest_is_resolved_from_the_registry_before_anything_long(box) -> None:
    p, calls = box("resolve-backend")
    assert p.returncode == 0, p.stderr
    assert f"gcloud artifacts docker images describe {box.repo}/backend:{SHA}" in calls
    assert (box.work / "vm-out/backend-image.txt").read_text() == f"{box.repo}/backend@{BACKEND_DIGEST}\n"
    assert f"gcloud artifacts docker images describe {box.repo}/support-gateway:{SHA}" in calls
    assert (box.work / "vm-out/support-gateway-image.txt").read_text() == f"{box.repo}/support-gateway@{GATEWAY_DIGEST}\n", "the gateway image of the same sha, by digest, from its own repository entry"
    assert _docker_calls(calls) == []


@pytest.mark.parametrize("digest", ["", "garbage", "sha256:abc", "sha256:" + "G" * 64, "sha256:" + "9" * 63])
def test_a_gateway_digest_that_is_not_one_stops_the_resolve_step(box, digest: str) -> None:
    p, _ = box("resolve-backend", FAKE_GATEWAY_DIGEST=digest)
    assert p.returncode != 0 and "no digest for" in p.stderr and "support-gateway" in p.stderr
    assert not (box.work / "vm-out/support-gateway-image.txt").exists()


@pytest.mark.parametrize("digest", ["", "latest", "sha256:abc", "sha256:" + "B" * 64])
def test_nothing_is_built_without_a_backend_digest(box, digest: str) -> None:
    p, _ = box("resolve-backend", FAKE_BACKEND_DIGEST=digest)
    assert p.returncode != 0 and "no digest" in p.stderr
    assert not (box.work / "vm-out/backend-image.txt").exists()
    p, calls = box("build-frontend-vm")  # the next step refuses to start without it
    assert p.returncode != 0 and "no backend image" in p.stderr
    assert _docker_calls(calls) == []


@pytest.mark.parametrize("sub", list(BUILD_VALUES))
def test_a_build_value_nobody_passed_stops_the_build_before_docker(box, sub: str) -> None:
    assert box("resolve-backend")[0].returncode == 0
    p, calls = box("build-frontend-vm", **{sub: NOT_PASSED})
    assert p.returncode != 0 and BUILD_VALUES[sub][1] in p.stderr and "was not passed" in p.stderr
    assert _docker_calls(calls) == []


def test_an_explicitly_empty_build_value_is_fine(box) -> None:
    assert box("resolve-backend")[0].returncode == 0
    p, calls = box("build-frontend-vm", _GA4_MEASUREMENT_ID="", _TOSS_CLIENT_KEY="")
    assert p.returncode == 0, p.stderr
    assert "NEXT_PUBLIC_GA4_MEASUREMENT_ID= " in next(c for c in calls.splitlines() if c.startswith("docker build")) + " "


def test_the_frontend_step_builds_with_the_cloud_run_values_for_amd64_pushes_and_records_the_digest(box) -> None:
    assert box("resolve-backend")[0].returncode == 0
    p, calls = box("build-frontend-vm")
    assert p.returncode == 0, p.stderr
    build = next(c for c in calls.splitlines() if c.startswith("docker build"))
    assert "--platform linux/amd64" in build and f"-t {box.repo}/frontend-vm:{SHA}" in build
    for arg in ("NEXT_PUBLIC_EE_ENABLED=true", "NEXT_PUBLIC_SUPPORT_WIDGET_ENABLED=true", "NEXT_PUBLIC_SUPPORT_GATEWAY_URL=https://gateway.example",
                "NEXT_PUBLIC_TOSS_CLIENT_KEY=toss-public-key", "NEXT_PUBLIC_GA4_MEASUREMENT_ID=", "NEXT_PUBLIC_FASTAPI_URL=https://dev-api.sprintable.ai",
                f"APP_COMMIT_SHA={SHA}", "SPRINTABLE_DEPLOY_BUILD=1"):
        assert f"--build-arg {arg}" in build + " ", arg
    assert any(c.startswith(f"docker push {box.repo}/frontend-vm:{SHA}") for c in calls.splitlines())
    assert (box.work / "vm-out/frontend-image.txt").read_text() == f"{box.repo}/frontend-vm@{FRONTEND_DIGEST}\n"


def test_the_frontend_step_installs_python_yaml_when_the_builder_image_lacks_it(box, tmp_path: Path) -> None:
    """the docker builder image may have no PyYAML (the build-argument list is read from the declaration with it): the step installs it, and goes on."""
    assert box("resolve-backend")[0].returncode == 0
    marker = tmp_path / "yaml-installed"
    shim = tmp_path / "bin" / "python3"
    shim.write_text(f"#!/bin/sh\nif [ \"$*\" = \"-c import yaml\" ] && [ ! -f {marker} ]; then exit 1; fi\nexec {sys.executable} \"$@\"\n")
    shim.chmod(0o755)
    apt = tmp_path / "bin" / "apt-get"
    apt.write_text(f"#!/bin/sh\necho \"apt-get $*\" >> \"$FAKE_LOG\"\ncase \"$*\" in *python3-yaml*) touch {marker} ;; esac\n")
    apt.chmod(0o755)
    p, calls = box("build-frontend-vm")
    assert p.returncode == 0, p.stderr
    assert "apt-get install -y -qq python3 python3-yaml" in calls
    assert (box.work / "vm-out/frontend-image.txt").is_file()


def test_the_frontend_step_does_not_touch_apt_when_yaml_is_there(box) -> None:
    assert box("resolve-backend")[0].returncode == 0
    _, calls = box("build-frontend-vm")
    assert "apt-get" not in calls


@pytest.mark.parametrize("ref", [
    "", "garbage", "r.example/frontend-vm@sha256:abc123",
    "asia-northeast3-docker.pkg.dev/proj-1/sprintable/frontend@sha256:" + "f" * 64,  # the Cloud Run image, not the VM's
    "asia-northeast3-docker.pkg.dev/proj-1/sprintable/frontend-vm:" + SHA,  # a tag, not a digest
    "evil.example/sprintable/frontend-vm@sha256:" + "f" * 64,
    "asia-northeast3-docker.pkg.dev/proj-1/sprintable/frontend-vm@sha256:abc123",  # our image, a short digest
    "asia-northeast3-docker.pkg.dev/proj-1/sprintable/frontend-vm@sha256:" + "F" * 64,
])
def test_the_frontend_step_records_nothing_unless_the_last_line_is_our_digest_reference(box, ref: str) -> None:
    assert box("resolve-backend")[0].returncode == 0
    p, _ = box("build-frontend-vm", FAKE_FRONTEND_REF=ref)
    assert p.returncode != 0
    assert not (box.work / "vm-out/frontend-image.txt").exists()


def test_the_bundle_step_uploads_the_bundle_then_the_candidate_and_never_desired_json(box) -> None:
    _resolve_and_build(box)
    p, calls = box("bundle-vm")
    assert p.returncode == 0, p.stderr
    cps = [c for c in calls.splitlines() if c.startswith("gcloud storage cp")]
    bucket = "gs://sprintable-vm-dev-deploy"
    assert [c.split()[-1] for c in cps] == [f"{bucket}/bundles/{SHA}.tgz", f"{bucket}/candidates/{SHA}.json"], "bundle first, the candidate after it, nothing else"
    assert not any("desired.json" in c.split()[-1] for c in cps)
    out = box.work / "vm-out/bundle"
    assert (out / f"bundles/{SHA}.tgz").is_file()
    cand = json.loads((out / "desired.json").read_text())
    assert cand["backend_image"] == f"{box.repo}/backend@{BACKEND_DIGEST}" and cand["frontend_image"] == f"{box.repo}/frontend-vm@{FRONTEND_DIGEST}"
    assert cand["sha"] == SHA and cand["bundle"] == f"bundles/{SHA}.tgz"
    assert cand["support_gateway_image"] == f"{box.repo}/support-gateway@{GATEWAY_DIGEST}", "the candidate names the gateway image of this sha"


@pytest.mark.parametrize("missing", ["frontend-image.txt", "backend-image.txt", "support-gateway-image.txt"])
def test_the_bundle_step_uploads_nothing_unless_all_three_images_were_recorded(box, missing: str) -> None:
    _resolve_and_build(box)
    (box.work / "vm-out" / missing).unlink()
    p, calls = box("bundle-vm")
    assert p.returncode != 0 and "no bundle" in p.stderr and missing.split("-")[0] in p.stderr
    assert calls.count("storage cp") == 0


def test_the_bundle_step_uploads_nothing_when_nothing_ran_before(box) -> None:
    p, calls = box("bundle-vm")
    assert p.returncode != 0 and "no bundle" in p.stderr
    assert calls == ""


def test_a_shell_variable_without_double_dollar_would_be_rejected_by_cloud_build() -> None:
    with pytest.raises(AssertionError, match="not a substitution"):
        _substitute("echo ${out}", {})
    assert _substitute("echo $${out} $${!v} ${PROJECT_ID}", {"PROJECT_ID": "p"}) == "echo ${out} ${!v} p"
