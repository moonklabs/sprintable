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
    # Docker writes «2026-11-09T04:34:44.123456789Z»; the fractional-seconds directive of the agent's parser is %L (Python's %f is not one)
    assert procs["docker_line"]["time_format"] == "%Y-%m-%dT%H:%M:%S.%L%z"
    fields = procs["log_to_message"]["fields"]
    assert fields["jsonPayload.message"] == {"move_from": "jsonPayload.log"}
    assert fields['labels."container"'] == {"move_from": "jsonPayload.attrs.sprintable_service"}
    assert procs["app_json"] == {"type": "parse_json", "field": "message"}
    order = CFG["logging"]["service"]["pipelines"]["containers"]["processors"]
    assert order == ["docker_line", "only_our_services", "log_to_message", "app_json", "no_access_lines"], "unwrap → drop the others → rename → parse the app's JSON → drop the access lines"


def test_the_backends_uvicorn_access_lines_are_dropped_after_the_apps_json_is_parsed() -> None:
    """the access line carries the client address and the request target (one-time codes and tokens travel there — the Caddyfile strips them): it must not reach Cloud Logging"""
    proc = CFG["logging"]["processors"]["no_access_lines"]
    assert proc == {"type": "exclude_logs", "match_any": ['jsonPayload.logger = "uvicorn.access"', 'jsonPayload.logger =~ "^(httpx|httpcore|urllib3)"']}
    order = CFG["logging"]["service"]["pipelines"]["containers"]["processors"]
    assert order.index("no_access_lines") > order.index("app_json"), "`logger` is a key of the app's JSON: it exists only after that parse"


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
  restart) [ -n "${FAKE_SWAP_LOCK_PID-}" ] && printf '424242\n' > "$FAKE_SWAP_LOCK_PID"; [ "${FAKE_RESTART_FAIL-0}" = 1 ] && exit 5 ;;
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


def test_a_second_run_is_a_no_op_without_a_restart_once_the_first_one_loaded_the_file(box) -> None:
    run, target, new = box
    p, _ = run()
    assert p.returncode == 0 and (target.parent / "config.yaml.loaded").is_file(), "the marker is written once the agent came up with the file"
    p, log = run()
    assert p.returncode == 0 and "already in place and loaded" in p.stdout
    assert log.count("systemctl restart") == 1, "only the first run restarted the agent"


def test_a_run_cut_off_between_the_write_and_the_restart_converges_on_the_next_run(box) -> None:
    """the file is in place but nobody ever loaded it (no marker): «already in place» must NOT be the answer"""
    run, target, new = box
    target.parent.mkdir(parents=True)
    target.write_text(new.read_text())
    p, log = run()
    assert p.returncode == 0 and "not known to be loaded" in p.stderr
    assert log.count("systemctl restart google-cloud-ops-agent") == 1, "the agent was restarted"
    assert (target.parent / "config.yaml.loaded").is_file()


def test_a_backup_left_by_an_interrupted_run_is_named_and_never_touched(box) -> None:
    run, target, new = box
    target.parent.mkdir(parents=True)
    orphan = target.parent / "config.yaml.previous.AbC123"
    orphan.write_text("# the configuration that was in place before the interrupted run\n")
    p, _ = run()
    assert p.returncode == 0 and str(orphan) in p.stderr
    assert orphan.read_text().startswith("# the configuration that was in place before")


def test_the_marker_is_gone_after_a_restore(box) -> None:
    run, target, new = box
    target.parent.mkdir(parents=True)
    target.write_text("# old\n")
    (target.parent / "config.yaml.loaded").write_text("stale marker\n")
    p, _ = run(FAKE_ACTIVE="0")
    assert p.returncode == 1 and not (target.parent / "config.yaml.loaded").exists()


@pytest.mark.parametrize("units", ["", "   ", "\t"])
def test_a_blank_unit_list_is_refused_because_it_would_make_the_agent_always_up(box, units: str) -> None:
    run, target, _ = box
    p, log = run(OPS_AGENT_UNITS=units)
    assert p.returncode == 2 and "OPS_AGENT_UNITS" in p.stderr and not target.exists() and "systemctl" not in log


