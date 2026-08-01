"""story #2384 REQUEST_CHANGES 후속(카디르군, 2026-08-01) — 이 PR이 scripts/jobs/로 옮긴 두
스크립트가 README(AC4)가 문서화한 ALEMBIC_URL 폴백을 실제로는 안 따랐다: 옮기기만 했지
`backfill_reference_semantic_candidates.py`가 이미 하던 패턴(_db_env.resolve_database_url())을
안 붙였다. 그대로 배포하면 sprintable-verify-oneoff에서 "No module named"가 "DATABASE_URL
미설정"으로 자리만 옮겨 갈 뿐이었다.

순수 로직 테스트 — DB 연결 없음(engine은 lazy라 실제 연결을 안 한다). 세 스크립트 모두
`importlib.reload`로 모듈 최상위(또는 main() 진입 직후)에서 resolve가 실제로 도는 순서를 태운다."""
from __future__ import annotations

import importlib
import os
import sys

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


def _reload(module_path: str):
    """정확히 한 번만 실행한다. import_module()에 이어 바로 reload()하면(둘 다 "실행"이라
    믿기 쉽지만) 첫 실행이 resolve_database_url()의 부작용으로 os.environ["DATABASE_URL"]을
    채워 두 번째 실행이 그걸 "이미 있던 DATABASE_URL"로 오인한다 — 이 테스트 파일 자신이
    오늘 하루 종일 다룬 그 자(문서/의도와 실제 실행의 불일치)에 걸릴 뻔한 자리."""
    if module_path in sys.modules:
        return importlib.reload(sys.modules[module_path])
    return importlib.import_module(module_path)


@pytest.mark.parametrize(
    "module_path",
    [
        "scripts.jobs.backfill_activity_events",
        "scripts.jobs.backfill_reference_semantic_candidates",
    ],
)
def test_module_level_falls_back_to_alembic_url(module_path):
    """backfill_activity_events.py·backfill_reference_semantic_candidates.py는 DB-touching
    import가 모듈 최상위에 있어, 폴백도 모듈 최상위(_db_url_summary)에서 돌아야 한다."""
    os.environ.pop("DATABASE_URL", None)
    os.environ["ALEMBIC_URL"] = "postgresql+psycopg2://u:secret-pw@alembic-host:5432/db"
    mod = _reload(module_path)

    assert mod._db_url_summary is not None
    assert "ALEMBIC_URL" in mod._db_url_summary
    assert "alembic-host" in mod._db_url_summary
    assert os.environ["DATABASE_URL"].startswith("postgresql+asyncpg://")
    assert "secret-pw" not in mod._db_url_summary


@pytest.mark.anyio
async def test_expire_script_main_falls_back_to_alembic_url(monkeypatch):
    """expire_undeliverable_pending_dispatched_events.py는 DB-touching import가 main() 안에
    지연돼 있어, resolve_database_url()도 main() 진입 시점에 불러야 한다 — argparse 뒤가 아니라
    맨 앞이어야 그 뒤의 app.core.database import가 올바른 DATABASE_URL을 본다."""
    os.environ.pop("DATABASE_URL", None)
    os.environ["ALEMBIC_URL"] = "postgresql+psycopg2://u:secret-pw@alembic-host:5432/db"
    monkeypatch.setattr("sys.argv", ["expire_undeliverable_pending_dispatched_events.py"])

    import scripts.jobs.expire_undeliverable_pending_dispatched_events as mod
    importlib.reload(mod)

    # DB 세션을 열지 않고 resolve 결과만 확認 — async_session_factory는 main() 안에서 argparse
    # 뒤에 지연 import되므로, 여기까지 오면 이미 DATABASE_URL 폴백이 성공했다는 뜻이다.
    called = {}

    class _FakeSession:
        async def __aenter__(self):
            called["opened"] = True
            raise SystemExit(0)  # 실제 DB 접속 전에 여기서 멈춘다

        async def __aexit__(self, *a):
            return False

    monkeypatch.setattr(
        "app.core.database.async_session_factory", lambda: _FakeSession()
    )

    with pytest.raises(SystemExit):
        await mod.main()

    assert called.get("opened") is True
    assert os.environ["DATABASE_URL"].startswith("postgresql+asyncpg://")
    assert "alembic-host" in os.environ["DATABASE_URL"]


@pytest.mark.anyio
async def test_expire_script_main_returns_2_when_neither_set():
    os.environ.pop("DATABASE_URL", None)
    os.environ.pop("ALEMBIC_URL", None)

    import scripts.jobs.expire_undeliverable_pending_dispatched_events as mod
    importlib.reload(mod)

    rc = await mod.main()
    assert rc == 2


@pytest.fixture
def anyio_backend():
    return "asyncio"
