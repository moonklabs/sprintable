"""POST /api/v2/workflow/report-done — 에이전트 작업 완료 보고 + 다음 단계 자동 트리거."""
import logging
import uuid
from typing import Any

import httpx
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Response, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
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

# S20: 하드코딩 role→member UUID(_ROLE_TO_MEMBER)는 제거됐다(AC④·미사용 dead). role→member 해소는
# line 의 role_assignments resolver(S14)가 SSOT. _TRANSITIONS 는 stage→status bootstrap 으로만 잔존(AC①).

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
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> ReportDoneResponse:
    if body.stage not in _VALID_STAGES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid stage '{body.stage}'. Valid: {list(_VALID_STAGES)}",
        )

    # S20 전수스캔 finding #12: org_id 검증이 전혀 없어 임의 org의 caller가 다른 org 소유
    # story를 조회/전이(cross-org story-pipeline 조작)할 수 있었다 — 이제 caller org로 필터.
    result = await session.execute(
        select(Story).where(Story.id == body.story_id, Story.org_id == org_id)
    )
    story = result.scalar_one_or_none()
    if story is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Story not found")

    # E-SECURITY SEC-S8(story 83ea3d6a) Z2(까심 전수스윕, 실HTTP 확定): org-scope(#12)는 있으나
    # caller의 실제 project 접근권(has_project_access) 검증이 없어, project_a만 grant된 caller가
    # project_b story_id로 이 엔드포인트를 호출하면 stage 전이가 실제로 반영됐다(DB 재조회로
    # backlog→in-progress 변조 확定, G-class).
    from app.services.project_auth import has_project_access
    if not await has_project_access(session, uuid.UUID(auth.user_id), story.project_id, org_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Story not found")

    # S20 finding #12(sibling): body.agent_id도 검증 없이 gate/line 평가의 actor로 그대로
    # 쓰였다 — 임의 agent_id로 actor 스푸핑 가능했던 갭. caller org 소속 member인지 확인.
    agent_check = await session.execute(
        select(TeamMember.id).where(
            TeamMember.id == body.agent_id, TeamMember.org_id == org_id,
        ).limit(1)
    )
    if agent_check.scalar_one_or_none() is None:
        raise HTTPException(status_code=400, detail="agent_id not found in this organization")

    transition = _TRANSITIONS[body.stage]
    next_stage: str = transition["next_stage"]
    story_status: str | None = transition["story_status"]

    # S-GATE-2: config 게이트 집행(merge) — flag-off면 no-op(무회귀). config 1차(H1 trust 게이트와 공존):
    # block→409·ask→HitlRequest park+409·auto→통과 후 아래 H1 trust 게이트로(점진 접목은 S-GATE-3+).
    if body.stage == "merge":
        from app.services.gate_enforce import enforce_gate
        await enforce_gate(
            session, org_id=story.org_id, project_id=getattr(story, "project_id", None),
            work_type="merge", actor_type="agent", actor_id=getattr(body, "agent_id", None),
            work_item_id=story.id, work_item_title=getattr(story, "title", None),
        )

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

    # S20: line engine compatibility adapter — 비-merge 전이를 line engine 에 위임(관측/거버닝·라인이
    # SSOT). merge 는 위 merge_gate_active(S5 line merge-gate)가 이미 처리하므로 중복 게이트 0. ⭐
    # default-off org 는 line engine 이 plain 반환 → 기존 동작 100% 동일(무회귀·AC②③⑤). 라인 평가
    # 예외도 fail-open(report-done 비차단). enforcing line 이 막으면 merge 차단과 동형으로 status 보류.
    if story_status and body.stage != "merge":
        line_decision = None
        try:
            from app.services.workflow_line_engine import evaluate_line_for_transition
            line_decision = await evaluate_line_for_transition(
                session, org_id=story.org_id, project_id=getattr(story, "project_id", None),
                entity_type="story", entity_id=story.id,
                from_status=story.status, to_status=story_status,
                actor_id=body.agent_id, actor_type="agent",
            )
        except Exception:  # noqa: BLE001 — 라인 평가 실패가 report-done 막지 않음(무회귀).
            line_decision = None
        if line_decision is not None and not line_decision.proceeds:
            await session.commit()  # line step_run/gate evidence 보존
            raise HTTPException(
                status_code=line_decision.http_status or status.HTTP_409_CONFLICT,
                detail={
                    "code": "LINE_BLOCKED",
                    "message": line_decision.blocking_reason or "blocked by workflow line",
                    "gate_id": str(line_decision.gate_id) if line_decision.gate_id else None,
                    "requires_human": True,
                },
            )

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
