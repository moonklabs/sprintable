"""story 4796 — the static parts of deploy/vm: compose, Caddyfile, systemd units, scripts. Nothing here talks to a VM."""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest
import yaml

_ROOT = Path(__file__).resolve().parents[2]
_VM = _ROOT / "deploy/vm"
_DOCKER = shutil.which("docker") or "/usr/local/bin/docker"
_SHELLCHECK = shutil.which("shellcheck") or "/opt/homebrew/bin/shellcheck"

COMPOSE = yaml.safe_load((_VM / "compose.yml").read_text())


def test_only_the_front_door_publishes_ports() -> None:
    published = {name: svc["ports"] for name, svc in COMPOSE["services"].items() if "ports" in svc}
    assert list(published) == ["caddy"] and published["caddy"] == ["80:80", "443:443"]
    for name in ("db", "backend", "frontend", "migrate"):
        assert "ports" not in COMPOSE["services"][name], f"{name} must not be reachable from outside the compose network"


def test_compose_carries_no_secret_and_none_of_the_forbidden_switches() -> None:
    text = (_VM / "compose.yml").read_text()
    assert "SPRINTABLE_LOCAL_DEV" not in re.sub(r"#.*", "", text) and "K_SERVICE" not in re.sub(r"#.*", "", text)
    # every environment entry of the db/migrate services is a name, a ${…} reference, or a plain non-secret value
    assert "POSTGRES_PASSWORD" in COMPOSE["services"]["db"]["environment"] and COMPOSE["services"]["db"]["environment"]["POSTGRES_PASSWORD"] is None
    assert COMPOSE["services"]["migrate"]["environment"] == ["ALEMBIC_DATABASE_URL"]


def test_images_other_than_ours_are_pinned() -> None:
    assert COMPOSE["services"]["db"]["image"] == "pgvector/pgvector:pg15"
    assert re.fullmatch(r"caddy:\d+\.\d+\.\d+(-alpine)?", COMPOSE["services"]["caddy"]["image"])
    for name in ("backend", "migrate"):
        assert COMPOSE["services"][name]["image"] == "${BACKEND_IMAGE:?}"
    assert COMPOSE["services"]["frontend"]["image"] == "${FRONTEND_IMAGE:?}"


def test_migrate_runs_only_on_request_and_the_data_lives_on_the_data_disk() -> None:
    assert COMPOSE["services"]["migrate"]["profiles"] == ["migrate"] and COMPOSE["services"]["migrate"]["restart"] == "no"
    assert COMPOSE["services"]["db"]["volumes"] == ["${DATA_DIR:?}/postgres:/var/lib/postgresql/data"]
    for name, svc in COMPOSE["services"].items():
        assert svc.get("logging") is not None, f"{name}: container logs must be size-limited"


def _compose_plugin() -> bool:
    try:
        return subprocess.run([_DOCKER, "compose", "version"], capture_output=True, timeout=20).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


@pytest.mark.skipif(not Path(_DOCKER).exists() or not _compose_plugin(), reason="docker compose is not installed")
def test_docker_compose_accepts_the_file_and_the_passthrough(tmp_path: Path) -> None:
    import importlib.util
    spec = importlib.util.spec_from_file_location("render_env", _VM / "bin/render_env.py")
    R = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(R)
    decl = R.load_declaration(_VM / "env/dev.yaml")
    services = {n: {k: "v" for k in R.build_service_env(decl, n, {p: "p" for p in s["live_plain"]}, "0123456789abcdef0123", lambda sid: "s")} for n, s in decl["services"].items()}
    pt = tmp_path / "pass-through.yml"
    R.write_passthrough(pt, services)
    env = {
        "PATH": "/usr/bin:/bin:/usr/local/bin", "HOME": os.environ["HOME"], "BACKEND_IMAGE": "b:1", "FRONTEND_IMAGE": "f:1", "API_HOST": "a.test", "REALTIME_HOST": "r.test",
        "APP_HOST": "p.test", "ACME_EMAIL": "x@test", "DB_USER": "u", "DB_NAME": "n", "DATA_DIR": "/srv/x", "CADDYDIR": str(_VM),
        "POSTGRES_PASSWORD": "pw", "ALEMBIC_DATABASE_URL": "postgresql://u:pw@db:5432/n", **R.process_environment(services),
    }
    p = subprocess.run([_DOCKER, "compose", "-f", str(_VM / "compose.yml"), "-f", str(pt), "--profile", "migrate", "config", "--format", "json"], env=env, capture_output=True, text=True)
    assert p.returncode == 0, p.stderr[-800:]
    out = json.loads(p.stdout)
    be = out["services"]["backend"]["environment"]
    assert be["DATABASE_URL"] == "v" and "JWT_SECRET" in be and "REDIS_URL" not in be
    assert out["services"]["db"]["environment"]["POSTGRES_PASSWORD"] == "pw"


