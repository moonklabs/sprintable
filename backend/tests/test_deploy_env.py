"""E-INFRA S1: deploy_backend.sh / provision_migrate_job.sh env별 분기 검증.

dev/prod 배포 경로가 서로 다른 Cloud SQL 인스턴스 + 다른 시크릿을 가리키는지,
DRY_RUN 모드 resolved config를 파싱해 양 경로를 검증한다.
"""
from __future__ import annotations

import os
import subprocess

_SCRIPTS = os.path.join(os.path.dirname(__file__), "..", "scripts")
_DEPLOY = os.path.join(_SCRIPTS, "deploy_backend.sh")
_DEPLOY_FE = os.path.join(_SCRIPTS, "deploy_frontend.sh")
_MIGRATE_JOB = os.path.join(_SCRIPTS, "provision_migrate_job.sh")
_DOCKERFILE = os.path.join(os.path.dirname(__file__), "..", "Dockerfile")


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


# ── story 19754b93(E-RECRUIT S15): 수동 실행 시 COMMIT_SHA 필수(latest-ENV 폴백 제거) ──────

def test_migrate_job_requires_commit_sha_without_dry_run():
    """COMMIT_SHA 없이 수동(DRY_RUN 아님) 실행 시 stale latest-ENV 태그로 조용히 폴백하지 않고
    fail-fast — #1886/S13 사고(잡이 코드와 동기화 안 된 이미지를 물고 도는 것)의 재발 방지."""
    environ = {k: v for k, v in os.environ.items() if k != "COMMIT_SHA"}
    proc = subprocess.run(
        ["bash", _MIGRATE_JOB, "dev"], capture_output=True, text=True, env=environ,
    )
    assert proc.returncode != 0
    assert "COMMIT_SHA" in proc.stderr


def test_migrate_job_dry_run_works_without_commit_sha():
    """DRY_RUN=1(검증 목적)은 COMMIT_SHA 없이도 예외적으로 통과 — resolved config 확인용."""
    environ = {k: v for k, v in os.environ.items() if k != "COMMIT_SHA"}
    environ["DRY_RUN"] = "1"
    proc = subprocess.run(
        ["bash", _MIGRATE_JOB, "dev"], capture_output=True, text=True, env=environ, check=True,
    )
    assert "latest-dev" in proc.stdout


def test_migrate_job_uses_exact_commit_sha_when_provided():
    """COMMIT_SHA 제공 시 IMAGE가 정확히 그 태그를 쓰는지(floating latest-ENV 아님)."""
    cfg = _resolve(_MIGRATE_JOB, "dev", {"COMMIT_SHA": "deadbeef123"})
    assert cfg["IMAGE"].endswith(":deadbeef123")
    assert "latest-dev" not in cfg["IMAGE"]


# ── story 19754b93(E-RECRUIT S15): Dockerfile uv.lock lock-pin ─────────────────

def test_dockerfile_copies_uv_lock_before_sync():
    """까심 S13 QA 실측(alembic 1.18.5 vs uv.lock 1.18.4 드리프트): uv.lock을 COPY 안 하면
    `uv sync`가 pyproject.toml 제약만으로 재resolve해 이미지가 실제로 lock-pin 안 된다."""
    with open(_DOCKERFILE) as f:
        lines = f.readlines()
    # 실 Dockerfile 인스트럭션만(주석 제외) — strip 후 "COPY"로 시작해야 함.
    copy_lock_idx = next(
        (i for i, ln in enumerate(lines) if ln.strip().startswith("COPY") and "uv.lock" in ln), None
    )
    sync_idx = next(
        (i for i, ln in enumerate(lines) if ln.strip().startswith("RUN") and "uv sync" in ln), None
    )
    assert copy_lock_idx is not None, "Dockerfile이 uv.lock을 COPY하지 않음(lock-pin 무효)"
    assert sync_idx is not None
    assert copy_lock_idx < sync_idx, "uv.lock COPY가 uv sync보다 먼저 와야 함"


