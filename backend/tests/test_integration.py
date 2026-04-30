"""S18+S25+S32: conftest fixture 기반 통합 테스트 — Sprint 3+4+5 도메인 헬스 체크."""
import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock

import pytest


@pytest.mark.anyio
async def test_health_via_conftest(test_client, mock_session):
    """conftest test_client fixture 사용 — health endpoint."""
    mock_session.execute = AsyncMock(return_value=None)
    resp = await test_client.get("/api/v2/health")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"


@pytest.mark.anyio
async def test_sprints_list_via_conftest(test_client, mock_session, org_id):
    """conftest fixture로 sprints list 200."""
    mock_result = MagicMock()
    mock_result.scalars.return_value.all.return_value = []
    mock_session.execute = AsyncMock(return_value=mock_result)

    resp = await test_client.get("/api/v2/sprints")
    assert resp.status_code == 200
    assert resp.json() == []


@pytest.mark.anyio
async def test_epics_list_via_conftest(test_client, mock_session):
    """conftest fixture로 epics list 200."""
    mock_result = MagicMock()
    mock_result.scalars.return_value.all.return_value = []
    mock_session.execute = AsyncMock(return_value=mock_result)

    resp = await test_client.get("/api/v2/epics")
    assert resp.status_code == 200
    assert resp.json() == []


@pytest.mark.anyio
async def test_tasks_list_via_conftest(test_client, mock_session):
    """conftest fixture로 tasks list 200."""
    mock_result = MagicMock()
    mock_result.scalars.return_value.all.return_value = []
    mock_session.execute = AsyncMock(return_value=mock_result)

    resp = await test_client.get("/api/v2/tasks")
    assert resp.status_code == 200
    assert resp.json() == []


@pytest.mark.anyio
async def test_docs_list_via_conftest(test_client, mock_session, project_id):
    """conftest fixture로 docs list 200."""
    mock_result = MagicMock()
    mock_result.scalars.return_value.all.return_value = []
    mock_session.execute = AsyncMock(return_value=mock_result)

    resp = await test_client.get(f"/api/v2/docs?project_id={project_id}")
    assert resp.status_code == 200
    assert resp.json() == []


@pytest.mark.anyio
async def test_meetings_list_via_conftest(test_client, mock_session, project_id):
    """conftest fixture로 meetings list 200."""
    mock_result = MagicMock()
    mock_result.scalars.return_value.all.return_value = []
    mock_session.execute = AsyncMock(return_value=mock_result)

    resp = await test_client.get(f"/api/v2/meetings?project_id={project_id}")
    assert resp.status_code == 200
    assert resp.json() == []


# ── Sprint 4: S19~S24 도메인 통합 테스트 ─────────────────────────────────────

@pytest.mark.anyio
async def test_stories_list_via_conftest(test_client, mock_session):
    """GET /api/v2/stories 200."""
    mock_result = MagicMock()
    mock_result.scalars.return_value.all.return_value = []
    mock_session.execute = AsyncMock(return_value=mock_result)

    resp = await test_client.get("/api/v2/stories")
    assert resp.status_code == 200
    assert resp.json() == []


@pytest.mark.anyio
async def test_projects_list_via_conftest(test_client, mock_session):
    """GET /api/v2/projects 200."""
    mock_result = MagicMock()
    mock_result.scalars.return_value.all.return_value = []
    mock_session.execute = AsyncMock(return_value=mock_result)

    resp = await test_client.get("/api/v2/projects")
    assert resp.status_code == 200
    assert resp.json() == []


@pytest.mark.anyio
async def test_team_members_list_via_conftest(test_client, mock_session):
    """GET /api/v2/team-members 200."""
    mock_result = MagicMock()
    mock_result.scalars.return_value.all.return_value = []
    mock_session.execute = AsyncMock(return_value=mock_result)

    resp = await test_client.get("/api/v2/team-members")
    assert resp.status_code == 200
    assert resp.json() == []


@pytest.mark.anyio
async def test_org_members_list_via_conftest(test_client, mock_session):
    """GET /api/v2/org-members 200."""
    mock_result = MagicMock()
    mock_result.scalars.return_value.all.return_value = []
    mock_session.execute = AsyncMock(return_value=mock_result)

    resp = await test_client.get("/api/v2/org-members")
    assert resp.status_code == 200
    assert resp.json() == []


