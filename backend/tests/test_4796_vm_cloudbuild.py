"""story 4796 — the dev VM's bundle is built by two dev-only, failure-tolerant steps at the end of cloudbuild.yaml (build-frontend-vm, bundle-vm).

What is pinned: they come after every Cloud Run step and can not hold one back, a failure of theirs does not fail the build, they build for dev only, the VM image takes the same
public build values as the Cloud Run frontend, `desired.json` is never written, and — run for real against a fake docker / gcloud, after the same substitution Cloud Build does —
the bundle and the candidate file go where they should and nothing is uploaded when anything is off.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

_ROOT = Path(__file__).resolve().parents[2]
_CB = yaml.safe_load((_ROOT / "cloudbuild.yaml").read_text())
_STEPS = {s["id"]: s for s in _CB["steps"]}
_IDS = [s["id"] for s in _CB["steps"]]
VM_STEPS = ("build-frontend-vm", "bundle-vm")
SHA = "0123456789abcdef0123456789abcdef01234567"
BACKEND_DIGEST = "sha256:" + "b" * 64
FRONTEND_DIGEST = "sha256:" + "f" * 64


# ───────────────────────── the shape of the build ─────────────────────────

def test_the_vm_steps_are_the_last_two_and_wait_for_everything_before() -> None:
    assert _IDS[-2:] == list(VM_STEPS)
    assert "waitFor" not in _STEPS["build-frontend-vm"], "no waitFor = wait for every step above, i.e. after the Cloud Run deploys"
    assert _STEPS["bundle-vm"]["waitFor"] == ["build-frontend-vm"]


def test_no_other_step_waits_for_a_vm_step() -> None:
    for s in _CB["steps"]:
        if s["id"] in VM_STEPS:
            continue
        assert not set(s.get("waitFor", [])) & set(VM_STEPS), f"{s['id']} must not wait for a VM step"


def test_a_failure_of_the_vm_steps_does_not_fail_the_build() -> None:
    for sid in VM_STEPS:
        assert _STEPS[sid].get("allowFailure") is True, sid
    others = [s["id"] for s in _CB["steps"] if s["id"] not in VM_STEPS and s.get("allowFailure")]
    assert others == [], f"allowFailure appeared on another step: {others}"


def test_the_vm_steps_can_not_turn_a_finished_deploy_into_a_timeout() -> None:
    def seconds(v: str) -> int:
        m = re.fullmatch(r"(\d+)s", v)
        assert m, v
        return int(m.group(1))

    step_total = sum(seconds(_STEPS[s]["timeout"]) for s in VM_STEPS)  # each step has its own limit
    assert step_total <= 1200
    assert seconds(_CB["timeout"]) >= 1800 + step_total, "the build limit must leave room for the deploys (≈ 12 minutes, 30 at the worst seen) and both VM steps' limits"
    # the GitHub job waits for the build (`gcloud builds submit` is synchronous): its limit must leave the same room, or a slow VM step makes the job fail after the deploy was done
    job = yaml.safe_load((_ROOT / ".github/workflows/cloud-build.yml").read_text())["jobs"]["cloud-build"]
    assert job["timeout-minutes"] * 60 >= seconds(_CB["timeout"]) + 300, "the job must outlive the build it waits for (plus the minutes it spends before submitting), or a finished deploy shows as a failed run"


def test_the_vm_image_takes_the_public_build_values_of_the_cloud_run_frontend() -> None:
    build = _STEPS["build-frontend"]["args"]
    cloud_run = {a.split("=", 1)[0]: a.split("=", 1)[1] for a in build if re.match(r"NEXT_PUBLIC_\w+=", a)}
    env = dict(e.split("=", 1) for e in _STEPS["build-frontend-vm"]["env"])
    pairs = {
        "NEXT_PUBLIC_GA4_MEASUREMENT_ID": "VM_GA4_MEASUREMENT_ID",
        "NEXT_PUBLIC_EE_ENABLED": "VM_EE_ENABLED",
        "NEXT_PUBLIC_SUPPORT_WIDGET_ENABLED": "VM_SUPPORT_WIDGET_ENABLED",
        "NEXT_PUBLIC_SUPPORT_GATEWAY_URL": "VM_SUPPORT_GATEWAY_URL",
        "NEXT_PUBLIC_TOSS_CLIENT_KEY": "VM_TOSS_CLIENT_KEY",
    }
    for build_arg, var in pairs.items():
        assert env[var] == cloud_run[build_arg], f"{build_arg}: the VM image must use {cloud_run[build_arg]}, not {env[var]}"
    # the two hosts are the VM's (from deploy/vm/env/dev.yaml), so they are not passed from here at all
    script = _STEPS["build-frontend-vm"]["args"][1]
    assert "NEXT_PUBLIC_FASTAPI_URL" not in script and "NEXT_PUBLIC_APP_URL" not in script


def test_both_steps_are_dev_only_and_no_script_writes_desired_json() -> None:
    for sid in VM_STEPS:
        script = _STEPS[sid]["args"][1]
        assert re.search(r'if \[ "\$\{_DEPLOY_ENV\}" != "dev" \]; then\s+echo [^\n]*\n\s+exit 0\s+fi', script), sid
        assert not re.search(r"gs://\S*desired\.json", script), f"{sid} must not write the VM's desired.json (RUNBOOK §7 step 6 does)"
        assert not re.search(r"\bcp\b[^\n]*desired\.json\s+\"?gs://", script)


def test_the_bucket_default_is_the_dev_vm_deploy_bucket_and_the_images_live_in_our_registry() -> None:
    assert _CB["substitutions"]["_VM_DEPLOY_BUCKET"] == "sprintable-vm-dev-deploy"
    script = _STEPS["build-frontend-vm"]["args"][1]
    assert '"${_AR_REGION}-docker.pkg.dev/${PROJECT_ID}/${_AR_REPO}"' in script and "frontend-vm:${COMMIT_SHA}" in script


# ───────────────────────── the two scripts, run for real ─────────────────────────

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
  image)
    case "$*" in
      *"/backend:"*) printf '%s' "$FAKE_BACKEND_REFS" ;;
      *) echo "$FAKE_FRONTEND_REF" ;;
    esac ;;
esac
exit 0
"""

