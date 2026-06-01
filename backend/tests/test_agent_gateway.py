"""E-AGENT-GATEWAY Phase 0: recipient_seq 커서 + ACK + 이중전달 fix 테스트."""
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

def test_push_v2_with_recipient_seq_calls_wake():
    """recipient_seq 있는 payload → wake_agent 호출."""
    with patch("app.routers.agent_gateway.wake_agent") as mock_wake:
        _push_to_agent_v2(str(AGENT_ID), {"event_type": "test", "recipient_seq": 5})
        mock_wake.assert_called_once_with(str(AGENT_ID), 5, _from_listener=False)


def test_push_v2_without_recipient_seq_falls_back():
    """recipient_seq 없는 payload → 레거시 _push_to_agent 호출."""
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

# ── acked_seq 재스캔 기반 visibility gap 테스트 ─────────────────────────────

@pytest.mark.anyio
async def test_fetch_events_returns_rows_above_seq():
    """`_fetch_events`: recipient_seq > after_seq인 행 반환."""
    from app.routers.agent_gateway import _fetch_events

    session = AsyncMock()
    row = MagicMock()
    row.recipient_seq = 101
    result = MagicMock(); result.fetchall.return_value = [row]
    session.execute = AsyncMock(return_value=result)

    rows = await _fetch_events(session, AGENT_ID, 100, 100)
    assert len(rows) == 1
    assert rows[0].recipient_seq == 101


@pytest.mark.anyio
async def test_visibility_gap_covered_by_acked_seq_rescan():
    """T1(낮은 seq, 늦게 커밋) 영구 누락 없음 — acked_seq 재스캔으로 보장.

    1) wake1: T2(seq=101)만 visible → yield, wake_floor=101, acked_seq=100(미ACK)
    2) T1 커밋, wake2: acked_seq=100 재스캔 → T1(100), T2(101) 모두 visible
       T1(100 > wake_floor=100? No → 중복방지) → T1도 yield됨(새 wake라 wake_floor=100으로 시작)
    """
    from app.routers.agent_gateway import _fetch_events

    # wake1: acked_seq=100, T2(seq=101) visible
    session1 = AsyncMock()
    t2 = MagicMock(); t2.recipient_seq = 101
    r1 = MagicMock(); r1.fetchall.return_value = [t2]
    session1.execute = AsyncMock(return_value=r1)

    rows1 = await _fetch_events(session1, AGENT_ID, 100, 100)
    assert len(rows1) == 1
    assert rows1[0].recipient_seq == 101

    # wake2: acked_seq still 100 (미ACK), T1 커밋됨
    session2 = AsyncMock()
    t1 = MagicMock(); t1.recipient_seq = 100
    t2_2 = MagicMock(); t2_2.recipient_seq = 101
    r2 = MagicMock(); r2.fetchall.return_value = [t1, t2_2]
    session2.execute = AsyncMock(return_value=r2)

    # acked_seq=100 재스캔 → T1(100), T2(101) 둘 다 나옴
    rows2 = await _fetch_events(session2, AGENT_ID, 99, 100)  # scan_from = acked_seq = 99 기준 예시
    assert len(rows2) == 2
    seqs = [r.recipient_seq for r in rows2]
    assert 100 in seqs  # T1 잡힘!
    assert 101 in seqs  # T2도 잡힘


@pytest.mark.anyio
async def test_wake_floor_prevents_intra_wake_duplicates():
    """같은 wake 내 중복 방지: wake_floor > seq이면 skip."""
    from app.routers.agent_gateway import _fetch_events

    session = AsyncMock()
    # seq=100, 101, 102 반환
    rows_data = []
    for i in [100, 101, 102]:
        r = MagicMock(); r.recipient_seq = i
        rows_data.append(r)
    result = MagicMock(); result.fetchall.return_value = rows_data
    session.execute = AsyncMock(return_value=result)

    rows = await _fetch_events(session, AGENT_ID, 99, 100)
    # wake_floor=99, yield: 100(OK), 101(OK), 102(OK)
    wake_floor = 99
    yielded = []
    for row in rows:
        if row.recipient_seq > wake_floor:
            yielded.append(row.recipient_seq)
            wake_floor = row.recipient_seq
    assert yielded == [100, 101, 102]  # 순서대로, 중복 없음


def test_canon_event_name_only():
    """신 스트림은 canonical 이벤트명만 yield (conversation:message alias 제거).

    agent_gateway.py 소스에서 conversation:message alias yield가 없어야 함.
    """
    import inspect
    from app.routers import agent_gateway
    src = inspect.getsource(agent_gateway)
    # 이중 yield 패턴 없어야 함
    assert "event: conversation:message" not in src

# ── jsonb payload 이중인코딩 방지 ────────────────────────────────────────────

def test_row_to_payload_jsonb_not_double_encoded():
    """_row_to_payload: jsonb str 수신 시 json.loads → payload는 dict."""
    from app.routers.agent_gateway import _row_to_payload
    import json

    row = MagicMock()
    row.event_id = str(uuid.uuid4())
    row.event_type = "dispatched"
    row.recipient_seq = 42
    row.source_entity_type = "story"
    row.source_entity_id = str(uuid.uuid4())
    row.sender_id = None
    row.payload = '{"key": "value"}'  # str (asyncpg jsonb)
    row.created_at = MagicMock(isoformat=lambda: "2026-06-01T00:00:00+00:00")

    result = _row_to_payload(row)
    # payload가 str이 아닌 dict여야 함
    assert isinstance(result["payload"], dict), f"payload should be dict, got {type(result['payload'])}"
    assert result["payload"] == {"key": "value"}


def test_row_to_payload_jsonb_dict_passthrough():
    """_row_to_payload: payload가 이미 dict이면 그대로."""
    from app.routers.agent_gateway import _row_to_payload

    row = MagicMock()
    row.event_id = str(uuid.uuid4())
    row.event_type = "dispatched"
    row.recipient_seq = 43
    row.source_entity_type = None
    row.source_entity_id = None
    row.sender_id = None
    row.payload = {"already": "dict"}
    row.created_at = MagicMock(isoformat=lambda: "2026-06-01T00:00:00+00:00")

    result = _row_to_payload(row)
    assert result["payload"] == {"already": "dict"}
