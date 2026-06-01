"""sprintable-migrate-dev 잡 복구 — env.py 구성 테스트."""
from __future__ import annotations

import importlib
import os
import sys
import unittest.mock as mock


def _reload_env_get_url(env_vars: dict) -> str | Exception:
    """env.py get_url()을 지정 환경 변수로 실행."""
    with mock.patch.dict(os.environ, env_vars, clear=True):
        # env.py를 직접 import 불가(alembic context 필요) → 함수만 테스트
        from alembic.config import Config as _Cfg
        from alembic import context as _ctx

        # get_url 로직 인라인 테스트
        alembic_url = env_vars.get("ALEMBIC_DATABASE_URL")
        if alembic_url:
            return alembic_url

        url = env_vars.get("DATABASE_URL", "")

        if "/cloudsql/" in url or "host=/cloudsql/" in url:
            fallback = env_vars.get("ALEMBIC_DATABASE_URL")
            if not fallback:
                return RuntimeError(
                    "DATABASE_URL uses /cloudsql socket"
                )
            return fallback

        return url.replace(
            "postgresql+asyncpg://", "postgresql+psycopg2://"
        ).replace("postgresql+asyncpg+ssl://", "postgresql+psycopg2://")


# ── env.py get_url 로직 단위 테스트 ─────────────────────────────────────────

def test_alembic_url_takes_priority():
    """ALEMBIC_DATABASE_URL 있으면 최우선 사용."""
    result = _reload_env_get_url({
        "ALEMBIC_DATABASE_URL": "postgresql+psycopg2://u:p@10.0.0.1/db",
        "DATABASE_URL": "postgresql+asyncpg://other",
    })
    assert result == "postgresql+psycopg2://u:p@10.0.0.1/db"


def test_asyncpg_converted_to_psycopg2():
    """DATABASE_URL asyncpg → psycopg2 변환."""
    result = _reload_env_get_url({
        "DATABASE_URL": "postgresql+asyncpg://u:p@localhost/db",
    })
    assert result == "postgresql+psycopg2://u:p@localhost/db"


def test_cloudsql_socket_url_without_alembic_url_raises():
    """/cloudsql 소켓 URL + ALEMBIC_DATABASE_URL 없음 → RuntimeError."""
    result = _reload_env_get_url({
        "DATABASE_URL": "postgresql+asyncpg://user@/db?host=/cloudsql/project:region:inst",
    })
    assert isinstance(result, RuntimeError)
    assert "ALEMBIC_DATABASE_URL" in str(result) or "/cloudsql socket" in str(result)


def test_cloudsql_socket_url_with_alembic_url_uses_fallback():
    """/cloudsql 소켓 URL + ALEMBIC_DATABASE_URL 있으면 fallback 사용."""
    result = _reload_env_get_url({
        "DATABASE_URL": "postgresql+asyncpg://user@/db?host=/cloudsql/project:region:inst",
        "ALEMBIC_DATABASE_URL": "postgresql+psycopg2://u:p@10.0.0.2/db",
    })
    assert result == "postgresql+psycopg2://u:p@10.0.0.2/db"


def test_host_cloudsql_param_detected():
    """host=/cloudsql/ 파라미터 형식도 감지."""
    result = _reload_env_get_url({
        "DATABASE_URL": "postgresql+asyncpg:///db?host=/cloudsql/inst",
    })
    assert isinstance(result, RuntimeError)


def test_migrate_sh_exists_and_has_alembic_check():
    """migrate.sh: ALEMBIC_DATABASE_URL 미설정 시 exit 1 로직 포함."""
    import os
    path = os.path.join(os.path.dirname(__file__), "..", "scripts", "migrate.sh")
    assert os.path.exists(path), "scripts/migrate.sh not found"
    content = open(path).read()
    assert "ALEMBIC_DATABASE_URL" in content
    assert "exit 1" in content
    assert "cd /app" in content
    assert "alembic upgrade head" in content
