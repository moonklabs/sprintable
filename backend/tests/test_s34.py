"""S34 AC: Webhook Config CRUD 라우터 (8건 이상)."""
import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

ORG_ID = uuid.uuid4()
PROJECT_ID = uuid.uuid4()
MEMBER_ID = uuid.uuid4()
CONFIG_ID = uuid.uuid4()


def _mock_config(is_active: bool = True) -> MagicMock:
    c = MagicMock()
    c.id = CONFIG_ID
    c.org_id = ORG_ID
    c.member_id = MEMBER_ID
    c.project_id = PROJECT_ID
    c.url = "https://hooks.example.com/webhook"
    c.events = ["memo.created", "story.updated"]
    c.channel = "generic"
    c.is_active = is_active
    c.created_at = datetime(2026, 4, 30, tzinfo=timezone.utc)
    return c


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
async def test_list_configs_200():
    client, session, app = await _client()
    try:
        with patch("app.repositories.webhook_config.WebhookConfigRepository.list", new_callable=AsyncMock) as mock_list:
            mock_list.return_value = [_mock_config()]

            async with client as c:
                resp = await c.get("/api/v2/webhooks/config")

        assert resp.status_code == 200
        assert len(resp.json()) == 1
        assert resp.json()[0]["url"] == "https://hooks.example.com/webhook"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_list_configs_empty_200():
    client, session, app = await _client()
    try:
        with patch("app.repositories.webhook_config.WebhookConfigRepository.list", new_callable=AsyncMock) as mock_list:
            mock_list.return_value = []

            async with client as c:
                resp = await c.get("/api/v2/webhooks/config")

        assert resp.status_code == 200
        assert resp.json() == []
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_upsert_config_create_200():
    client, session, app = await _client()
    try:
        with patch("app.repositories.webhook_config.WebhookConfigRepository.upsert", new_callable=AsyncMock) as mock_upsert:
            mock_upsert.return_value = _mock_config()

            async with client as c:
                resp = await c.put("/api/v2/webhooks/config", json={
                    "member_id": str(MEMBER_ID),
                    "url": "https://hooks.example.com/webhook",
                    "events": ["memo.created"],
                    "is_active": True,
                })

        assert resp.status_code == 200
        assert resp.json()["is_active"] is True
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_upsert_config_update_200():
    client, session, app = await _client()
    try:
        updated = _mock_config(is_active=False)
        with patch("app.repositories.webhook_config.WebhookConfigRepository.upsert", new_callable=AsyncMock) as mock_upsert:
            mock_upsert.return_value = updated

            async with client as c:
                resp = await c.put("/api/v2/webhooks/config", json={
                    "member_id": str(MEMBER_ID),
                    "url": "https://hooks.example.com/webhook",
                    "is_active": False,
                })

        assert resp.status_code == 200
        assert resp.json()["is_active"] is False
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_delete_config_200():
    client, session, app = await _client()
    try:
        with patch("app.repositories.webhook_config.WebhookConfigRepository.delete", new_callable=AsyncMock) as mock_del:
            mock_del.return_value = True

            async with client as c:
                resp = await c.delete(f"/api/v2/webhooks/config?id={CONFIG_ID}")

        assert resp.status_code == 200
        assert resp.json()["ok"] is True
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_delete_config_404():
    client, session, app = await _client()
    try:
        with patch("app.repositories.webhook_config.WebhookConfigRepository.delete", new_callable=AsyncMock) as mock_del:
            mock_del.return_value = False

            async with client as c:
                resp = await c.delete(f"/api/v2/webhooks/config?id={uuid.uuid4()}")

        assert resp.status_code == 404
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_upsert_non_https_422():
    client, session, app = await _client()
    try:
        async with client as c:
            resp = await c.put("/api/v2/webhooks/config", json={
                "member_id": str(MEMBER_ID),
                "url": "http://insecure.example.com/webhook",
            })

        assert resp.status_code == 422
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_by_project_200():
    client, session, app = await _client()
    try:
        with patch("app.repositories.webhook_config.WebhookConfigRepository.list", new_callable=AsyncMock) as mock_list:
            mock_list.return_value = [_mock_config()]

            async with client as c:
                resp = await c.get(f"/api/v2/webhooks/config?project_id={PROJECT_ID}")

        assert resp.status_code == 200
        assert len(resp.json()) == 1
        mock_list.assert_called_once_with(project_id=PROJECT_ID)
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_list_configs_with_events_200():
    client, session, app = await _client()
    try:
        with patch("app.repositories.webhook_config.WebhookConfigRepository.list", new_callable=AsyncMock) as mock_list:
            mock_list.return_value = [_mock_config()]

            async with client as c:
                resp = await c.get("/api/v2/webhooks/config")

        assert resp.status_code == 200
        assert "memo.created" in resp.json()[0]["events"]
    finally:
        app.dependency_overrides.clear()
