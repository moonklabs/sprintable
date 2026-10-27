"""story 4796 — the temporary front door (deploy/vm/bin/front-door.sh, RUNBOOK §7 «Phase 1 — front door first»).

A pass-through Caddy for the API host that hands every request on to the CLOUD RUN backend while the data is still on Cloud SQL, so clients can move to the new address long before the
database moves. The values go into a Caddyfile, so they are checked first; the container is the same pinned image as the stack's Caddy; it never runs next to the stack's own Caddy (same
ports); the certificates live in the stack's Caddy data folder so the stack's Caddy inherits them at the cutover. Run for real against a fake docker; when `docker` exists here the generated
Caddyfile is also validated by the real Caddy image.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

_ROOT = Path(__file__).resolve().parents[2]
_SCRIPT = _ROOT / "deploy/vm/bin/front-door.sh"
HOST = "dev-api.sprintable.ai"
UP = "https://sprintable-backend-dev-787818285179.asia-northeast3.run.app"
OLD_UP = "https://sprintable-backend-dev-57iommnikq-du.a.run.app"

_FAKE_DOCKER = r"""#!/bin/sh
echo "docker $*" >> "$FAKE_LOG"
case "$1" in
  ps)
    case "$*" in
      *"com.docker.compose.service=caddy"*) [ -n "${FAKE_STACK_CADDY:-}" ] && echo stackcaddy1 ;;
      *"name=^sprintable-front-door$"*) [ -f "$FAKE_STATE/up" ] && echo frontdoor1 ;;
    esac ;;
  run)
    case "$*" in
      *"caddy validate"*) [ -z "${FAKE_VALIDATE_FAIL:-}" ] || { echo "Error: adapting config" >&2; exit 1; } ;;
      *" -d "*) : > "$FAKE_STATE/up" ;;
    esac ;;
  rm) rm -f "$FAKE_STATE/up" ;;
  exec) [ -z "${FAKE_NOT_READY:-}" ] || exit 1 ;;
