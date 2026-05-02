import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import joinedload
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user
from app.dependencies.database import get_db
from app.models.team import TeamMember
from app.schemas.me import MeResponse, UpdateMe

router = APIRouter(prefix="/api/v2/me", tags=["me"])


@router.get("", response_model=MeResponse)
async def get_me(
    member_id: uuid.UUID | None = Query(default=None),
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
) -> MeResponse:
    resolved_id = member_id or uuid.UUID(auth.user_id)
    result = await session.execute(
        select(TeamMember)
        .options(joinedload(TeamMember.project))
        .where(TeamMember.id == resolved_id)
    )
    member = result.scalar_one_or_none()
    if member is None:
        raise HTTPException(status_code=404, detail="Member not found")
    data = MeResponse.model_validate(member)
    data.project_name = member.project.name if member.project else None
    return data


@router.patch("", response_model=MeResponse)
async def update_me(
    member_id: uuid.UUID = Query(...),
    body: UpdateMe = ...,
    session: AsyncSession = Depends(get_db),
    _auth: AuthContext = Depends(get_current_user),
) -> MeResponse:
    result = await session.execute(
        select(TeamMember).where(TeamMember.id == member_id)
    )
    member = result.scalar_one_or_none()
    if member is None:
        raise HTTPException(status_code=404, detail="Member not found")
    member.name = body.name
    await session.flush()
    await session.refresh(member)
    return MeResponse.model_validate(member)
