"""E-AGENT-GATEWAY Phase 0: gateway_seq 커서 + ACK + 이중전달 fix 테스트."""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.routers.agent_gateway import wake_agent, _push_to_agent_v2

AGENT_ID = uuid.uuid4()
ORG_ID = uuid.uuid4()


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ── wake_agent ────────────────────────────────────────────────────────────────

def test_wake_agent_no_connection():
    """연결 없으면 큐 없이 반환 (예외 없음)."""
    from app.routers.events import _agent_connections
    _agent_connections.pop(str(AGENT_ID), None)
    wake_agent(str(AGENT_ID), 42)  # 예외 없어야 함


def test_wake_agent_puts_wake_signal():
    """연결 중인 큐에 __wake__ 신호 전달."""
    import asyncio
    from app.routers.events import _agent_connections
    q = asyncio.Queue(maxsize=10)
    agent_id_str = str(AGENT_ID)
    _agent_connections[agent_id_str].add(q)
    try:
        with patch("app.routers.agent_gateway.asyncio.get_running_loop") as mock_loop:
            mock_loop.return_value.create_task = MagicMock()
            wake_agent(agent_id_str, 99)
        assert not q.empty()
        signal = q.get_nowait()
        assert signal["__wake__"] is True
        assert signal["seq"] == 99
    finally:
        _agent_connections.pop(agent_id_str, None)


# ── _push_to_agent_v2 backward compat ─────────────────────────────────────────

def test_push_v2_with_gateway_seq_calls_wake():
    """gateway_seq 있는 payload → wake_agent 호출."""
    with patch("app.routers.agent_gateway.wake_agent") as mock_wake:
        _push_to_agent_v2(str(AGENT_ID), {"event_type": "test", "gateway_seq": 5})
        mock_wake.assert_called_once_with(str(AGENT_ID), 5, _from_listener=False)


def test_push_v2_without_gateway_seq_falls_back():
    """gateway_seq 없는 payload → 레거시 _push_to_agent 호출."""
    with patch("app.routers.events._push_to_agent") as mock_legacy:
        mock_legacy.return_value = False
        _push_to_agent_v2(str(AGENT_ID), {"event_type": "test"})
        mock_legacy.assert_called_once()


# ── ACK 엔드포인트 ────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_ack_creates_cursor():
    """ACK POST → agent_event_cursors UPSERT."""
    from app.main import app
    from app.dependencies.auth import get_current_user
    from app.dependencies.database import get_db
    from httpx import ASGITransport, AsyncClient

    ctx = MagicMock()
    ctx.user_id = str(AGENT_ID)
    ctx.claims = {"app_metadata": {"api_key_id": "ak_test"}}

    session = AsyncMock()
    existing_result = MagicMock(); existing_result.scalar_one_or_none.return_value = None
    session.execute = AsyncMock(return_value=existing_result)
    session.add = MagicMock()
    session.commit = AsyncMock()

    async def override_db():
        yield session

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = lambda: ctx

    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await c.post("/api/v2/agent/events/ack", json={"seq": 42})
        assert resp.status_code == 200
        assert resp.json()["acked_seq"] == 42
        session.add.assert_called_once()
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_ack_updates_cursor_if_higher():
    """기존 cursor < 새 seq → acked_seq 갱신."""
    from app.main import app
    from app.dependencies.auth import get_current_user
    from app.dependencies.database import get_db
    from httpx import ASGITransport, AsyncClient
    from app.models.agent_gateway import AgentEventCursor

    ctx = MagicMock()
    ctx.user_id = str(AGENT_ID)
    ctx.claims = {"app_metadata": {"api_key_id": "ak_test"}}

    existing_cursor = MagicMock(spec=AgentEventCursor)
    existing_cursor.acked_seq = 10

    session = AsyncMock()
    result = MagicMock(); result.scalar_one_or_none.return_value = existing_cursor
    session.execute = AsyncMock(return_value=result)
    session.commit = AsyncMock()

    async def override_db():
        yield session

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = lambda: ctx

    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await c.post("/api/v2/agent/events/ack", json={"seq": 55})
        assert resp.status_code == 200
        assert existing_cursor.acked_seq == 55
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_ack_ignores_lower_seq():
    """기존 cursor > 새 seq → acked_seq 유지 (역행 방지)."""
    from app.main import app
    from app.dependencies.auth import get_current_user
    from app.dependencies.database import get_db
    from httpx import ASGITransport, AsyncClient
    from app.models.agent_gateway import AgentEventCursor

    ctx = MagicMock()
    ctx.user_id = str(AGENT_ID)
    ctx.claims = {"app_metadata": {"api_key_id": "ak_test"}}

    existing_cursor = MagicMock(spec=AgentEventCursor)
    existing_cursor.acked_seq = 100

    session = AsyncMock()
    result = MagicMock(); result.scalar_one_or_none.return_value = existing_cursor
    session.execute = AsyncMock(return_value=result)
    session.commit = AsyncMock()

    async def override_db():
        yield session

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = lambda: ctx

    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await c.post("/api/v2/agent/events/ack", json={"seq": 5})
        assert resp.status_code == 200
        assert existing_cursor.acked_seq == 100  # 역행 없음
    finally:
        app.dependency_overrides.clear()


# ── dispatch 순서 (commit 후 wake) ────────────────────────────────────────────

def test_dispatch_mock_structure_commit_after():
    """dispatch.py: commit 후 wake_agent 호출 구조 확인 (소스 검사)."""
    import inspect
    from app.routers import dispatch
    src = inspect.getsource(dispatch)
    # commit이 wake_agent/push 보다 앞에 나와야 함
    commit_pos = src.find("await db.commit()")
    wake_pos = src.find("_wake_agent(")
    assert commit_pos < wake_pos, "commit must happen before wake_agent"
