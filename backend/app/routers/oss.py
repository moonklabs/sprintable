import os
import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.pm import Story
from app.services.project_auth import has_project_access

router = APIRouter(prefix="/api/v2/oss", tags=["oss"])

_SAMPLE_STORIES = [
    {"title": "SPR-1: GitHub Webhook 연동하기", "status": "backlog", "priority": "high"},
    {"title": "SPR-2: 첫 번째 스프린트 계획", "status": "in-progress", "priority": "medium"},
    {"title": "SPR-3: Hello Sprintable!", "status": "done", "priority": "low"},
]


@router.post("/seed")
async def oss_seed(
    project_id: uuid.UUID,
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> dict:
    # E-SECURITY SEC-S8(story 83ea3d6a) EE(까심 전수스윕, CRITICAL): org_id가 get_verified_org_id를
    # 거치지 않는 raw client query param이라 인증 유저가 소속 여부와 무관하게 임의 org_id로
    # 시드를 심을 수 있었다(access-control 자체 부재). org_id는 이제 서버파생(JWT/X-Org-Id
    # membership 검증) + project_id도 caller 접근권 검증.
    if not await has_project_access(session, uuid.UUID(auth.user_id), project_id, org_id):
        raise HTTPException(status_code=404, detail="Project not found")

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
