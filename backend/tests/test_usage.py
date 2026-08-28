"""GET /api/v2/usage — org별 사용량 미터 조회.

story #2394: test_s48.py(mockups CRUD + usage 혼재 파일)에서 usage 부분만 분리했다 —
usage.py 라우터 자체가 mockups 도메인과 무관해(app/routers/usage.py 참고) 그 파일을
지우면서 이 테스트까지 같이 지우면 안 된다."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock

import pytest

ORG_ID = uuid.uuid4()
PROJECT_ID = uuid.uuid4()
USER_ID = uuid.uuid4()


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


async def _client():
    from app.main import app
    ctx = MagicMock()
    ctx.user_id = USER_ID
    ctx.claims = {"app_metadata": {"org_id": str(ORG_ID), "project_id": str(PROJECT_ID)}}
    mock_session = AsyncMock()

    async def override_db():
        yield mock_session

    async def override_auth():
        return ctx

    from app.dependencies.auth import get_current_user
    from app.dependencies.database import get_db
    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = override_auth
    from httpx import ASGITransport, AsyncClient
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test"), mock_session, app


@pytest.mark.anyio
async def test_get_usage_200():
    client, session, app = await _client()
    try:
        row = MagicMock()
        row.meter_type = "ai_calls"
        row.current_value = 3
        row.limit_value = 10
        row.period_start = datetime(2026, 4, 1, tzinfo=timezone.utc)
        # story #3175 — period_end는 DB NOT NULL이 정본(ORM도 정렬 완료), None 픽스처는
        # 이제 실제로 못 나오는 상태를 흉내내는 것이라 실제 기간말 값으로 교체.
        row.period_end = datetime(2026, 4, 30, 23, 59, 59, tzinfo=timezone.utc)
        mock_result = MagicMock()
        mock_result.all.return_value = [row]
        session.execute = AsyncMock(return_value=mock_result)
        async with client as c:
            resp = await c.get("/api/v2/usage")
        assert resp.status_code == 200
        body = resp.json()
        assert body["error"] is None
        assert body["data"][0]["meter_type"] == "ai_calls"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_usage_403_without_org_id():
    client, session, app = await _client()
    ctx = MagicMock()
    ctx.user_id = USER_ID
    ctx.claims = {"app_metadata": {}}
    from app.dependencies.auth import get_current_user
    app.dependency_overrides[get_current_user] = lambda: ctx
    try:
        async with client as c:
            resp = await c.get("/api/v2/usage")
        assert resp.status_code == 403
    finally:
        app.dependency_overrides.clear()
