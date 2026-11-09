"""story 4869 AC5 — the backend and frontend container logs reach Cloud Logging.

Since the move from Cloud Run the logs lived only in Docker's json-file log on the VM; the Ops Agent's default configuration reads syslog only. This pins:
1. the Ops Agent configuration (`deploy/vm/ops-agent/config.yaml`) and the contract its readers rely on (log name `containers`, `labels.container`, only our three services);
2. the compose side that makes the line carry its service (`labels` log option + the `sprintable_service` container label — on those three services only);
3. the bundle carries the file, bootstrap installs the installer and stops when it fails;
4. `bin/install-ops-agent-config.sh`, run for real against a fake `systemctl`: install, no-op when unchanged, and the old file back when the agent's log component does not come up.
"""
from __future__ import annotations

import io
import os
import re
import stat
import subprocess
import sys
import tarfile
from pathlib import Path

import pytest
import yaml

_ROOT = Path(__file__).resolve().parents[2]
_VM = _ROOT / "deploy/vm"
_CONFIG = _VM / "ops-agent/config.yaml"
_INSTALLER = _VM / "bin/install-ops-agent-config.sh"
SHIPPED = ["backend", "frontend"]
NOT_SHIPPED = ["caddy", "db", "migrate", "gateway-db"]   # caddy: its access log keeps the client address — personal data, «not shipped anywhere» (Caddyfile)

CFG = yaml.safe_load(_CONFIG.read_text())
COMPOSE = yaml.safe_load((_VM / "compose.yml").read_text())


# ───────────────────────── the Ops Agent configuration ─────────────────────────

def test_the_configuration_reads_the_docker_json_logs_and_names_its_pipeline_parts_consistently() -> None:
    log = CFG["logging"]
    assert list(log["receivers"]) == ["containers"]
    assert log["receivers"]["containers"] == {"type": "files", "include_paths": ["/var/lib/docker/containers/*/*-json.log"]}
    pipes = log["service"]["pipelines"]
    assert list(pipes) == ["containers"]
    pipe = pipes["containers"]
    assert pipe["receivers"] == ["containers"]
    assert set(pipe["processors"]) == set(log["processors"]), "a processor that is defined but not used (or used but not defined) is a typo"
    assert pipe["processors"][0] == "docker_line", "the docker line (log · stream · attrs · time) is unwrapped first"


def test_the_log_name_is_containers_and_no_other_pipeline_or_receiver_exists() -> None:
    """the receiver's id is the log name in Cloud Logging: infra/probe_dev_push.py's allow list knows `containers`; a rename would turn every reader's «0 lines» into «nothing arrives»"""
    assert list(CFG["logging"]["receivers"]) == ["containers"]


def test_only_the_three_services_are_shipped_and_everything_without_the_label_is_dropped() -> None:
    proc = CFG["logging"]["processors"]["only_our_services"]
    assert proc["type"] == "exclude_logs"
    (rule,) = proc["match_any"]
    assert rule.startswith("NOT jsonPayload.attrs.sprintable_service =~ ")
    alt = re.search(r'"\^\(([^)]*)\)\$"', rule).group(1).split("|")
    assert sorted(alt) == sorted(SHIPPED), alt
    assert "db" not in alt and "migrate" not in alt and "gateway-db" not in alt


def test_the_service_becomes_labels_container_and_the_app_line_becomes_message_then_json() -> None:
    procs = CFG["logging"]["processors"]
    assert procs["docker_line"]["type"] == "parse_json" and procs["docker_line"]["time_key"] == "time"
    fields = procs["log_to_message"]["fields"]
    assert fields["jsonPayload.message"] == {"move_from": "jsonPayload.log"}
    assert fields['labels."container"'] == {"move_from": "jsonPayload.attrs.sprintable_service"}
    assert procs["app_json"] == {"type": "parse_json", "field": "message"}
    order = CFG["logging"]["service"]["pipelines"]["containers"]["processors"]
    assert order == ["docker_line", "only_our_services", "log_to_message", "app_json"], "unwrap → drop the others → rename → parse the app's JSON"


def test_the_configuration_changes_no_resource_or_default_label() -> None:
    text = _CONFIG.read_text()
    assert "gce_instance" in text and "resource_name" in text, "the header documents the contract the readers rely on"
    code = re.sub(r"(?m)^\s*#.*$", "", text)
    assert "resource" not in code.replace("receivers", "").replace("resource_name", ""), "no processor may rewrite the monitored resource"
    assert "compute.googleapis.com" not in code


# ───────────────────────── compose: the line carries its service ─────────────────────────

def test_the_json_file_driver_writes_the_service_label_into_every_line() -> None:
    assert COMPOSE["x-logging"] == {"driver": "json-file", "options": {"max-size": "10m", "max-file": "5", "labels": "sprintable_service"}}


@pytest.mark.parametrize("svc", SHIPPED)
def test_a_shipped_service_carries_its_own_name_as_the_label(svc: str) -> None:
    assert COMPOSE["services"][svc]["labels"] == {"sprintable_service": svc}
    assert COMPOSE["services"][svc]["logging"] == COMPOSE["x-logging"]


@pytest.mark.parametrize("svc", NOT_SHIPPED)
def test_the_database_and_one_shot_services_are_not_labelled_so_they_are_not_shipped(svc: str) -> None:
    labels = COMPOSE["services"][svc].get("labels") or {}
    assert "sprintable_service" not in (labels if isinstance(labels, dict) else {l.split("=")[0] for l in labels}), svc


# ───────────────────────── bundle and bootstrap ─────────────────────────

