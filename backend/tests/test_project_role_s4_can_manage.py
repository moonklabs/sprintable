"""E-MEMBER-POLICY S4: can_manage_members enforcement → has_project_role(min='admin') 전환.

agent actor 의 멤버 생성 권한을 can_manage_members 플래그 대신 effective 프로젝트 역할로 판정.
"""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _agent_actor():
    a = MagicMock()
    a.type = "agent"
    a.id = uuid.uuid4()
    a.project_id = uuid.uuid4()
    a.role = "admin"
    a.name = "actor-agent"
    return a


def _auth():
    a = MagicMock()
    a.user_id = str(uuid.uuid4())
    a.claims = {"app_metadata": {}}
    return a


# ── create_team_member (team_members.py) ─────────────────────────────────────


@pytest.mark.anyio
async def test_team_member_create_agent_no_admin_403():
    from fastapi import HTTPException

    from app.routers.team_members import create_team_member
    from app.schemas.team_member import TeamMemberCreate

    org = uuid.uuid4()
    body = TeamMemberCreate(project_id=uuid.uuid4(), org_id=org, type="agent", name="new-agent")
    actor = _agent_actor()
    session = MagicMock()

    with patch("app.routers.team_members._resolve_actor", new=AsyncMock(return_value=actor)), patch(
        "app.services.project_auth.has_project_role", new=AsyncMock(return_value=False)
    ) as hpr:
        with pytest.raises(HTTPException) as ei:
            await create_team_member(body, session=session, auth=_auth(), org_id=org)
    assert ei.value.status_code == 403
    # role 경로 사용 확認: actor.id·actor.project_id·min='admin'
    hpr.assert_awaited_once()
    assert hpr.await_args.kwargs.get("min_role") == "admin"


@pytest.mark.anyio
async def test_team_member_create_human_actor_skips_gate():
    """human actor 는 agent 전용 게이트 미적용(has_project_role 미호출) — 무회귀."""
    from app.routers.team_members import create_team_member
    from app.schemas.team_member import TeamMemberCreate

    org = uuid.uuid4()
    body = TeamMemberCreate(project_id=uuid.uuid4(), org_id=org, type="human", name="x")
    human = MagicMock()
    human.type = "human"
    session = MagicMock()

    with patch("app.routers.team_members._resolve_actor", new=AsyncMock(return_value=human)), patch(
        "app.services.project_auth.has_project_role", new=AsyncMock(return_value=False)
    ) as hpr:
        # human create 는 410(deprecated)로 끊기지만 게이트(has_project_role) 전에 막힘 → 미호출
        from fastapi import HTTPException

        with pytest.raises(HTTPException):
            await create_team_member(body, session=session, auth=_auth(), org_id=org)
    hpr.assert_not_awaited()


# ── create_org_agent (agents.py) ─────────────────────────────────────────────


@pytest.mark.anyio
async def test_org_agent_create_agent_no_admin_403():
    from fastapi import HTTPException

    from app.routers.agents import create_org_agent
    from app.schemas.team_member import OrgAgentCreate

    org = uuid.uuid4()
    body = OrgAgentCreate(name="cos", scope_mode="org")
    actor = _agent_actor()
    session = MagicMock()

    with patch("app.routers.team_members._resolve_actor", new=AsyncMock(return_value=actor)), patch(
        "app.services.project_auth.has_project_role", new=AsyncMock(return_value=False)
    ) as hpr:
        with pytest.raises(HTTPException) as ei:
            await create_org_agent(body, session=session, auth=_auth(), org_id=org)
    assert ei.value.status_code == 403
    hpr.assert_awaited_once()
    assert hpr.await_args.kwargs.get("min_role") == "admin"