@pytest.mark.anyio
async def test_standups_list_via_conftest(test_client, mock_session, project_id):
    """GET /api/v2/standups 200."""
    mock_result = MagicMock()
    mock_result.scalars.return_value.all.return_value = []
    mock_session.execute = AsyncMock(return_value=mock_result)

    resp = await test_client.get(f"/api/v2/standups?project_id={project_id}")
    assert resp.status_code == 200
    assert resp.json() == []


@pytest.mark.anyio
async def test_retros_list_via_conftest(test_client, mock_session, project_id):
    """GET /api/v2/retros 200."""
    mock_result = MagicMock()
    mock_result.scalars.return_value.all.return_value = []
    mock_session.execute = AsyncMock(return_value=mock_result)

    resp = await test_client.get(f"/api/v2/retros?project_id={project_id}")
    assert resp.status_code == 200
    assert resp.json() == []


# ── Sprint 5: S26~S31 도메인 통합 테스트 ─────────────────────────────────────

@pytest.mark.anyio
async def test_memos_list_via_conftest(test_client, mock_session, project_id):
    """GET /api/v2/memos 200."""
    mock_result = MagicMock()
    mock_result.scalars.return_value.all.return_value = []
    mock_session.execute = AsyncMock(return_value=mock_result)

    resp = await test_client.get(f"/api/v2/memos?project_id={project_id}")
    assert resp.status_code == 200
    assert resp.json() == []


@pytest.mark.anyio
async def test_notifications_list_via_conftest(test_client, mock_session):
    """GET /api/v2/notifications 200."""
    member_id = uuid.uuid4()
    mock_result = MagicMock()
    mock_result.scalars.return_value.all.return_value = []
    mock_session.execute = AsyncMock(return_value=mock_result)

    resp = await test_client.get(f"/api/v2/notifications?user_id={member_id}")
    assert resp.status_code == 200
    assert resp.json() == []


@pytest.mark.anyio
async def test_analytics_overview_via_conftest(test_client, mock_session, project_id):
    """GET /api/v2/analytics/overview 200."""
    mock_result = MagicMock()
    mock_result.scalars.return_value.all.return_value = []
    mock_result.scalar_one.return_value = 0
    mock_session.execute = AsyncMock(return_value=mock_result)

    resp = await test_client.get(f"/api/v2/analytics/overview?project_id={project_id}")
    assert resp.status_code == 200
    data = resp.json()
    assert "sprints" in data
    assert "epics" in data


@pytest.mark.anyio
async def test_invitations_list_via_conftest(test_client, mock_session):
    """GET /api/v2/invitations 200."""
    mock_result = MagicMock()
    mock_result.scalars.return_value.all.return_value = []
    mock_session.execute = AsyncMock(return_value=mock_result)

    resp = await test_client.get("/api/v2/invitations")
    assert resp.status_code == 200
    assert resp.json() == []


@pytest.mark.anyio
async def test_rewards_list_via_conftest(test_client, mock_session, project_id):
    """GET /api/v2/rewards 200."""
    mock_result = MagicMock()
    mock_result.scalars.return_value.all.return_value = []
    mock_session.execute = AsyncMock(return_value=mock_result)

    resp = await test_client.get(f"/api/v2/rewards?project_id={project_id}")
    assert resp.status_code == 200
    assert resp.json() == []


@pytest.mark.anyio
async def test_audit_logs_list_via_conftest(test_client, mock_session):
    """GET /api/v2/audit-logs 200."""
    mock_result = MagicMock()
    mock_result.scalars.return_value.all.return_value = []
    mock_session.execute = AsyncMock(return_value=mock_result)

    resp = await test_client.get("/api/v2/audit-logs")
    assert resp.status_code == 200
    assert resp.json() == []


@pytest.mark.anyio
async def test_me_get_via_conftest(test_client, mock_session):
    """GET /api/v2/me 404 (member 없음) — 라우터 연결 확인."""
    member_id = uuid.uuid4()
    mock_result = MagicMock()
    mock_result.scalar_one_or_none.return_value = None
    mock_session.execute = AsyncMock(return_value=mock_result)

    resp = await test_client.get(f"/api/v2/me?member_id={member_id}")
    assert resp.status_code == 404


