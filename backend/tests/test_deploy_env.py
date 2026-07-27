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
    """결함③: full env — DATABASE_URL/JWT 외 GOOGLE/RESEND/EMAIL 시크릿 포함.

    story #2155(2026-07-23): GitHub 로그인 제거로 GITHUB_CLIENT_ID/_SECRET 배선도 함께
    삭제됐다(settings.github_client_id/github_client_secret 자체가 코드에 없음, #2436) —
    더 이상 이 목록에 있으면 안 된다(회귀가드로 부재를 고정)."""
    s = _resolve(_DEPLOY, "dev")["SECRETS_SPEC"]
    for name in ("DATABASE_URL=", "JWT_SECRET=", "GOOGLE_CLIENT_ID=", "GOOGLE_CLIENT_SECRET=",
                 "RESEND_API_KEY=", "EMAIL_FROM="):
        assert name in s, f"{name} 누락 (결함③ full env 미충족)"
    assert "GITHUB_CLIENT_ID=" not in s, "GitHub 로그인 제거(#2155) 후에도 배선이 남아있음"
    assert "GITHUB_CLIENT_SECRET=" not in s, "GitHub 로그인 제거(#2155) 후에도 배선이 남아있음"


def test_deploy_cors_custom_delimiter_preserves_commas():
    """결함④: CORS_ORIGINS 값에 콤마가 있어 ^@^ 커스텀 구분자 필요(없으면 env 쪼개짐)."""
    spec = _resolve(_DEPLOY, "dev")["ENV_VARS_SPEC"]
    assert spec.startswith("^@^"), "커스텀 구분자(^@^) 누락 → CORS 콤마로 env 깨짐(결함④)"
    assert "localhost:3000,http" in spec, "CORS 콤마 보존 실패"


def test_deploy_app_url_env_specific():
    assert _resolve(_DEPLOY, "dev")["APP_URL"] == "https://dev-app.sprintable.ai"
    assert _resolve(_DEPLOY, "prod")["APP_URL"] == "https://app.sprintable.ai"


def test_deploy_app_env_matches_local_envs_semantics():
    """story cd10e123 계열(2026-07-21, 오르테가군 SPEC-vs-라이브 1:1 대조): dev는 코드가
    기대하는 정확한 리터럴 "development"여야 한다(cron.py/auth_firebase_internal.py의
    `_LOCAL_ENVS = {"development"}`가 정확히 이 문자열만 매칭 — "dev"였다면 그 세이프티넷이
    조용히 꺼졌을 것). prod는 라이브 실측(APP_ENV=prod)과 동일 유지."""
    dev_spec = _resolve(_DEPLOY, "dev")["ENV_VARS_SPEC"]
    assert "APP_ENV=development@" in dev_spec, "dev APP_ENV가 _LOCAL_ENVS 리터럴('development')과 불일치"
    prod_spec = _resolve(_DEPLOY, "prod")["ENV_VARS_SPEC"]
    assert "APP_ENV=prod@" in prod_spec, "prod APP_ENV가 라이브 실측값(prod)과 불일치"


def test_deploy_dev_frontend_url_not_fake_placeholder():
    """story cd10e123 계열: 예전 dev FRONTEND_URL 기본값("...placeholder.run.app")은 실존한
    적 없는 가짜 호스트 — CORS allowlist에 실제 프론트 도메인이 안 실렸을 것. dev-app.sprintable.ai
    (라이브 실측 APP_URL과 동일 CF-fronted 도메인)로 교정됐는지 확認."""
    spec = _resolve(_DEPLOY, "dev")["ENV_VARS_SPEC"]
    assert "placeholder" not in spec, "가짜 placeholder 호스트 잔존"
    assert "dev-app.sprintable.ai" in spec


def test_deploy_no_invalid_probe_flag_and_has_vpc():
    """결함①: 무효 --startup-probe-path 제거. 결함②: VPC 플래그(Private-IP) 추가."""
    with open(_DEPLOY) as f:
        lines = f.readlines()
    # 주석 멘션은 무시하고 **실제 플래그 사용**(공백 후 --로 시작)만 검사.
    flag_usage = [ln for ln in lines if ln.strip().startswith("--startup-probe-path")]
    assert not flag_usage, "무효 플래그 --startup-probe-path 실사용 잔존(결함①)"
    src = "".join(lines)
    assert "--vpc-egress" in src and "--network=default" in src, "VPC 플래그 누락(결함②)"


