"""story 4796 — dumping the SOURCE database from the VM (deploy/vm/bin/dump-source.sh, RUNBOOK §7).

Cloud SQL dev has a private address only, so the dump is taken on the VM. The source connection URL arrives on standard input and must live in that process's memory only: not in an argument
list, not on disk, not in the output. Run for real against a fake docker / gcloud; what the fakes saw (arguments, environment names and values) is what is asserted.
"""
from __future__ import annotations

import hashlib
import json
import os
import pty
import re
import subprocess
import sys
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[2]
_SCRIPT = _ROOT / "deploy/vm/bin/dump-source.sh"
PASSWORD_RAW = "p@ss/w:rd#1"
PASSWORD_URL = "p%40ss%2Fw%3Ard%231"
URL = f"postgresql://app_user:{PASSWORD_URL}@10.110.0.5:5432/sprintable"
HOST = "10.110.0.5"

_FAKE_DOCKER = r"""#!/bin/sh
echo "docker $*" >> "$FAKE_LOG"
case "$1" in
  ps) echo dbcontainer1 ;;
  inspect) echo "pgvector/pgvector:pg15" ;;
  run)
    # what the container would receive through its environment (names were given, values come from our environment)
    env | grep '^PG' | sort | sed 's/^/ENV /' >> "$FAKE_ENV"
    case "$*" in
      *"--entrypoint psql"*) cat > /dev/null; printf '%b' "${FAKE_COUNTS-users\t5\nposts\t7\n}" ;;
      *"--entrypoint pg_dump"*) head -c "${FAKE_DUMP_BYTES-4096}" /dev/zero | tr '\0' 'x' ;;
    esac ;;
  exec) cat > /dev/null; printf '%b' "${FAKE_LISTING-; Data for Name: users; TABLE DATA public users\n}" ;;
esac
exit 0
"""
_FAKE_GCLOUD = r"""#!/bin/sh
echo "gcloud $*" >> "$FAKE_LOG"
exit 0
"""


@pytest.fixture()
def box(tmp_path: Path):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    for name, body in (("docker", _FAKE_DOCKER), ("gcloud", _FAKE_GCLOUD)):
        (bin_dir / name).write_text(body)
        (bin_dir / name).chmod(0o755)
    cfg = tmp_path / "deployer.json"
    cfg.write_text(json.dumps({"environment": "dev", "backups_bucket": "bkt-1"}))
    imp = tmp_path / "import"
    log, envlog = tmp_path / "calls.log", tmp_path / "env.log"
    log.write_text(""), envlog.write_text("")

    def run(*args: str, stdin: str | None = URL + "\n", **env: str):
        e = {"PATH": f"{bin_dir}:{Path(sys.executable).parent}:/usr/bin:/bin:/usr/local/bin", "HOME": str(tmp_path), "SPRINTABLE_CONFIG": str(cfg), "IMPORT_DIR": str(imp),
             "FAKE_LOG": str(log), "FAKE_ENV": str(envlog), **env}
        p = subprocess.run(["bash", str(_SCRIPT), *args], input=stdin, env=e, capture_output=True, text=True, timeout=60)
        return p, log.read_text(), envlog.read_text()

    run.imp, run.tmp = imp, tmp_path
    return run


def _files(imp: Path) -> dict[str, Path]:
    out = {}
    for f in imp.glob("*"):
        out[re.sub(r"^dev-[a-z0-9-]+-\d{8}T\d{6}Z", "X", f.name)] = f
    return out


def test_the_script_is_installed_by_bootstrap_and_executable() -> None:
    assert os.access(_SCRIPT, os.X_OK)
    assert "dump-source.sh" in (_ROOT / "deploy/vm/bin/bootstrap.sh").read_text()


def test_a_dump_is_taken_checked_counted_and_checksummed(box) -> None:
    p, calls, env = box("--host", HOST, "--label", "rehearsal")
    assert p.returncode == 0, p.stderr
    f = _files(box.imp)
    assert set(f) == {"X.dump", "X.dump.sha256", "X.counts.tsv"}, "no partial file is left behind"
    assert f["X.counts.tsv"].read_text() == "users\t5\nposts\t7\n"
    dump = f["X.dump"]
    assert dump.stat().st_size == 4096
    assert f["X.dump.sha256"].read_text() == f"{hashlib.sha256(dump.read_bytes()).hexdigest()}  {dump.name}\n"
    assert dump.stat().st_mode & 0o077 == 0 and box.imp.stat().st_mode & 0o077 == 0, "readable by root only"
    # the same image as the VM's own database, one throw-away container per tool
    runs = [c for c in calls.splitlines() if c.startswith("docker run")]
    assert len(runs) == 2 and all("pgvector/pgvector:pg15" in c and "--rm" in c for c in runs)
    assert any("--entrypoint pg_dump" in c and "-Fc --no-owner --no-privileges" in c for c in runs)
    assert re.search(r"seconds|done in \d+ s", p.stdout), "timings are printed"
    assert "restore.sh" in p.stdout and ".counts.tsv" in p.stdout


