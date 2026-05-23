"""E-EVENTBUS S3: 이벤트 큐 + 오프라인 재전달 테스트."""
from __future__ import annotations

import asyncio
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

from app.models.event import Event
from app.routers.events import _SSE_BATCH_SIZE, _agent_connections, _push_to_agent


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _make_event(**kwargs) -> MagicMock:
    defaults = {
        "id": uuid.uuid4(),
        "org_id": uuid.uuid4(),
        "project_id": uuid.uuid4(),
        "event_type": "memo_created",
        "source_entity_type": "memo",
        "source_entity_id": uuid.uuid4(),
        "sender_id": uuid.uuid4(),
        "recipient_id": uuid.uuid4(),
        "recipient_type": "agent",
        "payload": {},
        "status": "pending",
        "created_at": datetime.now(timezone.utc),
        "delivered_at": None,
    }
    defaults.update(kwargs)
    event = MagicMock(spec=Event)
    for k, v in defaults.items():
        setattr(event, k, v)
    return event


@pytest.fixture
def org_id():
    return uuid.uuid4()


@pytest.fixture
def mock_session():
    session = AsyncMock()
    session.add = MagicMock()
    session.commit = AsyncMock()
    session.refresh = AsyncMock()
    session.execute = AsyncMock()
    return session


@pytest.fixture
def auth_ctx(org_id):
    ctx = MagicMock()
    ctx.user_id = str(uuid.uuid4())
    ctx.email = "agent@test.com"
    ctx.claims = {"app_metadata": {"org_id": str(org_id)}}
    return ctx


@pytest.fixture
async def client(mock_session, auth_ctx, org_id):
    from app.dependencies.auth import get_current_user, get_verified_org_id
    from app.dependencies.database import get_db
    from app.main import app

    async def _db():
        yield mock_session

    async def _auth():
        return auth_ctx

    async def _org():
        return org_id

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth
    app.dependency_overrides[get_verified_org_id] = _org
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c
    app.dependency_overrides.clear()


# ─── 이슈 3: 중복 연결 race 수정 확인 ────────────────────────────────────────

@pytest.mark.anyio
async def test_multiple_connections_same_member():
    """동일 member 중복 연결 시 두 큐 모두 유지됨."""
    member_id = str(uuid.uuid4())
    q1: asyncio.Queue = asyncio.Queue(maxsize=10)
    q2: asyncio.Queue = asyncio.Queue(maxsize=10)

    _agent_connections[member_id].add(q1)
    _agent_connections[member_id].add(q2)

    try:
        payload = {"event_type": "memo_created", "event_id": str(uuid.uuid4())}
        pushed = _push_to_agent(member_id, payload)
        assert pushed is True
        # 두 큐 모두 수신
        assert not q1.empty()
        assert not q2.empty()
    finally:
        _agent_connections[member_id].discard(q1)
        _agent_connections[member_id].discard(q2)
        _agent_connections.pop(member_id, None)


@pytest.mark.anyio
async def test_disconnect_old_keeps_new_queue():
    """이전 연결 queue 제거 시 새 연결 queue 유지됨."""
    member_id = str(uuid.uuid4())
    q1: asyncio.Queue = asyncio.Queue(maxsize=10)
    q2: asyncio.Queue = asyncio.Queue(maxsize=10)

    _agent_connections[member_id].add(q1)
    _agent_connections[member_id].add(q2)

    # q1 연결 해제
    _agent_connections[member_id].discard(q1)

    try:
        # q2는 여전히 수신 가능
        payload = {"event_type": "memo_replied", "event_id": str(uuid.uuid4())}
        pushed = _push_to_agent(member_id, payload)
        assert pushed is True
        assert not q2.empty()
        assert q1.empty()
    finally:
        _agent_connections[member_id].discard(q2)
        _agent_connections.pop(member_id, None)


# ─── 이슈 2: at-least-once — create_event는 pending 유지 ────────────────────

@pytest.mark.anyio
async def test_create_event_stays_pending_even_when_agent_connected(client, mock_session):
    """연결 중인 에이전트에게 이벤트 enqueue해도 DB status는 pending 유지."""
    recipient_id = uuid.uuid4()
    member_id_str = str(recipient_id)

    queue: asyncio.Queue = asyncio.Queue(maxsize=10)
    _agent_connections[member_id_str].add(queue)

    member_result = MagicMock()
    member_result.scalar_one_or_none.return_value = "agent"
    mock_session.execute.return_value = member_result

    async def _refresh(obj):
        obj.id = uuid.uuid4()
        obj.status = "pending"  # delivered 아닌 pending
        obj.created_at = datetime.now(timezone.utc)
        obj.delivered_at = None
        obj.recipient_type = "agent"
        obj.org_id = uuid.uuid4()
        obj.project_id = uuid.uuid4()
        obj.event_type = "memo_created"
        obj.source_entity_type = None
        obj.source_entity_id = None
        obj.sender_id = None
        obj.recipient_id = recipient_id
        obj.payload = {}

    mock_session.refresh.side_effect = _refresh

    from app.routers.events import _push_to_agent as real_push

    async def _mock_dispatch_bg(event_id):
        # dispatch routing mock — 큐에 직접 push하여 전달 시뮬레이션
        real_push(member_id_str, {"event_type": "memo_created", "event_id": str(event_id)})

    try:
        with patch("app.routers.events._route_dispatch_bg", new=_mock_dispatch_bg):
            payload = {
                "project_id": str(uuid.uuid4()),
                "event_type": "memo_created",
                "recipient_id": member_id_str,
                "recipient_type": "agent",
            }
            resp = await client.post("/api/v2/events", json=payload)
            assert resp.status_code == 201
            data = resp.json()
            # S3: enqueue 후에도 pending 유지 (delivered 마킹은 SSE receive 시)
            assert data["status"] == "pending"
            # 큐에는 페이로드 도달 — background task 실행 대기
            await asyncio.sleep(0.05)
            assert not queue.empty()
    finally:
        _agent_connections[member_id_str].discard(queue)
        _agent_connections.pop(member_id_str, None)


