"""S41 AC: Agent Deployments CRUD + Preflight + Verification — FastAPI /api/v2/agent-deployments/**"""
from __future__ import annotations

import uuid
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

ORG_ID = uuid.uuid4()
PROJECT_ID = uuid.uuid4()
AGENT_ID = uuid.uuid4()
DEPLOYMENT_ID = uuid.uuid4()


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.fixture(autouse=True)
def _mock_resolve_member_db_verified(monkeypatch):
    """story #3370 회귀 클래스 정정(페드루 PO 지시 2026-09-11) — 라우터가 이제 actor_id를
    쓰기 前 resolve_member_db_verified()로 영속 멤버 id를 실측한다(진짜 DB 조회). 이 파일의
    세션은 순수 AsyncMock(실 PG 아님)이라 그 조회가 그대로 통과하면 응답 파싱이 깨진다 —
    라우터 모듈에 import된 그 심볼만 목으로 갈아 이 파일의 서비스-계층 목킹 계약(create_
    deployment 등 자체는 그대로 목)을 그대로 유지한다."""
    from unittest.mock import AsyncMock as _AsyncMock

    resolved = MagicMock()
    resolved.id = uuid.uuid4()
    monkeypatch.setattr(
        "app.routers.agent_deployments.resolve_member_db_verified",
        _AsyncMock(return_value=resolved),
    )


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
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test"), mock_session, app, ctx


def _make_deployment(status: str = "ACTIVE") -> MagicMock:
    dep = MagicMock()
    dep.id = DEPLOYMENT_ID
    dep.org_id = ORG_ID
    dep.project_id = PROJECT_ID
    dep.agent_id = AGENT_ID
    dep.persona_id = None
    dep.name = "Test Deployment"
    dep.runtime = "webhook"
    dep.model = None
    dep.version = None
    dep.status = status
    dep.config = {"schema_version": 1, "llm_mode": "managed", "provider": "openai", "scope_mode": "projects", "project_ids": [str(PROJECT_ID)]}
    dep.last_deployed_at = None
    dep.failure_code = None
    dep.failure_message = None
    dep.failure_detail = None
    dep.failed_at = None
    dep.created_at = MagicMock(isoformat=lambda: "2026-04-30T00:00:00+00:00")
    dep.updated_at = MagicMock(isoformat=lambda: "2026-04-30T00:00:00+00:00")
    dep.deleted_at = None
    return dep


