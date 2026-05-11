"""POST /api/v2/workflow/report-done — 에이전트 작업 완료 보고 + 다음 단계 자동 트리거."""
import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user
from app.dependencies.database import get_db
from app.models.memo import MemoAssignee
from app.models.pm import Story
from app.repositories.memo import MemoRepository
from app.repositories.story import StoryRepository

router = APIRouter(prefix="/api/v2/workflow", tags=["workflow"])

# ─── 파이프라인 정의 (하드코딩) ───────────────────────────────────────────────

_VALID_STAGES = ("kickoff", "dev", "review", "qa", "merge")

_TRANSITIONS: dict[str, dict[str, Any]] = {
    "kickoff": {
        "next_stage": "dev",
        "next_role": "dev",
        "memo_type": "task",
        "memo_title_prefix": "[DEV 킥오프]",
        "memo_content": "DEV 착수 요청인. story.description 확인 후 즉시 착수 바라는.",
        "story_status": "in-progress",
    },
    "dev": {
        "next_stage": "review",
        "next_role": "po",
        "memo_type": "task",
        "memo_title_prefix": "[REVIEW 요청]",
        "memo_content": "개발 완료. PR 리뷰 요청드리는.",
        "story_status": None,
    },
    "review": {
        "next_stage": "qa",
        "next_role": "qa",
        "memo_type": "task",
        "memo_title_prefix": "[QA 킥오프]",
        "memo_content": "PO 리뷰 LGTM. QA 검수 요청드리는.",
        "story_status": None,
    },
    "qa": {
        "next_stage": "merge",
        "next_role": "po",
        "memo_type": "task",
        "memo_title_prefix": "[MERGE 요청]",
        "memo_content": "QA APPROVE. 머지 요청드리는.",
        "story_status": None,
    },
    "merge": {
        "next_stage": "done",
        "next_role": None,
        "memo_type": None,
        "memo_title_prefix": None,
        "memo_content": None,
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
    next_role: str | None = transition["next_role"]
    story_status: str | None = transition["story_status"]

    # 스토리 상태 업데이트
    if story_status:
        story_repo = StoryRepository(session, story.org_id)
        await story_repo.update(story.id, status=story_status)

    # 메모 발송
    memo_id: uuid.UUID | None = None
    if next_role and transition["memo_type"]:
        next_member_id = _ROLE_TO_MEMBER.get(next_role)
        if next_member_id is None:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"No member mapping for role '{next_role}'",
            )

        story_title = story.title or str(story.id)
        title = f"{transition['memo_title_prefix']} {story_title}"
        content_parts = [transition["memo_content"]]
        if body.context:
            content_parts.append(f"\n\n**Context:**\n{body.context}")

        memo_repo = MemoRepository(session, story.org_id)
        memo = await memo_repo.create(
            project_id=story.project_id,
            content="\n".join(content_parts),
            memo_type=transition["memo_type"],
            title=title,
            assigned_to=next_member_id,
            created_by=body.agent_id,
        )
        session.add(MemoAssignee(
            memo_id=memo.id,
            member_id=next_member_id,
            assigned_by=body.agent_id,
        ))
        await session.flush()
        memo_id = memo.id

    return ReportDoneResponse(
        story_id=body.story_id,
        completed_stage=body.stage,
        next_stage=next_stage,
        memo_id=memo_id,
        story_status=story_status,
    )