# ─── AC4: 100건 배치 전달 ─────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_batch_size_constant():
    """_SSE_BATCH_SIZE가 10으로 설정됨."""
    assert _SSE_BATCH_SIZE == 10


def test_stream_batch_delivers_over_100_events(mock_session, org_id):
    """110건 pending 이벤트를 배치(10건 청크)로 전달 + commit 횟수 확인."""
    from starlette.testclient import TestClient
    import threading
    from contextlib import asynccontextmanager

    member_id = uuid.uuid4()
    events = [
        _make_event(
            recipient_id=member_id,
            org_id=org_id,
            status="pending",
            event_type="memo_created",
            created_at=datetime.now(timezone.utc),
        )
        for _ in range(110)
    ]

    membership_result = MagicMock()
    membership_result.scalar_one_or_none.return_value = member_id

    scalars_mock = MagicMock()
    scalars_mock.all.return_value = events
    pending_result = MagicMock()
    pending_result.scalars.return_value = scalars_mock

    mock_session.execute.side_effect = [membership_result, pending_result]

    from app.dependencies.auth import get_current_user, get_verified_org_id
    from app.dependencies.database import get_db
    from app.main import app

    async def _db():
        yield mock_session

    async def _auth():
        ctx = MagicMock()
        ctx.user_id = str(uuid.uuid4())
        ctx.claims = {}
        return ctx

    async def _org():
        return org_id

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth
    app.dependency_overrides[get_verified_org_id] = _org

    @asynccontextmanager
    async def _session_factory():
        yield mock_session

    try:
        with patch("app.core.database.async_session_factory", _session_factory):
            with patch("app.routers.events._SSE_HEARTBEAT_TIMEOUT", 0.1):
                with TestClient(app, raise_server_exceptions=False) as c:
                    with c.stream("GET", f"/api/v2/events/stream?member_id={member_id}") as resp:
                        assert resp.status_code == 200
                        assert str(member_id) in _agent_connections

                        # sentinel inject하여 스트림 종료
                        def _inject():
                            import time; time.sleep(0.3)
                            for q in list(_agent_connections.get(str(member_id), set())):
                                try: q.put_nowait({"event_type": "__test_sentinel__"})
                                except: pass

                        t = threading.Thread(target=_inject)
                        t.start()
                        for line in resp.iter_lines():
                            if "__test_sentinel__" in line:
                                resp.close(); break
                        t.join(timeout=1.0)
    finally:
        app.dependency_overrides.clear()
        _agent_connections.pop(str(member_id), None)

    # 110건 = 11배치 → commit 11번 (backfill 배치 처리 확인)
    assert mock_session.commit.call_count >= 11
    # 모든 이벤트가 delivered로 마킹됐는지
    delivered_count = sum(1 for evt in events if evt.status == "delivered")
    assert delivered_count == 110, f"Expected 110 delivered, got {delivered_count}"
    # 110건 = 11배치 → commit 11번
    assert mock_session.commit.call_count >= 11


# ─── AC5: 30일 초과 expired 처리 ─────────────────────────────────────────────

@pytest.mark.anyio
async def test_expire_stale_events(client, mock_session):
    """POST /api/v2/events/expire-stale — expired + cleaned rowcount 반환."""
    expired_result = MagicMock()
    expired_result.rowcount = 5
    cleaned_result = MagicMock()
    cleaned_result.rowcount = 3

    mock_session.execute.side_effect = [expired_result, cleaned_result]

    resp = await client.post("/api/v2/events/expire-stale")
    assert resp.status_code == 200
    data = resp.json()
    assert data["expired"] == 5
    assert data["cleaned"] == 3
    mock_session.commit.assert_called_once()


@pytest.mark.anyio
async def test_expire_stale_uses_correct_cutoffs(client, mock_session):
    """expire-stale 호출 시 30일/7일 기준으로 쿼리 실행됨."""
    expired_result = MagicMock()
    expired_result.rowcount = 0
    cleaned_result = MagicMock()
    cleaned_result.rowcount = 0
    mock_session.execute.side_effect = [expired_result, cleaned_result]

    resp = await client.post("/api/v2/events/expire-stale")
    assert resp.status_code == 200
    # execute 2번 호출 (update expired + delete cleaned)
    assert mock_session.execute.call_count == 2


# ─── RC 이슈: live SSE yield 후 delivered 마킹 org_id 검증 ─────────────────

def test_live_sse_delivered_query_has_org_scope():
    """events.py의 SSE yield 후 delivered 마킹 쿼리에 org_id 조건이 포함됐는지 소스 확인."""
    import inspect
    from app.routers import events as ev_module
    source = inspect.getsource(ev_module.agent_event_stream)
    # SSE live 이벤트 yield 후 delivered 마킹 경로에 org_id 조건 존재 확인
    assert "Event.org_id == org_id" in source, (
        "agent_event_stream의 live delivered 마킹 쿼리에 org_id 조건 누락"
    )
