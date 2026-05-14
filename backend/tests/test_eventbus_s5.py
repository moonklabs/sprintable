"""E-EVENTBUS S5: Notifications API — 알림 읽음 추적 테스트."""
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


@pytest.fixture
def org_id():
    return uuid.uuid4()


@pytest.fixture
def member_id():
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
def auth_ctx(org_id, member_id):
    ctx = MagicMock()
    ctx.user_id = str(member_id)
    ctx.email = "user@test.com"
    ctx.claims = {"app_metadata": {"org_id": str(org_id)}}
    return ctx


@pytest.fixture
async def client(mock_session, auth_ctx, org_id, member_id):
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
        "recipient_type": "human",
        "payload": {},
        "status": "delivered",
        "created_at": datetime.now(timezone.utc),
        "delivered_at": datetime.now(timezone.utc),
        "read_at": None,
    }
    defaults.update(kwargs)
    event = MagicMock(spec=Event)
    for k, v in defaults.items():
        setattr(event, k, v)
    return event


# ─── AC2: GET /api/v2/event-notifications ──────────────────────────────────────────

@pytest.mark.anyio
async def test_list_notifications_returns_current_user_events(client, mock_session, org_id, member_id):
    """GET /notifications → 현재 사용자 알림 목록 반환."""
    events = [_make_event(recipient_id=member_id, org_id=org_id) for _ in range(3)]

    # 1st execute: member_id 조회
    member_result = MagicMock()
    member_result.scalar_one_or_none.return_value = member_id
    # 2nd execute: 알림 목록
    scalars_mock = MagicMock()
    scalars_mock.all.return_value = events
    events_result = MagicMock()
    events_result.scalars.return_value = scalars_mock
    mock_session.execute.side_effect = [member_result, events_result]

    resp = await client.get("/api/v2/event-notifications")
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == 3


# ─── AC3: GET /api/v2/event-notifications/unread-count ─────────────────────────────

@pytest.mark.anyio
async def test_unread_count_returns_null_read_at_count(client, mock_session, member_id):
    """GET /notifications/unread-count → read_at IS NULL 카운트."""
    member_result = MagicMock()
    member_result.scalar_one_or_none.return_value = member_id
    count_result = MagicMock()
    count_result.scalar_one.return_value = 7
    mock_session.execute.side_effect = [member_result, count_result]

    resp = await client.get("/api/v2/event-notifications/unread-count")
    assert resp.status_code == 200
    assert resp.json()["count"] == 7


# ─── AC4: PATCH /api/v2/event-notifications/{id}/read ──────────────────────────────

@pytest.mark.anyio
async def test_mark_read_sets_read_at(client, mock_session, member_id):
    """PATCH /notifications/{id}/read → read_at 기록."""
    event_id = uuid.uuid4()
    event = _make_event(id=event_id, recipient_id=member_id, read_at=None)

    event_result = MagicMock()
    event_result.scalar_one_or_none.return_value = event
    member_result = MagicMock()
    member_result.scalar_one_or_none.return_value = member_id

    async def _refresh(obj):
        pass  # event already mutated

    mock_session.execute.side_effect = [event_result, member_result]
    mock_session.refresh.side_effect = _refresh

    resp = await client.patch(f"/api/v2/event-notifications/{event_id}/read")
    assert resp.status_code == 200
    assert event.read_at is not None
    mock_session.commit.assert_called_once()


@pytest.mark.anyio
async def test_mark_read_already_read_skips_commit(client, mock_session, member_id):
    """이미 read_at 있는 알림에 PATCH → commit 없이 200 반환."""
    event_id = uuid.uuid4()
    now = datetime.now(timezone.utc)
    event = _make_event(id=event_id, recipient_id=member_id, read_at=now)

    event_result = MagicMock()
    event_result.scalar_one_or_none.return_value = event
    member_result = MagicMock()
    member_result.scalar_one_or_none.return_value = member_id

    async def _refresh(obj):
        pass

    mock_session.execute.side_effect = [event_result, member_result]
    mock_session.refresh.side_effect = _refresh

    resp = await client.patch(f"/api/v2/event-notifications/{event_id}/read")
    assert resp.status_code == 200
    mock_session.commit.assert_not_called()


# ─── AC6: 타인 알림 접근 차단 ────────────────────────────────────────────────

@pytest.mark.anyio
async def test_mark_read_other_user_returns_403(client, mock_session, member_id):
    """다른 사용자의 알림에 PATCH → 403."""
    event_id = uuid.uuid4()
    other_member = uuid.uuid4()
    event = _make_event(id=event_id, recipient_id=other_member)  # 다른 사람 알림

    event_result = MagicMock()
    event_result.scalar_one_or_none.return_value = event
    member_result = MagicMock()
    member_result.scalar_one_or_none.return_value = member_id
    mock_session.execute.side_effect = [event_result, member_result]

    resp = await client.patch(f"/api/v2/event-notifications/{event_id}/read")
    assert resp.status_code == 403


@pytest.mark.anyio
async def test_mark_read_not_found_returns_404(client, mock_session, member_id):
    """존재하지 않는 알림 PATCH → 404."""
    event_result = MagicMock()
    event_result.scalar_one_or_none.return_value = None  # 이벤트 없음 → 즉시 404
    mock_session.execute.side_effect = [event_result]

    resp = await client.patch(f"/api/v2/event-notifications/{uuid.uuid4()}/read")
    assert resp.status_code == 404


# ─── AC5: PATCH /api/v2/event-notifications/read-all ───────────────────────────────

@pytest.mark.anyio
async def test_mark_all_read_updates_all_unread(client, mock_session, member_id):
    """PATCH /notifications/read-all → 전체 읽음 처리."""
    member_result = MagicMock()
    member_result.scalar_one_or_none.return_value = member_id
    update_result = MagicMock()
    update_result.rowcount = 5
    mock_session.execute.side_effect = [member_result, update_result]

    resp = await client.patch("/api/v2/event-notifications/read-all")
    assert resp.status_code == 200
    assert resp.json()["updated"] == 5
    mock_session.commit.assert_called_once()


# ─── AC1: migration 파일 존재 확인 ────────────────────────────────────────────

def test_migration_0025_exists():
    """Alembic migration 0025 파일 존재 확인."""
    import os
    migration_path = os.path.join(
        os.path.dirname(__file__),
        "..",
        "alembic",
        "versions",
        "0025_add_read_at_to_events.py",
    )
    assert os.path.exists(migration_path)


def test_event_model_has_read_at():
    """Event 모델에 read_at 필드 존재 확인."""
    from app.models.event import Event
    assert hasattr(Event, "read_at")
