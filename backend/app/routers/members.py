import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user
from app.dependencies.database import get_db
from app.models.team import TeamMember

router = APIRouter(prefix="/api/v2/members", tags=["members"])


class MemberResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    type: str
    role: str
    is_active: bool
    webhook_url: str | None = None


@router.get("", response_model=list[MemberResponse])
async def list_members(
    project_id: uuid.UUID = Query(...),
    session: AsyncSession = Depends(get_db),
    _auth: AuthContext = Depends(get_current_user),
) -> list[MemberResponse]:
    result = await session.execute(
        select(TeamMember).where(
            TeamMember.project_id == project_id,
            TeamMember.is_active.is_(True),
        ).order_by(TeamMember.name)
    )
    members = result.scalars().all()
    return [MemberResponse.model_validate(m) for m in members]