@pytest.mark.anyio
async def test_project_settings_get_via_conftest(test_client, mock_session, project_id):
    """GET /api/v2/project-settings 200 (기본값 반환)."""
    mock_result = MagicMock()
    mock_result.scalar_one_or_none.return_value = None
    mock_session.execute = AsyncMock(return_value=mock_result)

    resp = await test_client.get(f"/api/v2/project-settings?project_id={project_id}")
    assert resp.status_code == 200
    assert resp.json()["standup_deadline"] == "09:00:00"


# ── Sprint 6: S33~S39 도메인 통합 테스트 ─────────────────────────────────────

@pytest.mark.anyio
async def test_dashboard_get_via_conftest(test_client, mock_session, project_id):
    """GET /api/v2/dashboard 200."""
    import uuid as _uuid
    member_id = _uuid.uuid4()
    mock_result = MagicMock()
    mock_result.scalar_one_or_none.return_value = project_id
    mock_result.all.return_value = []
    mock_session.execute = AsyncMock(return_value=mock_result)

    resp = await test_client.get(f"/api/v2/dashboard?member_id={member_id}&project_id={project_id}")
    assert resp.status_code == 200
    assert "my_stories" in resp.json()


@pytest.mark.anyio
async def test_current_project_get_via_conftest(test_client, mock_session):
    """GET /api/v2/current-project 200 (member 없으면 null)."""
    import uuid as _uuid
    member_id = _uuid.uuid4()
    mock_result = MagicMock()
    mock_result.first.return_value = None
    mock_session.execute = AsyncMock(return_value=mock_result)

    resp = await test_client.get(f"/api/v2/current-project?member_id={member_id}")
    assert resp.status_code == 200
    assert resp.json()["project_id"] is None


@pytest.mark.anyio
async def test_members_list_via_conftest_s6(test_client, mock_session, project_id):
    """GET /api/v2/members 200."""
    mock_result = MagicMock()
    mock_result.scalars.return_value.all.return_value = []
    mock_session.execute = AsyncMock(return_value=mock_result)

    resp = await test_client.get(f"/api/v2/members?project_id={project_id}")
    assert resp.status_code == 200
    assert resp.json() == []


@pytest.mark.anyio
async def test_webhooks_config_list_via_conftest(test_client, mock_session):
    """GET /api/v2/webhooks/config 200."""
    mock_result = MagicMock()
    mock_result.scalars.return_value.all.return_value = []
    mock_session.execute = AsyncMock(return_value=mock_result)

    resp = await test_client.get("/api/v2/webhooks/config")
    assert resp.status_code == 200
    assert resp.json() == []


@pytest.mark.anyio
async def test_agent_keys_list_via_conftest(test_client, mock_session):
    """GET /api/v2/agents/{id}/api-keys — agent 없으면 404."""
    import uuid as _uuid
    agent_id = _uuid.uuid4()
    mock_result = MagicMock()
    mock_result.scalar_one_or_none.return_value = None
    mock_session.execute = AsyncMock(return_value=mock_result)

    resp = await test_client.get(f"/api/v2/agents/{agent_id}/api-keys")
    assert resp.status_code == 404


@pytest.mark.anyio
async def test_agent_runs_list_via_conftest(test_client, mock_session, project_id):
    """GET /api/v2/agent-runs 200."""
    mock_result = MagicMock()
    mock_result.all.return_value = []
    mock_result.scalars.return_value.all.return_value = []
    mock_session.execute = AsyncMock(return_value=mock_result)

    resp = await test_client.get(f"/api/v2/agent-runs?project_id={project_id}")
    assert resp.status_code == 200
    assert resp.json() == []


@pytest.mark.anyio
async def test_notification_settings_get_via_conftest_s6(test_client, mock_session):
    """GET /api/v2/notification-settings 200."""
    import uuid as _uuid
    member_id = _uuid.uuid4()
    mock_result = MagicMock()
    mock_result.scalars.return_value.all.return_value = []
    mock_session.execute = AsyncMock(return_value=mock_result)

    resp = await test_client.get(f"/api/v2/notification-settings?member_id={member_id}")
    assert resp.status_code == 200
    assert resp.json() == []


