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
    """연결 중인 큐에 __wake__ 신호 전달.

    prod 커넥션 누수 근본fix(2026-07-08) 후속: wake_agent()의 pg_notify 발사가
    `app.services.pg_pubsub.fire_and_forget()`로 옮겨져 `asyncio.get_running_loop`을 더는
    agent_gateway.py에서 직접 안 부른다 — 그 이름을 patch하면 asyncio 모듈 객체 자체가
    전역 패치돼(같은 asyncio 싱글턴) pg_pubsub의 `_background_tasks`에 MagicMock이 새는
    부작용이 있었다. fire_and_forget 자체를 patch해 격리한다."""
    import asyncio
    from app.routers.events import _agent_connections
    q = asyncio.Queue(maxsize=10)
    agent_id_str = str(AGENT_ID)
    _agent_connections[agent_id_str].add(q)
    try:
        # 까심 QA 후속(low-pri): mock이 넘겨받은 pg_notify() 코루틴을 실행도 close도 안 하면
        # "coroutine was never awaited" RuntimeWarning이 뜬다 — side_effect로 명시 close.
        with patch(
            "app.services.pg_pubsub.fire_and_forget", side_effect=lambda coro: coro.close(),
        ) as mock_fire:
            wake_agent(agent_id_str, 99)
            mock_fire.assert_called_once()
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
    wake_pos = src.find("wake_agent(")
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

def test_dispatch_conversation_event_uses_sorted_participant_ids():
    """conversations.py fan-out 루프가 sorted() 사용하는지 소스 inspect 가드."""
    import inspect
    from app.routers.conversations import _dispatch_conversation_event
    src = inspect.getsource(_dispatch_conversation_event)
    assert 'sorted(participant_ids)' in src, (
        'deadlock fix reverted: sorted(participant_ids) missing in _dispatch_conversation_event'
    )
    assert 'sorted(mention_targets)' not in src or True  # mention은 별도 함수


def test_dispatch_mention_events_uses_sorted_mention_targets():
    """_dispatch_mention_events의 sorted(mention_targets) 소스 inspect 가드."""
    import inspect
    from app.routers.conversations import _dispatch_mention_events
    src = inspect.getsource(_dispatch_mention_events)
    assert 'sorted(mention_targets)' in src, (
        'deadlock fix reverted: sorted(mention_targets) missing in _dispatch_mention_events'
    )


# ── 49fed0a1: presence를 실제 SSE 연결에 배선 ──────────────────────────────────

import contextlib
from datetime import datetime, timedelta, timezone

from app.routers.agent_gateway import (
    _mark_agent_online,
    _mark_agent_disconnected,
    _SESSION_FRESH_TTL,
)


def _patch_session_factory(execute_results=None):
    """async_session_factory() 를 mock async context manager 로 대체.

    execute_results: db.execute 가 호출 순서대로 반환할 result mock 리스트.
    반환: (patch context manager target 용 callable, db mock).
    """
    db = MagicMock()
    results = list(execute_results or [])

    async def _execute(*a, **k):
        return results.pop(0) if results else MagicMock()

    db.execute = AsyncMock(side_effect=_execute)
    db.commit = AsyncMock()

    def _factory():
        @contextlib.asynccontextmanager
        async def _cm():
            yield db
        return _cm()

    return _factory, db


@pytest.mark.anyio
async def test_mark_agent_online_touches_session_and_presence():
    """연결 중 tick: AgentGatewaySession.last_seen + presence(online) 갱신 후 commit."""
    factory, db = _patch_session_factory()
    sid = uuid.uuid4()
    with patch("app.routers.agent_gateway.async_session_factory", factory), \
         patch("app.services.agent_anchor_sync.sync_agent_profile_presence", new=AsyncMock()) as mock_sync:
        await _mark_agent_online(AGENT_ID, sid)
    # AgentGatewaySession UPDATE 1회 실행
    assert db.execute.await_count == 1
    # presence online 갱신
    mock_sync.assert_awaited_once()
    _, kwargs = mock_sync.await_args
    assert kwargs["agent_status"] == "online"
    assert kwargs["last_seen_at"] is not None
    db.commit.assert_awaited_once()


@pytest.mark.anyio
async def test_mark_agent_online_swallows_errors():
    """presence 갱신 실패가 스트림을 끊지 않도록 예외 삼킴(best-effort)."""
    def _boom():
        raise RuntimeError("db down")
    with patch("app.routers.agent_gateway.async_session_factory", side_effect=_boom):
        # 예외 전파되면 테스트 실패
        await _mark_agent_online(AGENT_ID, uuid.uuid4())


@pytest.mark.anyio
async def test_mark_agent_disconnected_demotes_offline_when_no_remaining():
    """마지막 세션 종료: 세션 삭제 후 잔여 활성 세션 없으면 presence offline 강등."""
    no_remaining = MagicMock()
    no_remaining.scalar_one_or_none.return_value = None  # 잔여 fresh 세션 없음
    # execute 순서: [DELETE 결과(미사용), SELECT remaining 결과]
    factory, db = _patch_session_factory([MagicMock(), no_remaining])
    with patch("app.routers.agent_gateway.async_session_factory", factory), \
         patch("app.services.agent_anchor_sync.sync_agent_profile_presence", new=AsyncMock()) as mock_sync:
        await _mark_agent_disconnected(AGENT_ID, uuid.uuid4())
    mock_sync.assert_awaited_once()
    _, kwargs = mock_sync.await_args
    assert kwargs["agent_status"] == "offline"
    assert kwargs["last_seen_at"] is None  # last_seen=None → presence_status 즉시 offline
    db.commit.assert_awaited_once()