@pytest.mark.parametrize("name,value", [("OPS_AGENT_TRIES", "08"), ("OPS_AGENT_TRIES", "09"), ("OPS_AGENT_WAIT", "08"), ("OPS_AGENT_WAIT", "00")])
def test_numbers_with_a_leading_zero_are_numbers_not_broken_octal_ones(box, name: str, value: str) -> None:
    """`$((08))` is an error in bash: it used to abort the script after the file was installed and before any restore — here the agent never comes up (FAKE_ACTIVE=0) and the failure path must still restore"""
    run, target, new = box
    target.parent.mkdir(parents=True)
    target.write_text("# old\n")
    env = {name: value, "FAKE_ACTIVE": "0"}
    if name == "OPS_AGENT_TRIES":
        env["OPS_AGENT_WAIT"] = "0"
    else:
        env["OPS_AGENT_TRIES"] = "2"
    p, _ = run(**env)
    assert p.returncode == 1 and "the previous state is back" in p.stderr and "syntax error" not in p.stderr and "value too great" not in p.stderr
    assert target.read_text() == "# old\n"


def test_a_backup_that_cannot_be_removed_after_a_restore_is_reported(box, tmp_path: Path) -> None:
    run, target, new = box
    target.parent.mkdir(parents=True)
    target.write_text("# old\n")
    rm = tmp_path / "bin" / "rm"
    rm.write_text('#!/bin/sh\nfor a in "$@"; do case "$a" in *.previous.*) exit 1 ;; esac; done\nexec /bin/rm "$@"\n')
    rm.chmod(rm.stat().st_mode | stat.S_IXUSR)
    p, _ = run(FAKE_ACTIVE="0")
    assert p.returncode == 1 and "could not be removed after the restore" in p.stderr


def test_an_empty_unit_list_is_refused_because_it_would_make_the_agent_always_up(box) -> None:
    run, target, _ = box
    p, log = run(OPS_AGENT_UNITS="")
    assert p.returncode == 2 and "OPS_AGENT_UNITS" in p.stderr and not target.exists() and "systemctl" not in log


def test_an_agent_that_does_not_come_up_gets_its_old_configuration_back_and_the_installer_fails_loudly(box) -> None:
    run, target, new = box
    target.parent.mkdir(parents=True)
    target.write_text("# the previous configuration\n")
    p, log = run(FAKE_ACTIVE="0")
    assert p.returncode == 1
    assert "OPS AGENT CONFIG FAILED" in p.stderr and "the previous state is back and the agent restarted" in p.stderr
    assert target.read_text() == "# the previous configuration\n"
    assert log.count("systemctl restart google-cloud-ops-agent") == 2, "restarted once with the new file and once after putting the old one back"
    assert not list(target.parent.glob("config.yaml.previous.*")), "no backup file is left behind"


def test_with_no_previous_file_a_failed_install_removes_ours_so_the_agent_runs_on_its_default(box) -> None:
    run, target, new = box
    p, _ = run(FAKE_ACTIVE="0")
    assert p.returncode == 1 and not target.exists()


def test_the_same_content_with_the_log_component_down_is_not_a_success(box) -> None:
    """a crashed agent must not read as «already in place, nothing to do»"""
    run, target, new = box
    target.parent.mkdir(parents=True)
    target.write_text(new.read_text())
    p, log = run(FAKE_ACTIVE="0")
    assert p.returncode == 1 and "OPS AGENT CONFIG FAILED" in p.stderr and "restart google-cloud-ops-agent" in log
    assert target.read_text() == new.read_text(), "the file is not touched"


def test_a_failed_restart_in_the_same_content_branch_says_the_agent_could_not_be_restarted(box) -> None:
    """(a mutant that ignores this restart failure must not survive: the unit-down branch without a marker)"""
    run, target, new = box
    target.parent.mkdir(parents=True)
    target.write_text(new.read_text())
    p, _ = run(FAKE_ACTIVE="0", FAKE_RESTART_FAIL="1")
    assert p.returncode == 1 and "could not be restarted (systemctl restart failed)" in p.stderr


def test_a_write_that_fails_is_a_failure_and_the_previous_file_is_back(box, tmp_path: Path) -> None:
    """no `set -e` in the installer: every step is checked — a failing `install` never reads as success"""
    run, target, new = box
    target.parent.mkdir(parents=True)
    target.write_text("# the previous configuration\n")
    fake = tmp_path / "bin" / "install"
    fake.write_text("#!/bin/sh\nexit 1\n")
    fake.chmod(fake.stat().st_mode | stat.S_IXUSR)
    p, log = run()
    assert p.returncode == 1 and "cannot write" in p.stderr and "the previous state is back and the agent restarted" in p.stderr
    assert target.read_text() == "# the previous configuration\n" and not list(target.parent.glob("config.yaml.previous.*"))
    assert log.count("systemctl restart google-cloud-ops-agent") == 1, "after a restore the agent is restarted once (the file may have been half written)"


