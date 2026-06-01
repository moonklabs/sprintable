"""E-CAGE-REFEREE P1: PR·CI verdict 캡처 내부 엔드포인트.

CRON_SECRET 인증 필요. 외부 노출 없음.
풀 GitHub webhook은 후속 — MVP는 머지 후 수동/cron 트리거.
"""
from __future__ import annotations

import logging
import uuid

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.database import get_db
from app.models.pm import Story
from app.routers.cron import CRON_SECRET, _err, _ok, verify_cron
from app.services.verdict_capture import capture_pr_ci_verdict, capture_review_verdict, parse_story_id
from fastapi import Depends

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v2/internal/verdict", tags=["verdict-capture"])


class CaptureBody(BaseModel):
    pr_title: str
    pr_number: int
    repo: str = "moonklabs/sprintable"
    merged: bool = True
    ci_result: str | None = None


@router.post("/capture-pr")
async def capture_pr_verdict(
    request: Request,
    body: CaptureBody,
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    """머지된 PR 기준 PR·CI verdict 포착.

    [SID:story_uuid] 태그가 없거나 participation이 없으면 skip(거짓기록 금지).
    """
    verify_cron(request)

    # SID 파싱
    story_id = parse_story_id(body.pr_title)
    if story_id is None:
        return _ok({"skipped_reason": "no_sid_tag", "recorded": []})

    # story 조회 → org_id 획득
    story_r = await session.execute(
        select(Story).where(Story.id == story_id, Story.deleted_at.is_(None))
    )
    story = story_r.scalar_one_or_none()
    if story is None:
        return _ok({"skipped_reason": "story_not_found", "recorded": []})

    try:
        result = await capture_pr_ci_verdict(
            session=session,
            org_id=story.org_id,
            story_id=story_id,
            pr_number=body.pr_number,
            repo=body.repo,
            merged=body.merged,
            ci_result=body.ci_result,
        )
        await session.commit()
        return _ok(result)
    except Exception as exc:
        logger.exception("verdict capture failed: %s", exc)
        return _err("INTERNAL_ERROR", "verdict capture failed", 500)


# ── QA·디자인 게이트 verdict 캡처 ─────────────────────────────────────────────

_VALID_REVIEW_ROLES = frozenset({"qa", "design"})


class CaptureReviewBody(BaseModel):
    story_id: uuid.UUID
    role: str                # 'qa' | 'design'
    member_id: uuid.UUID
    result: str | None = None  # 'pass' | 'fail' | None
    rounds: int | None = None


@router.post("/capture-review")
async def capture_review(
    request: Request,
    body: CaptureReviewBody,
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    """QA·디자인 게이트 결과 → verdict 기록 (CRON_SECRET 인증).

    트리거 경위: send_chat_message review_type 자동 훅 불가(FastAPI 스키마 미노출·
    Conversation에 story_id 링크 없음)→ MVP 내부 엔드포인트 택일.
    role 없거나 story 없으면 skip(거짓기록 금지). uq(participation,source) 멱등.
    """
    verify_cron(request)

    if body.role not in _VALID_REVIEW_ROLES:
        return _err("INVALID_ROLE", f"role must be one of {sorted(_VALID_REVIEW_ROLES)}", 422)

    # story 조회 → org_id 획득
    story_r = await session.execute(
        select(Story).where(Story.id == body.story_id, Story.deleted_at.is_(None))
    )
    story = story_r.scalar_one_or_none()
    if story is None:
        return _ok({"skipped_reason": "story_not_found", "recorded": False})

    try:
        result = await capture_review_verdict(
            session=session,
            org_id=story.org_id,
            story_id=body.story_id,
            role_key=body.role,
            member_id=body.member_id,
            result=body.result,
            rounds=body.rounds,
        )
        await session.commit()
        return _ok(result)
    except Exception as exc:
        logger.exception("review verdict capture failed: %s", exc)
        return _err("INTERNAL_ERROR", "review verdict capture failed", 500)
