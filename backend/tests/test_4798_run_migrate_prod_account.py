"""story 4798 (AC7, step 1) — the prod database jobs run as their own account, not as the default compute account.

The prod migrate and read-only jobs used to run as the default compute account because the provisioning scripts gave no `--service-account`. Now the prod job is deployed as `run-migrate-prod` (a dedicated least-privilege
account: it reads one secret and uses the database connector for the prod instance); dev is unchanged. These tests read the dry-run output and the REAL `gcloud` arguments (only `gcloud` recorded) of both scripts, check that
`setup_iam.sh` creates the account with exactly those grants, and scan every tracked file for a job pinned to the default compute account."""
from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path

import pytest

_BACKEND = Path(__file__).resolve().parents[1]
_ROOT = _BACKEND.parent
_SCRIPTS = _BACKEND / "scripts"
_MIGRATE = _SCRIPTS / "provision_migrate_job.sh"
_READONLY = _SCRIPTS / "provision_readonly_prod_job.sh"
_PROJECT = "sprintable-494803"
_NEW = f"run-migrate-prod@{_PROJECT}.iam.gserviceaccount.com"


def _dry(script: Path, *args: str) -> dict[str, str]:
    proc = subprocess.run(["bash", str(script), *args], capture_output=True, text=True, check=True, timeout=60, env={**os.environ, "DRY_RUN": "1"})
    out: dict[str, str] = {}
    for line in proc.stdout.splitlines():
        if "=" in line:
            k, _, v = line.partition("=")
            out[k.strip()] = v.strip()
    return out


@pytest.fixture
def recording_gcloud(tmp_path):
    log = tmp_path / "calls.txt"
    g = tmp_path / "bin" / "gcloud"
    g.parent.mkdir()
    g.write_text(f'#!/bin/sh\nfor a in "$@"; do printf "ARG=%s\\n" "$a" >> "{log}"; done\nprintf "ENDCALL\\n" >> "{log}"\nexit 0\n')
    g.chmod(0o755)
    return g.parent, log


def _real_call(script: Path, args: list[str], recording_gcloud) -> list[str]:
    """the argument list of the ONE `gcloud` call the script makes — it must be a `run jobs deploy <job>`, with no other gcloud call and no empty argument"""
    bin_dir, log = recording_gcloud
    env = {**os.environ, "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}", "COMMIT_SHA": "abc1234"}
    env.pop("DRY_RUN", None)
    proc = subprocess.run(["bash", str(script), *args], capture_output=True, text=True, env=env, timeout=60)
    assert proc.returncode == 0, proc.stderr[-400:]
    calls = [[a[4:] for a in c.splitlines() if a.startswith("ARG=")] for c in log.read_text().split("ENDCALL\n") if c.strip()]
    assert len(calls) == 1, calls  # no second gcloud call of any kind
    argv = calls[0]
    assert argv[:3] == ["run", "jobs", "deploy"], argv
    assert "" not in argv, argv  # an empty argument (an expansion that should have vanished) is a defect
    return argv


def test_the_prod_migrate_job_is_deployed_as_the_dedicated_account(recording_gcloud):
    argv = _real_call(_MIGRATE, ["prod"], recording_gcloud)
    assert f"--service-account={_NEW}" in argv, argv
    assert [a for a in argv if a.startswith("--service-account")] == [f"--service-account={_NEW}"]  # exactly one, exactly this
    assert argv[3] == "sprintable-migrate-prod"


def test_the_dev_migrate_job_is_not_changed(recording_gcloud):
    argv = _real_call(_MIGRATE, ["dev"], recording_gcloud)
    assert not [a for a in argv if a.startswith("--service-account")], argv  # dev's jobs keep what they have
    assert argv[3] == "sprintable-migrate-dev"


def test_the_readonly_prod_job_is_deployed_as_the_dedicated_account(recording_gcloud):
    argv = _real_call(_READONLY, [], recording_gcloud)
    assert [a for a in argv if a.startswith("--service-account")] == [f"--service-account={_NEW}"], argv
    assert argv[3] == "sprintable-readonly-prod"


def test_the_dry_runs_show_the_account():
    assert _dry(_MIGRATE, "prod")["SERVICE_ACCOUNT"] == _NEW
    assert _dry(_MIGRATE, "dev")["SERVICE_ACCOUNT"] == ""
    assert _dry(_READONLY)["SERVICE_ACCOUNT"] == _NEW