@pytest.mark.anyio
async def test_policy_documents_get_via_conftest(test_client, mock_session, project_id):
    """GET /api/v2/policy-documents 200."""
    mock_result = MagicMock()
    mock_result.scalars.return_value.all.return_value = []
    mock_session.execute = AsyncMock(return_value=mock_result)

    resp = await test_client.get(f"/api/v2/policy-documents?project_id={project_id}")
    assert resp.status_code == 200
    assert resp.json() == []


@pytest.mark.anyio
async def test_subscription_status_via_conftest(test_client, mock_session):
    """GET /api/v2/subscription/status 200 (기본값 반환)."""
    mock_result = MagicMock()
    mock_result.first.return_value = None
    mock_session.execute = AsyncMock(return_value=mock_result)

    resp = await test_client.get("/api/v2/subscription/status")
    assert resp.status_code == 200
    assert resp.json()["status"] == "active"
    assert resp.json()["tier"] == "free"


@pytest.mark.anyio
async def test_oss_seed_already_seeded_via_conftest(test_client, mock_session, project_id, org_id):
    """POST /api/v2/oss/seed — 데이터 있으면 already_has_data 200."""
    count_result = MagicMock()
    count_result.scalar_one.return_value = 3
    mock_session.execute = AsyncMock(return_value=count_result)

    resp = await test_client.post(f"/api/v2/oss/seed?project_id={project_id}&org_id={org_id}")
    assert resp.status_code == 200
    assert resp.json()["seeded"] is False
    assert resp.json()["reason"] == "already_has_data"


# ── Sprint 7: S41~S47 Phase B FastAPI 통합 ────────────────────────────────────

async def _make_full_client_s7(mock_session):
    """org_id + project_id 포함 클라이언트 (S41+ 라우터용)."""
    from httpx import ASGITransport, AsyncClient
    from app.main import app
    from app.dependencies.auth import get_current_user
    from app.dependencies.database import get_db
    ctx = MagicMock()
    ctx.user_id = uuid.uuid4()
    ctx.claims = {"app_metadata": {"org_id": str(uuid.uuid4()), "project_id": str(uuid.uuid4())}}

    async def _db():
        yield mock_session

    async def _auth():
        return ctx

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test"), app


@pytest.mark.anyio
async def test_agent_deployments_list_s7(mock_session):
    """GET /api/v2/agent-deployments 200 — envelope 형식."""
    from unittest.mock import patch
    client, app = await _make_full_client_s7(mock_session)
    try:
        with patch(
            "app.services.deployment_lifecycle.DeploymentLifecycleService.build_cards",
            new_callable=AsyncMock,
            return_value=[],
        ):
            async with client as c:
                resp = await c.get("/api/v2/agent-deployments")
        assert resp.status_code == 200
        assert resp.json()["error"] is None
        assert isinstance(resp.json()["data"], list)
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_agent_personas_list_s7(mock_session):
    """GET /api/v2/agent-personas 200 — S42 라우터 등록 확인."""
    client, app = await _make_full_client_s7(mock_session)
    try:
        mock_result = MagicMock()
        mock_result.scalars.return_value.all.return_value = []
        mock_session.execute = AsyncMock(return_value=mock_result)
        agent_id = uuid.uuid4()
        async with client as c:
            resp = await c.get(f"/api/v2/agent-personas?agent_id={agent_id}")
        assert resp.status_code == 200
        assert resp.json()["error"] is None
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_agent_routing_rules_list_s7(mock_session):
    """GET /api/v2/agent-routing-rules 200 — S43 라우터 등록 확인."""
    client, app = await _make_full_client_s7(mock_session)
    try:
        mock_result = MagicMock()
        mock_result.scalars.return_value.all.return_value = []
        mock_session.execute = AsyncMock(return_value=mock_result)
        async with client as c:
            resp = await c.get("/api/v2/agent-routing-rules")
        assert resp.status_code == 200
        assert resp.json()["error"] is None
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_bridge_teams_conversation_update_s7(test_client, mock_session):
    """POST /api/v2/bridge/teams/events conversationUpdate — S47 등록 확인."""
    resp = await test_client.post("/api/v2/bridge/teams/events", json={"type": "conversationUpdate"})
    assert resp.status_code == 200
    assert resp.json()["ok"] is True
