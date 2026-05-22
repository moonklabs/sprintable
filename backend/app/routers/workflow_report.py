"""POST /api/v2/workflow/report-done — 에이전트 작업 완료 보고 + 다음 단계 자동 트리거."""
import json
import logging
import os
import uuid
from typing import Any

import httpx
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user
from app.dependencies.database import get_db
from app.models.pm import Story
from app.models.team import TeamMember
from app.repositories.story import StoryRepository

logger = logging.getLogger(__name__)


def _fire_webhook(url: str, content: str, title: str, memo_url: str, memo_id: str = "") -> None:
    try:
        full_content = content
        if memo_id:
            full_content = f"{content}\n\nmemo_id: {memo_id}"
        if "discord.com/api/webhooks" in url or "discordapp.com/api/webhooks" in url:
            payload: dict = {"content": full_content}
            if memo_url:
                payload["embeds"] = [{"title": title, "url": memo_url}]
        else:
            payload = {"text": full_content}
        httpx.post(url, json=payload, timeout=10)
    except Exception:  # noqa: BLE001
        logger.warning("reply webhook fire failed url=%s", url, exc_info=True)

router = APIRouter(prefix="/api/v2/workflow", tags=["workflow"])

# ─── 파이프라인 정의 (하드코딩) ───────────────────────────────────────────────

_VALID_STAGES = ("kickoff", "dev", "review", "qa", "merge")

_TRANSITIONS: dict[str, dict[str, Any]] = {
    "kickoff": {
        "next_stage": "dev",
        "next_role": "dev",
        "story_status": "in-progress",
    },
    "dev": {
        "next_stage": "review",
        "next_role": "po",
        "story_status": "in-review",
    },
    "review": {
        "next_stage": "qa",
        "next_role": "qa",
        "story_status": None,
    },
    "qa": {
        "next_stage": "merge",
        "next_role": "po",
        "story_status": None,
    },
    "merge": {
        "next_stage": "done",
        "next_role": None,
        "story_status": "done",
    },
}

# role → member_id (하드코딩)
_ROLE_TO_MEMBER: dict[str, uuid.UUID] = {
    "po": uuid.UUID("05f52181-ea2a-42be-b9a8-9a418b72feb1"),
    "dev": uuid.UUID("9cac9d96-5474-45f7-941e-787407597b52"),
    "qa": uuid.UUID("685f3f72-c85c-4a32-898f-3d3320ba39ad"),
}

# ─── Schema ──────────────────────────────────────────────────────────────────

class ReportDoneRequest(BaseModel):
    story_id: uuid.UUID
    stage: str
    agent_id: uuid.UUID
    context: dict[str, Any] | None = None


class ReportDoneResponse(BaseModel):
    story_id: uuid.UUID
    completed_stage: str
    next_stage: str
    memo_id: uuid.UUID | None = None
    story_status: str | None = None

# ─── Endpoint ─────────────────────────────────────────────────────────────────

@router.post("/report-done", response_model=ReportDoneResponse, status_code=200)
async def report_done(
    body: ReportDoneRequest,
    background_tasks: BackgroundTasks,
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
) -> ReportDoneResponse:
    if body.stage not in _VALID_STAGES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid stage '{body.stage}'. Valid: {list(_VALID_STAGES)}",
        )

    # 스토리 조회
    result = await session.execute(select(Story).where(Story.id == body.story_id))
    story = result.scalar_one_or_none()
    if story is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Story not found")

    transition = _TRANSITIONS[body.stage]
    next_stage: str = transition["next_stage"]
    story_status: str | None = transition["story_status"]

    # 스토리 상태 업데이트
    if story_status:
        story_repo = StoryRepository(session, story.org_id)
        await story_repo.update(story.id, status=story_status)

    return ReportDoneResponse(
        story_id=body.story_id,
        completed_stage=body.stage,
        next_stage=next_stage,
        memo_id=None,
        story_status=story_status,
    )