def test_the_dedicated_account_is_neither_the_default_compute_account_nor_a_runtime_account_of_a_service():
    for acct in (_dry(_MIGRATE, "prod")["SERVICE_ACCOUNT"], _dry(_READONLY)["SERVICE_ACCOUNT"]):
        assert acct and re.fullmatch(r"run-migrate-prod@[a-z0-9-]+\.iam\.gserviceaccount\.com", acct), acct  # never empty, never another account
        assert not acct.endswith("-compute@developer.gserviceaccount.com")
        assert not acct.startswith("cloudrun-runtime-")


def test_the_prod_job_keeps_what_it_always_read_and_connected_to(recording_gcloud):
    argv = _real_call(_MIGRATE, ["prod"], recording_gcloud)
    assert "--set-secrets=ALEMBIC_DATABASE_URL=ALEMBIC_DATABASE_URL_PROD:latest" in argv
    assert any(a.startswith("--set-cloudsql-instances=") and a.endswith(":sprintable-prod") for a in argv)


_COMPUTE_PIN = re.compile(r"--service-account(?:=|\s+)\S*compute@developer\.gserviceaccount\.com")


def _normalised(text: str) -> str:
    """backslash-continued lines joined, so a flag and its value written on two lines are one"""
    return re.sub(r"\\\n\s*", " ", text)


@pytest.mark.parametrize(
    "name, text, hit",
    [
        ("single line", "gcloud run jobs deploy j --service-account=123-compute@developer.gserviceaccount.com\n", True),
        ("space instead of =", "gcloud run jobs deploy j --service-account 123-compute@developer.gserviceaccount.com\n", True),
        ("value on the next line", "gcloud run jobs deploy j \\\n  --service-account \\\n  123-compute@developer.gserviceaccount.com\n", True),
        ("constructed from the project number", 'gcloud run jobs deploy j --service-account="${PROJECT_NUMBER}"-compute@developer.gserviceaccount.com\n', True),
        ("a dedicated account is fine", "gcloud run jobs deploy j --service-account=run-migrate-prod@p.iam.gserviceaccount.com\n", False),
        ("a mention in prose is fine", "the default compute account is 123-compute@developer.gserviceaccount.com\n", False),
    ],
)
def test_the_pin_scan_sees_every_shape_of_a_job_pinned_to_the_default_compute_account(name, text, hit):
    assert bool(_COMPUTE_PIN.search(_normalised(text))) is hit, name


def test_no_tracked_file_pins_a_job_to_the_default_compute_account():
    """every tracked file (the whole tree, not selected roots): no `--service-account` that is the default compute account"""
    raw = subprocess.run(["git", "-C", str(_ROOT), "ls-files", "-z"], capture_output=True, check=True, timeout=60).stdout
    names = [os.fsdecode(n) for n in raw.split(b"\0") if n]
    assert len(names) > 500, "the scan saw almost nothing"
    hits = []
    for n in names:
        rel = Path(n)
        if rel.name == "test_4798_run_migrate_prod_account.py" or any(part in {"node_modules", ".git", "tests", "__tests__"} for part in rel.parts[:-1]) or rel.suffix in {".png", ".jpg", ".gz", ".zip", ".lock", ".pyc"}:
            continue
        try:
            text = (_ROOT / rel).read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        for m in _COMPUTE_PIN.finditer(_normalised(text)):
            hits.append(f"{n}: {m.group(0)[:60]}")
    assert hits == [], hits


# ── the account is created reproducibly (setup_iam.sh) with exactly the grants the jobs need ──


@pytest.fixture
def recording_gcloud_for_setup(tmp_path):
    log = tmp_path / "calls.txt"
    g = tmp_path / "bin" / "gcloud"
    g.parent.mkdir()
    # K_FAIL (an env variable of the test): a call whose arguments contain it fails — to see what the setup does when gcloud refuses
    g.write_text(f'#!/bin/sh\necho "$*" >> "{log}"\nif [ -n "$K_FAIL" ] && echo "$*" | grep -q -- "$K_FAIL"; then exit 1; fi\nexit 0\n')
    g.chmod(0o755)
    return g.parent, log


def _setup_iam(recording, extra=None, expect_ok=True):
    bin_dir, log = recording
    env = {**os.environ, "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}", "GCP_PROJECT": "proj-x", "PROJECT_NUMBER": "123456", **(extra or {})}
    proc = subprocess.run(["bash", str(_SCRIPTS / "setup_iam.sh")], capture_output=True, text=True, env=env, timeout=120)
    if expect_ok:
        assert proc.returncode == 0, proc.stderr[-400:]
    return proc, (log.read_text().splitlines() if log.exists() else [])


