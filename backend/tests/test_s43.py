"""S43 AC: Agent Routing Rules CRUD — FastAPI /api/v2/agent-routing-rules/**"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

ORG_ID = uuid.uuid4()
PROJECT_ID = uuid.uuid4()
AGENT_ID = uuid.uuid4()
RULE_ID = uuid.uuid4()


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


async def _client():
    from app.main import app
    ctx = MagicMock()
    ctx.user_id = str(uuid.uuid4())
    ctx.email = "test@example.com"
    ctx.claims = {"app_metadata": {"org_id": str(ORG_ID), "project_id": str(PROJECT_ID)}, "sub": ctx.user_id}
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


def _make_rule() -> "RoutingRuleResponse":
    from app.schemas.agent_routing_rule import RoutingRuleResponse
    now = datetime.now(timezone.utc)
    return RoutingRuleResponse(
        id=RULE_ID,
        org_id=ORG_ID,
        project_id=PROJECT_ID,
        agent_id=AGENT_ID,
        persona_id=None,
        deployment_id=None,
        name="Test Rule",
        priority=10,
        match_type="event",
        conditions={"memo_type": ["task"]},
        action={"auto_reply_mode": "process_and_report", "forward_to_agent_id": None},
        target_runtime="openclaw",
        target_model=None,
        is_enabled=True,
        metadata={},
        created_by=None,
        created_at=now,
        updated_at=now,
    )


@pytest.mark.anyio
async def test_list_rules_200():
    client, session, app = await _client()
    try:
        with patch("app.repositories.agent_routing_rule.AgentRoutingRuleRepository.list", new_callable=AsyncMock) as mock_list:
            mock_list.return_value = [_make_rule()]
            async with client as c:
                resp = await c.get("/api/v2/agent-routing-rules")
            assert resp.status_code == 200
            body = resp.json()
            assert len(body["data"]) == 1
            assert body["data"][0]["name"] == "Test Rule"
            assert body["error"] is None
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_rule_by_id_200():
    client, session, app = await _client()
    try:
        with patch("app.repositories.agent_routing_rule.AgentRoutingRuleRepository.get", new_callable=AsyncMock) as mock_get:
            mock_get.return_value = _make_rule()
            async with client as c:
                resp = await c.get(f"/api/v2/agent-routing-rules?id={RULE_ID}")
            assert resp.status_code == 200
            assert resp.json()["data"]["priority"] == 10
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_create_rule_201():
    client, session, app = await _client()
    try:
        with patch("app.repositories.agent_routing_rule.AgentRoutingRuleRepository.create", new_callable=AsyncMock) as mock_create:
            mock_create.return_value = _make_rule()
            payload = {"agent_id": str(AGENT_ID), "name": "Test Rule", "conditions": {"memo_type": ["task"]}}
            async with client as c:
                resp = await c.post("/api/v2/agent-routing-rules", json=payload)
            assert resp.status_code == 201
            assert resp.json()["data"]["match_type"] == "event"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_replace_rules_200():
    client, session, app = await _client()
    try:
        with patch("app.repositories.agent_routing_rule.AgentRoutingRuleRepository.replace", new_callable=AsyncMock) as mock_replace:
            mock_replace.return_value = [_make_rule()]
            payload = {"items": [{"agent_id": str(AGENT_ID), "name": "Test Rule"}]}
            async with client as c:
                resp = await c.put("/api/v2/agent-routing-rules", json=payload)
            assert resp.status_code == 200
            assert len(resp.json()["data"]) == 1
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_update_rule_200():
    client, session, app = await _client()
    try:
        with patch("app.repositories.agent_routing_rule.AgentRoutingRuleRepository.update", new_callable=AsyncMock) as mock_update:
            updated = _make_rule()
            updated.name = "Updated Rule"
            mock_update.return_value = updated
            payload = {"id": str(RULE_ID), "name": "Updated Rule"}
            async with client as c:
                resp = await c.put("/api/v2/agent-routing-rules", json=payload)
            assert resp.status_code == 200
            assert resp.json()["data"]["name"] == "Updated Rule"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_reorder_rules_200():
    client, session, app = await _client()
    try:
        with patch("app.repositories.agent_routing_rule.AgentRoutingRuleRepository.reorder", new_callable=AsyncMock) as mock_reorder:
            mock_reorder.return_value = [_make_rule()]
            payload = {"items": [{"id": str(RULE_ID), "priority": 5}]}
            async with client as c:
                resp = await c.patch("/api/v2/agent-routing-rules", json=payload)
            assert resp.status_code == 200
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_disable_all_200():
    client, session, app = await _client()
    try:
        with patch("app.repositories.agent_routing_rule.AgentRoutingRuleRepository.disable_all", new_callable=AsyncMock) as mock_disable:
            disabled = _make_rule()
            disabled.is_enabled = False
            mock_disable.return_value = [disabled]
            async with client as c:
                resp = await c.patch("/api/v2/agent-routing-rules", json={"disable_all": True})
            assert resp.status_code == 200
            assert resp.json()["data"][0]["is_enabled"] is False
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_delete_rule_200():
    client, session, app = await _client()
    try:
        with patch("app.repositories.agent_routing_rule.AgentRoutingRuleRepository.delete", new_callable=AsyncMock) as mock_del:
            mock_del.return_value = True
            async with client as c:
                resp = await c.delete(f"/api/v2/agent-routing-rules?id={RULE_ID}")
            assert resp.status_code == 200
            assert resp.json()["data"]["ok"] is True
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_delete_rule_not_found_404():
    client, session, app = await _client()
    try:
        with patch("app.repositories.agent_routing_rule.AgentRoutingRuleRepository.delete", new_callable=AsyncMock) as mock_del:
            mock_del.return_value = False
            async with client as c:
                resp = await c.delete(f"/api/v2/agent-routing-rules?id={RULE_ID}")
            assert resp.status_code == 404
    finally:
        app.dependency_overrides.clear()
