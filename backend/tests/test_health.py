import pytest
from httpx import ASGITransport, AsyncClient
from unittest.mock import AsyncMock, patch


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _override_db(app, mock_session):
    from app.dependencies.database import get_db

    async def _override():
        yield mock_session

    app.dependency_overrides[get_db] = _override
    return app


@pytest.mark.anyio
async def test_health_returns_200():
    """AC2: GET /api/v2/health → 200 응답(DB 정상)."""
    from app.main import app

    mock_session = AsyncMock()
    mock_session.execute = AsyncMock(return_value=None)
    _override_db(app, mock_session)
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.get("/api/v2/health")
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["version"] == "v2"


@pytest.mark.anyio
async def test_health_returns_503_when_db_fails():
    """story #2295 별개 fix(카디르 QA 적발) — 이 엔드포인트가 원래 DB 실패에도 top-level
    status를 "ok"로, HTTP를 200으로 고정 반환했다(db 필드에만 에러가 실려 호출자가 status만
    보면 절대 못 잡음). 이제 DB 조회 실패 시 503+status:"error"로 정직하게 반영한다."""
    from app.main import app

    mock_session = AsyncMock()
    mock_session.execute = AsyncMock(side_effect=ConnectionRefusedError("db down"))
    _override_db(app, mock_session)
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.get("/api/v2/health")
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 503
    body = response.json()
    assert body["status"] == "error"
    assert "ConnectionRefusedError" in body["db"]


@pytest.mark.anyio
async def test_ready_returns_200_when_pg_listen_connected():
    """story #2295 AC — /ready는 DB를 조회하지 않고 pg_pubsub의 캐시된 연결상태만 읽는다."""
    from app.main import app
    from app.services import realtime_readiness as rr

    rr.mark_connected()
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.get("/api/v2/ready")
    finally:
        rr._connected = False
        rr._disconnected_since = None

    assert response.status_code == 200
    body = response.json()
    assert body["ready"] is True
    assert body["pg_listen"] == "connected"


@pytest.mark.anyio
async def test_ready_returns_503_when_pg_listen_disconnected_past_grace(monkeypatch):
    """story #2295 AC1 — 원 인시던트(cloud-sql-proxy 죽음)를 이 엔드포인트가 이제 UNHEALTHY로
    본다는 것을 직접 재현: 연결이 끊긴 채 유예시간을 넘기면 503."""
    from app.main import app
    from app.services import realtime_readiness as rr

    monkeypatch.setattr(rr, "UNHEALTHY_GRACE_SECONDS", 0.0)
    rr.mark_connected()
    rr.mark_disconnected("bind: address already in use")
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.get("/api/v2/ready")
    finally:
        rr._connected = False
        rr._disconnected_since = None
        rr._last_error = None

    assert response.status_code == 503
    body = response.json()
    assert body["ready"] is False
    assert body["pg_listen"] == "disconnected"
