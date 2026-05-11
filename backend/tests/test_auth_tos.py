"""AUTH-07: TOS 동의 검증 단위 테스트."""
import uuid
from unittest.mock import AsyncMock, MagicMock

import pytest
from httpx import ASGITransport, AsyncClient


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _client():
    from app.main import app
    from app.dependencies.auth import get_current_user
    from app.dependencies.database import get_db

    mock_session = AsyncMock()
    mock_result = MagicMock()
    mock_result.scalar_one_or_none.return_value = None
    mock_session.execute = AsyncMock(return_value=mock_result)
    mock_session.flush = AsyncMock()
    mock_session.add = MagicMock()

    async def override_db():
        yield mock_session

    async def override_auth():
        ctx = MagicMock()
        ctx.user_id = str(uuid.uuid4())
        return ctx

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = override_auth
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test"), mock_session, app


@pytest.mark.anyio
async def test_register_without_tos_400():
    """tos_accepted=False → 400 TOS_NOT_ACCEPTED."""
    client, session, app = await _client()
    try:
        async with client as c:
            resp = await c.post("/api/v2/auth/register", json={
                "email": "new@example.com",
                "password": "TestPass1!",
                "tos_accepted": False,
            })
        assert resp.status_code == 400
        assert resp.json()["error"]["code"] == "TOS_NOT_ACCEPTED"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_register_without_tos_field_400():
    """tos_accepted 미전달(기본값 False) → 400."""
    client, session, app = await _client()
    try:
        async with client as c:
            resp = await c.post("/api/v2/auth/register", json={
                "email": "new@example.com",
                "password": "TestPass1!",
            })
        assert resp.status_code == 400
        assert resp.json()["error"]["code"] == "TOS_NOT_ACCEPTED"
    finally:
        app.dependency_overrides.clear()