def test_the_bundle_carries_the_configuration_and_the_installer() -> None:
    sys.path.insert(0, str(_VM / "bin"))
    try:
        import make_bundle  # type: ignore[import-not-found]
    finally:
        sys.path.pop(0)
    blob = make_bundle.build_bundle(_VM)
    import gzip
    names = set(tarfile.open(fileobj=io.BytesIO(gzip.decompress(blob))).getnames())
    assert "ops-agent/config.yaml" in names and "bin/install-ops-agent-config.sh" in names


def test_bootstrap_installs_the_installer_runs_it_with_the_bundles_file_and_stops_when_it_fails() -> None:
    boot = (_VM / "bin/bootstrap.sh").read_text()
    installed = re.search(r"for f in ([^;]+); do\n  install", boot).group(1).split()
    assert "install-ops-agent-config.sh" in installed
    code = re.sub(r"(?m)^\s*#.*$", "", boot)
    assert re.search(r'if ! /opt/sprintable/bin/install-ops-agent-config\.sh "\$src/ops-agent/config\.yaml"; then\n.*\n  exit 1\nfi', code)
    assert code.index('install -m 0755 "$src/bin/$f"') < code.index("install-ops-agent-config.sh \"$src") < code.index("bootstrap done for")


def test_the_installer_is_executable() -> None:
    assert _INSTALLER.stat().st_mode & 0o111


# ───────────────────────── the installer, run for real against a fake systemctl ─────────────────────────

_FAKE_SYSTEMCTL = r"""#!/bin/sh
printf 'systemctl %s\n' "$*" >> "$FAKE_LOG"
case "$1" in
  is-active) [ "${FAKE_ACTIVE-1}" = 1 ] && exit 0 || exit 3 ;;
esac
exit 0
"""


@pytest.fixture()
def box(tmp_path: Path):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    sc = bin_dir / "systemctl"
    sc.write_text(_FAKE_SYSTEMCTL)
    sc.chmod(sc.stat().st_mode | stat.S_IXUSR)
    log = tmp_path / "log"
    log.write_text("")
    target = tmp_path / "etc/config.yaml"
    new = tmp_path / "new.yaml"
    new.write_text("logging: {receivers: {containers: {type: files}}}\n")

    def run(**env: str) -> tuple[subprocess.CompletedProcess, str]:
        full = {"PATH": f"{bin_dir}:{os.environ['PATH']}", "HOME": str(tmp_path), "FAKE_LOG": str(log), "OPS_AGENT_CONFIG": str(target),
                "OPS_AGENT_WAIT": "0", "OPS_AGENT_TRIES": "3", **env}
        p = subprocess.run(["bash", str(_INSTALLER), str(new)], capture_output=True, text=True, env=full, timeout=60)
        return p, log.read_text()

    return run, target, new


def test_a_fresh_install_puts_the_file_in_place_restarts_the_agent_and_checks_the_log_component(box) -> None:
    run, target, new = box
    p, log = run()
    assert p.returncode == 0, p.stderr
    assert target.read_text() == new.read_text() and (target.stat().st_mode & 0o777) == 0o644
    assert "systemctl restart google-cloud-ops-agent" in log and "systemctl is-active --quiet google-cloud-ops-agent-fluent-bit" in log
    assert "installed" in p.stdout


def test_the_same_content_is_a_no_op_without_a_restart(box) -> None:
    run, target, new = box
    target.parent.mkdir(parents=True)
    target.write_text(new.read_text())
    p, log = run()
    assert p.returncode == 0 and "already in place" in p.stdout and "restart" not in log


def test_an_agent_that_does_not_come_up_gets_its_old_configuration_back_and_the_installer_fails_loudly(box) -> None:
    run, target, new = box
    target.parent.mkdir(parents=True)
    target.write_text("# the previous configuration\n")
    p, log = run(FAKE_ACTIVE="0")
    assert p.returncode == 1
    assert "OPS AGENT CONFIG FAILED" in p.stderr and "previous state is put back" in p.stderr
    assert target.read_text() == "# the previous configuration\n"
    assert log.count("systemctl restart google-cloud-ops-agent") == 2, "restarted once with the new file and once after putting the old one back"
    assert not list(target.parent.glob("config.yaml.previous.*")), "no backup file is left behind"


def test_with_no_previous_file_a_failed_install_removes_ours_so_the_agent_runs_on_its_default(box) -> None:
    run, target, new = box
    p, _ = run(FAKE_ACTIVE="0")
    assert p.returncode == 1 and not target.exists()


def test_a_successful_install_leaves_no_backup_file(box) -> None:
    run, target, new = box
    target.parent.mkdir(parents=True)
    target.write_text("# old\n")
    p, _ = run()
    assert p.returncode == 0 and target.read_text() == new.read_text()
    assert not list(target.parent.glob("config.yaml.previous.*"))


@pytest.mark.parametrize("name,value", [("OPS_AGENT_TRIES", "0"), ("OPS_AGENT_TRIES", "abc"), ("OPS_AGENT_TRIES", ""), ("OPS_AGENT_WAIT", "-1"), ("OPS_AGENT_WAIT", "1.5")])
def test_bad_settings_are_refused_before_anything_is_touched(box, name: str, value: str) -> None:
    run, target, _ = box
    p, log = run(**{name: value})
    assert p.returncode == 2 and not target.exists() and "systemctl" not in log


def test_without_a_config_file_argument_it_is_a_usage_error() -> None:
    p = subprocess.run(["bash", str(_INSTALLER)], capture_output=True, text=True, timeout=30)
    assert p.returncode == 2 and "usage" in p.stderr
