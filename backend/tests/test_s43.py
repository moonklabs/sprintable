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
        # story f0c99070: bulk-replace 분기도 이제 요청시점 재해소를 거친다 — body에 project_id를
        # 실어보내(FE PR #2120과 동일 계약) explicit 경로로 단락, has_project_access만 mock.
        with patch("app.repositories.agent_routing_rule.AgentRoutingRuleRepository.replace", new_callable=AsyncMock) as mock_replace, \
             patch("app.services.project_auth.has_project_access", new_callable=AsyncMock, return_value=True):
            mock_replace.return_value = [_make_rule()]
            payload = {
                "items": [{"agent_id": str(AGENT_ID), "name": "Test Rule"}],
                "project_id": str(PROJECT_ID),
            }
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
        # story #1831 후속: 단일-룰 update 분기도 이제 요청시점 재해소(resolve_required_project_id)
        # 를 거친다 — session mock의 내부 쿼리 체인까지 흉내내는 대신(test_disable_all_200과 달리
        # 이 분기는 X-Project-Id/명시 project_id가 없어 _resolve_project_default 경로까지 타야
        # 해서 그 흉내가 더 무겁다) 이 라우터가 실제로 무엇을 호출하는지만 확인하면 되므로
        # resolve_required_project_id 자체를 직접 patch한다(그 함수 자신의 계약은
        # test_f0c99070_critical_project_scope_realdb.py가 실PG로 따로 검증한다).
        with patch("app.repositories.agent_routing_rule.AgentRoutingRuleRepository.update", new_callable=AsyncMock) as mock_update, \
             patch(
                 "app.routers.agent_routing_rules.resolve_required_project_id",
                 new_callable=AsyncMock, return_value=PROJECT_ID,
             ) as mock_resolve:
            updated = _make_rule()
            updated.name = "Updated Rule"
            mock_update.return_value = updated
            payload = {"id": str(RULE_ID), "name": "Updated Rule"}
            async with client as c:
                resp = await c.put("/api/v2/agent-routing-rules", json=payload)
            assert resp.status_code == 200
            assert resp.json()["data"]["name"] == "Updated Rule"
            # 오르테가 지적(2026-07-31): return_value만 걸면 이 유닛이 「그 함수를 실제로
            # 타는가」를 안 잰다 — 호출이 나중에 사라져도 초록일 수 있다. assert_awaited_once로
            # 그 자체를 고정한다.
            mock_resolve.assert_awaited_once()
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_reorder_rules_200():
    client, session, app = await _client()
    try:
        # story f0c99070: reorder-items 분기도 이제 요청시점 재해소를 거친다 — body에 project_id를
        # 실어보내(FE PR #2120과 동일 계약) explicit 경로로 단락.
        with patch("app.repositories.agent_routing_rule.AgentRoutingRuleRepository.reorder", new_callable=AsyncMock) as mock_reorder, \
             patch("app.services.project_auth.has_project_access", new_callable=AsyncMock, return_value=True):
            mock_reorder.return_value = [_make_rule()]
            payload = {"items": [{"id": str(RULE_ID), "priority": 5}], "project_id": str(PROJECT_ID)}
            async with client as c:
                resp = await c.patch("/api/v2/agent-routing-rules", json=payload)
            assert resp.status_code == 200
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_disable_all_200():
    client, session, app = await _client()
    try:
        # story f0c99070: disable_all 분기가 이제 요청시점 재해소(resolve_required_project_id)를
        # 거친다 — accessible_project_ids_in_org의 단일-접근-프로젝트 단축 경로를 태우도록 mock.
        _accessible_result = MagicMock()
        _accessible_result.all.return_value = [(PROJECT_ID,)]
        session.execute = AsyncMock(return_value=_accessible_result)
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
