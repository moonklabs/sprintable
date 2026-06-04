"""E-INFRA S1: deploy_backend.sh / provision_migrate_job.sh env별 분기 검증.

dev/prod 배포 경로가 서로 다른 Cloud SQL 인스턴스 + 다른 시크릿을 가리키는지,
DRY_RUN 모드 resolved config를 파싱해 양 경로를 검증한다.
"""
from __future__ import annotations

import os
import subprocess

_SCRIPTS = os.path.join(os.path.dirname(__file__), "..", "scripts")
_DEPLOY = os.path.join(_SCRIPTS, "deploy_backend.sh")
_MIGRATE_JOB = os.path.join(_SCRIPTS, "provision_migrate_job.sh")


def _resolve(script: str, env: str, extra: dict | None = None) -> dict[str, str]:
    """스크립트를 DRY_RUN=1로 실행하고 KEY=VALUE stdout을 dict로 파싱."""
    environ = {**os.environ, "DRY_RUN": "1"}
    if extra:
        environ.update(extra)
    proc = subprocess.run(
        ["bash", script, env],
        capture_output=True, text=True, env=environ, check=True,
    )
    cfg: dict[str, str] = {}
    for line in proc.stdout.strip().splitlines():
        if "=" in line:
            k, _, v = line.partition("=")
            cfg[k.strip()] = v.strip()
    return cfg


# ── deploy_backend.sh ────────────────────────────────────────────────────────

def test_deploy_dev_targets_dev_instance():
    cfg = _resolve(_DEPLOY, "dev")
    assert cfg["SERVICE_NAME"] == "sprintable-backend-dev"
    assert cfg["CLOUD_SQL_INSTANCE"].endswith(":sprintable-dev")
    assert cfg["DB_SECRET_NAME"] == "DATABASE_URL_DEV"


def test_deploy_prod_targets_prod_instance():
    cfg = _resolve(_DEPLOY, "prod")
    assert cfg["SERVICE_NAME"] == "sprintable-backend-prod"
    assert cfg["CLOUD_SQL_INSTANCE"].endswith(":sprintable-prod")
    assert cfg["DB_SECRET_NAME"] == "DATABASE_URL_PROD"


def test_deploy_dev_and_prod_are_separated():
    """핵심 AC: 양 경로가 서로 다른 인스턴스 + 다른 시크릿."""
    dev = _resolve(_DEPLOY, "dev")
    prod = _resolve(_DEPLOY, "prod")
    assert dev["CLOUD_SQL_INSTANCE"] != prod["CLOUD_SQL_INSTANCE"]
    assert dev["DB_SECRET_NAME"] != prod["DB_SECRET_NAME"]
    assert dev["SERVICE_NAME"] != prod["SERVICE_NAME"]


def test_deploy_prod_instance_overridable():
    """새 prod 인스턴스명을 env로 override 가능 (PO 명명 결정에 종속되지 않음)."""
    cfg = _resolve(_DEPLOY, "prod", {"PROD_SQL_INSTANCE": "sprintable-prod-v2"})
    assert cfg["CLOUD_SQL_INSTANCE"].endswith(":sprintable-prod-v2")


def test_deploy_no_dead_supabase_secret():
    """사망 SUPABASE 시크릿이 resolved config에 남아있지 않음."""
    for env in ("dev", "prod"):
        cfg = _resolve(_DEPLOY, env)
        joined = " ".join(cfg.values())
        assert "SUPABASE" not in joined


# ── provision_migrate_job.sh ─────────────────────────────────────────────────

def test_migrate_job_dev():
    cfg = _resolve(_MIGRATE_JOB, "dev")
    assert cfg["JOB_NAME"] == "sprintable-migrate-dev"
    assert cfg["CLOUD_SQL_INSTANCE"].endswith(":sprintable-dev")
    assert cfg["ALEMBIC_SECRET_NAME"] == "ALEMBIC_DATABASE_URL_DEV"
    assert cfg["COMMAND"] == "/app/scripts/migrate.sh"


def test_migrate_job_prod():
    cfg = _resolve(_MIGRATE_JOB, "prod")
    assert cfg["JOB_NAME"] == "sprintable-migrate-prod"
    assert cfg["CLOUD_SQL_INSTANCE"].endswith(":sprintable-prod")
    assert cfg["ALEMBIC_SECRET_NAME"] == "ALEMBIC_DATABASE_URL_PROD"


def test_migrate_job_dev_prod_separated():
    dev = _resolve(_MIGRATE_JOB, "dev")
    prod = _resolve(_MIGRATE_JOB, "prod")
    assert dev["CLOUD_SQL_INSTANCE"] != prod["CLOUD_SQL_INSTANCE"]
    assert dev["ALEMBIC_SECRET_NAME"] != prod["ALEMBIC_SECRET_NAME"]
    assert dev["JOB_NAME"] != prod["JOB_NAME"]