def test_caddy_serves_the_three_hosts_and_never_buffers_a_stream() -> None:
    text = (_VM / "Caddyfile").read_text()
    for host in ("{$API_HOST}", "{$REALTIME_HOST}", "{$APP_HOST}"):
        assert host in text
    assert re.sub(r"(?m)^\s*#.*$", "", text).count("flush_interval -1") == 2
    api_block = re.sub(r"(?m)^\s*#.*$", "", text).split("{$APP_HOST}")[0]
    assert "encode" not in api_block, "compression would hold SSE frames back on the API host"
    assert "reverse_proxy backend:8000" in text and "reverse_proxy frontend:3000" in text
    assert "trusted_proxies" not in text, "without trusted proxies Caddy overwrites a client's X-Forwarded-For"


def test_every_file_a_unit_runs_is_installed_by_bootstrap() -> None:
    boot = (_VM / "bin/bootstrap.sh").read_text()
    installed = set(re.findall(r"\b([\w.-]+\.(?:py|sh|sql))\b", re.search(r"for f in ([^;]+); do\n  install", boot).group(1)))
    for unit in (_VM / "systemd").glob("*.service"):
        for exe in re.findall(r"^ExecStart=\S*?/(?:bin/)?([\w.-]+\.(?:py|sh))", unit.read_text(), re.M):
            assert exe in installed, f"{unit.name} runs {exe}, which bootstrap.sh does not install"
    for f in installed:
        assert (_VM / "bin" / f).exists(), f
    shipped = {f.name for f in (_VM / "bin").iterdir() if f.is_file()} - {"make_bundle.py", "bootstrap.sh", "check_live_names.py", "frontend_build_args.py", "build-frontend-vm.sh"}
    assert installed == shipped, f"bootstrap installs {sorted(installed)} but bin/ holds {sorted(shipped)}"
    assert "enable --now sprintable-deploy.timer" not in re.sub(r"(?m)^\s*#.*$|echo .*$", "", boot), "the deploy timer is enabled by hand after the database is restored"


def test_the_runbook_puts_desired_json_in_place_and_starts_the_database_before_the_first_dump() -> None:
    """found by the codex review: a new VM has no desired.json, and the dump step needs the database container the `--db-only` start provides"""
    text = (_VM / "RUNBOOK.md").read_text()
    section = text[text.index("## 7. Move the data"):text.index("## 8. ")]
    put = section.index("gcloud storage cp gs://$DEPLOY_BUCKET/candidates/$SHA.json gs://$DEPLOY_BUCKET/desired.json")
    db_only = section.index("deployer.py --db-only")
    dump = section.index("dump-source.sh --host $SRC_IP --label rehearsal --upload")
    assert put < db_only < dump, "desired.json, then the database, then the dump"
    assert section.count("deployer.py --db-only") == 1, "started once, in step 1"
    assert "Once per VM, before the first dump" in section


def test_the_real_restore_command_carries_restore_wipe_because_the_rehearsal_left_tables_behind() -> None:
    """codex: after the rehearsal the database holds tables and restore.sh refuses without RESTORE_WIPE=yes"""
    text = (_VM / "RUNBOOK.md").read_text()
    section = text[text.index("## 7. Move the data"):text.index("## 8. ")]
    step5 = section[section.index("\n5. On the VM, restore"):section.index("\n6. Enable the deployer")]
    assert "sudo env RESTORE_WIPE=yes /opt/sprintable/bin/restore.sh /srv/sprintable/import/" in step5
    assert "sudo bash -c 'diff /srv/sprintable/import/" in step5, "the import folder is root-only and sudo closes a bare <(...) descriptor"
    seven_a = section[section.index("7a. Rehearsal"):section.index("**The dump is taken on the VM.**")]
    assert "steps 1, 3, 4 and 5 only" in seven_a and "not step 6" in seven_a, "a rehearsal must not start the application or the timers"
    assert "RESTORE_WIPE" in (_VM / "bin/restore.sh").read_text()


def test_every_gcloud_command_of_section_7_names_its_project_and_the_writers_stop_is_more_than_the_ingress_flag() -> None:
    """codex: `export PROJECT` does not set gcloud's active project; and `--ingress internal` alone does not stop every writer"""
    text = (_VM / "RUNBOOK.md").read_text()
    section = text[text.index("## 7. Move the data"):text.index("## 8. ")]
    for command in re.findall(r"`(gcloud (?:sql|run|scheduler|compute|secrets|storage)[^`]*)`", section):
        assert "--project $PROJECT" in command, command
    assert "gcloud storage cp /tmp/vm-bundle/desired.json gs://$DEPLOY_BUCKET/desired.json" in section, "the hand-built bundle path has its own upload"
    step2 = section[section.index("\n2. Stop writes"):section.index("\n3. Dump and count")]
    assert "does not stop every writer" in step2 and "front-door.sh stop" in step2
    assert "sprintable-frontend-dev" in step2 and "sprintable-mcp-dev" in step2, "the same-project callers that write through the backend"
    undo = step2[step2.index("Undo:"):]
    for service in ("sprintable-backend-dev", "sprintable-frontend-dev", "sprintable-mcp-dev"):
        assert service in undo, f"closed above, so reopened by the undo: {service}"
    assert "--ingress all" in undo and "scheduler jobs resume" in undo
    assert "no request other than the health check" in step2 and "cron endpoints are GET requests" in step2, "a GET can write"


