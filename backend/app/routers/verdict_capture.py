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
from app.services.verdict_capture import capture_pr_ci_verdict, parse_story_id
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
