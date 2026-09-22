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
    """agent 존재 확인 + ownership guard. TeamMember를 반환.

    읽기(list/조회) 경로도 이 함수를 쓴다 — 「시스템 발행」 예약 거부(story #3999)는 이
    함수에 넣지 않는다. 쓰기 경로는 아래 `assert_agent_owner_mutable`을 쓴다."""
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
    if agent.created_by == current_user_id:
        return agent
    if await _is_org_admin(session, org_id, current_user_id):
        return agent
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not the owner of this agent")


async def assert_agent_owner_mutable(
    agent_id: uuid.UUID,
    session: AsyncSession,
    org_id: uuid.UUID,
    current_user_id: uuid.UUID,
) -> TeamMember:
    """story #3999 — `assert_agent_owner` + 「시스템 발행」(runtime_type=='system-publisher')
    예약 거부. AC1 census로 확認된 모든 쓰기(mutation) 경로(키 발급/회전/폐기·PATCH/DELETE
    team-members·아바타·메시지 정책·recruit)가 이 함수 하나로 좁혀진다 — #3994의 「canEdit
    한 곳」 원칙과 동형(자리마다 조건 분산 금지). 409 SYSTEM_PUBLISHER_RESERVED, 부작용 0
    (ownership 통과 여부와 무관하게 이 시점 이후 아무 write도 실행되지 않은 채 즉시 raise)."""
    from app.services.system_publisher_guard import assert_not_system_publisher

    agent = await assert_agent_owner(agent_id, session, org_id, current_user_id)
    assert_not_system_publisher(agent.runtime_type)
    return agent
