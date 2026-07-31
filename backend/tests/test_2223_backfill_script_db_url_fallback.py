"""story #2223 후속(오르테가 판정, 2026-07-31) — `backfill_reference_semantic_candidates.py`가
DATABASE_URL 없이 ALEMBIC_URL만 있는 환경(Cloud Run Job `sprintable-verify-oneoff`)에서도
돌 수 있게 하는 폴백. 순수 로직 테스트 — DB 연결 없음(모듈 import가 만드는 engine은 lazy라
실제 연결을 안 한다).

⛔이 스크립트의 engine은 `app.core.database` import **시점**에 만들어진다 — 폴백은 반드시
그 import 前에 os.environ["DATABASE_URL"]을 채워야 한다(늦으면 무효). 이 파일은 매 테스트마다
모듈을 `importlib.reload`해 그 순서를 실제로 태운다."""
from __future__ import annotations

import importlib
import os

import pytest


@pytest.fixture(autouse=True)
def _restore_env():
    saved = {k: os.environ.get(k) for k in ("DATABASE_URL", "ALEMBIC_URL")}
    yield
    for k, v in saved.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v


def _reload_script():
    import scripts.jobs.backfill_reference_semantic_candidates as mod
    return importlib.reload(mod)


def test_prefers_database_url_when_present():
    os.environ["DATABASE_URL"] = "postgresql+asyncpg://u:p@myhost:5432/db"
    os.environ.pop("ALEMBIC_URL", None)
    mod = _reload_script()

    assert mod._db_url_summary is not None
    assert mod._db_url_summary.startswith("DATABASE_URL")
    assert "myhost" in mod._db_url_summary
    assert os.environ["DATABASE_URL"] == "postgresql+asyncpg://u:p@myhost:5432/db"


def test_falls_back_to_alembic_url_with_scheme_conversion():
    os.environ.pop("DATABASE_URL", None)
    os.environ["ALEMBIC_URL"] = "postgresql+psycopg2://u:secret-pw@alembic-host:5432/db"
    mod = _reload_script()

    assert mod._db_url_summary is not None
    assert "ALEMBIC_URL" in mod._db_url_summary
    assert "alembic-host" in mod._db_url_summary
    # 스킴이 asyncpg로 바뀌어야 engine이 실제로 쓸 수 있다.
    assert os.environ["DATABASE_URL"].startswith("postgresql+asyncpg://")
    assert "alembic-host" in os.environ["DATABASE_URL"]


def test_falls_back_plain_postgresql_scheme_too():
    os.environ.pop("DATABASE_URL", None)
    os.environ["ALEMBIC_URL"] = "postgresql://u:pw@plain-host:5432/db"
    mod = _reload_script()

    assert os.environ["DATABASE_URL"] == "postgresql+asyncpg://u:pw@plain-host:5432/db"


def test_summary_never_contains_credentials():
    os.environ.pop("DATABASE_URL", None)
    os.environ["ALEMBIC_URL"] = "postgresql+psycopg2://myuser:supersecret@somehost:5432/db"
    mod = _reload_script()

    assert "supersecret" not in mod._db_url_summary
    assert "myuser" not in mod._db_url_summary


def test_neither_set_returns_none():
    os.environ.pop("DATABASE_URL", None)
    os.environ.pop("ALEMBIC_URL", None)
    mod = _reload_script()

    assert mod._db_url_summary is None


@pytest.mark.anyio
async def test_main_returns_2_and_prints_error_when_neither_set(capsys):
    os.environ.pop("DATABASE_URL", None)
    os.environ.pop("ALEMBIC_URL", None)
    mod = _reload_script()

    rc = await mod.main()
    assert rc == 2
    captured = capsys.readouterr()
    assert "미설정" in captured.err


@pytest.fixture
def anyio_backend():
    return "asyncio"
