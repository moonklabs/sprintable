"""story #2486(두 번째 문): agents.py 6개 엔드포인트를 ``get_verified_org_id``에서
``get_verified_org_id_no_project_gate``로 스왑한 회귀 고정.

role_templates(#2875)와 동일 근본 — BFF가 모든 프록시 호출에 브라우저 탭의 X-Project-Id를
무조건 실어 보내는데, agents.py는 자체 인가(org owner/admin·agent 소유권·body.project_ids)를
쓰지 탭이 지금 보고 있는 프로젝트와는 무관하다. PO 조건(2026-08-06):
① 각 엔드포인트의 실제 인가는 그대로 — X-Project-Id 부작용만 제거.
② 엔드포인트별 양성(비접근 X-Project-Id→200/201)·음성(진짜 무권한→403·unauth→401) 대조.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock

import pytest

from tests.conftest import override_db_and_read


def _mock_agent_member(*, org_id: uuid.UUID, project_id: uuid.UUID) -> MagicMock:
    m = MagicMock()
    m.id = uuid.uuid4()
    m.project_id = project_id
    m.org_id = org_id
    m.user_id = None
    m.type = "agent"
    m.name = "probe-agent"
    m.role = "member"
    m.avatar_url = None
    m.agent_config = None
    m.is_active = True
    m.color = "#3385f8"
    m.agent_role = None
    m.runtime_type = None
    m.created_by = None
    m.can_manage_members = False
    m.created_at = datetime(2026, 8, 6, tzinfo=timezone.utc)
    m.updated_at = datetime(2026, 8, 6, tzinfo=timezone.utc)
    m.last_seen_at = None
    m.active_story_id = None
    m.agent_status = None
    m.active_story = None
    m.fakechat_port = None
    return m


@pytest.mark.anyio
async def test_create_org_agent_ignores_inaccessible_x_project_id_when_org_admin(
    test_client, mock_session, monkeypatch, org_id
):
    """양성대조: org owner/admin이면 탭이 비접근 프로젝트를 가리켜도 201(과거엔 403)."""
    import app.routers.agents as agents_router
    import app.routers.team_members as team_members_router
    import app.services.project_auth as project_auth

    project_id = uuid.uuid4()
    monkeypatch.setattr(
        agents_router, "_resolve_org_project_ids", AsyncMock(return_value=[project_id])
    )
    monkeypatch.setattr(team_members_router, "_resolve_actor", AsyncMock(return_value=None))
    monkeypatch.setattr(project_auth, "is_org_owner_or_admin", AsyncMock(return_value=True))

    member = _mock_agent_member(org_id=org_id, project_id=project_id)
    monkeypatch.setattr(
        agents_router, "create_org_level_agent", AsyncMock(return_value=(member, "sk_live_probe"))
    )
    monkeypatch.setattr(
        agents_router, "emit_onboarding_event", AsyncMock(return_value=None)
    )
    mock_session.commit = AsyncMock(return_value=None)

    inaccessible_project_id = str(uuid.uuid4())
    resp = await test_client.post(
        "/api/v2/agents",
        json={"name": "probe-agent", "role": "member", "scope_mode": "org"},
        headers={"X-Project-Id": inaccessible_project_id},
    )
    assert resp.status_code == 201


@pytest.mark.anyio
async def test_create_org_agent_still_403_for_genuine_non_admin(
    test_client, mock_session, monkeypatch, org_id
):
    """음성대조: 진짜 org owner/admin이 아니면(비-owner) 여전히 403 — 단 메시지는
    project-access가 아니라 실제 authz 실패("org admin/owner role required")여야
    project-gate 제거가 인가 자체를 열어버린 게 아님을 증명한다."""
    import app.routers.agents as agents_router
    import app.routers.team_members as team_members_router
    import app.services.project_auth as project_auth

    project_id = uuid.uuid4()
    monkeypatch.setattr(
        agents_router, "_resolve_org_project_ids", AsyncMock(return_value=[project_id])
    )
    monkeypatch.setattr(team_members_router, "_resolve_actor", AsyncMock(return_value=None))
    monkeypatch.setattr(project_auth, "is_org_owner_or_admin", AsyncMock(return_value=False))

    resp = await test_client.post(
        "/api/v2/agents",
        json={"name": "probe-agent", "role": "member", "scope_mode": "org"},
    )
    assert resp.status_code == 403
    assert "admin" in resp.json()["error"]["message"].lower()


@pytest.mark.anyio
async def test_get_agent_access_matrix_ignores_inaccessible_x_project_id_when_org_admin(
    test_client, mock_session, monkeypatch
):
    """양성대조 — access-matrix(가장 가벼운 엔드포인트)로도 동일 패턴 재확인."""
    import app.services.project_auth as project_auth

    monkeypatch.setattr(project_auth, "is_org_owner_or_admin", AsyncMock(return_value=True))
    res = MagicMock()
    res.all.return_value = []
    mock_session.execute = AsyncMock(return_value=res)

    inaccessible_project_id = str(uuid.uuid4())
    resp = await test_client.get(
        "/api/v2/agents/access-matrix", headers={"X-Project-Id": inaccessible_project_id}
    )
    assert resp.status_code == 200


@pytest.mark.anyio
async def test_get_agent_access_matrix_still_403_for_genuine_non_admin(
    test_client, mock_session, monkeypatch
):
    """음성대조 — access-matrix도 진짜 무권한이면 여전히 403."""
    import app.services.project_auth as project_auth

    monkeypatch.setattr(project_auth, "is_org_owner_or_admin", AsyncMock(return_value=False))

    resp = await test_client.get("/api/v2/agents/access-matrix")
    assert resp.status_code == 403


@pytest.mark.anyio
async def test_recruit_ignores_inaccessible_x_project_id_when_owner(
    test_client, mock_session, monkeypatch, org_id
):
    """양성대조 — POST /{agent_id}/recruit (위저드 2단계, 라이브 재현 지점)."""
    import app.routers.agents as agents_router

    agent_id = uuid.uuid4()
    project_id = uuid.uuid4()
    member = _mock_agent_member(org_id=org_id, project_id=project_id)
    monkeypatch.setattr(agents_router, "assert_agent_owner", AsyncMock(return_value=member))

    role_template = MagicMock()
    role_template.slug = "backend-dev"
    monkeypatch.setattr(
        agents_router, "get_published_role_template", AsyncMock(return_value=role_template)
    )

    persona = MagicMock()
    persona.id = uuid.uuid4()
    persona.system_prompt = "probe prompt"
    monkeypatch.setattr(
        agents_router,
        "recruit_agent",
        AsyncMock(
            return_value={
                "persona": persona,
                "api_key_plaintext": "sk_live_probe",
                "tool_allowlist": ["stories", "chat"],
            }
        ),
    )
    monkeypatch.setattr(
        agents_router,
        "build_agent_mcp_config_bundle",
        MagicMock(return_value={"mcp_config": {}, "default_transport": "stdio", "mcp_config_alternatives": {}}),
    )
    monkeypatch.setattr(agents_router, "emit_onboarding_event", AsyncMock(return_value=None))
    mock_session.commit = AsyncMock(return_value=None)

    inaccessible_project_id = str(uuid.uuid4())
    resp = await test_client.post(
        f"/api/v2/agents/{agent_id}/recruit",
        json={"role_template_slug": "backend-dev", "runtime": "claude-code"},
        headers={"X-Project-Id": inaccessible_project_id},
    )
    assert resp.status_code == 201


@pytest.mark.anyio
async def test_recruit_still_403_for_genuine_non_owner(test_client, mock_session, monkeypatch):
    """음성대조 — recruit도 진짜 non-owner/non-admin이면 여전히 403(assert_agent_owner 그대로)."""
    from fastapi import HTTPException

    import app.routers.agents as agents_router

    agent_id = uuid.uuid4()
    monkeypatch.setattr(
        agents_router,
        "assert_agent_owner",
        AsyncMock(side_effect=HTTPException(status_code=403, detail="Not the owner of this agent")),
    )

    resp = await test_client.post(
        f"/api/v2/agents/{agent_id}/recruit",
        json={"role_template_slug": "backend-dev", "runtime": "claude-code"},
    )
    assert resp.status_code == 403
    assert "owner" in resp.json()["error"]["message"].lower()


@pytest.mark.anyio
async def test_verify_connection_ignores_inaccessible_x_project_id_when_owner(
    test_client, mock_session, monkeypatch, org_id
):
    """양성대조 — POST /{agent_id}/verify-connection (transport=http, SSE 우회 최단경로)."""
    import app.routers.agents as agents_router

    agent_id = uuid.uuid4()
    project_id = uuid.uuid4()
    member = _mock_agent_member(org_id=org_id, project_id=project_id)
    monkeypatch.setattr(agents_router, "assert_agent_owner", AsyncMock(return_value=member))
    monkeypatch.setattr(
        agents_router,
        "get_verification_state",
        AsyncMock(return_value={"verified": False, "rail": []}),
    )

    inaccessible_project_id = str(uuid.uuid4())
    resp = await test_client.post(
        f"/api/v2/agents/{agent_id}/verify-connection",
        params={"transport": "http"},
        headers={"X-Project-Id": inaccessible_project_id},
    )
    assert resp.status_code == 200


@pytest.mark.anyio
async def test_verification_status_ignores_inaccessible_x_project_id_when_owner(
    test_client, mock_session, monkeypatch, org_id
):
    """양성대조 — GET /{agent_id}/verification-status."""
    import app.routers.agents as agents_router

    agent_id = uuid.uuid4()
    project_id = uuid.uuid4()
    member = _mock_agent_member(org_id=org_id, project_id=project_id)
    monkeypatch.setattr(agents_router, "_fetch_org_agent", AsyncMock(return_value=member))
    monkeypatch.setattr(
        agents_router,
        "get_verification_state",
        AsyncMock(return_value={"verified": False, "rail": [], "verify_seq": None}),
    )

    inaccessible_project_id = str(uuid.uuid4())
    resp = await test_client.get(
        f"/api/v2/agents/{agent_id}/verification-status",
        headers={"X-Project-Id": inaccessible_project_id},
    )
    assert resp.status_code == 200


@pytest.mark.anyio
async def test_connection_artifact_ignores_inaccessible_x_project_id_when_owner(
    test_client, mock_session, monkeypatch, org_id
):
    """양성대조 — GET /{agent_id}/connection-artifact (org-scope anti-IDOR 조회, ownership 무관)."""
    import app.routers.agents as agents_router
    from app.repositories.agent_persona import AgentPersonaRepository

    agent_id = uuid.uuid4()
    project_id = uuid.uuid4()
    member = _mock_agent_member(org_id=org_id, project_id=project_id)
    res = MagicMock()
    res.scalar_one_or_none.return_value = member
    mock_session.execute = AsyncMock(return_value=res)
    monkeypatch.setattr(AgentPersonaRepository, "list", AsyncMock(return_value=[]))
    monkeypatch.setattr(
        agents_router,
        "build_agent_mcp_config",
        MagicMock(return_value={"mcpServers": {}}),
    )
    monkeypatch.setattr(agents_router, "emit_onboarding_event", AsyncMock(return_value=None))
    mock_session.commit = AsyncMock(return_value=None)

    inaccessible_project_id = str(uuid.uuid4())
    resp = await test_client.get(
        f"/api/v2/agents/{agent_id}/connection-artifact",
        headers={"X-Project-Id": inaccessible_project_id},
    )
    assert resp.status_code == 200


@pytest.mark.anyio
async def test_no_project_gate_dependency_still_enforces_org_membership(monkeypatch, org_id):
    """PO 리뷰 급소①(2026-08-06): ``get_verified_org_id_no_project_gate``가 project-gate만
    뺐지 org membership 검증까지 열어버린 건 아님을 직접(dependency 단위) 확인 —
    X-Org-Id 헤더로 실제 비멤버 org를 지정하면 여전히 403이어야 한다."""
    from fastapi import HTTPException

    import app.dependencies.auth as auth_module
    from app.dependencies.auth import AuthContext, get_verified_org_id_no_project_gate

    auth = AuthContext(user_id=str(uuid.uuid4()), email=None, claims={}, org_id=None)

    async def _not_a_member(*args, **kwargs):
        raise HTTPException(status_code=403, detail="해당 조직의 멤버가 아닌")

    monkeypatch.setattr(auth_module, "_verify_org_membership", _not_a_member)

    with pytest.raises(HTTPException) as ei:
        await get_verified_org_id_no_project_gate(
            auth=auth, x_org_id=str(org_id), request=None
        )
    assert ei.value.status_code == 403


@pytest.mark.anyio
async def test_agents_router_still_401_without_auth_http(mock_session):
    """unauth→401 — role_templates(#2875) 회귀 패턴 재사용. 이 라우터도 로그인 자체는
    여전히 필수임을 pin(대표로 create+access-matrix 2개)."""
    from httpx import ASGITransport, AsyncClient

    from app.main import app

    async def _override_db():
        yield mock_session

    override_db_and_read(app, _override_db)
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            create_resp = await client.post(
                "/api/v2/agents",
                json={"name": "probe-agent", "role": "member", "scope_mode": "org"},
            )
            matrix_resp = await client.get("/api/v2/agents/access-matrix")
    finally:
        app.dependency_overrides.clear()

    assert create_resp.status_code == 401
    assert matrix_resp.status_code == 401