def test_a_half_written_file_and_a_failing_restore_never_claim_that_the_previous_file_is_back(box, tmp_path: Path) -> None:
    """a write that is cut off leaves a truncated file; if the copy back fails too, the output says the previous configuration is NOT back, and the backup stays"""
    run, target, new = box
    target.parent.mkdir(parents=True)
    target.write_text("# the previous configuration\n")
    inst = tmp_path / "bin" / "install"
    inst.write_text('#!/bin/sh\n# writes half of the file, then fails\nhead -c 5 "$3" > "$4"\nexit 1\n')
    inst.chmod(inst.stat().st_mode | stat.S_IXUSR)
    cp = tmp_path / "bin" / "cp"
    cp.write_text('#!/bin/sh\nif [ -e "$FAKE_LOG.cp" ]; then exit 1; fi\n: > "$FAKE_LOG.cp"\nexec /bin/cp "$@"\n')
    cp.chmod(cp.stat().st_mode | stat.S_IXUSR)
    p, log = run()
    assert p.returncode == 1
    assert "could NOT be copied back" in p.stderr and "NOT fully back" in p.stderr
    assert "the previous state is back" not in p.stderr and "is back and" not in p.stderr
    assert "systemctl restart" not in log, "a half-written file must not be handed to the agent by a restart (the running agent keeps its configuration in memory)"
    assert "is NOT restarted" in p.stderr
    assert list(target.parent.glob("config.yaml.previous.*")), "the backup is kept"


def test_a_target_directory_that_cannot_be_made_is_a_failure(box, tmp_path: Path) -> None:
    run, target, new = box
    (tmp_path / "etc").write_text("a file where the directory should be")
    p, _ = run()
    assert p.returncode == 1 and "cannot write" in p.stderr


def test_a_restart_that_fails_is_a_failure_even_if_the_unit_still_shows_active(box) -> None:
    """`systemctl restart` failing while the old process keeps running would otherwise read as «unit active = success» with the new file never loaded"""
    run, target, new = box
    target.parent.mkdir(parents=True)
    target.write_text("# the previous configuration\n")
    p, log = run(FAKE_RESTART_FAIL="1", FAKE_ACTIVE="1")
    assert p.returncode == 1 and "OPS AGENT CONFIG FAILED" in p.stderr and "restart" in p.stderr
    assert target.read_text() == "# the previous configuration\n" and not list(target.parent.glob("config.yaml.previous.*"))


def test_a_target_that_is_a_directory_is_refused_and_nothing_is_changed(box) -> None:
    run, target, new = box
    target.mkdir(parents=True)
    p, log = run()
    assert p.returncode == 1 and "not a regular file" in p.stderr and "systemctl" not in log
    assert not (target / "new.yaml").exists() and not list(target.iterdir())


def test_a_restore_that_fails_is_said_so_not_claimed(box, tmp_path: Path) -> None:
    """the old file could not be copied back: the installer says it is NOT fully back and keeps the backup, instead of claiming the old configuration is back"""
    run, target, new = box
    target.parent.mkdir(parents=True)
    target.write_text("# the previous configuration\n")
    fake = tmp_path / "bin" / "cp"
    fake.write_text("#!/bin/sh\n# the first cp (the backup) works; any later one fails\nif [ -e \"$FAKE_LOG.cp\" ]; then exit 1; fi\n: > \"$FAKE_LOG.cp\"\nexec /bin/cp \"$@\"\n")
    fake.chmod(fake.stat().st_mode | stat.S_IXUSR)
    p, log = run(FAKE_ACTIVE="0")
    assert p.returncode == 1
    assert "could NOT be copied back" in p.stderr and "NOT fully back" in p.stderr
    assert list(target.parent.glob("config.yaml.previous.*")), "the backup is kept when the restore failed"


def test_a_marker_for_another_file_does_not_count_as_loaded(box) -> None:
    """same file, agent up, but the marker holds another checksum (the file was changed after it was loaded): the agent must be restarted"""
    run, target, new = box
    target.parent.mkdir(parents=True)
    target.write_text(new.read_text())
    (target.parent / "config.yaml.loaded").write_text("1 2\n")
    p, log = run()
    assert p.returncode == 0 and log.count("systemctl restart google-cloud-ops-agent") == 1
    assert (target.parent / "config.yaml.loaded").read_text() != "1 2\n"


