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
    """AC5: /api/v2/health → FastAPI 정상 응답.

    story #2295(카디르 QA) — `patch("app.routers.health.get_db")`는 FastAPI가
    `Depends(get_db)`를 라우트 등록 시점에 이미 캡처해 두므로 이후 모듈 속성을 patch해도
    실제 의존성 해석엔 반영되지 않는 사문(死文) 패턴이었다(늘 진짜 전역 테스트 DB를 탔을
    뿐 — 예전엔 `/health`가 DB 성패 무관 항상 200을 반환해 이 갭이 안 드러났었다. 이제
    `/health`가 DB 실패 시 정직하게 503을 반환하면서 이 사문 mock의 무효함이 표면화됐다).
    `app.dependency_overrides`(FastAPI 정본 오버라이드 경로)로 교체."""
    from app.dependencies.database import get_db
    from app.main import app

    mock_session = AsyncMock()
    mock_session.execute = AsyncMock(return_value=None)

    async def _override():
        yield mock_session

    app.dependency_overrides[get_db] = _override
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.get(
                "/api/v2/health",
                headers={"Origin": "http://localhost:3000", "Authorization": "Bearer test-token"},
            )
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["version"] == "v2"
