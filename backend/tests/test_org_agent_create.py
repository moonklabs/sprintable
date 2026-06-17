"""S3: org-level 멀티프로젝트 에이전트 생성(POST /api/v2/agents) + 서비스 fan-out 테스트."""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock

import pytest


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _projects_result(project_ids):
    r = MagicMock()
    r.all.return_value = [(p,) for p in project_ids]
    return r


# ─── _resolve_org_project_ids: scope_mode 해소 ────────────────────────────────


@pytest.mark.anyio
async def test_resolve_scope_org_returns_all_projects():
    from app.routers.agents import _resolve_org_project_ids
    from app.schemas.team_member import OrgAgentCreate

    p1, p2 = uuid.uuid4(), uuid.uuid4()
    session = MagicMock()
    session.execute = AsyncMock(return_value=_projects_result([p1, p2]))
    body = OrgAgentCreate(name="CoS", scope_mode="org")
    out = await _resolve_org_project_ids(body, session, uuid.uuid4())
    assert out == [p1, p2]


@pytest.mark.anyio
async def test_resolve_scope_projects_validates_subset_and_dedups():
    from app.routers.agents import _resolve_org_project_ids
    from app.schemas.team_member import OrgAgentCreate

    p1, p2, p3 = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    session = MagicMock()
    session.execute = AsyncMock(return_value=_projects_result([p1, p2, p3]))
    # 중복 포함 + 순서 보존
    body = OrgAgentCreate(name="CoS", scope_mode="projects", project_ids=[p2, p1, p2])
    out = await _resolve_org_project_ids(body, session, uuid.uuid4())
    assert out == [p2, p1]


@pytest.mark.anyio
async def test_resolve_scope_projects_rejects_foreign_project():
    from fastapi import HTTPException

    from app.routers.agents import _resolve_org_project_ids
    from app.schemas.team_member import OrgAgentCreate

    p1, foreign = uuid.uuid4(), uuid.uuid4()
    session = MagicMock()
    session.execute = AsyncMock(return_value=_projects_result([p1]))
    body = OrgAgentCreate(name="CoS", scope_mode="projects", project_ids=[foreign])
    with pytest.raises(HTTPException) as ei:
        await _resolve_org_project_ids(body, session, uuid.uuid4())
    assert ei.value.status_code == 400


@pytest.mark.anyio
async def test_resolve_scope_projects_requires_ids():
    from fastapi import HTTPException

    from app.routers.agents import _resolve_org_project_ids
    from app.schemas.team_member import OrgAgentCreate

    session = MagicMock()
    session.execute = AsyncMock(return_value=_projects_result([uuid.uuid4()]))
    body = OrgAgentCreate(name="CoS", scope_mode="projects", project_ids=[])
    with pytest.raises(HTTPException) as ei:
        await _resolve_org_project_ids(body, session, uuid.uuid4())
    assert ei.value.status_code == 400


@pytest.mark.anyio
async def test_resolve_invalid_scope_mode():
    from fastapi import HTTPException

    from app.routers.agents import _resolve_org_project_ids
    from app.schemas.team_member import OrgAgentCreate

    session = MagicMock()
    session.execute = AsyncMock(return_value=_projects_result([uuid.uuid4()]))
    body = OrgAgentCreate(name="CoS", scope_mode="bogus")
    with pytest.raises(HTTPException) as ei:
        await _resolve_org_project_ids(body, session, uuid.uuid4())
    assert ei.value.status_code == 400


# ─── create_org_level_agent: members/api_key 1회 + N grant fan-out ────────────


@pytest.mark.anyio
async def test_create_org_level_agent_fans_out_grants(monkeypatch):
    from app.services import org_agent

    session = MagicMock()
    port_res = MagicMock()
    port_res.all.return_value = []  # 미사용 포트 조회 → 빈
    session.execute = AsyncMock(return_value=port_res)
    session.flush = AsyncMock()

    calls = {"sync": 0, "placement": []}

    async def fake_sync(_s, member, _cb):
        calls["sync"] += 1

    async def fake_place(_s, **kw):
        calls["placement"].append(kw["project_id"])

    monkeypatch.setattr(org_agent, "sync_agent_anchor_on_create", fake_sync)
    monkeypatch.setattr(org_agent, "write_agent_project_placement", fake_place)
    monkeypatch.setattr(
        "app.services.notification_preference_defaults.insert_default_preferences",
        AsyncMock(),
    )
    monkeypatch.setattr(
        "app.services.agent_message_policy.ensure_creator_allowlisted", AsyncMock()
    )

    class _FakeApiKeyRepo:
        def __init__(self, _s):
            pass

        async def create(self, team_member_id, scope):
            return (MagicMock(), "sk_live_test")

    monkeypatch.setattr("app.repositories.api_key.ApiKeyRepository", _FakeApiKeyRepo)

    p1, p2, p3 = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    member, key = await org_agent.create_org_level_agent(
        session,
        org_id=uuid.uuid4(),
        created_by=uuid.uuid4(),
        name="Chief of Staff",
        project_ids=[p1, p2, p3],
    )

    assert calls["sync"] == 1  # 앵커 프로젝트는 anchor write-sync 1회
    assert calls["placement"] == [p2, p3]  # 나머지 프로젝트만 placement
    assert member.project_id == p1  # 앵커 프로젝트
    assert member.type == "agent"
    assert key == "sk_live_test"


@pytest.mark.anyio
async def test_create_org_level_agent_empty_projects_raises(monkeypatch):
    from app.services import org_agent

    session = MagicMock()
    with pytest.raises(ValueError):
        await org_agent.create_org_level_agent(
            session, org_id=uuid.uuid4(), created_by=None, name="x", project_ids=[]
        )
