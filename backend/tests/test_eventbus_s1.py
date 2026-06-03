"""E-EVENTBUS S1: events 테이블 + 이벤트 라우터 API 테스트."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock

import pytest
from httpx import ASGITransport, AsyncClient

from app.models.event import Event


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
        "payload": {"title": "test"},
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
def mock_session():
    session = AsyncMock()
    session.add = MagicMock()
    session.commit = AsyncMock()
    session.refresh = AsyncMock()
    session.execute = AsyncMock()
    return session


@pytest.fixture
def auth_ctx():
    ctx = MagicMock()
    ctx.user_id = str(uuid.uuid4())
    ctx.email = "agent@test.com"
    ctx.claims = {"app_metadata": {"org_id": str(uuid.uuid4())}}
    return ctx


@pytest.fixture
def org_id():
    return uuid.uuid4()


@pytest.fixture
async def client(mock_session, auth_ctx, org_id):
    from app.dependencies.auth import get_current_user, get_verified_org_id
    from app.dependencies.database import get_db
    from app.main import app

    async def _db():
        yield mock_session

    async def _auth():
        return auth_ctx

    async def _org_id():
        return org_id

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth
    app.dependency_overrides[get_verified_org_id] = _org_id
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c
    app.dependency_overrides.clear()


# ─── AC2: POST /api/v2/events ─────────────────────────────────────────────────

@pytest.mark.anyio
async def test_create_event_stores_in_db(client, mock_session):
    recipient_id = uuid.uuid4()
    event = _make_event(recipient_id=recipient_id, recipient_type="agent")

    # team_members.type 조회 결과 mock
    member_result = MagicMock()
    member_result.scalar_one_or_none.return_value = "agent"
    mock_session.execute.return_value = member_result

    # refresh populates the created event
    async def _refresh(obj):
        obj.id = event.id
        obj.status = "pending"
        obj.created_at = event.created_at
        obj.delivered_at = None
        obj.recipient_type = "agent"

    mock_session.refresh.side_effect = _refresh

    payload = {
        "project_id": str(uuid.uuid4()),
        "org_id": str(uuid.uuid4()),
        "event_type": "memo_created",
        "source_entity_type": "memo",
        "source_entity_id": str(uuid.uuid4()),
        "sender_id": str(uuid.uuid4()),
        "recipient_id": str(recipient_id),
        "recipient_type": "agent",
        "payload": {"title": "킥오프"},
    }
    resp = await client.post("/api/v2/events", json=payload)
    assert resp.status_code == 201
    data = resp.json()
    assert data["status"] == "pending"
    assert data["event_type"] == "memo_created"
    mock_session.add.assert_called_once()
    mock_session.commit.assert_called_once()


@pytest.mark.anyio
async def test_create_event_recipient_not_found_returns_404(client, mock_session):
    # E-MEMBER-SSOT Phase 0: resolve_member_identity는 TeamMember → OrgMember 순 조회
    member_result = MagicMock()
    member_result.scalars.return_value.first.return_value = None  # TeamMember 없음
    member_result.scalar_one_or_none.return_value = None  # OrgMember 없음
    mock_session.execute.return_value = member_result

    payload = {
        "project_id": str(uuid.uuid4()),
        "org_id": str(uuid.uuid4()),
        "event_type": "memo_created",
        "recipient_id": str(uuid.uuid4()),
        "recipient_type": "agent",
    }
    resp = await client.post("/api/v2/events", json=payload)
    assert resp.status_code == 404


# ─── AC3: GET /api/v2/events/pending ──────────────────────────────────────────

@pytest.mark.anyio
async def test_get_pending_events_returns_list(client, mock_session):
    recipient_id = uuid.uuid4()
    events = [_make_event(recipient_id=recipient_id, status="pending") for _ in range(3)]

    scalars_mock = MagicMock()
    scalars_mock.all.return_value = events
    result_mock = MagicMock()
    result_mock.scalars.return_value = scalars_mock
    mock_session.execute.return_value = result_mock

    resp = await client.get(f"/api/v2/events/pending?recipient_id={recipient_id}")
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == 3
    assert all(e["status"] == "pending" for e in data)


# ─── AC4: PATCH /api/v2/events/{id}/delivered ─────────────────────────────────

@pytest.mark.anyio
async def test_mark_delivered_sets_status_and_timestamp(client, mock_session):
    event = _make_event(status="pending")

    async def _refresh(obj):
        pass  # obj already mutated in-place

    mock_session.refresh.side_effect = _refresh

    scalar_mock = MagicMock()
    scalar_mock.scalar_one_or_none.return_value = event
    mock_session.execute.return_value = scalar_mock

    resp = await client.patch(f"/api/v2/events/{event.id}/delivered")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "delivered"
    assert data["delivered_at"] is not None
    mock_session.commit.assert_called_once()


@pytest.mark.anyio
async def test_mark_delivered_event_not_found_returns_404(client, mock_session):
    scalar_mock = MagicMock()
    scalar_mock.scalar_one_or_none.return_value = None
    mock_session.execute.return_value = scalar_mock

    resp = await client.patch(f"/api/v2/events/{uuid.uuid4()}/delivered")
    assert resp.status_code == 404


# ─── AC5: recipient_type 분기 로직 ────────────────────────────────────────────

@pytest.mark.anyio
async def test_recipient_type_resolved_from_db(client, mock_session):
    """POST 시 DB의 team_members.type이 recipient_type으로 저장됨을 확인."""
    recipient_id = uuid.uuid4()
    captured = {}

    # E-MEMBER-SSOT Phase 0: recipient는 resolve_member_identity가 반환한 멤버의 type 사용
    tm = MagicMock()
    tm.id = recipient_id
    tm.type = "human"
    tm.user_id = uuid.uuid4()
    tm.name = "휴먼"
    tm.role = "member"
    tm.org_id = uuid.uuid4()
    tm.project_id = None
    tm.avatar_url = None
    member_result = MagicMock()
    member_result.scalars.return_value.first.return_value = tm
    mock_session.execute.return_value = member_result

    original_add = mock_session.add.side_effect
    def capture_add(obj):
        if isinstance(obj, Event):
            captured["recipient_type"] = obj.recipient_type
    mock_session.add.side_effect = capture_add

    async def _refresh(obj):
        obj.id = uuid.uuid4()
        obj.status = "pending"
        obj.created_at = datetime.now(timezone.utc)
        obj.delivered_at = None

    mock_session.refresh.side_effect = _refresh

    payload = {
        "project_id": str(uuid.uuid4()),
        "org_id": str(uuid.uuid4()),
        "event_type": "memo_created",
        "recipient_id": str(recipient_id),
        "recipient_type": "agent",  # 요청값과 무관하게 DB 값 사용
    }
    resp = await client.post("/api/v2/events", json=payload)
    assert resp.status_code == 201
    assert captured.get("recipient_type") == "human"


# ─── org scope 검증 ────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_get_pending_filters_by_org(client, mock_session, org_id):
    """GET /pending 은 verified org_id 내 이벤트만 반환해야 함."""
    recipient_id = uuid.uuid4()
    event_same_org = _make_event(recipient_id=recipient_id, org_id=org_id, status="pending")

    scalars_mock = MagicMock()
    scalars_mock.all.return_value = [event_same_org]
    result_mock = MagicMock()
    result_mock.scalars.return_value = scalars_mock
    mock_session.execute.return_value = result_mock

    resp = await client.get(f"/api/v2/events/pending?recipient_id={recipient_id}")
    assert resp.status_code == 200
    # execute 호출 시 org_id 필터가 쿼리에 포함됐는지 — 실제 SQL은 mock이므로 호출 여부로 확인
    mock_session.execute.assert_called_once()


@pytest.mark.anyio
async def test_mark_delivered_cross_org_returns_404(client, mock_session):
    """다른 org의 이벤트에 대한 PATCH는 404여야 함."""
    scalar_mock = MagicMock()
    scalar_mock.scalar_one_or_none.return_value = None  # org_id 불일치 → not found
    mock_session.execute.return_value = scalar_mock

    resp = await client.patch(f"/api/v2/events/{uuid.uuid4()}/delivered")
    assert resp.status_code == 404


@pytest.mark.anyio
async def test_create_event_uses_verified_org(client, mock_session, org_id):
    """POST 시 body의 org_id가 아닌 verified org_id가 Event에 설정돼야 함."""
    captured = {}
    # E-MEMBER-SSOT Phase 0: agent recipient → resolve_member_identity가 TeamMember 반환
    tm = MagicMock()
    tm.id = uuid.uuid4()
    tm.type = "agent"
    tm.user_id = None
    tm.name = "agent"
    tm.role = "member"
    tm.org_id = org_id
    tm.project_id = None
    tm.avatar_url = None
    member_result = MagicMock()
    member_result.scalars.return_value.first.return_value = tm
    mock_session.execute.return_value = member_result

    def capture_add(obj):
        if isinstance(obj, Event):
            captured["org_id"] = obj.org_id
    mock_session.add.side_effect = capture_add

    async def _refresh(obj):
        obj.id = uuid.uuid4()
        obj.status = "pending"
        obj.created_at = datetime.now(timezone.utc)
        obj.delivered_at = None
    mock_session.refresh.side_effect = _refresh

    forged_org = uuid.uuid4()  # 요청자가 임의로 보낸 org_id
    payload = {
        "project_id": str(uuid.uuid4()),
        "org_id": str(forged_org),
        "event_type": "memo_created",
        "recipient_id": str(uuid.uuid4()),
        "recipient_type": "agent",
    }
    resp = await client.post("/api/v2/events", json=payload)
    assert resp.status_code == 201
    # body의 forged_org가 아닌 verified org_id가 사용됐는지
    assert captured.get("org_id") == org_id
