"""S47 AC: Bridge — Slack Events/Interactions + Teams Events FastAPI /api/v2/bridge/**"""
from __future__ import annotations

import hashlib
import hmac
import json
import time
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

ORG_ID = uuid.uuid4()
PROJECT_ID = uuid.uuid4()
AGENT_ID = uuid.uuid4()
HITL_ID = uuid.uuid4()
TEAM_MEMBER_ID = uuid.uuid4()
SIGNING_SECRET = "test-secret-1234"


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


async def _client():
    from app.main import app
    mock_session = AsyncMock()

    async def override_db():
        yield mock_session

    from app.dependencies.database import get_db
    app.dependency_overrides[get_db] = override_db
    from httpx import ASGITransport, AsyncClient
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test"), mock_session, app


def _slack_sig(body: str, secret: str = SIGNING_SECRET) -> tuple[str, str]:
    ts = str(int(time.time()))
    sig = "v0=" + hmac.new(secret.encode(), f"v0:{ts}:{body}".encode(), hashlib.sha256).hexdigest()
    return ts, sig


def _make_channel_mapping(platform: str = "slack") -> MagicMock:
    m = MagicMock()
    m.id = uuid.uuid4()
    m.org_id = ORG_ID
    m.project_id = PROJECT_ID
    m.platform = platform
    m.channel_id = "C123"
    m.config = {}
    m.is_active = True
    return m


def _make_user_mapping() -> MagicMock:
    m = MagicMock()
    m.team_member_id = TEAM_MEMBER_ID
    m.display_name = "Test User"
    return m


# ─── Slack Events ─────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_slack_events_url_verification():
    client, session, app = await _client()
    try:
        body = json.dumps({"type": "url_verification", "challenge": "abc123"})
        ts, sig = _slack_sig(body)
        with patch.dict("os.environ", {"SLACK_SIGNING_SECRET": SIGNING_SECRET}):
            async with client as c:
                resp = await c.post(
                    "/api/v2/bridge/slack/events",
                    content=body,
                    headers={"x-slack-signature": sig, "x-slack-request-timestamp": ts, "content-type": "application/json"},
                )
        assert resp.status_code == 200
        assert resp.json()["challenge"] == "abc123"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_slack_events_invalid_signature_401():
    client, session, app = await _client()
    try:
        body = json.dumps({"type": "event_callback"})
        with patch.dict("os.environ", {"SLACK_SIGNING_SECRET": SIGNING_SECRET}):
            async with client as c:
                resp = await c.post(
                    "/api/v2/bridge/slack/events",
                    content=body,
                    headers={"x-slack-signature": "v0=bad", "x-slack-request-timestamp": str(int(time.time())), "content-type": "application/json"},
                )
        assert resp.status_code == 401
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_slack_events_channel_not_mapped_ignored():
    client, session, app = await _client()
    try:
        body = json.dumps({"type": "event_callback", "event": {"type": "message", "channel": "C999", "user": "U1", "text": "hi"}})
        ts, sig = _slack_sig(body)
        with patch.dict("os.environ", {"SLACK_SIGNING_SECRET": SIGNING_SECRET}):
            with patch("app.repositories.bridge_inbound.BridgeInboundRepository.find_channel_mapping", new_callable=AsyncMock) as mock_find:
                mock_find.return_value = None
                async with client as c:
                    resp = await c.post(
                        "/api/v2/bridge/slack/events",
                        content=body,
                        headers={"x-slack-signature": sig, "x-slack-request-timestamp": ts, "content-type": "application/json"},
                    )
        assert resp.status_code == 200
        assert resp.json()["data"]["action"] == "ignored"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_slack_events_creates_memo():
    client, session, app = await _client()
    try:
        body = json.dumps({"type": "event_callback", "team_id": "T1", "event_id": "ev1", "event": {"type": "message", "channel": "C123", "user": "U1", "text": "hello"}})
        ts, sig = _slack_sig(body)
        with patch.dict("os.environ", {"SLACK_SIGNING_SECRET": SIGNING_SECRET}):
            with patch("app.repositories.bridge_inbound.BridgeInboundRepository.find_channel_mapping", new_callable=AsyncMock) as mock_channel:
                mock_channel.return_value = _make_channel_mapping()
                with patch("app.repositories.bridge_inbound.BridgeInboundRepository.find_user_mapping", new_callable=AsyncMock) as mock_user:
                    mock_user.return_value = _make_user_mapping()
                    with patch("app.repositories.bridge_inbound.BridgeInboundRepository.create_memo", new_callable=AsyncMock) as mock_create:
                        mock_create.return_value = str(uuid.uuid4())
                        async with client as c:
                            resp = await c.post(
                                "/api/v2/bridge/slack/events",
                                content=body,
                                headers={"x-slack-signature": sig, "x-slack-request-timestamp": ts, "content-type": "application/json"},
                            )
        assert resp.status_code == 200
        body_json = resp.json()
        assert body_json["data"]["action"] == "created"
        assert body_json["data"]["memo_id"] is not None
    finally:
        app.dependency_overrides.clear()