def test_setup_iam_creates_the_dedicated_account_with_exactly_its_grants(recording_gcloud_for_setup):
    proc, calls = _setup_iam(recording_gcloud_for_setup)
    assert any(c.startswith("iam service-accounts create run-migrate-prod ") for c in calls), calls
    # the database connector, for the PROD instance only (an IAM condition on the instance)
    conn = [c for c in calls if c.startswith("projects add-iam-policy-binding") and "run-migrate-prod@proj-x" in c]
    assert len(conn) == 1 and "--role=roles/cloudsql.client" in conn[0], conn
    assert "resource.name == \"projects/proj-x/instances/sprintable-prod\"" in conn[0] and "sqladmin.googleapis.com/Instance" in conn[0], conn[0]
    # the build's account may deploy a job as it — on this account only
    assert any(c.startswith("iam service-accounts add-iam-policy-binding run-migrate-prod@proj-x") and "--member=serviceAccount:123456-compute@developer.gserviceaccount.com" in c and "--role=roles/iam.serviceAccountUser" in c for c in calls), calls
    # the one secret, granted on the secret (never at project level)
    grants = [c for c in calls if c.startswith("secrets add-iam-policy-binding") and "--member=serviceAccount:run-migrate-prod@proj-x.iam.gserviceaccount.com" in c]
    assert len(grants) == 1 and "ALEMBIC_DATABASE_URL_PROD" in grants[0], grants
    assert "--service-account=run-migrate-prod@proj-x.iam.gserviceaccount.com" in proc.stdout


def test_the_helper_knows_the_dedicated_account(recording_gcloud_for_setup):
    bin_dir, log = recording_gcloud_for_setup
    env = {**os.environ, "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}", "GCP_PROJECT": "proj-x"}
    proc = subprocess.run(["bash", str(_SCRIPTS / "grant_secret_access.sh"), "migrate-prod", "SECRET_A"], capture_output=True, text=True, env=env, timeout=60)
    assert proc.returncode == 0, proc.stderr
    assert any("--member=serviceAccount:run-migrate-prod@proj-x.iam.gserviceaccount.com" in c for c in log.read_text().splitlines())


def test_the_build_still_runs_the_migrate_script_with_the_environment_of_the_deploy():
    """the build calls the script per environment — a prod build therefore deploys the prod job as the dedicated account (and a dev build leaves dev alone)"""
    import yaml

    cb = yaml.safe_load((_ROOT / "cloudbuild.yaml").read_text())
    scripts = [s["args"][1] for s in cb["steps"] if isinstance(s.get("args"), list) and len(s["args"]) > 1 and "provision_migrate_job.sh" in str(s["args"][1])]
    assert scripts, "no build step runs provision_migrate_job.sh"
    assert any("provision_migrate_job.sh ${_DEPLOY_ENV}" in s for s in scripts), scripts


@pytest.mark.parametrize(
    "fail_on, said",
    [
        ("describe ALEMBIC_DATABASE_URL_PROD", "could not grant the secret"),  # the secret does not exist: the helper refuses, the setup must NOT report success
        ("--role=roles/iam.serviceAccountUser", "could not allow the build account"),
        ("title=prod-instance-only", "could not grant the connector role"),
    ],
)
def test_setup_iam_fails_loudly_when_a_grant_of_the_dedicated_account_fails(recording_gcloud_for_setup, fail_on, said):
    proc, calls = _setup_iam(recording_gcloud_for_setup, {"K_FAIL": fail_on}, expect_ok=False)
    assert proc.returncode != 0, (proc.stdout[-300:], proc.stderr[-300:])
    assert said in proc.stderr, proc.stderr[-500:]
    assert "run-migrate-prod failed" in proc.stderr
    assert "--service-account=run-migrate-prod" not in proc.stdout  # no guidance as if it had worked


def test_setup_iam_does_not_depend_on_bash_source():
    """BASH_SOURCE is unset under `set -u` in some bash 3.2 contexts: the script finds its own folder through $0 and never expands BASH_SOURCE"""
    text = (_SCRIPTS / "setup_iam.sh").read_text()
    assert 'SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"' in text
    assert "BASH_SOURCE" not in "\n".join(l for l in text.splitlines() if not l.lstrip().startswith("#") and "BASH_SOURCE is unset" not in l)