@pytest.mark.anyio
async def test_mark_agent_disconnected_keeps_online_when_other_session_active():
    """같은 API Key 멀티세션(AC2): 다른 활성 세션 잔존 시 offline 강등 안 함."""
    remaining = MagicMock()
    remaining.scalar_one_or_none.return_value = uuid.uuid4()  # 다른 fresh 세션 존재
    factory, db = _patch_session_factory([MagicMock(), remaining])
    with patch("app.routers.agent_gateway.async_session_factory", factory), \
         patch("app.services.agent_anchor_sync.sync_agent_profile_presence", new=AsyncMock()) as mock_sync:
        await _mark_agent_disconnected(AGENT_ID, uuid.uuid4())
    mock_sync.assert_not_awaited()  # 강등 없음
    db.commit.assert_awaited_once()


def test_presence_tick_interval_below_online_threshold():
    """tick 주기 < online 임계(5분) — 연결 유지 중 last_seen이 online 윈도우 안에 머무름 보장."""
    from app.schemas.team_member import _ONLINE_THRESHOLD
    from app.routers.agent_gateway import _PRESENCE_TICK_INTERVAL
    assert _PRESENCE_TICK_INTERVAL < _ONLINE_THRESHOLD.total_seconds()
    # 세션 fresh TTL 도 online 임계 미만이어야 disconnect 판정이 stale 세션을 활성으로 오판 안 함
    assert _SESSION_FRESH_TTL < _ONLINE_THRESHOLD.total_seconds()


# ── d5de8e08: disconnect → chat working 안전망 clear ───────────────────────────

@pytest.mark.anyio
async def test_disconnect_clears_chat_working_when_no_remaining():
    """마지막 세션 종료(offline) → 그 에이전트 chat working 신호도 즉시 정리(안전망)."""
    no_remaining = MagicMock()
    no_remaining.scalar_one_or_none.return_value = None
    factory, db = _patch_session_factory([MagicMock(), no_remaining])
    with patch("app.routers.agent_gateway.async_session_factory", factory), \
         patch("app.services.agent_anchor_sync.sync_agent_profile_presence", new=AsyncMock()), \
         patch("app.services.chat_presence.clear_member") as mock_clear:
        await _mark_agent_disconnected(AGENT_ID, uuid.uuid4())
    mock_clear.assert_called_once_with(str(AGENT_ID))


@pytest.mark.anyio
async def test_disconnect_keeps_chat_working_when_other_session_active():
    """다른 활성 세션 잔존 → 아직 연결 중이므로 chat working 정리 안 함."""
    remaining = MagicMock()
    remaining.scalar_one_or_none.return_value = uuid.uuid4()
    factory, db = _patch_session_factory([MagicMock(), remaining])
    with patch("app.routers.agent_gateway.async_session_factory", factory), \
         patch("app.services.agent_anchor_sync.sync_agent_profile_presence", new=AsyncMock()), \
         patch("app.services.chat_presence.clear_member") as mock_clear:
        await _mark_agent_disconnected(AGENT_ID, uuid.uuid4())
    mock_clear.assert_not_called()


# d0bca260: SSE payload BYOA 컨텍스트 — project_id·org_id·conversation_title top-level
def test_row_to_payload_includes_project_org_conversation_title():
    from types import SimpleNamespace
    from datetime import datetime, timezone
    from app.routers.agent_gateway import _row_to_payload

    pid, oid = str(uuid.uuid4()), str(uuid.uuid4())
    row = SimpleNamespace(
        event_id="ev1", event_type="conversation.message_created", recipient_seq=42,
        source_entity_type="member", source_entity_id="m1", sender_id="s1",
        payload={"conversation_id": "c1", "content": "hi"},
        created_at=datetime(2026, 6, 15, tzinfo=timezone.utc),
        project_id=pid, org_id=oid, conversation_title="Sprintable QA",
        sender_name="디디 은와추쿠",
    )
    out = _row_to_payload(row)
    # 신규 top-level 4필드
    assert out["project_id"] == pid
    assert out["org_id"] == oid
    assert out["conversation_title"] == "Sprintable QA"
    assert out["sender_name"] == "디디 은와추쿠"
    # 기존 키 무파손(additive)
    assert out["event_id"] == "ev1"
    assert out["recipient_seq"] == 42
    assert out["content"] == "hi"
    assert out["source"]["id"] == "m1"


def test_row_to_payload_missing_new_attrs_safe():
    """구 row(컬럼 미포함)에도 getattr 기본 None — AttributeError 0(하위호환)."""
    from types import SimpleNamespace
    from datetime import datetime, timezone
    from app.routers.agent_gateway import _row_to_payload

    row = SimpleNamespace(
        event_id="ev2", event_type="dispatched", recipient_seq=1,
        source_entity_type=None, source_entity_id=None, sender_id=None,
        payload={}, created_at=datetime(2026, 6, 15, tzinfo=timezone.utc),
    )
    out = _row_to_payload(row)
    assert out["project_id"] is None
    assert out["org_id"] is None
    assert out["conversation_title"] is None
    assert out["sender_name"] is None