_FAKE_GCLOUD = r"""#!/bin/sh
echo "gcloud $*" >> "$FAKE_LOG"
case "$*" in
  "storage cp "*) : ;;
  *) echo "unexpected gcloud call: $*" >&2; exit 9 ;;
esac
exit 0
"""


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
    repo = "asia-northeast3-docker.pkg.dev/proj-1/sprintable"
    values = {
        "PROJECT_ID": "proj-1", "COMMIT_SHA": SHA, "_AR_REGION": "asia-northeast3", "_AR_REPO": "sprintable", "_DEPLOY_ENV": "dev",
        "_VM_DEPLOY_BUCKET": _CB["substitutions"]["_VM_DEPLOY_BUCKET"], "_GA4_MEASUREMENT_ID": "", "_EE_ENABLED": "true", "_SUPPORT_WIDGET_ENABLED": "true",
        "_NEXT_PUBLIC_SUPPORT_GATEWAY_URL": "https://gateway.example", "_TOSS_CLIENT_KEY": "toss-public-key",
    }

    def run(step: str, **over: str):
        vals = {**values, **{k: v for k, v in over.items() if k in values}}
        env = {"PATH": f"{bin_dir}:{Path(sys.executable).parent}:/usr/bin:/bin:/usr/local/bin", "HOME": os.environ["HOME"], "FAKE_LOG": str(log),
               "FAKE_FRONTEND_REF": over.get("FAKE_FRONTEND_REF", f"{repo}/frontend-vm@{FRONTEND_DIGEST}"),
               "FAKE_BACKEND_REFS": over.get("FAKE_BACKEND_REFS", f"{repo}/backend@{BACKEND_DIGEST}\n")}
        for e in _STEPS[step].get("env", []):
            k, v = _substitute(e, vals).split("=", 1)
            env[k] = v
        script = _substitute(_STEPS[step]["args"][1], vals).replace("/workspace/", f"{work}/")
        p = subprocess.run(["bash", "-c", script], env=env, cwd=_ROOT, capture_output=True, text=True, timeout=120)
        return p, log.read_text()

    run.work, run.repo = work, repo
    return run


def test_prod_runs_neither_step(box) -> None:
    for step in VM_STEPS:
        p, calls = box(step, _DEPLOY_ENV="prod")
        assert p.returncode == 0 and "dev only" in p.stdout
        assert calls == ""
    assert not (box.work / "vm-out").exists()


def test_the_frontend_step_builds_with_the_cloud_run_values_for_amd64_pushes_and_records_the_digest(box) -> None:
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
    assert (box.work / "vm-out/backend-image.txt").read_text() == f"{box.repo}/backend@{BACKEND_DIGEST}\n"
    assert f"docker image inspect --format {{{{range .RepoDigests}}}}{{{{println .}}}}{{{{end}}}} {box.repo}/backend:{SHA}" in calls, "the backend digest is read from THIS build's image"


def test_the_frontend_step_installs_python_yaml_when_the_builder_image_lacks_it(box, tmp_path: Path) -> None:
    """the docker builder image may have no PyYAML (the build-argument list is read from the declaration with it): the step installs it, and goes on."""
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
    _, calls = box("build-frontend-vm")
    assert "apt-get" not in calls


def test_the_runbook_describes_these_steps_and_the_desired_json_handover() -> None:
    text = (_ROOT / "deploy/vm/RUNBOOK.md").read_text()
    assert "`build-frontend-vm` and `bundle-vm`" in text
    assert "gcloud storage cp gs://$DEPLOY_BUCKET/candidates/$SHA.json gs://$DEPLOY_BUCKET/desired.json" in text


