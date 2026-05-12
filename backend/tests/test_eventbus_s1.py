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
async def client(mock_session, auth_ctx):
    from app.dependencies.auth import get_current_user
    from app.dependencies.database import get_db
    from app.main import app

    async def _db():
        yield mock_session

    async def _auth():
        return auth_ctx

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth
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
    member_result = MagicMock()
    member_result.scalar_one_or_none.return_value = None
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

    member_result = MagicMock()
    member_result.scalar_one_or_none.return_value = "human"
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