def test_section_9_names_the_real_variables_of_the_hosted_mcp_and_the_scheduler_tool() -> None:
    """codex round 7: the hosted MCP's address is SPRINTABLE_API_URL (deploy_mcp_dev.sh, cloudbuild deploy-mcp), not `_BACKEND_URL`; the scheduler jobs need --base-url and the pipeline step would undo it"""
    text = (_VM / "RUNBOOK.md").read_text()
    sec = text[text.index("## 9. "):text.index("## 10. ")]
    assert "--update-env-vars SPRINTABLE_API_URL=https://dev-api.sprintable.ai" in sec and "`_BACKEND_URL`" not in sec
    assert "infra/apply_cloud_scheduler.py --env dev --base-url https://dev-api.sprintable.ai" in sec and "apply-cloud-scheduler" in sec
    deploy_mcp = (_ROOT / "backend/scripts/deploy_mcp_dev.sh").read_text()
    assert "--set-env-vars=\"MCP_TRANSPORT=http,SPRINTABLE_API_URL=${DEV_BACKEND_URL}" in deploy_mcp, "the variable the hosted MCP reads is SPRINTABLE_API_URL"
    assert "--base-url" in (_ROOT / "infra/apply_cloud_scheduler.py").read_text()


def test_the_rehearsal_dump_is_cleaned_up_locally_and_in_the_bucket() -> None:
    """codex (combined review): the rehearsal dump is a copy of the whole dev database and must not stay in import/"""
    text = (_VM / "RUNBOOK.md").read_text()
    section = text[text.index("7a. Rehearsal"):text.index("**The dump is taken on the VM.**")]
    assert "sudo find /srv/sprintable/import -name '*-rehearsal-*' -delete" in section
    assert 'gcloud storage rm "gs://$BACKUPS_BUCKET/import/*-rehearsal-*" --project $PROJECT' in section, "double quotes, or the bucket variable is not expanded"
    commands = re.findall(r"`([^`]+)`", section)
    assert not [c for c in commands if c.startswith("sudo rm") and "*" in c], "a glob after sudo is expanded by the caller's shell, which cannot read the root-only folder"
    assert "-final-" in section, "the real move's copies go the same way after the soak"


def test_every_apply_cloud_scheduler_call_in_the_runbook_names_the_project_through_the_environment() -> None:
    """codex (combined review): the tool runs gcloud without --project, so `export PROJECT` alone leaves the active project to chance"""
    text = (_VM / "RUNBOOK.md").read_text()
    calls = re.findall(r"(\S*\s*python3 infra/apply_cloud_scheduler\.py [^`)]*)", text)
    assert calls, "the runbook shows the tool"
    for call in calls:
        assert "CLOUDSDK_CORE_PROJECT=$PROJECT python3 infra/apply_cloud_scheduler.py" in call, call


def test_the_documented_cleanup_commands_really_delete_only_the_rehearsal_files(tmp_path: Path) -> None:
    """codex round 9: the first version had a single-quoted variable and a glob after sudo - neither worked. Run the documented commands for real (sudo dropped, gcloud replaced by a recorder)."""
    import subprocess
    text = (_VM / "RUNBOOK.md").read_text()
    section = text[text.index("7a. Rehearsal"):text.index("**The dump is taken on the VM.**")]
    find_cmd = re.search(r"`sudo (find /srv/sprintable/import -name '\*-rehearsal-\*' -delete)`", section).group(1)
    rm_cmd = re.search(r"`(gcloud storage rm \"[^`]+)`", section).group(1)
    imp = tmp_path / "import"
    imp.mkdir()
    for name in ("dev-rehearsal-1-9.dump", "dev-rehearsal-1-9.dump.sha256", "dev-final-1-9.dump"):
        (imp / name).write_text("x")
    subprocess.run(["bash", "-c", find_cmd.replace("/srv/sprintable/import", str(imp))], check=True, timeout=30)
    assert sorted(f.name for f in imp.iterdir()) == ["dev-final-1-9.dump"], "only the rehearsal files go"
    fake = tmp_path / "bin"
    fake.mkdir()
    (fake / "gcloud").write_text('#!/bin/sh\nprintf "%s\\n" "$@" > "$GCLOUD_ARGS"\n')
    (fake / "gcloud").chmod(0o755)
    args = tmp_path / "args.txt"
    subprocess.run(["bash", "-c", rm_cmd], check=True, timeout=30, env={"PATH": f"{fake}:/usr/bin:/bin", "BACKUPS_BUCKET": "bkt-1", "PROJECT": "proj-1", "GCLOUD_ARGS": str(args), "HOME": str(tmp_path)})
    assert args.read_text().splitlines() == ["storage", "rm", "gs://bkt-1/import/*-rehearsal-*", "--project", "proj-1"], "the bucket variable is expanded, the star reaches gcloud"