# ─── Slack Interactions ────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_slack_interactions_invalid_sig_401():
    client, session, app = await _client()
    try:
        with patch.dict("os.environ", {"SLACK_SIGNING_SECRET": SIGNING_SECRET}):
            async with client as c:
                resp = await c.post(
                    "/api/v2/bridge/slack/interactions",
                    content="payload={}",
                    headers={"x-slack-signature": "v0=bad", "x-slack-request-timestamp": str(int(time.time())), "content-type": "application/x-www-form-urlencoded"},
                )
        assert resp.status_code == 401
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_slack_interactions_hitl_approve():
    client, session, app = await _client()
    try:
        interaction = {
            "type": "block_actions",
            "user": {"id": "USLACK", "username": "testuser"},
            "team": {"id": "T1"},
            "actions": [{"action_id": "hitl_approve", "value": json.dumps({"requestId": str(HITL_ID)})}],
        }
        form_body = f"payload={json.dumps(interaction)}"
        ts, sig = _slack_sig(form_body)

        mock_row = {"id": str(HITL_ID), "org_id": str(ORG_ID), "project_id": str(PROJECT_ID), "status": "pending"}

        with patch.dict("os.environ", {"SLACK_SIGNING_SECRET": SIGNING_SECRET}):
            mock_result = MagicMock()
            mock_result.mappings.return_value.one_or_none.return_value = mock_row
            session.execute = AsyncMock(return_value=mock_result)
            with patch("app.repositories.bridge_inbound.BridgeInboundRepository.find_user_mapping", new_callable=AsyncMock) as mock_user:
                mock_user.return_value = _make_user_mapping()
                async with client as c:
                    resp = await c.post(
                        "/api/v2/bridge/slack/interactions",
                        content=form_body,
                        headers={"x-slack-signature": sig, "x-slack-request-timestamp": ts, "content-type": "application/x-www-form-urlencoded"},
                    )
        assert resp.status_code == 200
    finally:
        app.dependency_overrides.clear()


# ─── Teams Events ──────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_teams_events_conversation_update_ok():
    client, session, app = await _client()
    try:
        async with client as c:
            resp = await c.post(
                "/api/v2/bridge/teams/events",
                json={"type": "conversationUpdate"},
            )
        assert resp.status_code == 200
        assert resp.json()["ok"] is True
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_teams_events_channel_not_mapped():
    client, session, app = await _client()
    try:
        with patch("app.repositories.bridge_inbound.BridgeInboundRepository.find_channel_mapping", new_callable=AsyncMock) as mock_find:
            mock_find.return_value = None
            async with client as c:
                resp = await c.post(
                    "/api/v2/bridge/teams/events",
                    json={"type": "message", "channelData": {"channel": {"id": "19:abc"}}, "conversation": {"id": "conv1"}},
                )
        assert resp.status_code == 200
        assert resp.json()["skipped"] == "channel_not_mapped"
    finally:
        app.dependency_overrides.clear()
