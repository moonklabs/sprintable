"""S27 AC: Notifications router 단위 테스트 (8건 이상)."""
import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

ORG_ID = uuid.uuid4()
PROJECT_ID = uuid.uuid4()
MEMBER_ID = uuid.uuid4()
NOTIF_ID = uuid.uuid4()


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
    from tests.conftest import override_db_and_read

    # story #2451(§6 Phase3, 카디르 QA 4차 검산 중 자체 발견 2026-08-04): 이 파일이
    # /api/v2/notifications/count(A1이 get_read_db로 라우팅)를 호출하는데 get_db만
    # override — baseline에 얼리지 않고 지금 고친다(test_2249와 동형 latent bug).
    override_db_and_read(app, override_db)
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
        body = resp.json()
        assert len(body["data"]) == 1
        assert body["data"][0]["is_read"] is False
        # story #2195: #2231 정본 규약 A — body meta 로 has_more/next_cursor 를 낸다.
        assert body["meta"]["has_more"] is False
        assert body["meta"]["next_cursor"] is None
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
        assert resp.json()["data"] == []
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
async def test_mark_read_single_200():
    """48de882a: PATCH /notifications/{id}/read — 단일 읽음 처리 200 + is_read=True."""
    client, session, app = await _client()
    try:
        with patch("app.repositories.notification.NotificationRepository.mark_read", new_callable=AsyncMock) as mock_mark:
            mock_mark.return_value = _mock_notification(is_read=True)

            async with client as c:
                resp = await c.patch(f"/api/v2/notifications/{NOTIF_ID}/read")

        assert resp.status_code == 200
        assert resp.json()["is_read"] is True
        assert resp.json()["id"] == str(NOTIF_ID)
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_mark_read_single_404_when_not_owned():
    """48de882a: 본인 것 아니거나 없는 알림 → 404."""
    client, session, app = await _client()
    try:
        with patch("app.repositories.notification.NotificationRepository.mark_read", new_callable=AsyncMock) as mock_mark:
            mock_mark.return_value = None

            async with client as c:
                resp = await c.patch(f"/api/v2/notifications/{NOTIF_ID}/read")

        assert resp.status_code == 404
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_notification_settings_200():
    """까심 델타 재QA HIGH(S19): 이 GET이 무가드로 남아있었다 — self 통과 시 정상 동작 확인."""
    client, session, app = await _client()
    try:
        with patch("app.repositories.notification.NotificationSettingRepository.get_by_member", new_callable=AsyncMock) as mock_get, \
             patch("app.routers.notifications.is_caller_member", new_callable=AsyncMock, return_value=True):
            mock_get.return_value = [_mock_setting()]

            async with client as c:
                resp = await c.get(f"/api/v2/notification-settings?member_id={MEMBER_ID}")

        assert resp.status_code == 200
        assert len(resp.json()) == 1
        assert resp.json()[0]["event_type"] == "story_assigned"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_notification_settings_403_when_not_self_or_admin():
    """까심 델타 재QA HIGH(S19 MUST): 타 member의 알림설정 열람(정보노출) 차단."""
    client, session, app = await _client()
    try:
        with patch("app.routers.notifications.is_caller_member", new_callable=AsyncMock, return_value=False), \
             patch("app.routers.notifications._is_org_admin", new_callable=AsyncMock, return_value=False):
            async with client as c:
                resp = await c.get(f"/api/v2/notification-settings?member_id={MEMBER_ID}")
        assert resp.status_code == 403
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_upsert_notification_setting_200():
    """S19(#4): self-scope 통과 시(caller==member_id) 정상 동작."""
    client, session, app = await _client()
    try:
        with patch("app.repositories.notification.NotificationSettingRepository.upsert", new_callable=AsyncMock) as mock_upsert, \
             patch("app.routers.notifications.is_caller_member", new_callable=AsyncMock, return_value=True):
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
async def test_upsert_notification_setting_403_when_not_self_or_admin():
    """S19(#4 MUST): member_id가 caller 본인도 org-admin도 아니면 403(타 member 설정 덮어쓰기 차단)."""
    client, session, app = await _client()
    try:
        with patch("app.routers.notifications.is_caller_member", new_callable=AsyncMock, return_value=False), \
             patch("app.routers.notifications._is_org_admin", new_callable=AsyncMock, return_value=False):
            async with client as c:
                resp = await c.put(
                    f"/api/v2/notification-settings?member_id={MEMBER_ID}",
                    json={"channel": "in_app", "event_type": "story_assigned", "enabled": True},
                )
        assert resp.status_code == 403
    finally:
        app.dependency_overrides.clear()