def test_no_timer_that_needs_the_database_is_enabled_before_the_restore() -> None:
    """a backup run before the restore finds no database and fails every night (the first dev VM found this); the timers are enabled with the deploy timer, RUNBOOK §7 step 6"""
    code = re.sub(r"(?m)^\s*#.*$|echo .*$", "", (_VM / "bin/bootstrap.sh").read_text())
    for timer in ("sprintable-backup.timer", "sprintable-restore-check.timer", "sprintable-deploy.timer"):
        assert not re.search(rf"systemctl enable[^\n]*{re.escape(timer)}", code), timer
    runbook = (_VM / "RUNBOOK.md").read_text()
    step6 = next(line for line in runbook.splitlines() if line.startswith("6. Enable the deployer"))
    for timer in ("sprintable-deploy.timer", "sprintable-backup.timer", "sprintable-restore-check.timer"):
        assert timer in step6, timer


def test_the_units_wait_for_the_data_disk() -> None:
    for unit in _VM.joinpath("systemd").glob("*.service"):
        assert "ConditionPathIsMountPoint=/srv/sprintable" in unit.read_text(), unit.name
    assert "RequiresMountsFor" in (_VM / "bin/bootstrap.sh").read_text()


@pytest.mark.skipif(not Path(_SHELLCHECK).exists(), reason="shellcheck not installed")
def test_shellcheck_is_clean() -> None:
    p = subprocess.run([_SHELLCHECK, "-x", *sorted(f.name for f in _VM.glob("bin/*.sh"))], capture_output=True, text=True, cwd=_VM / "bin")
    assert p.returncode == 0, p.stdout[-1500:]


def test_the_scripts_are_executable() -> None:
    for f in _VM.glob("bin/*.sh"):
        assert f.stat().st_mode & 0o111, f.name


# ───────────────────────── backup / restore, run for real against a fake docker and a fake gcloud ─────────────────────────

_FAKE_DOCKER = r"""#!/bin/sh
echo "docker $*" >> "$FAKE_LOG"
case "$1" in
  ps)
    case "$*" in
      *service=backend*) [ -z "${FAKE_BACKEND_RUNNING:-}" ] || echo bbb111 ;;
      *) echo abc123 ;;
    esac ;;
  exec)
    shift
    case "$*" in
      *pg_dump*) head -c "${FAKE_DUMP_BYTES:-5000}" /dev/zero ;;
      *"pg_restore --list"*) cat > /dev/null; [ -n "${FAKE_LIST_NODATA:-}" ] || echo "; 1; 1259 16385 TABLE DATA public t u"; exit "${FAKE_LIST_RC:-0}" ;;
      *"-A -t -F"*) cat > /dev/null; printf 'a\t3\nb\t4\n'; [ -z "${FAKE_COUNTS_JUNK:-}" ] || printf 'NOTICE: something\n\n' ;;
      *pg_restore*) cat > /dev/null ;;
      *POSTGRES_USER*) printf sprintable ;;
      *POSTGRES_DB*) printf '%s' "${FAKE_DB_NAME-sprintable}" ;;
      *"information_schema.tables where"*) echo "${FAKE_EXISTING:-0}" ;;
      *) cat > /dev/null ;;
    esac ;;
esac
"""
# the second never changes, so two runs «in the same second» are what the scratch-name test sees
_FAKE_DATE = '#!/bin/sh\ncase "$*" in *+%Y%m%d%H%M%S) echo 20260101000000 ;; *) exec /bin/date "$@" ;; esac\n'
_FAKE_GCLOUD = (
    '#!/bin/sh\necho "gcloud $*" >> "$FAKE_LOG"\n'
    # `storage cp <src>... <dest>`: copy from FAKE_GCS_DIR when it is set (a gs:// source), otherwise only log
    'if [ "$2" = ls ]; then echo "${FAKE_LS:-}"; exit 0; fi\n'
    'if [ -n "${FAKE_GCS_DIR:-}" ] && [ "$2" = cp ]; then\n'
    '  for a in "$@"; do last="$a"; done\n'
    '  for a in "$@"; do case "$a" in gs://*) cp "$FAKE_GCS_DIR/$(basename "$a")" "$last/" 2>/dev/null || exit 1 ;; esac; done\n'
    'fi\n'
)


