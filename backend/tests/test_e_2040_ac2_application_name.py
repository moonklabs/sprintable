"""SID f2fe1c5e/#2040 AC2: application_name을 서비스·리비전·연결종류별로 부여하고
pg_stat_activity를 그 축으로 집계할 수 있게 한다 — "어느 서비스가 커넥션을 몇 개 쓰는지
분해할 수 없다"는 계측 부재를 없애는 첫 단계(AC1 예산표·AC3/AC4 조치의 전제).
"""
from __future__ import annotations

import asyncio

import pytest
from unittest.mock import AsyncMock, patch

from app.core.database import db_application_name


def test_application_name_uses_k_service_and_k_revision(monkeypatch):
    monkeypatch.setenv("K_SERVICE", "sprintable-backend-dev")
    monkeypatch.setenv("K_REVISION", "sprintable-backend-dev-00842-abc")
    assert db_application_name() == "sprintable-backend-dev:sprintable-backend-dev-00842-abc"


def test_application_name_appends_suffix_for_raw_listen(monkeypatch):
    monkeypatch.setenv("K_SERVICE", "sprintable-backend-dev")
    monkeypatch.setenv("K_REVISION", "rev-1")
    assert db_application_name("listen") == "sprintable-backend-dev:rev-1:listen"


def test_application_name_falls_back_locally_without_cloud_run_env(monkeypatch):
    monkeypatch.delenv("K_SERVICE", raising=False)
    monkeypatch.delenv("K_REVISION", raising=False)
    assert db_application_name() == "local:dev"


def test_application_name_truncated_to_postgres_namedatalen(monkeypatch):
    # Postgres application_name silently truncates >63자(NAMEDATALEN 64) — 우리 쪽에서 먼저 잘라야
    # truncate로 인한 서로 다른 리비전의 우연한 충돌(뒤 63자 초과분 소실)을 명시적으로 통제한다.
    monkeypatch.setenv("K_SERVICE", "sprintable-backend-dev")
    monkeypatch.setenv("K_REVISION", "x" * 80)
    name = db_application_name("listen")
    assert len(name) == 63


def test_engine_connect_args_carries_application_name(monkeypatch):
    monkeypatch.setenv("K_SERVICE", "sprintable-backend-dev")
    monkeypatch.setenv("K_REVISION", "rev-9")
    from app.core.database import _build_engine_kwargs

    kwargs = _build_engine_kwargs()
    assert kwargs["connect_args"]["server_settings"]["application_name"] == "sprintable-backend-dev:rev-9"


@pytest.mark.anyio
async def test_listen_loop_tags_raw_connection_with_listen_suffix(monkeypatch):
    """raw asyncpg.connect가 :listen suffix가 붙은 application_name으로 호출되는지 —
    pg_stat_activity에서 pool 연결과 raw LISTEN 연결을 분리 집계하기 위한 근거."""
    from app.services import pg_pubsub

    monkeypatch.setenv("K_SERVICE", "sprintable-backend-dev")
    monkeypatch.setenv("K_REVISION", "rev-9")

    connect_calls = []

    async def _fake_connect_then_cancel(url, **kwargs):
        connect_calls.append((url, kwargs))
        raise asyncio.CancelledError  # listen_loop이 잡아 정상 종료 — 1회 호출만 관찰

    with patch("asyncpg.connect", _fake_connect_then_cancel):
        await pg_pubsub.listen_loop()  # CancelledError를 내부에서 삼키고 return

    assert connect_calls, "asyncpg.connect가 호출되지 않았다"
    _, kwargs = connect_calls[0]
    assert kwargs["server_settings"]["application_name"] == "sprintable-backend-dev:rev-9:listen"


@pytest.mark.anyio
async def test_db_connection_stats_aggregates_by_application_name_and_state():
    """db-connection-stats가 pg_stat_activity row를 application_name·state·count로 반환하는지."""
    from types import SimpleNamespace

    from httpx import ASGITransport, AsyncClient

    from app.dependencies.database import get_db
    from app.main import app

    rows = [
        SimpleNamespace(application_name="sprintable-backend-dev:rev-9", state="active", count=3),
        SimpleNamespace(application_name="sprintable-backend-dev:rev-9:listen", state="idle", count=1),
        SimpleNamespace(application_name="", state="idle", count=12),  # internal-api 등 미태깅 소비자
    ]
    mock_session = AsyncMock()
    mock_session.execute = AsyncMock(return_value=rows)

    async def _override_db():
        yield mock_session

    app.dependency_overrides[get_db] = _override_db
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.get("/api/v2/internal/cron/db-connection-stats")
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    body = response.json()["data"]
    assert body["total"] == 16
    assert {"application_name": "", "state": "idle", "count": 12} in body["rows"]


@pytest.mark.anyio
async def test_db_connection_stats_requires_cron_secret(monkeypatch):
    from httpx import ASGITransport, AsyncClient

    from app.main import app
    from app.routers import cron as cron_mod

    monkeypatch.setattr(cron_mod, "CRON_SECRET", "s3cr3t")

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/api/v2/internal/cron/db-connection-stats")

    assert response.status_code == 401


@pytest.fixture
def anyio_backend():
    return "asyncio"
