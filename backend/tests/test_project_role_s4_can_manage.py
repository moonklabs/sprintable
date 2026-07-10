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
    session = AsyncMock()

    # E-SECURITY SEC-S8(L): create_team_member가 이제 role 게이트 前 target-org 대조(신설)를
    # 먼저 하므로 no-op으로 통과시켜 이 테스트의 실제 관심사(role 게이트 자체)만 검증.
    with patch("app.routers.team_members._resolve_actor", new=AsyncMock(return_value=actor)), \
         patch("app.services.project_auth.assert_target_in_caller_org", new=MagicMock(return_value=None)), \
         patch("app.services.project_auth.has_project_role", new=AsyncMock(return_value=False)) as hpr:
        with pytest.raises(HTTPException) as ei:
            await create_team_member(body, session=session, auth=_auth(), org_id=org)
    assert ei.value.status_code == 403
    # role 경로 사용 확認: 이제 actor 무관 target(body.project_id) 기준으로 단일 호출.
    hpr.assert_awaited_once()
    assert hpr.await_args.kwargs.get("min_role") == "admin"
    assert hpr.await_args.args[2] == body.project_id


@pytest.mark.anyio
async def test_team_member_create_human_actor_now_gated():
    """E-SECURITY SEC-S8(L) 회귀: human actor(또는 actor 미해소)도 이제 동일 게이트 적용 —
    과거엔 `if actor.type=="agent"`에 갇혀 human이면 인가가 통째로 스킵되던 CRITICAL 갭이었다.
    무권한 human은 403(게이트가 410 deprecated-check보다 먼저 실행돼 has_project_role이 실제
    호출됨)."""
    from app.routers.team_members import create_team_member
    from app.schemas.team_member import TeamMemberCreate

    org = uuid.uuid4()
    body = TeamMemberCreate(project_id=uuid.uuid4(), org_id=org, type="human", name="x")
    human = MagicMock()
    human.type = "human"
    session = AsyncMock()

    with patch("app.routers.team_members._resolve_actor", new=AsyncMock(return_value=human)), \
         patch("app.services.project_auth.assert_target_in_caller_org", new=MagicMock(return_value=None)), \
         patch("app.services.project_auth.has_project_role", new=AsyncMock(return_value=False)) as hpr:
        from fastapi import HTTPException

        with pytest.raises(HTTPException) as ei:
            await create_team_member(body, session=session, auth=_auth(), org_id=org)
        assert ei.value.status_code == 403
    hpr.assert_awaited_once()


# ── create_org_agent (agents.py) ─────────────────────────────────────────────


@pytest.mark.anyio
async def test_org_agent_create_agent_no_admin_403():
    from fastapi import HTTPException

    from app.routers.agents import create_org_agent
    from app.schemas.team_member import OrgAgentCreate

    org = uuid.uuid4()
    body = OrgAgentCreate(name="cos", scope_mode="org")
    actor = _agent_actor()
    session = AsyncMock()
    # E-SECURITY SEC-S8(O): _resolve_org_project_ids가 이제 role 체크보다 먼저 실행돼(grant
    # 대상 전체를 role 검증 대상으로 삼기 위함) org 프로젝트 목록 조회를 먼저 만족시켜야 한다.
    single_project_id = uuid.uuid4()
    mock_result = MagicMock()
    mock_result.all.return_value = [(single_project_id,)]
    session.execute = AsyncMock(return_value=mock_result)

    with patch("app.routers.team_members._resolve_actor", new=AsyncMock(return_value=actor)), patch(
        "app.services.project_auth.has_project_role", new=AsyncMock(return_value=False)
    ) as hpr:
        with pytest.raises(HTTPException) as ei:
            await create_org_agent(body, session=session, auth=_auth(), org_id=org)
    assert ei.value.status_code == 403
    hpr.assert_awaited_once()
    assert hpr.await_args.kwargs.get("min_role") == "admin"
    # O 회귀 확認: grant 대상(single_project_id) 기준으로 검증됐지 actor.project_id가 아니어야 함.
    assert hpr.await_args.args[2] == single_project_id