@pytest.fixture()
def fakebin(tmp_path: Path):
    b = tmp_path / "fakebin"
    b.mkdir()
    for name, body in (("docker", _FAKE_DOCKER), ("gcloud", _FAKE_GCLOUD), ("date", _FAKE_DATE)):
        (b / name).write_text(body)
        (b / name).chmod(0o755)
    cfgf = tmp_path / "deployer.json"
    cfgf.write_text(json.dumps({"environment": "dev", "backups_bucket": "bk-bucket"}))
    log = tmp_path / "fake.log"
    log.write_text("")

    def run(script: str, *args: str, **env: str) -> tuple[subprocess.CompletedProcess, str]:
        e = {"PATH": f"{b}:/usr/bin:/bin:/usr/local/bin", "HOME": os.environ["HOME"], "SPRINTABLE_CONFIG": str(cfgf), "FAKE_LOG": str(log),
             "BACKUP_DIR": str(tmp_path / "backups"), **env}
        p = subprocess.run(["bash", str(_VM / "bin" / script), *args], env=e, capture_output=True, text=True, timeout=60)
        return p, log.read_text()

    return run


def test_backup_uploads_a_checked_dump_and_its_checksum(fakebin, tmp_path: Path) -> None:
    p, log = fakebin("backup.sh")
    assert p.returncode == 0, p.stderr
    up = [l for l in log.splitlines() if l.startswith("gcloud storage cp")]
    assert len(up) == 1 and up[0].endswith("gs://bk-bucket/db/") and ".dump " in up[0] and up[0].count(".sha256") == 1
    assert list((tmp_path / "backups").glob("db-dev-*.dump")) and list((tmp_path / "backups").glob("db-dev-*.dump.sha256"))
    assert log.index("pg_restore --list") < log.index("gcloud storage cp")


def test_backup_refuses_a_tiny_dump(fakebin) -> None:
    p, log = fakebin("backup.sh", FAKE_DUMP_BYTES="10")
    assert p.returncode != 0 and "gcloud" not in log


def test_backup_refuses_a_dump_pg_restore_cannot_list(fakebin) -> None:
    p, log = fakebin("backup.sh", FAKE_LIST_RC="1")
    assert p.returncode != 0 and "gcloud" not in log


def test_restore_refuses_a_database_that_already_has_tables(fakebin, tmp_path: Path) -> None:
    dump = tmp_path / "x.dump"
    dump.write_bytes(b"0" * 2000)
    p, log = fakebin("restore.sh", str(dump), FAKE_EXISTING="7")
    assert p.returncode != 0 and "RESTORE_WIPE" in p.stderr
    assert "--single-transaction" not in log and "DROP DATABASE" not in log


def test_restore_into_an_empty_database_is_one_transaction_that_stops_at_the_first_error(fakebin, tmp_path: Path) -> None:
    dump = tmp_path / "x.dump"
    dump.write_bytes(b"0" * 2000)
    p, log = fakebin("restore.sh", str(dump), FAKE_EXISTING="0")
    assert p.returncode == 0, p.stderr
    line = next(l for l in log.splitlines() if "--single-transaction" in l)
    assert "--single-transaction" in line and "--exit-on-error" in line and "--no-owner" in line
    assert "DROP DATABASE" not in log


def test_restore_wipes_only_when_told_to(fakebin, tmp_path: Path) -> None:
    dump = tmp_path / "x.dump"
    dump.write_bytes(b"0" * 2000)
    p, log = fakebin("restore.sh", str(dump), FAKE_EXISTING="7", RESTORE_WIPE="yes")
    assert p.returncode == 0, p.stderr
    assert log.index("DROP DATABASE") < log.index("--single-transaction")


def test_backup_refuses_a_dump_that_lists_no_table_data(fakebin) -> None:
    p, log = fakebin("backup.sh", FAKE_LIST_NODATA="1")
    assert p.returncode != 0 and "gcloud" not in log


def test_backup_leaves_no_half_written_dump_behind(fakebin, tmp_path: Path) -> None:
    for env in ({"FAKE_DUMP_BYTES": "10"}, {"FAKE_LIST_RC": "1"}):
        p, _log = fakebin("backup.sh", **env)
        assert p.returncode != 0
        assert not list((tmp_path / "backups").glob("*.partial")) and not list((tmp_path / "backups").glob("*.dump"))


def test_backup_directory_is_private(fakebin, tmp_path: Path) -> None:
    fakebin("backup.sh")
    assert (tmp_path / "backups").stat().st_mode & 0o077 == 0
    assert all(f.stat().st_mode & 0o077 == 0 for f in (tmp_path / "backups").iterdir())


def test_restore_checks_the_dump_before_it_drops_anything(fakebin, tmp_path: Path) -> None:
    dump = tmp_path / "x.dump"
    dump.write_bytes(b"0" * 2000)
    p, log = fakebin("restore.sh", str(dump), FAKE_EXISTING="7", RESTORE_WIPE="yes", FAKE_LIST_RC="1")
    assert p.returncode != 0 and "DROP DATABASE" not in log