@pytest.mark.parametrize("ref", [
    "", "garbage", "r.example/frontend-vm@sha256:abc123",
    "asia-northeast3-docker.pkg.dev/proj-1/sprintable/frontend@sha256:" + "f" * 64,  # the Cloud Run image, not the VM's
    "asia-northeast3-docker.pkg.dev/proj-1/sprintable/frontend-vm:" + SHA,  # a tag, not a digest
    "evil.example/sprintable/frontend-vm@sha256:" + "f" * 64,
    "asia-northeast3-docker.pkg.dev/proj-1/sprintable/frontend-vm@sha256:abc123",  # our image, a short digest
    "asia-northeast3-docker.pkg.dev/proj-1/sprintable/frontend-vm@sha256:" + "F" * 64,
])
def test_the_frontend_step_records_nothing_unless_the_last_line_is_our_digest_reference(box, ref: str) -> None:
    p, _ = box("build-frontend-vm", FAKE_FRONTEND_REF=ref)
    assert p.returncode != 0
    assert not (box.work / "vm-out/frontend-image.txt").exists()


def test_the_bundle_step_uploads_the_bundle_then_the_candidate_and_never_desired_json(box) -> None:
    assert box("build-frontend-vm")[0].returncode == 0
    p, calls = box("bundle-vm")
    assert p.returncode == 0, p.stderr
    lines = calls.splitlines()
    assert "artifacts" not in calls, "the backend digest comes from this build, not from a tag read from the registry later"
    cps = [c for c in lines if c.startswith("gcloud storage cp")]
    bucket = "gs://sprintable-vm-dev-deploy"
    assert [c.split()[-1] for c in cps] == [f"{bucket}/bundles/{SHA}.tgz", f"{bucket}/candidates/{SHA}.json"], "bundle first, the candidate after it, nothing else"
    assert not any("desired.json" in c.split()[-1] for c in cps)
    out = box.work / "vm-out/bundle"
    assert (out / f"bundles/{SHA}.tgz").is_file()
    cand = json.loads((out / "desired.json").read_text())
    assert cand["backend_image"] == f"{box.repo}/backend@{BACKEND_DIGEST}" and cand["frontend_image"] == f"{box.repo}/frontend-vm@{FRONTEND_DIGEST}"
    assert cand["sha"] == SHA and cand["bundle"] == f"bundles/{SHA}.tgz"


def test_the_bundle_step_uploads_nothing_without_the_frontend_image(box) -> None:
    p, calls = box("bundle-vm")  # build-frontend-vm did not run / failed
    assert p.returncode != 0 and "no bundle" in p.stderr
    assert calls == ""


_REPO = "asia-northeast3-docker.pkg.dev/proj-1/sprintable"


@pytest.mark.parametrize("refs", [
    "", "latest\n", f"{_REPO}/backend@sha256:abc\n", f"{_REPO}/backend@sha256:" + "B" * 64 + "\n",
    f"{_REPO}/backend:{SHA}\n", "evil.example/sprintable/backend@sha256:" + "b" * 64 + "\n",
    f"{_REPO}/frontend@sha256:" + "b" * 64 + "\n",
])
def test_nothing_is_built_or_pushed_without_this_builds_backend_digest(box, refs: str) -> None:
    p, calls = box("build-frontend-vm", FAKE_BACKEND_REFS=refs)
    assert p.returncode != 0 and "no digest reference" in p.stderr
    assert "docker build" not in calls and "docker push" not in calls
    assert not (box.work / "vm-out/backend-image.txt").exists()


def test_the_backend_digest_is_the_line_of_our_repository_when_the_image_has_several(box) -> None:
    refs = f"other.example/x/backend@sha256:{'a' * 64}\n{_REPO}/backend@{BACKEND_DIGEST}\n"
    p, _ = box("build-frontend-vm", FAKE_BACKEND_REFS=refs)
    assert p.returncode == 0, p.stderr
    assert (box.work / "vm-out/backend-image.txt").read_text() == f"{_REPO}/backend@{BACKEND_DIGEST}\n"


@pytest.mark.parametrize("missing", ["frontend-image.txt", "backend-image.txt"])
def test_the_bundle_step_uploads_nothing_unless_both_images_were_recorded(box, missing: str) -> None:
    assert box("build-frontend-vm")[0].returncode == 0
    (box.work / "vm-out" / missing).unlink()
    p, calls = box("bundle-vm")
    assert p.returncode != 0 and "no bundle" in p.stderr and missing.split("-")[0] in p.stderr
    assert calls.count("storage cp") == 0


def test_a_shell_variable_without_double_dollar_would_be_rejected_by_cloud_build() -> None:
    with pytest.raises(AssertionError, match="not a substitution"):
        _substitute("echo ${out}", {})
    assert _substitute("echo $${out} ${PROJECT_ID}", {"PROJECT_ID": "p"}) == "echo ${out} p"
