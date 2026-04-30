"""S27 AC: Notifications + Inbox router 단위 테스트 (8건 이상)."""
import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

ORG_ID = uuid.uuid4()
PROJECT_ID = uuid.uuid4()
MEMBER_ID = uuid.uuid4()
NOTIF_ID = uuid.uuid4()
INBOX_ID = uuid.uuid4()


def _mock_notification(is_read: bool = False) -> MagicMock:
    n = MagicMock()
    n.id = NOTIF_ID
    n.org_id = ORG_ID
    n.user_id = MEMBER_ID
    n.type = "info"
    n.title = "Test Notification"
    n.body = "본문"
    n.is_read = is_read
    n.reference_type = None
    n.reference_id = None
    n.created_at = datetime(2026, 4, 30, tzinfo=timezone.utc)
    return n


def _mock_setting() -> MagicMock:
    s = MagicMock()
    s.id = uuid.uuid4()
    s.org_id = ORG_ID
    s.member_id = MEMBER_ID
    s.channel = "in_app"
    s.event_type = "story_assigned"
    s.enabled = True
    return s


def _mock_inbox(state: str = "pending") -> MagicMock:
    i = MagicMock()
    i.id = INBOX_ID
    i.org_id = ORG_ID
    i.project_id = PROJECT_ID
    i.assignee_member_id = MEMBER_ID
    i.from_agent_id = None
    i.story_id = None
    i.memo_id = None
    i.resolved_by = None
    i.kind = "approval"
    i.title = "승인 요청"
    i.context = None
    i.agent_summary = None
    i.origin_chain = []
    i.options = []
    i.after_decision = None
    i.priority = "normal"
    i.state = state
    i.resolved_option_id = None
    i.resolved_note = None
    i.source_type = "agent_run"
    i.source_id = "run-abc"
    i.waiting_since = datetime(2026, 4, 30, tzinfo=timezone.utc)
    i.created_at = datetime(2026, 4, 30, tzinfo=timezone.utc)
    i.resolved_at = None
    return i


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


@pytest.mark.anyio
async def test_list_notifications_200():
    client, session, app = await _client()
    try:
        with patch("app.repositories.notification.NotificationRepository.list", new_callable=AsyncMock) as mock_list:
            mock_list.return_value = [_mock_notification()]

            async with client as c:
                resp = await c.get(f"/api/v2/notifications?user_id={MEMBER_ID}")

        assert resp.status_code == 200
        assert len(resp.json()) == 1
        assert resp.json()[0]["is_read"] is False
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_list_notifications_is_read_filter_200():
    client, session, app = await _client()
    try:
        with patch("app.repositories.notification.NotificationRepository.list", new_callable=AsyncMock) as mock_list:
            mock_list.return_value = []

            async with client as c:
                resp = await c.get(f"/api/v2/notifications?user_id={MEMBER_ID}&is_read=true")

        assert resp.status_code == 200
        assert resp.json() == []
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_count_unread_200():
    client, session, app = await _client()
    try:
        with patch("app.repositories.notification.NotificationRepository.count_unread", new_callable=AsyncMock) as mock_count:
            mock_count.return_value = 3

            async with client as c:
                resp = await c.get(f"/api/v2/notifications/count?user_id={MEMBER_ID}")

        assert resp.status_code == 200
        assert resp.json()["count"] == 3
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_mark_all_read_200():
    client, session, app = await _client()
    try:
        with patch("app.repositories.notification.NotificationRepository.mark_all_read", new_callable=AsyncMock) as mock_mark:
            mock_mark.return_value = None

            async with client as c:
                resp = await c.patch(f"/api/v2/notifications/mark-all-read?user_id={MEMBER_ID}")

        assert resp.status_code == 200
        assert resp.json()["ok"] is True
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_notification_settings_200():
    client, session, app = await _client()
    try:
        with patch("app.repositories.notification.NotificationSettingRepository.get_by_member", new_callable=AsyncMock) as mock_get:
            mock_get.return_value = [_mock_setting()]

            async with client as c:
                resp = await c.get(f"/api/v2/notification-settings?member_id={MEMBER_ID}")

        assert resp.status_code == 200
        assert len(resp.json()) == 1
        assert resp.json()[0]["event_type"] == "story_assigned"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_upsert_notification_setting_200():
    client, session, app = await _client()
    try:
        with patch("app.repositories.notification.NotificationSettingRepository.upsert", new_callable=AsyncMock) as mock_upsert:
            mock_upsert.return_value = _mock_setting()

            async with client as c:
                resp = await c.put(
                    f"/api/v2/notification-settings?member_id={MEMBER_ID}",
                    json={"channel": "in_app", "event_type": "story_assigned", "enabled": True},
                )

        assert resp.status_code == 200
        assert resp.json()["enabled"] is True
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_list_inbox_200():
    client, session, app = await _client()
    try:
        with patch("app.repositories.notification.InboxRepository.list", new_callable=AsyncMock) as mock_list:
            mock_list.return_value = [_mock_inbox()]

            async with client as c:
                resp = await c.get(f"/api/v2/inbox?assignee_member_id={MEMBER_ID}")

        assert resp.status_code == 200
        assert len(resp.json()) == 1
        assert resp.json()[0]["state"] == "pending"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_list_incoming_200():
    client, session, app = await _client()
    try:
        with patch("app.repositories.notification.InboxRepository.list_incoming", new_callable=AsyncMock) as mock_list:
            mock_list.return_value = [_mock_inbox()]

            async with client as c:
                resp = await c.get(f"/api/v2/inbox/incoming?assignee_member_id={MEMBER_ID}")

        assert resp.status_code == 200
        assert resp.json()[0]["kind"] == "approval"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_resolve_inbox_200():
    client, session, app = await _client()
    try:
        resolved = _mock_inbox("resolved")
        resolved.resolved_by = MEMBER_ID
        resolved.resolved_at = datetime(2026, 4, 30, tzinfo=timezone.utc)

        with patch("app.repositories.notification.InboxRepository.resolve", new_callable=AsyncMock) as mock_resolve:
            mock_resolve.return_value = resolved

            async with client as c:
                resp = await c.post(
                    f"/api/v2/inbox/{INBOX_ID}/resolve",
                    json={"resolved_by": str(MEMBER_ID)},
                )

        assert resp.status_code == 200
        assert resp.json()["state"] == "resolved"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_dismiss_inbox_200():
    client, session, app = await _client()
    try:
        dismissed = _mock_inbox("dismissed")

        with patch("app.repositories.notification.InboxRepository.dismiss", new_callable=AsyncMock) as mock_dismiss:
            mock_dismiss.return_value = dismissed

            async with client as c:
                resp = await c.post(f"/api/v2/inbox/{INBOX_ID}/dismiss")

        assert resp.status_code == 200
        assert resp.json()["state"] == "dismissed"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_resolve_inbox_404():
    client, session, app = await _client()
    try:
        with patch("app.repositories.notification.InboxRepository.resolve", new_callable=AsyncMock) as mock_resolve:
            mock_resolve.return_value = None

            async with client as c:
                resp = await c.post(
                    f"/api/v2/inbox/{uuid.uuid4()}/resolve",
                    json={"resolved_by": str(MEMBER_ID)},
                )

        assert resp.status_code == 404
    finally:
        app.dependency_overrides.clear()