def test_restore_check_reports_time_tables_and_rows_and_drops_its_scratch_database(fakebin, tmp_path: Path) -> None:
    dump = tmp_path / "x.dump"
    dump.write_bytes(b"0" * 2000)
    p, log = fakebin("restore-check.sh", str(dump))
    assert p.returncode == 0, p.stderr
    assert re.search(r"restore_seconds=\d+ tables=2 rows=7", p.stdout)
    created = re.findall(r"CREATE DATABASE (restore_check_\S+)", log)
    dropped = re.findall(r"DROP DATABASE IF EXISTS (restore_check_\S+)", log)
    assert created and created == dropped


def test_restore_check_scratch_names_do_not_collide(fakebin, tmp_path: Path) -> None:
    dump = tmp_path / "x.dump"
    dump.write_bytes(b"0" * 2000)
    names = set()
    for _ in range(2):
        _p, log = fakebin("restore-check.sh", str(dump))
        names |= set(re.findall(r"CREATE DATABASE (restore_check_\S+)", log))
    assert len(names) == 2


def test_the_deploy_unit_outlives_the_longest_possible_deploy() -> None:
    import importlib.util
    spec = importlib.util.spec_from_file_location("deployer_for_timeouts", _VM / "bin/deployer.py")
    import sys as _sys
    _sys.path.insert(0, str(_VM / "bin"))
    mod = importlib.util.module_from_spec(spec)
    _sys.modules["deployer_for_timeouts"] = mod
    spec.loader.exec_module(mod)
    unit = (_VM / "systemd/sprintable-deploy.service").read_text()
    limit = int(re.search(r"^TimeoutStartSec=(\d+)$", unit, re.M).group(1))
    swap = mod.T_UP + 240 + 30 * 3  # up + health window + a few exec probes
    worst = mod.T_PULL + mod.T_DB + mod.T_MIGRATE + swap + swap  # … and a rollback swap after a failed one
    assert limit > worst, f"{limit} s is not above the worst deploy {worst} s"
    assert "UMask=0077" in unit


def test_caddy_waits_for_healthy_backends_and_has_its_own_healthcheck() -> None:
    caddy = COMPOSE["services"]["caddy"]
    assert caddy["depends_on"] == {"backend": {"condition": "service_healthy"}, "frontend": {"condition": "service_healthy"}}
    assert caddy["healthcheck"]["test"][0] == "CMD"


def test_restore_check_counts_only_table_lines(fakebin, tmp_path: Path) -> None:
    dump = tmp_path / "x.dump"
    dump.write_bytes(b"0" * 2000)
    p, _log = fakebin("restore-check.sh", str(dump), FAKE_COUNTS_JUNK="1")
    assert re.search(r"tables=2 rows=7", p.stdout), p.stdout


def test_restore_refuses_while_the_backend_is_running(fakebin, tmp_path: Path) -> None:
    dump = tmp_path / "x.dump"
    dump.write_bytes(b"0" * 2000)
    p, log = fakebin("restore.sh", str(dump), FAKE_BACKEND_RUNNING="1", FAKE_EXISTING="0")
    assert p.returncode != 0 and "stop it first" in p.stderr and "--single-transaction" not in log


def test_restore_refuses_an_archive_without_table_data(fakebin, tmp_path: Path) -> None:
    dump = tmp_path / "x.dump"
    dump.write_bytes(b"0" * 2000)
    p, log = fakebin("restore.sh", str(dump), FAKE_LIST_NODATA="1", RESTORE_WIPE="yes", FAKE_EXISTING="7")
    assert p.returncode != 0 and "DROP DATABASE" not in log


@pytest.mark.parametrize("name", ["sprint;drop", 'a"b', "Mixed", "x y", ""])
def test_restore_refuses_a_database_name_that_is_not_a_plain_identifier(fakebin, tmp_path: Path, name: str) -> None:
    dump = tmp_path / "x.dump"
    dump.write_bytes(b"0" * 2000)
    p, log = fakebin("restore.sh", str(dump), FAKE_DB_NAME=name, RESTORE_WIPE="yes", FAKE_EXISTING="7")
    assert p.returncode != 0 and "DROP DATABASE" not in log


@pytest.mark.skipif(not (shutil.which("sha256sum") or shutil.which("shasum")), reason="no sha256 tool")
def test_restore_from_the_bucket_verifies_the_checksum_before_anything_else(fakebin, tmp_path: Path) -> None:
    import hashlib
    gcs = tmp_path / "gcs"
    gcs.mkdir()
    blob = b"0" * 2000
    (gcs / "db-dev-1.dump").write_bytes(blob)
    (gcs / "db-dev-1.dump.sha256").write_text(f"{hashlib.sha256(blob).hexdigest()}  db-dev-1.dump\n")
    p, log = fakebin("restore.sh", "gs://bk-bucket/db/db-dev-1.dump", FAKE_GCS_DIR=str(gcs), FAKE_EXISTING="0")
    assert p.returncode == 0, p.stderr
    (gcs / "db-dev-1.dump.sha256").write_text(f"{'0' * 64}  db-dev-1.dump\n")
    p2, log2 = fakebin("restore.sh", "gs://bk-bucket/db/db-dev-1.dump", FAKE_GCS_DIR=str(gcs), FAKE_EXISTING="0")
    assert p2.returncode != 0 and "does not match" in p2.stderr