def test_deploy_backend_env_and_secrets_are_additive():
    """결함⑤(story cd10e123 계열, 2026-07-21 durable-wiring 스윕 ⓐ): --set-env-vars/
    --set-secrets(전체교체)는 이 일회성 런북이 기존 서비스 위에 실수로 재실행될 때
    routine cloudbuild.yaml이 additive로 쌓아온 값(PG_LISTEN_ENABLED·REDIS_*·
    GITHUB_APP_PRIVATE_KEY 등)을 조용히 지우는 landmine이었다 — --update-env-vars/
    --update-secrets(additive)로 교정. --no-allow-unauthenticated도 현재 운영값
    (--allow-unauthenticated, 2026-06-21 prod 403 사건 이후 명시 고정)과 충돌해 제거.
    """
    with open(_DEPLOY) as f:
        lines = f.readlines()
    # 주석 멘션(이 fix를 설명하는 텍스트 자체)은 무시하고 **실제 플래그 사용**만 검사.
    used = lambda flag: [ln for ln in lines if ln.strip().startswith(flag)]
    assert not used("--set-env-vars="), "--set-env-vars(전체교체) 실사용 잔존 — additive 회귀"
    assert not used("--set-secrets="), "--set-secrets(전체교체) 실사용 잔존 — additive 회귀"
    assert not used("--no-allow-unauthenticated"), "--no-allow-unauthenticated 실사용 잔존 — 현재 운영값과 충돌"
    assert used("--update-env-vars=") and used("--update-secrets="), "--update-* 플래그 누락"
    assert used("--allow-unauthenticated")


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
    """--update-env-vars 단일화(gcloud 반복 시 덮어써 NODE_ENV/NEXT_TELEMETRY 유실 위험 방지).

    story cd10e123 계열(2026-07-21, durable-wiring 스윕 ⓐ): --set-env-vars(전체교체)는 이
    스크립트가 재실행될 때 cloudbuild.yaml deploy-frontend가 additive로 쌓아온 값(REALTIME_URL
    등)을 조용히 지우는 landmine이라 --update-env-vars(additive)로 교정됐다 — 이 테스트도 새
    플래그 이름으로 갱신(단일화라는 원래 의도는 동일하게 검증).
    """
    with open(_DEPLOY_FE) as f:
        lines = f.readlines()
    src = "".join(lines)
    # 주석 멘션(이 fix를 설명하는 텍스트 자체)은 무시하고 **실제 플래그 사용**만 검사.
    used = lambda flag: [ln for ln in lines if ln.strip().startswith(flag)]
    assert not used("--set-env-vars="), "--set-env-vars(전체교체) 실사용 잔존 — additive 회귀"
    assert len(used("--update-env-vars=")) == 1, "--update-env-vars 중복 → env 유실 위험"
    for kv in ("NODE_ENV=production", "NEXT_TELEMETRY_DISABLED=1", "NEXT_PUBLIC_FASTAPI_URL="):
        assert kv in src, f"{kv} 누락"


def test_deploy_frontend_cookie_domain_prod_only():
    """story cd10e123 계열(2026-07-21, 오르테가군 SPEC-vs-라이브 1:1 대조): NEXT_PUBLIC_COOKIE_DOMAIN
    은 story e5225c0a(3차 근본 — prod 로그인 풀림 원인 그 자체, 이 세션 초입에 재확認)가 정확히
    이 값의 dev/prod 유무 차이 때문이었다. 예전엔 env 구분 없이 항상 바인딩 — 재실행 시 dev에
    이 값이 새로 생겨 그 클래스 버그를 재현할 위험. env별로 분리됐는지 실증."""
    with open(_DEPLOY_FE) as f:
        src = f.read()
    assert 'COOKIE_DOMAIN_SECRET_SPEC=""' in src, "dev COOKIE_DOMAIN_SECRET_SPEC 빈 값 누락"
    assert "COOKIE_DOMAIN_SECRET_SPEC=\",NEXT_PUBLIC_COOKIE_DOMAIN=NEXT_PUBLIC_COOKIE_DOMAIN:latest\"" in src, \
        "prod COOKIE_DOMAIN_SECRET_SPEC 누락"


def test_deploy_frontend_dev_uses_cf_fronted_fastapi_domain():
    """story cd10e123 계열: dev NEXT_PUBLIC_FASTAPI_URL 동적 discovery는 항상 raw *.run.app 로
    resolve돼, 라이브 실측(CF-fronted dev-api.sprintable.ai)과 다르다 — 재실행 시 조용히
    되돌아갈 위험. 하드코드 override 확認."""
    with open(_DEPLOY_FE) as f:
        src = f.read()
    assert 'FASTAPI_URL_OVERRIDE="https://dev-api.sprintable.ai"' in src


# ── story #2060(SID f2fe1c5e #2040 AC5 후속): uvicorn graceful shutdown 상한 ────────

def test_dockerfile_uvicorn_bounds_graceful_shutdown():
    """uvicorn 0.46.0 `timeout_graceful_shutdown` 기본값은 None(무기한) — 장수명 SSE 스트림이
    안 끊기면 lifespan.shutdown()(pg_pubsub LISTEN 정리)이 영영 안 불리고 Cloud Run SIGKILL
    (terminationGracePeriodSeconds 기본 10초, dev/prod 둘 다 미설정 — 오르테가군 gcloud 실측
    2026-07-20)에 정리 없이 죽는다. `--timeout-graceful-shutdown 5`로 상한을 강제해
    드레인 5초+정리(밀리초 단위) 5초 여유를 10초 한도 안에 확보한다."""
    with open(_DOCKERFILE) as f:
        src = f.read()
    cmd_lines = [ln for ln in src.splitlines() if ln.strip().startswith("CMD")]
    assert cmd_lines, "CMD 인스트럭션을 찾을 수 없음"
    cmd = cmd_lines[-1]
    assert "--timeout-graceful-shutdown" in cmd, (
        "uvicorn CMD에 --timeout-graceful-shutdown 누락 — 기본값 None(무기한)으로 되돌아가면 "
        "pg_pubsub LISTEN 정리가 SIGKILL에 밀려 좀비 커넥션이 재발한다."
    )
    assert '"5"' in cmd, "timeout 값이 5초가 아님 — Cloud Run 10초 유예 안에서의 안전 마진 확認 필요"
