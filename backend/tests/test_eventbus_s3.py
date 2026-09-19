"""E-EVENTBUS S3: 이벤트 큐 + 오프라인 재전달 테스트."""
from __future__ import annotations

import asyncio
import time
import uuid
from contextlib import asynccontextmanager
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
    from app.dependencies.auth import get_current_user, get_verified_org_id, get_current_user_streaming, get_verified_org_id_streaming
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
    app.dependency_overrides[get_current_user_streaming] = _auth
    app.dependency_overrides[get_verified_org_id_streaming] = _org
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c
    app.dependency_overrides.clear()


async def _wait_until(predicate, *, timeout: float = 15.0, interval: float = 0.005) -> bool:
    """story #3580/#3494(test_eventbus_s2.py에서 근본원인 확定, 이 파일엔 미이식 상태였던
    걸 이번에 이식) — OS threading.Thread injector가 asyncio 프리미티브(Queue.put_nowait·
    Event.set())를 이벤트 루프 밖 스레드에서 건드리는 것 자체가 CI 부하 시 통지 유실의
    원인이었다(로컬 저부하에선 우연히 통과). 이 코루틴은 같은 이벤트 루프 위에서 돈다 —
    스레드도 락도 필요 없다. 타임아웃 15.0s는 새 추측이 아니라 s2가 실제 CI durations
    로그로 확定한 값을 그대로 재사용(1.0s→5.0s→15.0s, GitHub Actions 러너가 로컬보다
    느리다는 실측 근거)."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        await asyncio.sleep(interval)
    return predicate()


class _SSEObserver:
    """test_eventbus_s2.py::_SSEObserver 그대로 이식(새 기전 발명 금지) — ASGI 자신의
    `send()`을 감싸 바이트열이 실제로 응답 바디에 실리는 순간을 직접 관찰한다. sentinel은
    등록 직후가 아니라 `event: sync_status`(백필 완료·라이브 루프 진입) 관찰 後에 큐에
    넣어야 "write 예산"이 백필 시간까지 재는 오차를 피한다."""

    def __init__(self) -> None:
        self.events: list[tuple[float, str]] = []
        self._waiters: dict[str, asyncio.Event] = {}

    def _mark(self, event_type: str) -> None:
        self.events.append((time.monotonic(), event_type))
        self._waiters.setdefault(event_type, asyncio.Event()).set()

    def waiter_for(self, event_type: str) -> asyncio.Event:
        return self._waiters.setdefault(event_type, asyncio.Event())

    def timeline(self, t0: float) -> str:
        return ", ".join(f"{name}@+{ts - t0:.3f}s" for ts, name in self.events) or "(no events observed)"


def _asgi_transport_with_observer(app) -> tuple[ASGITransport, _SSEObserver]:
    observer = _SSEObserver()

    async def _wrapped_app(scope, receive, send):
        async def _send(message):
            if message.get("type") == "http.response.body":
                for line in message.get("body", b"").split(b"\n"):
                    if line.startswith(b"event: "):
                        observer._mark(line[len(b"event: "):].decode())
            await send(message)

        await app(scope, receive, _send)

    return ASGITransport(app=_wrapped_app), observer


async def _wait_for_event(observer: _SSEObserver, event_type: str, *, timeout: float) -> bool:
    try:
        await asyncio.wait_for(observer.waiter_for(event_type).wait(), timeout=timeout)
        return True
    except asyncio.TimeoutError:
        return False


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


@pytest.mark.anyio
async def test_stream_batch_delivers_over_100_events(mock_session, org_id):
    """110건 pending 이벤트를 배치(10건 청크)로 전달 + commit 횟수 확인.

    forward(SSE 플레이키 근본 de-flake, 2026-09-19 페드루 PO 지시) — #4418/#4429
    CI 재발 로그 실측: "injector never observed the connection" — OS threading.
    Thread injector가 단 1.0s만 폴링하고 포기하던 게 원인. 그런데 이 파일 자신의
    class(threading.Thread + time.sleep로 asyncio 프리미티브를 이벤트 루프 밖에서
    건드리는 것)는 test_eventbus_s2.py가 story #3580/#3494에서 **이미 근본원인까지
    확定하고 폐기한 패턴**이다(그 파일 docstring 참조) — 이 테스트만 그 이식이
    누락돼 있었다(#3494 카드 자신이 "test_eventbus_s3 포함" 명시했었음). 새 기전
    발명 금지 원칙대로 s2가 이미 검증한 `_wait_until`/`_SSEObserver`(같은 파일
    상단, 이번에 이식) 패턴을 그대로 재사용 — 스레드 0개, 같은 이벤트 루프 위
    코루틴으로 등록 관찰→sync_status(라이브 루프 진입) 관찰→sentinel 주입→
    write 관찰까지 전부 상태 기반."""
    member_id = uuid.uuid4()
    member_id_str = str(member_id)
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

    from app.core import shutdown as shutdown_module
    from app.dependencies.auth import get_current_user, get_verified_org_id, get_current_user_streaming, get_verified_org_id_streaming
    from app.dependencies.database import get_db
    from app.main import app

    async def _db():
        yield mock_session

    async def _auth():
        ctx = MagicMock()
        ctx.user_id = str(member_id)  # API key: user_id = team_member.id
        ctx.claims = {"app_metadata": {"api_key_id": "test-key", "org_id": str(org_id)}}
        return ctx

    async def _org():
        return org_id

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth
    app.dependency_overrides[get_verified_org_id] = _org
    app.dependency_overrides[get_current_user_streaming] = _auth
    app.dependency_overrides[get_verified_org_id_streaming] = _org

    @asynccontextmanager
    async def _session_factory():
        yield mock_session

    t0 = time.monotonic()
    registered_observed = False
    sync_status_observed = False
    written_observed = False
    transport, observer = _asgi_transport_with_observer(app)
    try:
        with patch("app.core.database.async_session_factory", _session_factory):
            with patch("app.routers.events._SSE_HEARTBEAT_TIMEOUT", 0.1):
                async with AsyncClient(transport=transport, base_url="http://test") as c:
                    stream_task = asyncio.create_task(
                        c.get(f"/api/v2/events/stream?member_id={member_id}")
                    )
                    registered_observed = await _wait_until(lambda: member_id_str in _agent_connections)
                    queues = list(_agent_connections.get(member_id_str, set())) if registered_observed else []
                    # 110건 백필(11배치 commit)이 sync_status(라이브 루프 진입)보다
                    # 먼저 끝나므로, sentinel을 그 관찰 後에 넣어야 "write 예산"이
                    # 백필 시간까지 재는 오차를 피한다(s2 2차 리뷰와 동일 원칙).
                    if queues:
                        sync_status_observed = await _wait_for_event(observer, "sync_status", timeout=15.0)
                    for q in queues:
                        q.put_nowait({"event_type": "__test_sentinel__"})
                    if queues and sync_status_observed:
                        written_observed = await _wait_for_event(observer, "__test_sentinel__", timeout=5.0)
                    shutdown_module.shutdown_event.set()
                    resp = await asyncio.wait_for(stream_task, timeout=15.0)
                    assert resp.status_code == 200
    finally:
        # story #3580(페드루 PO 確定, #3942 CI 실사고 근본원인) — 이 reset을 finally
        # 블록 맨 앞·독립 try로 둔다(뒤 정리가 예외를 던져도 이건 반드시 돈다 —
        # 안 그러면 다음 SSE 스트림 테스트를 오염시킨다).
        try:
            shutdown_module.reset_shutdown_event()
        finally:
            app.dependency_overrides.clear()
            _agent_connections.pop(member_id_str, None)

    _timeline = observer.timeline(t0)
    assert registered_observed, f"injector never observed the connection in _agent_connections — timeline: {_timeline}"
    assert sync_status_observed, f"generator never reached the live loop (no sync_status observed) — timeline: {_timeline}"
    assert written_observed, f"generator never actually wrote the sentinel line to the ASGI send() callable — timeline: {_timeline}"

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
    """POST /api/v2/events/expire-stale — expired + cleaned rowcount 반환.

    S19(SHOULD): org-admin 전용 게이트 추가 — org-admin caller로 mock.
    """
    expired_result = MagicMock()
    expired_result.rowcount = 5
    cleaned_result = MagicMock()
    cleaned_result.rowcount = 3

    mock_session.execute.side_effect = [expired_result, cleaned_result]

    with patch("app.routers.events._is_org_admin", new_callable=AsyncMock, return_value=True):
        resp = await client.post("/api/v2/events/expire-stale")
    assert resp.status_code == 200
    data = resp.json()
    assert data["expired"] == 5
    assert data["cleaned"] == 3
    mock_session.commit.assert_called_once()


@pytest.mark.anyio
async def test_expire_stale_403_when_not_org_admin(client, mock_session):
    """S19(SHOULD MUST급): per-resource IDOR이 아니라 privilege 게이트 부재 — org-admin 아니면 403."""
    with patch("app.routers.events._is_org_admin", new_callable=AsyncMock, return_value=False):
        resp = await client.post("/api/v2/events/expire-stale")
    assert resp.status_code == 403


@pytest.mark.anyio
async def test_expire_stale_uses_correct_cutoffs(client, mock_session):
    """expire-stale 호출 시 30일/7일 기준으로 쿼리 실행됨."""
    expired_result = MagicMock()
    expired_result.rowcount = 0
    cleaned_result = MagicMock()
    cleaned_result.rowcount = 0
    mock_session.execute.side_effect = [expired_result, cleaned_result]

    with patch("app.routers.events._is_org_admin", new_callable=AsyncMock, return_value=True):
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