def test_the_connection_settings_travel_as_environment_names_and_the_password_is_nowhere_else(box) -> None:
    p, calls, env = box("--host", HOST, stdin=URL.replace("/sprintable", "/sprintable?sslmode=require") + "\n")
    assert p.returncode == 0, p.stderr
    # the values reached the containers through the environment, decoded
    for line in ("ENV PGDATABASE=sprintable", "ENV PGHOST=10.110.0.5", "ENV PGPORT=5432", "ENV PGUSER=app_user", f"ENV PGPASSWORD={PASSWORD_RAW}", "ENV PGSSLMODE=require"):
        assert line in env.splitlines(), line
    # …and nowhere else: not in any argument list of any command, not in the output, not in a file
    for secret in (PASSWORD_RAW, PASSWORD_URL, "p@ss", "w:rd"):
        assert secret not in calls and secret not in p.stdout and secret not in p.stderr, secret
        assert not any(secret in f.read_text(errors="ignore") for f in box.imp.glob("*") if f.name.endswith((".sha256", ".tsv")))
    assert "-e PGPASSWORD " in calls or "-e PGPASSWORD\n" in calls or re.search(r"-e PGPASSWORD( |$)", calls), "only the NAME is given to docker"
    assert "PGPASSWORD=" not in calls


def test_a_driver_suffix_and_an_absent_sslmode_are_fine(box) -> None:
    p, _, env = box("--host", HOST, stdin=URL.replace("postgresql://", "postgresql+asyncpg://") + "\n")
    assert p.returncode == 0, p.stderr
    assert "ENV PGSSLMODE" not in env


@pytest.mark.parametrize("bad", [
    "", "   ", "not a url", "mysql://u:p@10.0.0.1/db", "postgresql://u@10.0.0.1/db", "postgresql://:p@10.0.0.1/db", "postgresql://u:p@10.0.0.1/",
    "postgresql://u:p@10.0.0.1/db?sslmode=Require;rm", "postgresql://u:topsecret-pw%0Aevil@10.0.0.1/db",
])
def test_a_bad_url_stops_before_any_container_and_is_never_echoed(box, bad: str) -> None:
    p, calls, _ = box("--host", HOST, stdin=bad + "\n")
    assert p.returncode != 0
    assert "docker run" not in calls
    assert "topsecret-pw" not in p.stdout + p.stderr and bad.strip() not in (p.stdout + p.stderr) or bad.strip() == ""


@pytest.mark.parametrize("args", [
    [], ["--host", ""], ["--host", "sql.example.com"], ["--host", "127.0.0.1"], ["--host", "0.0.0.0"], ["--host", "10.1.1"], ["--host", "10.0.0.1;ls"],
    ["--host", HOST, "--label", "Bad Label"], ["--host", HOST, "--label", ""], ["--host", HOST, "--label", "a" * 21], ["--host", HOST, "--bogus"],
])
def test_the_arguments_are_checked_before_the_url_is_read(box, args: list[str]) -> None:
    p, calls, _ = box(*args)
    assert p.returncode == 2 and "docker" not in calls
    assert not box.imp.exists() or not list(box.imp.glob("*"))


def test_a_terminal_on_standard_input_is_refused(box) -> None:
    master, slave = pty.openpty()
    try:
        e = {"PATH": f"{box.tmp}/bin:{Path(sys.executable).parent}:/usr/bin:/bin", "HOME": str(box.tmp), "SPRINTABLE_CONFIG": str(box.tmp / "deployer.json"),
             "IMPORT_DIR": str(box.imp), "FAKE_LOG": str(box.tmp / "calls.log"), "FAKE_ENV": str(box.tmp / "env.log")}
        p = subprocess.run(["bash", str(_SCRIPT), "--host", HOST], stdin=slave, env=e, capture_output=True, text=True, timeout=60)
    finally:
        os.close(master), os.close(slave)
    assert p.returncode == 2 and "standard input" in p.stderr
    assert "docker run" not in (box.tmp / "calls.log").read_text()


@pytest.mark.parametrize("env,message", [
    ({"FAKE_DUMP_BYTES": "100"}, "only 100 bytes"),
    ({"FAKE_LISTING": "; no data here\\n"}, "lists no table data"),
    ({"FAKE_COUNTS": ""}, "no row counts"),
])
def test_nothing_is_kept_when_the_dump_or_the_counts_are_unusable(box, env: dict[str, str], message: str) -> None:
    p, _, _ = box("--host", HOST, **env)
    assert p.returncode != 0 and message in p.stderr
    assert list(box.imp.glob("*")) == [], "no half result is left on the disk"


def test_upload_copies_the_three_files_to_the_import_folder_and_only_when_asked(box) -> None:
    p, calls, _ = box("--host", HOST)
    assert "gcloud" not in calls
    p, calls, _ = box("--host", HOST, "--upload", "--label", "final")
    assert p.returncode == 0, p.stderr
    cp = next(c for c in calls.splitlines() if c.startswith("gcloud storage cp"))
    assert cp.endswith(" gs://bkt-1/import/") and cp.count("gs://") == 1, "one destination: the backups bucket's import folder"
    names = re.findall(r"(dev-final-\d{8}T\d{6}Z\.[\w.]+)", cp)
    assert sorted(re.sub(r"^dev-final-\d{8}T\d{6}Z", "X", n) for n in names) == ["X.counts.tsv", "X.dump", "X.dump.sha256"]


def test_the_upload_does_not_happen_when_the_dump_is_refused(box) -> None:
    p, calls, _ = box("--host", HOST, "--upload", FAKE_DUMP_BYTES="10")
    assert p.returncode != 0 and "gcloud" not in calls
