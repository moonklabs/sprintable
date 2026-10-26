"""story 4796 — the VM's frontend image: its build-argument list and the build/verify script (deploy/vm/bin/{frontend_build_args.py,build-frontend-vm.sh}).

`apps/web/Dockerfile` bakes NEXT_PUBLIC_FASTAPI_URL into the build; the Cloud Run image keeps calling Cloud Run. The Dockerfile already takes it as a build argument, so
the VM image is a different argument list — and a check that what was baked is the VM's address.
"""
from __future__ import annotations

import importlib.util
import json
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[2]
_VM = _ROOT / "deploy/vm"
sys.path.insert(0, str(_VM / "bin"))


def _load(name: str):
    spec = importlib.util.spec_from_file_location(name, _VM / "bin" / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


FB = _load("frontend_build_args")
R = sys.modules["render_env"]
SETS = {
    "NEXT_PUBLIC_GA4_MEASUREMENT_ID": "", "NEXT_PUBLIC_EE_ENABLED": "true", "NEXT_PUBLIC_SUPPORT_WIDGET_ENABLED": "true",
    "NEXT_PUBLIC_SUPPORT_GATEWAY_URL": "https://gateway.example", "NEXT_PUBLIC_TOSS_CLIENT_KEY": "",
}


@pytest.mark.parametrize("env", ["dev", "prod"])
def test_the_hosts_come_from_the_declaration(env: str) -> None:
    if not (_VM / f"env/{env}.yaml").exists():
        pytest.skip("declaration not in this branch")
    decl = R.load_declaration(_VM / f"env/{env}.yaml")
    args = dict(FB.build_args(decl, "abc1234", SETS))
    assert args["NEXT_PUBLIC_FASTAPI_URL"] == f"https://{decl['hosts']['api']}"
    assert args["NEXT_PUBLIC_APP_URL"] == f"https://{decl['hosts']['app']}"
    assert args["SPRINTABLE_DEPLOY_BUILD"] == "1" and args["APP_COMMIT_SHA"] == "abc1234"
    assert not any("run.app" in v for v in args.values())


def test_the_argument_names_are_the_ones_the_dockerfile_declares() -> None:
    dockerfile = (_ROOT / "apps/web/Dockerfile").read_text()
    declared = set(re.findall(r"^ARG (\w+)", dockerfile, re.M))
    decl = R.load_declaration(_VM / "env/dev.yaml")
    names = {n for n, _ in FB.build_args(decl, "abc1234", SETS)}
    assert names <= declared, f"not declared in the Dockerfile: {sorted(names - declared)}"


def test_the_public_build_values_must_be_given_explicitly() -> None:
    decl = R.load_declaration(_VM / "env/dev.yaml")
    for drop in SETS:
        partial = {k: v for k, v in SETS.items() if k != drop}
        with pytest.raises(FB.BuildArgsError, match=drop):
            FB.build_args(decl, "abc1234", partial)
    FB.build_args(decl, "abc1234", {**SETS, "NEXT_PUBLIC_TOSS_CLIENT_KEY": ""})  # an explicit empty value is fine


def test_the_support_gateway_is_its_own_cloud_run_service_so_its_url_may_be_a_run_app_address() -> None:
    decl = R.load_declaration(_VM / "env/dev.yaml")
    args = dict(FB.build_args(decl, "abc1234", {**SETS, "NEXT_PUBLIC_SUPPORT_GATEWAY_URL": "https://support-gateway-dev-1.a.run.app"}))
    assert args["NEXT_PUBLIC_SUPPORT_GATEWAY_URL"].endswith("run.app")
    assert "run.app" not in args["NEXT_PUBLIC_FASTAPI_URL"] and "run.app" not in args["NEXT_PUBLIC_APP_URL"]


def test_hosts_cannot_be_overridden_from_the_command_line() -> None:
    decl = R.load_declaration(_VM / "env/dev.yaml")
    for name in FB.DERIVED:
        with pytest.raises(FB.BuildArgsError, match="declaration"):
            FB.build_args(decl, "abc1234", {**SETS, name: "https://elsewhere.example"})


def test_unknown_values_and_run_app_addresses_are_refused() -> None:
    decl = R.load_declaration(_VM / "env/dev.yaml")
    with pytest.raises(FB.BuildArgsError, match="unknown"):
        FB.build_args(decl, "abc1234", {**SETS, "NODE_OPTIONS": "--inspect"})
    bad = json.loads(json.dumps(decl))
    bad["hosts"]["api"] = "sprintable-backend-dev-787818285179.asia-northeast3.run.app"
    with pytest.raises(FB.BuildArgsError, match="run.app"):
        FB.build_args(bad, "abc1234", SETS)


@pytest.mark.parametrize("sha", ["", "main", "ABC1234", "abc", "abc1234; rm -rf /"])
def test_the_sha_must_be_a_git_sha(sha: str) -> None:
    with pytest.raises(FB.BuildArgsError, match="sha"):
        FB.build_args(R.load_declaration(_VM / "env/dev.yaml"), sha, SETS)


def test_the_cli_prints_name_equals_value_lines_and_fails_with_exit_2(capsys) -> None:
    sets = [x for k, v in SETS.items() for x in ("--set", f"{k}={v}")]
    assert FB.main(["x", str(_VM / "env/dev.yaml"), "--sha", "abc1234", *sets]) == 0
    lines = capsys.readouterr().out.splitlines()
    assert "NEXT_PUBLIC_FASTAPI_URL=https://dev-api.sprintable.ai" in lines and "NEXT_PUBLIC_TOSS_CLIENT_KEY=" in lines
    assert FB.main(["x", str(_VM / "env/dev.yaml"), "--sha", "abc1234"]) == 2


# ───────────────────────── the script, against a fake docker ─────────────────────────

_FAKE_DOCKER = r"""#!/bin/sh
echo "docker $*" >> "$FAKE_LOG"
case "$1" in
  run)
    case "$*" in
      *"-rlF"*) [ "${FAKE_FAIL_ON:-}" = api ] && exit 125; echo "${FAKE_API_COUNT-1}" ;;
      *"/web/public"*) [ "${FAKE_FAIL_ON:-}" = public ] && exit 125; echo "${FAKE_PUBLIC_COUNT-0}" ;;
      *"-rlE"*) [ "${FAKE_FAIL_ON:-}" = stale ] && exit 125; echo "${FAKE_STALE_COUNT-0}" ;;
    esac ;;
  image) echo "r.example/frontend-vm@sha256:abc123" ;;
esac
exit 0
"""


@pytest.fixture()
def build(tmp_path: Path):
    b = tmp_path / "fakebin"
    b.mkdir()
    (b / "docker").write_text(_FAKE_DOCKER)
    (b / "docker").chmod(0o755)
    log = tmp_path / "fake.log"
    log.write_text("")
    sets = [x for k, v in SETS.items() for x in ("--set", f"{k}={v}")]

    def run(*extra: str, **env: str) -> tuple[subprocess.CompletedProcess, str]:
        e = {"PATH": f"{b}:{Path(sys.executable).parent}:/usr/bin:/bin:/usr/local/bin", "HOME": os.environ["HOME"], "FAKE_LOG": str(log), **env}
        p = subprocess.run(["bash", str(_VM / "bin/build-frontend-vm.sh"), "dev", "abc1234", "r.example/frontend-vm:abc1234", *sets, *extra],
                           env=e, capture_output=True, text=True, timeout=60, cwd=tmp_path)
        return p, log.read_text()

    return run


def test_the_script_builds_with_the_vm_hosts_and_checks_what_was_baked(build) -> None:
    p, log = build()
    assert p.returncode == 0, p.stderr
    build_line = next(l for l in log.splitlines() if l.startswith("docker build"))
    assert "--platform linux/amd64 --no-cache -f apps/web/Dockerfile -t r.example/frontend-vm:abc1234" in build_line
    assert "--build-arg NEXT_PUBLIC_FASTAPI_URL=https://dev-api.sprintable.ai" in build_line
    assert "--build-arg NEXT_PUBLIC_APP_URL=https://dev-app.sprintable.ai" in build_line
    assert "run.app" not in build_line and "docker push" not in log
    assert log.index("docker build") < log.index("-rlF") < log.index("-rlE")


def test_the_script_refuses_an_image_whose_output_lacks_the_vm_address(build) -> None:
    p, log = build("--push", FAKE_API_COUNT="0")
    assert p.returncode != 0 and "not in the build output" in p.stderr and "docker push" not in log


def test_the_script_refuses_an_image_that_still_contains_a_cloud_run_address(build) -> None:
    p, log = build("--push", FAKE_STALE_COUNT="2")
    assert p.returncode != 0 and "Cloud Run service address" in p.stderr and "docker push" not in log


@pytest.mark.parametrize("failing_check", ["api", "stale", "public"])
def test_a_check_that_itself_fails_is_not_taken_for_a_clean_result_and_nothing_is_pushed(build, failing_check: str) -> None:
    p, log = build("--push", FAKE_FAIL_ON=failing_check)
    assert p.returncode != 0 and "could not inspect the image" in p.stderr
    assert "docker push" not in log


@pytest.mark.parametrize("var", ["FAKE_API_COUNT", "FAKE_STALE_COUNT", "FAKE_PUBLIC_COUNT"])
def test_an_answer_that_is_not_a_number_stops_the_script(build, var: str) -> None:
    p, log = build("--push", **{var: "garbage"})
    assert p.returncode != 0 and "unexpected answer" in p.stderr and "docker push" not in log


def test_run_app_in_the_static_guides_is_a_warning_not_a_failure(build) -> None:
    p, log = build("--push", FAKE_PUBLIC_COUNT="3")
    assert p.returncode == 0, p.stderr
    assert "WARNING: 3 file(s) under public/" in p.stderr and "docker push" in log
    assert p.stdout.strip().splitlines()[-1] == "r.example/frontend-vm@sha256:abc123"


def test_with_push_the_script_prints_the_digest_reference(build) -> None:
    p, log = build("--push")
    assert p.returncode == 0, p.stderr
    assert "docker push r.example/frontend-vm:abc1234" in log
    assert p.stdout.strip().splitlines()[-1] == "r.example/frontend-vm@sha256:abc123"


def test_the_script_does_not_build_when_a_value_is_missing(build, tmp_path: Path) -> None:
    e = {"PATH": f"{tmp_path}/fakebin:{Path(sys.executable).parent}:/usr/bin:/bin:/usr/local/bin", "HOME": os.environ["HOME"], "FAKE_LOG": str(tmp_path / "fake.log")}
    p = subprocess.run(["bash", str(_VM / "bin/build-frontend-vm.sh"), "dev", "abc1234", "r.example/f:1"], env=e, capture_output=True, text=True, cwd=tmp_path)
    assert p.returncode == 2 and "missing --set" in p.stderr, "refused up front (exit 2), not by accident later"
    assert "docker build" not in (tmp_path / "fake.log").read_text()