@pytest.mark.anyio
async def test_get_deployment_cards_200():
    client, session, app, ctx = await _client()
    try:
        with patch("app.services.deployment_lifecycle.DeploymentLifecycleService.build_cards", new_callable=AsyncMock) as mock_cards:
            mock_cards.return_value = []
            async with client as c:
                resp = await c.get("/api/v2/agent-deployments")
            assert resp.status_code == 200
            body = resp.json()
            assert body["data"] == []
            assert body["error"] is None
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_deployment_by_id_200():
    client, session, app, ctx = await _client()
    try:
        dep = _make_deployment()
        with patch("app.services.deployment_lifecycle.DeploymentLifecycleService._get_deployment", new_callable=AsyncMock) as mock_get:
            mock_get.return_value = dep
            async with client as c:
                resp = await c.get(f"/api/v2/agent-deployments/{DEPLOYMENT_ID}")
            assert resp.status_code == 200
            body = resp.json()
            assert body["data"]["status"] == "ACTIVE"
            assert body["error"] is None
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_deployment_not_found_404():
    client, session, app, ctx = await _client()
    try:
        from app.services.deployment_lifecycle import DeploymentLifecycleError
        with patch("app.services.deployment_lifecycle.DeploymentLifecycleService._get_deployment", new_callable=AsyncMock) as mock_get:
            mock_get.side_effect = DeploymentLifecycleError("DEPLOYMENT_NOT_FOUND", 404, "Deployment not found in current project")
            async with client as c:
                resp = await c.get(f"/api/v2/agent-deployments/{DEPLOYMENT_ID}")
            assert resp.status_code == 404
            body = resp.json()
            assert body["data"] is None
            assert body["error"]["code"] == "DEPLOYMENT_NOT_FOUND"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_run_preflight_200():
    client, session, app, ctx = await _client()
    try:
        from app.schemas.agent_deployment import DeploymentPreflightResponse
        preflight = DeploymentPreflightResponse(
            ok=True, checked_at="2026-04-30T00:00:00+00:00",
            blocking_reasons=[], warnings=[],
            routing_template_id="solo-dev", routing_rule_count=0,
            existing_routing_rule_count=0, requires_routing_overwrite_confirmation=False,
            mcp_validation_errors=[],
        )
        with patch("app.services.deployment_lifecycle.DeploymentLifecycleService.run_deployment_preflight", new_callable=AsyncMock) as mock_pf:
            mock_pf.return_value = preflight
            payload = {
                "agent_id": str(AGENT_ID),
                "name": "Test Deploy",
                "config": {"llm_mode": "managed", "provider": "openai", "scope_mode": "projects", "project_ids": [str(PROJECT_ID)]},
            }
            async with client as c:
                resp = await c.post("/api/v2/agent-deployments/preflight", json=payload)
            assert resp.status_code == 200
            body = resp.json()
            assert body["data"]["preflight"]["ok"] is True
            assert body["error"] is None
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_create_deployment_202():
    client, session, app, ctx = await _client()
    try:
        from app.schemas.agent_deployment import DeploymentMutationResponse, AgentDeploymentResponse
        dep = _make_deployment("ACTIVE")
        dep_resp = AgentDeploymentResponse.model_validate(dep)
        mutation = DeploymentMutationResponse(
            deployment=dep_resp, queue_held_count=0, queue_resumed_count=0, queue_failed_count=0
        )
        with patch("app.services.deployment_lifecycle.DeploymentLifecycleService.create_deployment", new_callable=AsyncMock) as mock_create:
            mock_create.return_value = mutation
            payload = {
                "agent_id": str(AGENT_ID),
                "name": "Test Deploy",
                "config": {"llm_mode": "managed", "provider": "openai", "scope_mode": "projects", "project_ids": [str(PROJECT_ID)]},
            }
            async with client as c:
                resp = await c.post("/api/v2/agent-deployments", json=payload)
            assert resp.status_code == 202
            body = resp.json()
            assert body["data"]["deployment"]["status"] == "ACTIVE"
            assert body["error"] is None
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_patch_deployment_transition_200():
    client, session, app, ctx = await _client()
    try:
        from app.schemas.agent_deployment import DeploymentMutationResponse, AgentDeploymentResponse
        dep = _make_deployment("SUSPENDED")
        dep_resp = AgentDeploymentResponse.model_validate(dep)
        mutation = DeploymentMutationResponse(
            deployment=dep_resp, queue_held_count=2, queue_resumed_count=0, queue_failed_count=0
        )
        with patch("app.services.deployment_lifecycle.DeploymentLifecycleService.transition_deployment", new_callable=AsyncMock) as mock_tx:
            mock_tx.return_value = mutation
            async with client as c:
                resp = await c.patch(f"/api/v2/agent-deployments/{DEPLOYMENT_ID}", json={"status": "SUSPENDED"})
            assert resp.status_code == 200
            body = resp.json()
            assert body["data"]["queue_held_count"] == 2
            assert body["error"] is None
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_delete_deployment_200():
    client, session, app, ctx = await _client()
    try:
        from app.schemas.agent_deployment import DeploymentMutationResponse, AgentDeploymentResponse
        dep = _make_deployment("TERMINATED")
        dep_resp = AgentDeploymentResponse.model_validate(dep)
        mutation = DeploymentMutationResponse(
            deployment=dep_resp, queue_held_count=0, queue_resumed_count=0, queue_failed_count=1
        )
        with patch("app.services.deployment_lifecycle.DeploymentLifecycleService.terminate_deployment", new_callable=AsyncMock) as mock_term:
            mock_term.return_value = mutation
            async with client as c:
                resp = await c.delete(f"/api/v2/agent-deployments/{DEPLOYMENT_ID}")
            assert resp.status_code == 200
            body = resp.json()
            assert body["data"]["queue_failed_count"] == 1
            assert body["error"] is None
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_complete_verification_200():
    client, session, app, ctx = await _client()
    try:
        from app.schemas.agent_deployment import AgentDeploymentResponse
        dep = _make_deployment("ACTIVE")
        dep_resp = AgentDeploymentResponse.model_validate(dep)
        with patch("app.services.deployment_lifecycle.DeploymentLifecycleService.complete_verification", new_callable=AsyncMock) as mock_verify:
            mock_verify.return_value = dep_resp
            async with client as c:
                resp = await c.post(f"/api/v2/agent-deployments/{DEPLOYMENT_ID}/verification")
            assert resp.status_code == 200
            body = resp.json()
            assert body["data"]["deployment"]["status"] == "ACTIVE"
            assert body["error"] is None
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_invalid_transition_409():
    client, session, app, ctx = await _client()
    try:
        from app.services.deployment_lifecycle import DeploymentLifecycleError
        with patch("app.services.deployment_lifecycle.DeploymentLifecycleService.transition_deployment", new_callable=AsyncMock) as mock_tx:
            mock_tx.side_effect = DeploymentLifecycleError("INVALID_DEPLOYMENT_TRANSITION", 409, "Cannot transition")
            async with client as c:
                resp = await c.patch(f"/api/v2/agent-deployments/{DEPLOYMENT_ID}", json={"status": "DEPLOYING"})
            assert resp.status_code == 409
            body = resp.json()
            assert body["error"]["code"] == "INVALID_DEPLOYMENT_TRANSITION"
    finally:
        app.dependency_overrides.clear()
