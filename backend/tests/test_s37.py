"""S37 AC: Policy Documents + Notification Settings 라우터 (7건 이상)."""
import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

ORG_ID = uuid.uuid4()
PROJECT_ID = uuid.uuid4()
SPRINT_ID = uuid.uuid4()
EPIC_ID = uuid.uuid4()
MEMBER_ID = uuid.uuid4()
DOC_ID = uuid.uuid4()


def _mock_doc() -> MagicMock:
    d = MagicMock()
    d.id = DOC_ID
    d.org_id = ORG_ID
    d.project_id = PROJECT_ID
    d.sprint_id = SPRINT_ID
    d.epic_id = EPIC_ID
    d.title = "S1 Policy"
    d.content = "내용"
    d.legacy_sprint_key = None
    d.legacy_epic_key = None
    d.created_by = MEMBER_ID
    d.created_at = datetime(2026, 4, 30, tzinfo=timezone.utc)
    d.updated_at = datetime(2026, 4, 30, tzinfo=timezone.utc)
    d.deleted_at = None
    return d


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


# ── Policy Documents ─────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_list_policy_docs_200():
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalars.return_value.all.return_value = [_mock_doc()]
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.get(f"/api/v2/policy-documents?project_id={PROJECT_ID}")

        assert resp.status_code == 200
        assert len(resp.json()) == 1
        assert resp.json()[0]["title"] == "S1 Policy"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_list_policy_docs_empty_200():
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalars.return_value.all.return_value = []
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.get(f"/api/v2/policy-documents?project_id={PROJECT_ID}")

        assert resp.status_code == 200
        assert resp.json() == []
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_list_policy_docs_sprint_filter_200():
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalars.return_value.all.return_value = [_mock_doc()]
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.get(f"/api/v2/policy-documents?project_id={PROJECT_ID}&sprint_id={SPRINT_ID}")

        assert resp.status_code == 200
        assert resp.json()[0]["sprint_id"] == str(SPRINT_ID)
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_list_policy_docs_q_filter_200():
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalars.return_value.all.return_value = []
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.get(f"/api/v2/policy-documents?project_id={PROJECT_ID}&q=검색")

        assert resp.status_code == 200
        assert resp.json() == []
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_list_policy_docs_missing_project_id_422():
    client, session, app = await _client()
    try:
        async with client as c:
            resp = await c.get("/api/v2/policy-documents")

        assert resp.status_code == 422
    finally:
        app.dependency_overrides.clear()


# ── Notification Settings (S27에서 구현됨 — 회귀 확인) ───────────────────────

@pytest.mark.anyio
async def test_get_notification_settings_200():
    client, session, app = await _client()
    try:
        with patch(
            "app.repositories.notification.NotificationSettingRepository.get_by_member",
            new_callable=AsyncMock
        ) as mock_get:
            mock_get.return_value = []

            async with client as c:
                resp = await c.get(f"/api/v2/notification-settings?member_id={MEMBER_ID}")

        assert resp.status_code == 200
        assert resp.json() == []
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_put_notification_setting_200():
    client, session, app = await _client()
    try:
        setting_mock = MagicMock()
        setting_mock.id = uuid.uuid4()
        setting_mock.org_id = ORG_ID
        setting_mock.member_id = MEMBER_ID
        setting_mock.channel = "in_app"
        setting_mock.event_type = "story_assigned"
        setting_mock.enabled = True

        with patch(
            "app.repositories.notification.NotificationSettingRepository.upsert",
            new_callable=AsyncMock
        ) as mock_upsert:
            mock_upsert.return_value = setting_mock

            async with client as c:
                resp = await c.put(
                    f"/api/v2/notification-settings?member_id={MEMBER_ID}",
                    json={"channel": "in_app", "event_type": "story_assigned", "enabled": True},
                )

        assert resp.status_code == 200
        assert resp.json()["channel"] == "in_app"
    finally:
        app.dependency_overrides.clear()