@pytest.mark.skipif(not (shutil.which("sha256sum") or shutil.which("shasum")), reason="no sha256 tool")
def test_restore_check_verifies_the_checksum_of_the_backup_it_fetched(fakebin, tmp_path: Path) -> None:
    import hashlib
    gcs = tmp_path / "gcs"
    gcs.mkdir()
    blob = b"0" * 2000
    (gcs / "db-dev-9.dump").write_bytes(blob)
    (gcs / "db-dev-9.dump.sha256").write_text(f"{hashlib.sha256(blob).hexdigest()}  db-dev-9.dump\n")
    p, _ = fakebin("restore-check.sh", FAKE_GCS_DIR=str(gcs), FAKE_LS="gs://bk-bucket/db/db-dev-9.dump")
    assert p.returncode == 0, p.stderr
    (gcs / "db-dev-9.dump.sha256").write_text(f"{'1' * 64}  db-dev-9.dump\n")
    p2, _ = fakebin("restore-check.sh", FAKE_GCS_DIR=str(gcs), FAKE_LS="gs://bk-bucket/db/db-dev-9.dump")
    assert p2.returncode != 0 and "does not match" in p2.stderr


def test_the_runbook_grants_exactly_the_secrets_the_declaration_reads(capsys) -> None:
    """RUNBOOK §2 loops over `render_env.py --secret-ids`: ids with hyphens / mixed case come out whole, the DB password is included, Cloud SQL strings are not"""
    import importlib.util
    import yaml
    text = (_VM / "RUNBOOK.md").read_text()
    assert "render_env.py --secret-ids deploy/vm/env/$ENV.yaml" in text
    spec = importlib.util.spec_from_file_location("render_env_ids", _VM / "bin/render_env.py")
    R = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(R)
    assert R.main(["render_env.py", "--secret-ids", str(_VM / "env/dev.yaml")]) == 0
    ids = set(capsys.readouterr().out.split())
    decl = yaml.safe_load((_VM / "env/dev.yaml").read_text())
    wanted = {sid for svc in decl["services"].values() for sid in (svc.get("secrets") or {}).values()} | {decl["database"]["password_secret"]}
    assert ids == wanted and "DB_PASSWORD_VM_DEV" in ids
    assert any("-" in i for i in ids) and any(i != i.upper() and "_" in i for i in ids), "the fixture has hyphenated and mixed-case ids"
    assert not any("PGBOUNCER" in i or "DATABASE_URL" in i for i in ids), "the VM never reads the Cloud SQL connection strings"


def test_the_dump_comes_with_its_checksum_because_restore_demands_it_for_a_gs_source() -> None:
    """the dump is taken on the VM by dump-source.sh (the source database has no public address), which writes the sidecar restore.sh verifies and, with --upload, copies it all to the import folder"""
    text = (_VM / "RUNBOOK.md").read_text()
    assert "dump-source.sh --host $SRC_IP --label rehearsal --upload" in text and "gs://$BACKUPS_BUCKET/import/" in text
    cmd = next(line for line in text.splitlines() if "gcloud secrets versions access latest --secret=DATABASE_URL_DIRECT_DEV_SPRINTABLE" in line)
    assert re.search(r"\| gcloud compute ssh \$VM .*--ssh-flag=-T --command \"sudo /opt/sprintable/bin/dump-source\.sh ", cmd), "the URL travels on a pipe, into ssh without a terminal"
    assert "cloud-sql-proxy" not in text, "the source has no public address: a laptop can not reach it"
    assert "sha256_verify" in (_VM / "bin/restore.sh").read_text()
    script = (_VM / "bin/dump-source.sh").read_text()
    assert '.dump.sha256' in script and 'gcloud storage cp --quiet --no-clobber --project "$(cfg project)" "$base.dump" "$base.dump.sha256" "$base.counts.tsv" "gs://$bucket/import/"' in script


def test_the_runbook_closes_the_cloud_run_door_with_a_flag_cloud_run_accepts() -> None:
    text = (_VM / "RUNBOOK.md").read_text()
    assert "--max-instances 0" not in re.sub(r"\(`--max-instances 0` is not allowed[^)]*\)", "", text), "Cloud Run's minimum is 1"
    assert "--ingress internal" in text and "--ingress all" in text and "scheduler jobs pause" in text