def test_dockerfile_uv_sync_uses_frozen():
    """--frozen: lock 재계산 없이 uv.lock 그대로만 설치 — pyproject.toml과 어긋나면 조용히
    재resolve하는 대신 build 자체가 실패해 드리프트를 빌드 타임에 잡는다."""
    with open(_DOCKERFILE) as f:
        src = f.read()
    sync_lines = [ln for ln in src.splitlines() if "uv sync" in ln]
    assert sync_lines, "uv sync 커맨드를 찾을 수 없음"
    assert "--frozen" in sync_lines[0], f"--frozen 플래그 누락: {sync_lines[0]!r}"


# ── deploy_backend.sh 4결함 fix (cutover 첫 prod 실행서 노출) ────────────────────

def test_deploy_full_env_secrets():
    """결함③: full env — DATABASE_URL/JWT 외 GOOGLE/GITHUB/RESEND/EMAIL 시크릿 포함."""
    s = _resolve(_DEPLOY, "dev")["SECRETS_SPEC"]
    for name in ("DATABASE_URL=", "JWT_SECRET=", "GOOGLE_CLIENT_ID=", "GOOGLE_CLIENT_SECRET=",
                 "GITHUB_CLIENT_ID=", "RESEND_API_KEY=", "EMAIL_FROM="):
        assert name in s, f"{name} 누락 (결함③ full env 미충족)"


def test_deploy_cors_custom_delimiter_preserves_commas():
    """결함④: CORS_ORIGINS 값에 콤마가 있어 ^@^ 커스텀 구분자 필요(없으면 env 쪼개짐)."""
    spec = _resolve(_DEPLOY, "dev")["ENV_VARS_SPEC"]
    assert spec.startswith("^@^"), "커스텀 구분자(^@^) 누락 → CORS 콤마로 env 깨짐(결함④)"
    assert "localhost:3000,http" in spec, "CORS 콤마 보존 실패"


def test_deploy_app_url_env_specific():
    assert _resolve(_DEPLOY, "dev")["APP_URL"] == "https://dev-app.sprintable.ai"
    assert _resolve(_DEPLOY, "prod")["APP_URL"] == "https://app.sprintable.ai"


def test_deploy_no_invalid_probe_flag_and_has_vpc():
    """결함①: 무효 --startup-probe-path 제거. 결함②: VPC 플래그(Private-IP) 추가."""
    with open(_DEPLOY) as f:
        lines = f.readlines()
    # 주석 멘션은 무시하고 **실제 플래그 사용**(공백 후 --로 시작)만 검사.
    flag_usage = [ln for ln in lines if ln.strip().startswith("--startup-probe-path")]
    assert not flag_usage, "무효 플래그 --startup-probe-path 실사용 잔존(결함①)"
    src = "".join(lines)
    assert "--vpc-egress" in src and "--network=default" in src, "VPC 플래그 누락(결함②)"


# ── deploy_frontend.sh 결함 fix (deploy_backend.sh와 동일 패턴) ──────────────────

def test_deploy_frontend_no_invalid_flags():
    """① --startup-cpu-boost(무효) → --cpu-boost. ② --startup-probe-path(무효) 제거."""
    with open(_DEPLOY_FE) as f:
        lines = f.readlines()
    used = lambda flag: [ln for ln in lines if ln.strip().startswith(flag)]
    assert not used("--startup-cpu-boost"), "무효 플래그 --startup-cpu-boost 잔존(결함①)"
    assert not used("--startup-probe-path"), "무효 플래그 --startup-probe-path 잔존(결함②)"
    assert used("--cpu-boost"), "--cpu-boost 누락(--startup-cpu-boost 대체)"


def test_deploy_frontend_single_set_env_vars():
    """--set-env-vars 단일화(gcloud 반복 시 덮어써 NODE_ENV/NEXT_TELEMETRY 유실 위험 방지)."""
    with open(_DEPLOY_FE) as f:
        src = f.read()
    assert src.count("--set-env-vars=") == 1, "--set-env-vars 중복 → env 유실 위험"
    for kv in ("NODE_ENV=production", "NEXT_TELEMETRY_DISABLED=1", "NEXT_PUBLIC_FASTAPI_URL="):
        assert kv in src, f"{kv} 누락"
