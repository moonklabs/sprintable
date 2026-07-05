"""S27 AC: Notifications + Inbox router 단위 테스트 (8건 이상)."""
import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException

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


def _resolved(member_id: uuid.UUID):
    """S19: resolve_member() 반환 mock — caller가 member_id 본인/assignee임을 가장."""
    from app.services.member_resolver import ResolvedMember

    return ResolvedMember(
        id=member_id, user_id=None, name="TestMember", type="human",
        role="member", org_id=ORG_ID, project_id=PROJECT_ID,
    )


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


@pytest.mark.anyio
async def test_list_inbox_200():
    """까심 델타 재QA HIGH(S19): 무가드였던 GET — self 통과 시 정상 동작."""
    client, session, app = await _client()
    try:
        with patch("app.repositories.notification.InboxRepository.list", new_callable=AsyncMock) as mock_list, \
             patch("app.routers.notifications.is_caller_member", new_callable=AsyncMock, return_value=True):
            mock_list.return_value = [_mock_inbox()]

            async with client as c:
                resp = await c.get(f"/api/v2/inbox?assignee_member_id={MEMBER_ID}")

        assert resp.status_code == 200
        assert len(resp.json()) == 1
        assert resp.json()[0]["state"] == "pending"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_list_inbox_403_when_not_self_or_admin():
    """까심 델타 재QA HIGH(S19 MUST): 타 member의 inbox 열람(정보노출) 차단."""
    client, session, app = await _client()
    try:
        with patch("app.routers.notifications.is_caller_member", new_callable=AsyncMock, return_value=False), \
             patch("app.routers.notifications._is_org_admin", new_callable=AsyncMock, return_value=False):
            async with client as c:
                resp = await c.get(f"/api/v2/inbox?assignee_member_id={MEMBER_ID}")
        assert resp.status_code == 403
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_list_incoming_200():
    """까심 델타 재QA HIGH(S19): 무가드였던 GET — self 통과 시 정상 동작."""
    client, session, app = await _client()
    try:
        with patch("app.repositories.notification.InboxRepository.list_incoming", new_callable=AsyncMock) as mock_list, \
             patch("app.routers.notifications.is_caller_member", new_callable=AsyncMock, return_value=True):
            mock_list.return_value = [_mock_inbox()]

            async with client as c:
                resp = await c.get(f"/api/v2/inbox/incoming?assignee_member_id={MEMBER_ID}")

        assert resp.status_code == 200
        assert resp.json()[0]["kind"] == "approval"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_list_incoming_403_when_not_self_or_admin():
    """까심 델타 재QA HIGH(S19 MUST): list_inbox와 동일 갭 — 정보노출 차단."""
    client, session, app = await _client()
    try:
        with patch("app.routers.notifications.is_caller_member", new_callable=AsyncMock, return_value=False), \
             patch("app.routers.notifications._is_org_admin", new_callable=AsyncMock, return_value=False):
            async with client as c:
                resp = await c.get(f"/api/v2/inbox/incoming?assignee_member_id={MEMBER_ID}")
        assert resp.status_code == 403
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_resolve_inbox_200():
    """S19(#5): assignee==caller일 때 정상 동작. resolved_by는 이제 caller에서 서버-파생."""
    client, session, app = await _client()
    try:
        pending_item = _mock_inbox("pending")
        resolved = _mock_inbox("resolved")
        resolved.resolved_by = MEMBER_ID
        resolved.resolved_at = datetime(2026, 4, 30, tzinfo=timezone.utc)

        with patch("app.repositories.notification.InboxRepository.get", new_callable=AsyncMock,
                   return_value=pending_item), \
             patch("app.repositories.notification.InboxRepository.resolve", new_callable=AsyncMock) as mock_resolve, \
             patch("app.routers.notifications.assert_caller_is_member", new_callable=AsyncMock,
                   return_value=None):
            mock_resolve.return_value = resolved

            async with client as c:
                resp = await c.post(
                    f"/api/v2/inbox/{INBOX_ID}/resolve",
                    json={"resolved_by": str(uuid.uuid4())},  # S19: 바디값 무시(caller에서 서버-파생)
                )

        assert resp.status_code == 200
        assert resp.json()["state"] == "resolved"
        mock_resolve.assert_awaited_once_with(
            id=INBOX_ID, resolved_by=MEMBER_ID, resolved_option_id=None, resolved_note=None,
        )
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_resolve_inbox_403_when_caller_is_not_assignee():
    """S19(#5 MUST): auth 파라미터 자체가 없어 assignee 확인이 전혀 없었다 — 타 member의 inbox
    item을 resolve할 수 있었고 resolved_by 바디값도 임의로 스푸핑 가능했다."""
    client, session, app = await _client()
    try:
        pending_item = _mock_inbox("pending")  # assignee_member_id == MEMBER_ID

        with patch("app.repositories.notification.InboxRepository.get", new_callable=AsyncMock,
                   return_value=pending_item), \
             patch("app.routers.notifications.assert_caller_is_member", new_callable=AsyncMock,
                   side_effect=HTTPException(status_code=403, detail="Not the assignee of this inbox item")):  # caller != assignee
            async with client as c:
                resp = await c.post(
                    f"/api/v2/inbox/{INBOX_ID}/resolve",
                    json={"resolved_by": str(MEMBER_ID)},
                )

        assert resp.status_code == 403
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_dismiss_inbox_200():
    client, session, app = await _client()
    try:
        pending_item = _mock_inbox("pending")
        dismissed = _mock_inbox("dismissed")

        with patch("app.repositories.notification.InboxRepository.get", new_callable=AsyncMock,
                   return_value=pending_item), \
             patch("app.repositories.notification.InboxRepository.dismiss", new_callable=AsyncMock) as mock_dismiss, \
             patch("app.routers.notifications.assert_caller_is_member", new_callable=AsyncMock,
                   return_value=None):
            mock_dismiss.return_value = dismissed

            async with client as c:
                resp = await c.post(f"/api/v2/inbox/{INBOX_ID}/dismiss")

        assert resp.status_code == 200
        assert resp.json()["state"] == "dismissed"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_dismiss_inbox_403_when_caller_is_not_assignee():
    """S19(#6 MUST): resolve와 동일 갭 — assignee 아닌 caller의 dismiss 차단."""
    client, session, app = await _client()
    try:
        pending_item = _mock_inbox("pending")

        with patch("app.repositories.notification.InboxRepository.get", new_callable=AsyncMock,
                   return_value=pending_item), \
             patch("app.routers.notifications.assert_caller_is_member", new_callable=AsyncMock,
                   side_effect=HTTPException(status_code=403, detail="Not the assignee of this inbox item")):
            async with client as c:
                resp = await c.post(f"/api/v2/inbox/{INBOX_ID}/dismiss")

        assert resp.status_code == 403
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_resolve_inbox_404():
    client, session, app = await _client()
    try:
        pending_item = _mock_inbox("pending")
        with patch("app.repositories.notification.InboxRepository.get", new_callable=AsyncMock,
                   return_value=pending_item), \
             patch("app.repositories.notification.InboxRepository.resolve", new_callable=AsyncMock) as mock_resolve, \
             patch("app.routers.notifications.assert_caller_is_member", new_callable=AsyncMock,
                   return_value=None):
            mock_resolve.return_value = None

            async with client as c:
                resp = await c.post(
                    f"/api/v2/inbox/{INBOX_ID}/resolve",
                    json={"resolved_by": str(MEMBER_ID)},
                )

        assert resp.status_code == 404
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_resolve_inbox_404_when_item_not_found():
    """item 자체가 없으면(repo.get()==None) 404 — assignee 확인 전에 먼저 404."""
    client, session, app = await _client()
    try:
        with patch("app.repositories.notification.InboxRepository.get", new_callable=AsyncMock,
                   return_value=None):
            async with client as c:
                resp = await c.post(
                    f"/api/v2/inbox/{uuid.uuid4()}/resolve",
                    json={"resolved_by": str(MEMBER_ID)},
                )

        assert resp.status_code == 404
    finally:
        app.dependency_overrides.clear()
