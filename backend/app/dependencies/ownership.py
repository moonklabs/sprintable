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
        select(TeamMember).where(
            TeamMember.id == agent_id,
            TeamMember.type == "agent",
            TeamMember.org_id == org_id,
        )
    )
    agent = result.scalar_one_or_none()
    if agent is None:
        raise HTTPException(status_code=404, detail="Agent not found")
    if agent.created_by == current_user_id:
        return agent
    if await _is_org_admin(session, org_id, current_user_id):
        return agent
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not the owner of this agent")