esac
exit 0
"""


_FAKE_MOUNTPOINT = """#!/bin/sh
echo "mountpoint $*" >> "$FAKE_LOG"
[ -z "${FAKE_NOT_MOUNTED:-}" ]
"""


@pytest.fixture()
def box(tmp_path: Path):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    for name, body in (("docker", _FAKE_DOCKER), ("mountpoint", _FAKE_MOUNTPOINT)):
        (bin_dir / name).write_text(body)
        (bin_dir / name).chmod(0o755)
    install, data = tmp_path / "opt", tmp_path / "srv"
    cfg = tmp_path / "deployer.json"
    # the folders are the deployer's own configuration keys (install_dir, data_dir), as on the VM
    cfg.write_text(json.dumps({"environment": "dev", "acme_email": "ops@sprintable.ai", "install_dir": str(install), "data_dir": str(data)}))
    state = tmp_path / "state"
    state.mkdir()
    log = tmp_path / "calls.log"
    log.write_text("")

    def run(*args: str, **env: str):
        e = {"PATH": f"{bin_dir}:{Path(sys.executable).parent}:/usr/bin:/bin:/usr/local/bin", "HOME": str(tmp_path), "SPRINTABLE_CONFIG": str(cfg),
             "FAKE_LOG": str(log), "FAKE_STATE": str(state), **env}
        p = subprocess.run(["bash", str(_SCRIPT), *args], env=e, capture_output=True, text=True, timeout=120)
        return p, log.read_text()

    run.caddyfile = install / "runtime/front-door/Caddyfile"
    run.data, run.tmp, run.cfg = data, tmp_path, cfg
    return run


def test_it_is_executable_installed_by_bootstrap_and_uses_the_stacks_caddy_image() -> None:
    assert os.access(_SCRIPT, os.X_OK)
    assert "front-door.sh" in (_ROOT / "deploy/vm/bin/bootstrap.sh").read_text()
    compose = yaml.safe_load((_ROOT / "deploy/vm/compose.yml").read_text())
    assert f'image="{compose["services"]["caddy"]["image"]}"' in _SCRIPT.read_text(), "the same pinned image as the stack's Caddy"


def test_passthrough_writes_a_caddyfile_that_hands_the_api_host_to_the_cloud_run_backend_and_starts_one_container(box) -> None:
    p, calls = box("passthrough", "--host", HOST, "--upstream", UP)
    assert p.returncode == 0, p.stderr
    text = re.sub(r"(?m)^\s*#.*$", "", box.caddyfile.read_text())  # settings only: the comments talk about them too
    assert f"{HOST} {{" in text and f"reverse_proxy {UP} {{" in text
    assert re.search(r"(?m)^\s*flush_interval -1$", text), "streams are not buffered"
    assert re.search(r"(?m)^\s*header_up Host \{upstream_hostport\}$", text), "Cloud Run answers only to its own Host"
    assert "email ops@sprintable.ai" in text and "encode" not in text, "no compression: it would hold stream frames back"
    runs = [c for c in calls.splitlines() if c.startswith("docker run") and " -d " in c]
    assert len(runs) == 1
    r = runs[0]
    assert "--name sprintable-front-door" in r and "--restart unless-stopped" in r and "-p 80:80 -p 443:443" in r
    assert "caddy:2.8.4-alpine" in r
    assert f"-v {box.data}/caddy:/data" in r, "the stack's own certificate store"
    assert (box.data / "caddy").is_dir()


def test_the_generated_caddyfile_is_validated_before_anything_starts(box) -> None:
    p, calls = box("passthrough", "--host", HOST, "--upstream", UP, FAKE_VALIDATE_FAIL="1")
    assert p.returncode != 0 and "does not validate" in p.stderr
    assert not any(c.startswith("docker run") and " -d " in c for c in calls.splitlines())
    assert not box.caddyfile.exists(), "a Caddyfile that did not validate is not installed"


@pytest.mark.parametrize("up", [UP, OLD_UP])
def test_this_environments_cloud_run_backend_addresses_are_accepted(box, up: str) -> None:
    p, _ = box("passthrough", "--host", HOST, "--upstream", up)
    assert p.returncode == 0, p.stderr


@pytest.mark.parametrize("up", [
    "", "http://sprintable-backend-dev-787818285179.asia-northeast3.run.app", UP + "/", UP + "/api", UP + ":8443", "https://evil.example",
    "https://sprintable-frontend-dev-787818285179.asia-northeast3.run.app", "https://sprintable-backend-dev-1.asia-northeast3.run.app.evil.example",
    "https://sprintable-backend-staging-1.asia-northeast3.run.app", UP + "\nrespond 200", UP + " {", "https://u:p@sprintable-backend-dev-1.asia-northeast3.run.app",
])
def test_anything_but_one_of_our_backend_addresses_is_refused_before_it_can_reach_a_file(box, up: str) -> None:
    p, calls = box("passthrough", "--host", HOST, "--upstream", up)
    assert p.returncode == 2 and not box.caddyfile.exists() and "docker" not in calls


@pytest.mark.parametrize("host", ["", "example.com", "dev-api.sprintable.ai.evil.com", "sprintable.ai", "-dev.sprintable.ai", "dev api.sprintable.ai", "dev-api.sprintable.ai\nrespond", "DEV-API.sprintable.ai"])
def test_the_host_must_be_a_name_under_sprintable_ai(box, host: str) -> None:
    p, calls = box("passthrough", "--host", host, "--upstream", UP)
    assert p.returncode == 2 and not box.caddyfile.exists() and "docker" not in calls


def test_it_does_not_start_next_to_the_stacks_own_caddy(box) -> None:
    p, calls = box("passthrough", "--host", HOST, "--upstream", UP, FAKE_STACK_CADDY="1")
    assert p.returncode == 1 and "stack's own Caddy is running" in p.stderr
    assert not any(c.startswith("docker run") for c in calls.splitlines()) and not box.caddyfile.exists()


def test_starting_again_replaces_the_running_front_door(box) -> None:
    assert box("passthrough", "--host", HOST, "--upstream", UP)[0].returncode == 0
    p, calls = box("passthrough", "--host", HOST, "--upstream", OLD_UP)
    assert p.returncode == 0
    assert "docker rm -f sprintable-front-door" in calls
    assert OLD_UP in box.caddyfile.read_text() and UP not in box.caddyfile.read_text()


def test_it_says_so_when_the_front_door_does_not_become_ready(box) -> None:
    p, _ = box("passthrough", "--host", HOST, "--upstream", UP, FAKE_NOT_READY="1", FRONT_DOOR_WAIT="2")
    assert p.returncode == 1 and "did not become ready" in p.stderr


def _config(box, **over) -> None:
    base = json.loads(box.cfg.read_text())
    box.cfg.write_text(json.dumps({**base, **over}))


def test_a_bad_email_in_the_vm_configuration_stops_it(box) -> None:
    _config(box, acme_email="not an email\nrespond 200")
    p, calls = box("passthrough", "--host", HOST, "--upstream", UP)
    assert p.returncode == 1 and not box.caddyfile.exists() and "docker" not in calls


def test_stop_removes_the_container_and_keeps_the_certificates(box) -> None:
    assert box("passthrough", "--host", HOST, "--upstream", UP)[0].returncode == 0
    p, calls = box("stop")
    assert p.returncode == 0 and "docker rm -f sprintable-front-door" in calls
    assert (box.data / "caddy").is_dir(), "the stack's Caddy inherits the certificates"
    p, _ = box("stop")
    assert p.returncode == 0 and "no front door was running" in p.stdout, "stopping twice is fine"


def test_status_reports_running_with_the_target_or_not_running(box) -> None:
    p, _ = box("status")
    assert p.returncode == 1 and "not running" in p.stdout
    assert box("passthrough", "--host", HOST, "--upstream", UP)[0].returncode == 0
    p, _ = box("status")
    assert p.returncode == 0 and "running" in p.stdout and UP in p.stdout and HOST in p.stdout


@pytest.mark.parametrize("args", [[], ["bogus"], ["passthrough"], ["passthrough", "--host", HOST], ["passthrough", "--upstream", UP], ["passthrough", "--host", HOST, "--upstream", UP, "--x"], ["stop", "now"], ["status", "now"]])
def test_wrong_usage_is_refused(box, args: list[str]) -> None:
    p, calls = box(*args)
    assert p.returncode == 2 and "docker" not in calls


@pytest.mark.skipif(shutil.which("docker") is None, reason="docker not installed here")
def test_the_generated_caddyfile_is_valid_for_the_real_caddy_image(box, tmp_path: Path) -> None:
    """the fake docker only pretends to validate: with a real docker the pinned Caddy image reads the generated file"""
    assert box("passthrough", "--host", HOST, "--upstream", UP)[0].returncode == 0
    probe = subprocess.run(["docker", "info"], capture_output=True, timeout=60)
    if probe.returncode != 0:
        pytest.skip("docker is installed but not running")
    r = subprocess.run(["docker", "run", "--rm", "-v", f"{box.caddyfile}:/etc/caddy/Caddyfile:ro", "caddy:2.8.4-alpine", "caddy", "validate", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"],
                       capture_output=True, text=True, timeout=300)
    assert r.returncode == 0, r.stderr[-600:]


def test_the_runbook_has_the_three_phases_with_the_workers_and_the_front_door_commands() -> None:
    text = (_ROOT / "deploy/vm/RUNBOOK.md").read_text()
    card = text[text.index("## 7c. Dev cutover in three phases"):text.index("## 8. ")]
    for must in ("sprintable-dev-api-proxy", "sprintable-dev-app-proxy", "sprintable-mcp-dev-proxy",
                 "front-door.sh passthrough --host dev-api.sprintable.ai --upstream https://sprintable-backend-dev-787818285179.asia-northeast3.run.app",
                 "front-door.sh stop", "front-door.sh status", "deployer.py --force", "--ingress internal", "RESTORE_WIPE=yes"):
        assert must in card, must
    assert card.index("**Phase 1") < card.index("**Phase 2") < card.index("**Phase 3")
    p1 = card[card.index("**Phase 1"):card.index("**Phase 2")]
    assert p1.index("delete the route `sprintable-dev-api-proxy`") < p1.index("change the record `dev-api`") < p1.index("front-door.sh passthrough"), "route, then record, then the front door"
    p3 = card[card.index("**Phase 3"):]
    assert p3.index("front-door.sh stop") < p3.index("deployer.py --force"), "the front door goes before the stack's Caddy comes up"
    assert p3.index("--ingress internal") < p3.index("RESTORE_WIPE=yes")


def test_the_upstream_must_belong_to_this_vms_environment_a_dev_vm_never_forwards_credentials_to_prod(box) -> None:
    prod_up = UP.replace("-dev-", "-prod-")
    p, calls = box("passthrough", "--host", HOST, "--upstream", prod_up)
    assert p.returncode == 2 and "dev" in p.stderr and not box.caddyfile.exists() and "docker" not in calls
    _config(box, environment="prod")
    p, calls = box("passthrough", "--host", "api.sprintable.ai", "--upstream", UP)
    assert p.returncode == 2 and not box.caddyfile.exists(), "and a prod VM does not take the dev backend either"
    assert box("passthrough", "--host", "api.sprintable.ai", "--upstream", prod_up)[0].returncode == 0


@pytest.mark.parametrize("env_name", ["", "staging", "DEV", "dev\nrespond"])
def test_an_unknown_environment_in_the_configuration_stops_it(box, env_name: str) -> None:
    _config(box, environment=env_name)
    p, calls = box("passthrough", "--host", HOST, "--upstream", UP)
    assert p.returncode != 0 and not box.caddyfile.exists() and "docker" not in calls


def test_the_certificate_folder_is_the_deployers_data_disk_and_it_must_be_mounted(box) -> None:
    p, calls = box("passthrough", "--host", HOST, "--upstream", UP, FAKE_NOT_MOUNTED="1")
    assert p.returncode == 1 and "not a mounted data disk" in p.stderr
    assert not (box.data / "caddy").exists() and "docker run" not in calls and not box.caddyfile.exists()
    assert f"mountpoint -q {box.data}" in calls, "the deployer's data_dir is what is checked"


def test_the_folders_come_from_the_deployer_configuration_not_from_the_environment(box, tmp_path: Path) -> None:
    other = tmp_path / "elsewhere"
    p, calls = box("passthrough", "--host", HOST, "--upstream", UP, INSTALL_DIR=str(other), DATA_DIR=str(other))
    assert p.returncode == 0, p.stderr
    assert not other.exists() and (box.data / "caddy").is_dir() and f"-v {box.data}/caddy:/data" in calls


def test_the_defaults_are_the_deployers_defaults_when_the_configuration_names_no_folder(box) -> None:
    text = _SCRIPT.read_text()
    assert 'cfg_opt install_dir /opt/sprintable' in text and 'cfg_opt data_dir /srv/sprintable' in text
    deployer = (_ROOT / "deploy/vm/bin/deployer.py").read_text()
    assert 'install_dir: Path = Path("/opt/sprintable")' in deployer and 'data_dir: Path = Path("/srv/sprintable")' in deployer


def test_the_runbook_says_how_to_undo_phase_3_and_stops_the_front_door_before_the_dump() -> None:
    text = (_ROOT / "deploy/vm/RUNBOOK.md").read_text()
    p3 = text[text.index("**Phase 3"):text.index("## 8. ")]
    assert p3.index("front-door.sh stop") < p3.index("--ingress internal") < p3.index("Final dump"), "the front door is the first writer to stop"
    assert "also admits traffic from the same project" in p3 and "check from outside" in p3
    undo = p3[p3.index("**Undo"):]
    assert undo.index("systemctl stop sprintable-deploy.timer") < undo.index("front-door.sh passthrough"), "the stack's Caddy must be down before the front door can start"
    assert "docker stop sprintable-caddy-1" in undo


@pytest.mark.parametrize("env_name", [".*", "dev|prod", "[a-z]+", "d.v"])
def test_a_regex_looking_environment_name_can_not_widen_the_upstream_check(box, env_name: str) -> None:
    """the environment name is placed into the pattern the upstream is matched against: it must be exactly dev or prod first"""
    _config(box, environment=env_name)
    p, calls = box("passthrough", "--host", HOST, "--upstream", "https://sprintable-backend-evil-1.asia-northeast3.run.app")
    assert p.returncode != 0 and not box.caddyfile.exists() and "docker" not in calls
