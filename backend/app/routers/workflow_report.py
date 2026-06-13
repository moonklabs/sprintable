"""POST /api/v2/workflow/report-done — 에이전트 작업 완료 보고 + 다음 단계 자동 트리거."""
import json
import logging
import os
import uuid
from typing import Any

import httpx
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Response, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user
from app.dependencies.database import get_db
from app.models.gate import Gate
from app.models.pm import Story
from app.models.team import TeamMember
from app.repositories.story import StoryRepository
from app.services.merge_verdict_gate import (
    AUTO_MERGE,
    BLOCK,
    MergeGateDecision,
    evaluate_merge_gate,
    merge_gate_active,
    merge_gate_advisory,
)

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
    # H1-S4: merge stage 게이트 결정(merge 단계에서만 채워짐).
    gate_decision: str | None = None  # auto_merge | ask_human | block
    gate_id: uuid.UUID | None = None
    requires_human: bool | None = None
    decision_basis: str | None = None


def _evidence_status(decision: str) -> str:
    if decision == AUTO_MERGE:
        return "sufficient"
    if decision == BLOCK:
        return "blocked"
    return "insufficient"


async def _record_gate_evidence(session: AsyncSession, decision: MergeGateDecision) -> None:
    """S3 gate evidence metadata 컬럼에 머지 게이트 결정을 기록(gate row 있을 때만)."""
    if decision.gate_id is None:
        return
    gate = await session.get(Gate, decision.gate_id)
    if gate is None:
        return
    gate.requires_human = decision.decision != AUTO_MERGE
    gate.evidence_status = _evidence_status(decision.decision)
    gate.decision_basis = decision.reason
    gate.auto_decision_reason = decision.decision
    await session.flush()

# ─── Endpoint ─────────────────────────────────────────────────────────────────

@router.post("/report-done", response_model=ReportDoneResponse, status_code=200)
async def report_done(
    body: ReportDoneRequest,
    background_tasks: BackgroundTasks,
    response: Response,
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

    # H1-S4: merge 단계는 status=done 전이 전에 merge verdict gate(S2)를 통과해야 한다.
    # auto_merge만 done·ask_human은 status 유지+202·block은 status 유지+409. gate evidence(S3) 기록.
    # H1-S5: 전 게이트 단일 스위치 — 플래그 off(또는 allowlist 밖)면 게이트 미호출(기존 merge→done 동작).
    gate_info: MergeGateDecision | None = None
    if body.stage == "merge" and merge_gate_active(story.org_id):
        ctx = body.context or {}
        pr_number = ctx.get("pr_number")
        gate_info = await evaluate_merge_gate(
            session,
            story.org_id,
            story.id,
            pr_number=int(pr_number) if pr_number else 0,
            repo=str(ctx.get("repo") or ""),
            ci_result=ctx.get("ci_result"),
            pr_result=ctx.get("pr_result"),
        )
        await _record_gate_evidence(session, gate_info)
        # advisory(B): eval/gate evidence/metrics는 기록(위)하되 차단(409/202·done 보류)은 면제 →
        # decision 무관 done 통과(관측만). enforcing(미설정)은 아래 분기 그대로.
        if gate_info.decision != AUTO_MERGE and not merge_gate_advisory():
            story_status = None  # done 전이 차단 — 현재 status 유지(AC①③).
            if gate_info.decision == BLOCK:
                # gate audit를 보존하고 차단(get_db는 예외 시 rollback이라 명시 commit).
                await session.commit()
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail={
                        "code": "MERGE_BLOCKED",
                        "message": f"merge gate blocked: {gate_info.reason}",
                        "decision": gate_info.decision,
                        "gate_id": str(gate_info.gate_id) if gate_info.gate_id else None,
                        "requires_human": True,
                    },
                )
            response.status_code = status.HTTP_202_ACCEPTED  # ask_human — 사람 보류.

    # 스토리 상태 업데이트 (merge에서 auto_merge가 아니면 story_status=None이라 skip)
    if story_status:
        story_repo = StoryRepository(session, story.org_id)
        await story_repo.update(story.id, status=story_status)

    return ReportDoneResponse(
        story_id=body.story_id,
        completed_stage=body.stage,
        next_stage=next_stage,
        memo_id=None,
        story_status=story_status,
        gate_decision=gate_info.decision if gate_info else None,
        gate_id=gate_info.gate_id if gate_info else None,
        requires_human=(gate_info.decision != AUTO_MERGE) if gate_info else None,
        decision_basis=gate_info.reason if gate_info else None,
    )