@pytest.mark.parametrize("env", ["dev", "prod"])
def test_an_environment_that_trusts_forwarded_for_has_caddy_as_the_only_service_with_ports(env: str) -> None:
    """TRUST_FORWARDED_FOR is only safe when the front door overwrites X-Forwarded-For AND nothing else can reach the backend (Kadir's lint)"""
    import yaml
    path = _VM / f"env/{env}.yaml"
    if not path.exists():
        pytest.skip("declaration not in this branch")
    decl = yaml.safe_load(path.read_text())
    trusts = any(str((svc.get("added") or {}).get("TRUST_FORWARDED_FOR", "")).lower() == "true" for svc in decl["services"].values())
    assert trusts, f"{env} is expected to turn the switch on"
    with_ports = sorted(name for name, svc in COMPOSE["services"].items() if svc.get("ports"))
    assert with_ports == ["caddy"], f"the switch is on but {with_ports} publish ports"
    assert "trusted_proxies" not in (_VM / "Caddyfile").read_text()


def test_the_runbook_asks_for_a_real_world_check_of_the_counted_address_before_dns_moves() -> None:
    text = (_VM / "RUNBOOK.md").read_text()
    assert "First-VM measurement" in text and "X-Forwarded-For: 9.9.9" in text and "do not switch DNS" in text


def test_bootstrap_installs_the_compose_file_the_deployer_holds_bundles_to() -> None:
    boot = (_VM / "bin/bootstrap.sh").read_text()
    assert 'install -m 0644 "$src/compose.yml" /opt/sprintable/bin/compose.yml' in boot
    import importlib.util
    spec = importlib.util.spec_from_file_location("deployer_for_cfg", _VM / "bin/deployer.py")
    import sys as _sys
    _sys.path.insert(0, str(_VM / "bin"))
    mod = importlib.util.module_from_spec(spec)
    _sys.modules["deployer_for_cfg"] = mod
    spec.loader.exec_module(mod)
    assert str(mod.Config.__dataclass_fields__["trusted_compose"].default) == "/opt/sprintable/bin/compose.yml"


def test_the_runbook_closes_ssh_and_rdp_for_this_vm_and_uses_the_dev_attachments_bucket() -> None:
    text = (_VM / "RUNBOOK.md").read_text()
    assert re.search(r"\$VM-iap-ssh .*--priority 800 .*35\.235\.240\.0/20", text)
    assert re.search(r"\$VM-deny-admin .*--priority 900 --action DENY --rules tcp:22,tcp:3389 --target-tags \$VM", text)
    assert "sprintable-memo-attachments-dev" in text
    assert not re.search(r"sprintable-memo-attachments(?!-dev)", text), "the shared attachments bucket must not be granted to the dev VM"
    assert "Log scrubbing covers" in text and "JWT_SECRET_DEV" in text and "JWT_SECRET_PROD" in text and "4798" in text
    assert "`JWT_SECRET` is per environment (story 4798 AC6 — done)" in text and "still shared" not in text
    assert "exactly** the one `bootstrap.sh` installed" in text


def test_dev_declares_its_own_attachments_bucket_and_prod_does_not_touch_it() -> None:
    import yaml
    dev = yaml.safe_load((_VM / "env/dev.yaml").read_text())
    for svc in ("backend", "frontend"):  # live on Cloud Run dev since story 4798, on both services: an override (it was an addition before it went live)
        assert dev["services"][svc]["overrides"]["GCS_MEMO_ATTACHMENTS_BUCKET"] == "sprintable-memo-attachments-dev"
        assert "GCS_MEMO_ATTACHMENTS_BUCKET" not in (dev["services"][svc].get("added") or {})
    prod_path = _VM / "env/prod.yaml"
    if prod_path.exists():
        prod = yaml.safe_load(prod_path.read_text())
        assert "GCS_MEMO_ATTACHMENTS_BUCKET" not in (prod["services"]["backend"].get("added") or {})


def test_the_runbook_says_bucket_write_is_deployment_control_and_names_what_is_not_pinned() -> None:
    text = (_VM / "RUNBOOK.md").read_text()
    assert "write access to the deploy bucket = control of the deployment" in text
    assert "`Caddyfile`" in text and "env/<environment>.yaml" in text and "come from the bundle itself" in text
    assert "one extra flip, nothing lost" in text


def test_bootstrap_installs_gcloud_when_the_image_lacks_it_and_the_runbook_does_not_need_it_on_the_vm_for_the_first_bundle() -> None:
    boot = (_VM / "bin/bootstrap.sh").read_text()
    assert "apt-get install -y -qq google-cloud-cli" in boot and "cloud-sdk main" in boot
    assert boot.index("google-cloud-cli") < boot.index("could not be installed")
    text = (_VM / "RUNBOOK.md").read_text()
    assert "gcloud compute scp /tmp/vm-bundle.tgz $VM:/tmp/" in text
    on_vm = text.split("# on the VM:")[1].split("```")[0]
    assert "gcloud" not in on_vm.split("sudo b/bin/bootstrap.sh")[0], "nothing before bootstrap on the VM may need gcloud"


def test_the_runbook_tells_where_the_amd64_build_should_run() -> None:
    text = (_VM / "RUNBOOK.md").read_text()
    assert "linux/amd64" in text and "Apple-silicon" in text and "Cloud Shell" in text and "image_summary.digest" in text
