"""S12 AC2+AC5: CORS 미들웨어 + /api/v2/health 프록시 경로 검증."""
import pytest
from httpx import ASGITransport, AsyncClient
from unittest.mock import AsyncMock, patch


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.anyio
async def test_cors_allows_localhost_3000():
    from app.main import app

    with patch("app.routers.health.get_db") as mock_get_db:
        mock_session = AsyncMock()
        mock_session.execute = AsyncMock(return_value=None)

        async def _override():
            yield mock_session

        mock_get_db.return_value = _override()

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.options(
                "/api/v2/health",
                headers={
                    "Origin": "http://localhost:3000",
                    "Access-Control-Request-Method": "GET",
                    "Access-Control-Request-Headers": "Authorization",
                },
            )

    assert response.status_code == 200
    assert response.headers.get("access-control-allow-origin") == "http://localhost:3000"
    assert response.headers.get("access-control-allow-credentials") == "true"


@pytest.mark.anyio
async def test_cors_allows_sprintable_ai():
    from app.main import app

    with patch("app.routers.health.get_db") as mock_get_db:
        mock_session = AsyncMock()
        mock_session.execute = AsyncMock(return_value=None)

        async def _override():
            yield mock_session

        mock_get_db.return_value = _override()

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.options(
                "/api/v2/health",
                headers={
                    "Origin": "https://app.sprintable.ai",
                    "Access-Control-Request-Method": "GET",
                    "Access-Control-Request-Headers": "Authorization",
                },
            )

    assert response.status_code == 200
    assert response.headers.get("access-control-allow-origin") == "https://app.sprintable.ai"


@pytest.mark.anyio
async def test_health_via_proxy_path():
    """AC5: /api/v2/health → FastAPI 정상 응답."""
    from app.main import app

    with patch("app.routers.health.get_db") as mock_get_db:
        mock_session = AsyncMock()
        mock_session.execute = AsyncMock(return_value=None)

        async def _override():
            yield mock_session

        mock_get_db.return_value = _override()

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.get(
                "/api/v2/health",
                headers={"Origin": "http://localhost:3000", "Authorization": "Bearer test-token"},
            )

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["version"] == "v2"
