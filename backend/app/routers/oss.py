import os
import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user
from app.dependencies.database import get_db
from app.models.pm import Story

router = APIRouter(prefix="/api/v2/oss", tags=["oss"])

_SAMPLE_STORIES = [
    {"title": "SPR-1: GitHub Webhook 연동하기", "status": "backlog", "priority": "high"},
    {"title": "SPR-2: 첫 번째 스프린트 계획", "status": "in-progress", "priority": "medium"},
    {"title": "SPR-3: Hello Sprintable!", "status": "done", "priority": "low"},
]


@router.post("/seed")
async def oss_seed(
    project_id: uuid.UUID,
    org_id: uuid.UUID,
    session: AsyncSession = Depends(get_db),
    _auth: AuthContext = Depends(get_current_user),
) -> dict:
    count_r = await session.execute(
        select(func.count()).select_from(Story).where(
            Story.project_id == project_id, Story.org_id == org_id, Story.deleted_at.is_(None)
        )
    )
    if count_r.scalar_one() > 0:
        return {"seeded": False, "reason": "already_has_data"}

    for story_data in _SAMPLE_STORIES:
        session.add(
            Story(
                project_id=project_id,
                org_id=org_id,
                title=story_data["title"],
                status=story_data["status"],
                priority=story_data["priority"],
            )
        )
    await session.flush()

    return {"seeded": True, "count": len(_SAMPLE_STORIES)}


@router.get("/webhook-status")
async def oss_webhook_status(
    _auth: AuthContext = Depends(get_current_user),
) -> dict:
    connected = bool(os.environ.get("GITHUB_WEBHOOK_SECRET"))
    return {"connected": connected}
