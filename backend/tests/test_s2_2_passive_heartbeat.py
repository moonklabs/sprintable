"""S2-2: MCP 미들웨어 passive heartbeat 검증.

AC1: PATCH /api/v2/team-members/{id}/heartbeat 엔드포인트 존재 + 200
AC2: 응답에 ok=True, last_seen_at 포함
AC3: _flat() wrapper가 heartbeat fire-and-forget task 생성
AC4: heartbeat 실패 시 tool 결과에 영향 없음
AC5: ping() 도구도 heartbeat task 생성
AC6: MCP server _heartbeat_fire_forget — member_id 없으면 API 미호출
"""
from __future__ import annotations

import asyncio
import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

ORG_ID = uuid.uuid4()
MEMBER_ID = uuid.uuid4()


# ─── AC1/2: heartbeat 엔드포인트 ─────────────────────────────────────────────

def _mock_member_for_heartbeat():
    m = MagicMock()
    m.id = MEMBER_ID
    m.org_id = ORG_ID
    m.project_id = uuid.uuid4()
    m.user_id = None
    m.type = "agent"
    m.name = "TestAgent"
    m.role = "member"
    m.avatar_url = None
    m.agent_config = None
    m.is_active = True
    m.color = "#3385f8"
    m.agent_role = None
    m.runtime_type = None  # E-CHAT-CMD S1b: 신규 필드 — mock 명시(from_attributes ValidationError 방지)
    m.created_by = None
    m.created_at = datetime(2026, 5, 1, tzinfo=timezone.utc)
    m.updated_at = datetime(2026, 5, 19, tzinfo=timezone.utc)
    m.last_seen_at = datetime(2026, 5, 19, 10, 0, 0, tzinfo=timezone.utc)
    m.active_story_id = None
    m.agent_status = "online"
    return m


async def _heartbeat_client():
    from app.main import app
    from httpx import ASGITransport, AsyncClient

    ctx = MagicMock()
    ctx.user_id = str(uuid.uuid4())
    ctx.email = "agent@test.com"
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

    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test"), mock_session, app


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.anyio
async def test_heartbeat_endpoint_200():
    """AC1: PATCH /api/v2/team-members/{id}/heartbeat → 200."""
    client, session, app = await _heartbeat_client()
    try:
        member = _mock_member_for_heartbeat()
        updated = _mock_member_for_heartbeat()

        mock_get_result = MagicMock()
        mock_get_result.scalar_one_or_none.return_value = member

        mock_update_result = MagicMock()
        mock_update_result.scalar_one_or_none.return_value = updated

        call_count = 0

        async def mock_execute(stmt, *args, **kwargs):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return mock_get_result
            return mock_update_result

        session.execute = mock_execute
        session.flush = AsyncMock()
        session.refresh = AsyncMock()

        async with client as c:
            resp = await c.patch(f"/api/v2/team-members/{MEMBER_ID}/heartbeat")

        assert resp.status_code == 200
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_heartbeat_response_shape():
    """AC2: 응답에 ok=True, last_seen_at(ISO8601) 포함."""
    client, session, app = await _heartbeat_client()
    try:
        member = _mock_member_for_heartbeat()
        updated = _mock_member_for_heartbeat()

        call_count = 0

        async def mock_execute(stmt, *args, **kwargs):
            nonlocal call_count
            call_count += 1
            result = MagicMock()
            result.scalar_one_or_none.return_value = member if call_count == 1 else updated
            return result

        session.execute = mock_execute
        session.flush = AsyncMock()
        session.refresh = AsyncMock()

        async with client as c:
            resp = await c.patch(f"/api/v2/team-members/{MEMBER_ID}/heartbeat")

        body = resp.json()
        assert body["ok"] is True
        assert "last_seen_at" in body
        # ISO8601 형식 확인
        datetime.fromisoformat(body["last_seen_at"].replace("Z", "+00:00"))
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_heartbeat_404_if_not_found():
    """AC1: 존재하지 않는 멤버 → 404."""
    client, session, app = await _heartbeat_client()
    try:
        mock_result = MagicMock()
        mock_result.scalars.return_value.first.return_value = None  # AC3-4 2-2: get→scalars().first()
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.patch(f"/api/v2/team-members/{uuid.uuid4()}/heartbeat")

        assert resp.status_code == 404
    finally:
        app.dependency_overrides.clear()


# ─── AC3: _flat() wrapper heartbeat task 생성 ────────────────────────────────

@pytest.mark.anyio
async def test_flat_wrapper_creates_heartbeat_task():
    """AC3: _flat() wrapper가 tool 완료 후 heartbeat task를 생성."""
    from sprintable_mcp.server import _flat
    from sprintable_mcp.schemas import SprintableInput

    async def dummy_tool(args: SprintableInput):
        return [MagicMock()]

    wrapped = _flat("dummy", "dummy doc", SprintableInput, dummy_tool)

    tasks_created = []

    def fake_create_task(coro):
        tasks_created.append(coro)
        coro.close()  # 실제 실행 없이 정리
        return MagicMock()

    with patch("sprintable_mcp.server.asyncio.create_task", side_effect=fake_create_task):
        await wrapped()

    assert len(tasks_created) == 1


# ─── AC4: heartbeat 실패 시 tool 결과 영향 없음 ──────────────────────────────

@pytest.mark.anyio
async def test_heartbeat_failure_does_not_affect_tool():
    """AC4: heartbeat 실패해도 tool 결과 정상 반환."""
    from sprintable_mcp.server import _flat
    from sprintable_mcp.schemas import SprintableInput
    from mcp.types import TextContent

    sentinel = [TextContent(type="text", text="ok")]

    async def dummy_tool(args: SprintableInput):
        return sentinel

    wrapped = _flat("dummy", "doc", SprintableInput, dummy_tool)

    async def failing_heartbeat():
        raise RuntimeError("network error")

    with patch("sprintable_mcp.server._heartbeat_fire_forget", side_effect=failing_heartbeat):
        with patch("sprintable_mcp.server.asyncio.create_task"):
            result = await wrapped()

    assert result is sentinel


# ─── AC5: ping() heartbeat task 생성 ─────────────────────────────────────────

@pytest.mark.anyio
async def test_ping_creates_heartbeat_task():
    """AC5: ping() 도구 호출 시 heartbeat task 생성."""
    import sprintable_mcp.server as srv

    tasks_created = []

    def fake_create_task(coro):
        tasks_created.append(coro)
        coro.close()
        return MagicMock()

    with patch.object(srv.asyncio, "create_task", side_effect=fake_create_task):
        await srv.ping()

    assert len(tasks_created) == 1


# ─── AC6: member_id 없으면 API 미호출 ────────────────────────────────────────

@pytest.mark.anyio
async def test_heartbeat_skips_if_no_member_id():
    """AC6: client.member_id가 빈 문자열이면 heartbeat API 미호출."""
    from sprintable_mcp.server import _heartbeat_fire_forget

    with patch("sprintable_mcp.server.client") as mock_client:
        mock_client.member_id = ""
        mock_client.patch = AsyncMock()

        await _heartbeat_fire_forget()

        mock_client.patch.assert_not_called()