def test_two_runs_at_once_are_refused_while_the_first_is_alive(box) -> None:
    run, target, new = box
    lock = target.parent / "config.yaml.lock.d"
    lock.mkdir(parents=True)
    sleeper = subprocess.Popen(["sleep", "30"])
    try:
        (lock / "pid").write_text(f"{sleeper.pid}\n")
        p, log = run()
        assert p.returncode == 1 and "another run of this installer is in progress" in p.stderr and "systemctl" not in log
        assert not target.exists() and lock.is_dir(), "the other run's lock is left alone"
    finally:
        sleeper.kill()
        sleeper.wait()


def test_a_lock_whose_process_is_gone_is_taken_over_and_removed_at_the_end(box) -> None:
    run, target, new = box
    lock = target.parent / "config.yaml.lock.d"
    lock.mkdir(parents=True)
    gone = subprocess.Popen(["true"])
    gone.wait()
    (lock / "pid").write_text(f"{gone.pid}\n")
    p, _ = run()
    assert p.returncode == 0 and "taking over a stale lock" in p.stderr
    assert not lock.exists(), "released at the end"


def test_a_lock_that_is_still_being_made_is_waited_for_not_taken_over(box, tmp_path: Path) -> None:
    """the other run has made the directory but not yet written its pid (empty `pid` file): it is not stale. No timing here: a stand-in `sleep` writes the live pid of the other run the FIRST time the installer
    waits 0.2 s — so the test fails if the installer does not wait at all, and cannot pass if it does not look again afterwards"""
    run, target, new = box
    lock = target.parent / "config.yaml.lock.d"
    lock.mkdir(parents=True)
    (lock / "pid").write_text("")
    sleeper = subprocess.Popen(["sleep", "30"])
    fake_sleep = tmp_path / "bin" / "sleep"
    fake_sleep.write_text(
        '#!/bin/sh\nif [ "$1" = 0.2 ]; then printf \'%s\\n\' "$FAKE_OTHER_PID" > "$FAKE_LOCK_PID"; printf \'waited\\n\' >> "$FAKE_LOG"; fi\nexec /bin/sleep "$@"\n'
    )
    fake_sleep.chmod(fake_sleep.stat().st_mode | stat.S_IXUSR)
    try:
        p, log = run(FAKE_OTHER_PID=str(sleeper.pid), FAKE_LOCK_PID=str(lock / "pid"))
        assert "waited" in log, "the installer waited for the pid before judging"
        assert p.returncode == 1 and "another run of this installer is in progress" in p.stderr and "taking over" not in p.stderr and "systemctl" not in log
        assert lock.is_dir() and (lock / "pid").read_text().strip() == str(sleeper.pid), "the other run's lock is untouched"
    finally:
        sleeper.kill()
        sleeper.wait()


def test_a_lock_whose_pid_cannot_be_written_stops_the_run_and_leaves_no_lock(box, tmp_path: Path) -> None:
    """mkdir succeeded but the pid file cannot be written (a stand-in `mkdir` makes the lock directory read-only): nothing is installed, no lock is left behind"""
    import shutil

    if os.geteuid() == 0:
        pytest.skip("root can write into a read-only directory")
    run, target, new = box
    real_mkdir = shutil.which("mkdir")
    fake = tmp_path / "bin" / "mkdir"
    fake.write_text(f'#!/bin/sh\n"{real_mkdir}" "$@" || exit $?\nfor last; do :; done\ncase "$last" in *.lock.d) chmod 555 "$last" ;; esac\n')
    fake.chmod(fake.stat().st_mode | stat.S_IXUSR)
    p, log = run()
    assert p.returncode == 1 and "cannot write the pid file of the lock" in p.stderr
    assert "systemctl" not in log and not target.exists()
    assert not (target.parent / "config.yaml.lock.d").exists(), "the lock that could not be filled is removed again"


def test_a_run_never_removes_a_lock_that_another_run_owns(box) -> None:
    """the cleanup of a run whose lock was taken over must leave the new owner's lock: a fake `systemctl` that rewrites the pid file while the installer runs stands for the takeover"""
    run, target, new = box
    lock = target.parent / "config.yaml.lock.d"
    p, _ = run(FAKE_SWAP_LOCK_PID=str(lock / "pid"))
    assert p.returncode == 0
    assert lock.is_dir() and (lock / "pid").read_text().strip() == "424242", "released only by its owner"
    (lock / "pid").unlink()
    lock.rmdir()


@pytest.mark.parametrize("fail", [False, True])
def test_the_lock_is_released_after_success_and_after_failure(box, fail: bool) -> None:
    run, target, new = box
    p, _ = run(FAKE_ACTIVE="0" if fail else "1")
    assert p.returncode == (1 if fail else 0)
    assert not (target.parent / "config.yaml.lock.d").exists()


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
