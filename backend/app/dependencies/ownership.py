import uuid

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.project import OrgMember
from app.models.team import TeamMember


async def _is_org_admin(session: AsyncSession, org_id: uuid.UUID, user_id: uuid.UUID) -> bool:
    result = await session.execute(
        select(OrgMember.role).where(
            OrgMember.org_id == org_id,
            OrgMember.user_id == user_id,
            OrgMember.deleted_at.is_(None),
        )
    )
    role = result.scalar_one_or_none()
    return role in ("admin", "owner")


async def assert_agent_owner(
    agent_id: uuid.UUID,
    session: AsyncSession,
    org_id: uuid.UUID,
    current_user_id: uuid.UUID,
) -> TeamMember:
    """agent 존재 확인 + ownership guard. TeamMember를 반환."""
    result = await session.execute(
        # team_members projection VIEW — multi-project agent N 행. 아래선 .created_by(동형) ownership
        # guard + org_id 필터만 쓰므로 .limit(1) 로 MultipleResultsFound 회피(아무 projection 행 OK).
        select(TeamMember).where(
            TeamMember.id == agent_id,
            TeamMember.type == "agent",
            TeamMember.org_id == org_id,
        ).limit(1)
    )
    agent = result.scalar_one_or_none()
    if agent is None:
        raise HTTPException(status_code=404, detail="Agent not found")
    # story #4000 그라운딩 중 발견(f0c99070/test_d764522c 실DB 회귀로 실측) — 이 코드베이스
    # 전역에서 agent는 자기 자신의 API 키로 인증해 스스로 API를 호출하는 게 정상 패턴이다
    # (`user_id`가 agent 자신의 member id인 AuthContext, 수십 개 realdb 테스트가 이 패턴을
    # 씀 — 휴먼 전용이 아님). 자기 자신을 대상으로 한 호출까지 막으면 자기소유 아닌 것으로
    # 오판정돼 agent 자기서비스(예: 자기 라우팅 규칙 disable_all)가 전부 403 난다.
    if agent_id == current_user_id:
        return agent
    if agent.created_by == current_user_id:
        return agent
    if await _is_org_admin(session, org_id, current_user_id):
        return agent
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not the owner of this agent")
