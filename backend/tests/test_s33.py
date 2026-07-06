"""S33 AC: Dashboard + Current Project + Members 라우터 (7건 이상)."""
import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

ORG_ID = uuid.uuid4()
PROJECT_ID = uuid.uuid4()
MEMBER_ID = uuid.uuid4()


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _client():
    from app.main import app

    ctx = MagicMock()
    ctx.user_id = str(uuid.uuid4())
    ctx.email = "test@example.com"
    ctx.claims = {"app_metadata": {"org_id": str(ORG_ID)}}

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


# ── Dashboard ────────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_dashboard_200():
    client, session, app = await _client()
    try:
        empty = MagicMock()
        empty.all.return_value = []
        session.execute = AsyncMock(return_value=empty)

        async with client as c:
            resp = await c.get(f"/api/v2/dashboard?member_id={MEMBER_ID}&project_id={PROJECT_ID}")

        assert resp.status_code == 200
        data = resp.json()
        assert "my_stories" in data
        assert "my_tasks" in data
        assert "open_memos" in data
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_dashboard_missing_member_id_422():
    client, session, app = await _client()
    try:
        async with client as c:
            resp = await c.get("/api/v2/dashboard")

        assert resp.status_code == 422
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_dashboard_empty_result_200():
    client, session, app = await _client()
    try:
        empty = MagicMock()
        empty.all.return_value = []
        session.execute = AsyncMock(return_value=empty)

        async with client as c:
            resp = await c.get(f"/api/v2/dashboard?member_id={MEMBER_ID}&project_id={PROJECT_ID}")

        assert resp.status_code == 200
        assert resp.json()["my_stories"] == []
        assert resp.json()["my_tasks"] == []
        assert resp.json()["open_memos"] == []
    finally:
        app.dependency_overrides.clear()


# ── Current Project ──────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_current_project_get_200():
    client, session, app = await _client()
    try:
        call_count = 0

        async def mock_execute(stmt, *a, **kw):
            nonlocal call_count
            call_count += 1
            result = MagicMock()
            if call_count == 1:
                result.first.return_value = (PROJECT_ID, ORG_ID)
            else:
                result.scalar_one_or_none.return_value = "Test Project"
            return result

        session.execute = mock_execute

        with patch("app.routers.current_project.assert_caller_is_member", new_callable=AsyncMock, return_value=None):
            async with client as c:
                resp = await c.get(f"/api/v2/current-project?member_id={MEMBER_ID}")

        assert resp.status_code == 200
        assert resp.json()["project_id"] == str(PROJECT_ID)
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_current_project_get_403_when_not_self():
    """S20(authz-coverage 스캐너 발견): member_id가 caller 본인 아니면 403(membership-existence
    오라클 차단 — S19 Phase C서 no-op 판단했다가 스캐너가 재발견)."""
    from fastapi import HTTPException

    client, session, app = await _client()
    try:
        with patch("app.routers.current_project.assert_caller_is_member", new_callable=AsyncMock,
                   side_effect=HTTPException(status_code=403, detail="Cannot act as another member")):
            async with client as c:
                resp = await c.get(f"/api/v2/current-project?member_id={MEMBER_ID}")
        assert resp.status_code == 403
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_current_project_post_200():
    client, session, app = await _client()
    try:
        call_count = 0

        async def mock_execute(stmt, *a, **kw):
            nonlocal call_count
            call_count += 1
            result = MagicMock()
            if call_count == 1:
                result.scalar_one_or_none.return_value = ORG_ID
            else:
                result.scalar_one_or_none.return_value = "Test Project"
            return result

        session.execute = mock_execute

        with patch("app.routers.current_project.assert_caller_is_member", new_callable=AsyncMock, return_value=None):
            async with client as c:
                resp = await c.post(
                    f"/api/v2/current-project?member_id={MEMBER_ID}",
                    json={"project_id": str(PROJECT_ID)},
                )

        assert resp.status_code == 200
        assert resp.json()["project_id"] == str(PROJECT_ID)
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_current_project_post_403_when_not_self():
    """S20: POST도 GET과 동일 갭 — self-scope 강제."""
    from fastapi import HTTPException

    client, session, app = await _client()
    try:
        with patch("app.routers.current_project.assert_caller_is_member", new_callable=AsyncMock,
                   side_effect=HTTPException(status_code=403, detail="Cannot act as another member")):
            async with client as c:
                resp = await c.post(
                    f"/api/v2/current-project?member_id={MEMBER_ID}",
                    json={"project_id": str(PROJECT_ID)},
                )
        assert resp.status_code == 403
    finally:
        app.dependency_overrides.clear()


# ── Members ──────────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_members_list_200():
    client, session, app = await _client()
    try:
        member_mock = MagicMock()
        member_mock.id = MEMBER_ID
        member_mock.name = "Alice"
        member_mock.type = "human"
        member_mock.role = "admin"
        member_mock.is_active = True

        mock_result = MagicMock()
        mock_result.scalars.return_value.all.return_value = [member_mock]
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.get(f"/api/v2/members?project_id={PROJECT_ID}")

        assert resp.status_code == 200
        assert len(resp.json()) == 1
        assert resp.json()[0]["name"] == "Alice"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_members_missing_project_id_422():
    client, session, app = await _client()
    try:
        async with client as c:
            resp = await c.get("/api/v2/members")

        assert resp.status_code == 422
    finally:
        app.dependency_overrides.clear()
