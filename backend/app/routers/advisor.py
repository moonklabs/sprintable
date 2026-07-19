from __future__ import annotations

import uuid
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.pm import Story
from app.services.advisor_context import advisor_enabled_for, build_context
from app.services.member_resolver import resolve_member
from app.services.project_auth import has_project_access

router = APIRouter(prefix="/api/v2/advisor", tags=["advisor"])


@router.get("/context")
async def advisor_context(
    story_id: uuid.UUID,
    moment: str = Query("preflight"),
    max_prior_decisions: int = Query(5, ge=0, le=10),
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
):
    if moment not in {"preflight", "kickoff"} or not advisor_enabled_for(org_id):
        raise HTTPException(status_code=404, detail="Advisor context not found")
    story = (
        await session.execute(
            select(Story).where(
                Story.id == story_id,
                Story.org_id == org_id,
                Story.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if story is None:
        raise HTTPException(status_code=404, detail="Story not found")
    caller = await resolve_member(auth, org_id, session)
    if caller.type != "agent" or not await has_project_access(session, caller.id, story.project_id, org_id):
        raise HTTPException(status_code=404, detail="Story not found")
    return await build_context(session, story, max_prior_decisions)
