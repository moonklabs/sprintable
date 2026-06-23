"""E-MODERN Track C: 커맨드 센터 BE — CC-BE.1 (집계 2 엔드포인트).

운영자 대시보드의 cross-cut 집계. **2 엔드포인트**(FE N+1 차단):
- `GET /api/v2/command-center/my-actions` — ⭐**혼합 scope**: `action_queue`(=caller **member-private**·타 멤버 큐 노출 0)
  + `attention`(=**org-scope** 자동 이상감지). 두 섹션 scope label·배열 분리(산티아고 lock).
- `GET /api/v2/command-center/overview` — **org/team** scope: 헤더 함대 + 프로젝트 현황.

**mock-0 금지선**: CC-BE.1 미구현(신규 집계)은 `{"status": "pending_data"}` 명시 — 가짜 수치 0(CC-BE.2서 실데이터).
**민감 정보 비노출**(산티아고): 이상감지는 enum/summary·count 만(raw error/log/failure_message 0).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.activity_event import ActivityEvent
from app.models.hypothesis import Hypothesis
from app.models.member import Member
from app.models.pm import Epic, Story
from app.models.workflow_line import WorkflowLineStepApproval, WorkflowLineStepRun

router = APIRouter(prefix="/api/v2/command-center", tags=["command-center"])

# 자동 이상감지 임계(분). step_run 이 pending 으로 이 시간 넘게 정체 = 에이전트 멈춤(CC-BE.1 1종).
_AGENT_STUCK_MINUTES = 30
_PENDING = {"status": "pending_data"}  # mock-0: 신규 집계 미구현 — 가짜 수치 대신 명시(CC-BE.2서 실데이터).


def _now() -> datetime:
    return datetime.now(timezone.utc)


@router.get("/my-actions")
async def my_actions(
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    """① 지금 내 할 일. `action_queue`=caller member-private·`attention`=org 자동 이상감지(scope 분리)."""
    try:
        member_id = uuid.UUID(auth.user_id)
    except (ValueError, TypeError):
        return JSONResponse(status_code=400, content={"error": "invalid_member"})

    queue: list[dict] = []
    # 게이트 승인 대기 = 내가 approver 인 pending blocking approval(member-private·서버 resolve member_id).
    approvals = (
        await session.execute(
            select(WorkflowLineStepApproval)
            .where(
                WorkflowLineStepApproval.org_id == org_id,
                WorkflowLineStepApproval.approver_member_id == member_id,
                WorkflowLineStepApproval.status == "pending",
                WorkflowLineStepApproval.blocking.is_(True),
            )
            .order_by(WorkflowLineStepApproval.created_at.asc())
            .limit(50)
        )
    ).scalars().all()
    for a in approvals:
        queue.append({
            "type": "gate_approval",
            "priority": "warn",
            "context": {"gate_id": str(a.gate_id) if a.gate_id else None,
                        "approval_group_id": str(a.approval_group_id), "kind": a.kind},
            "created_at": a.created_at.isoformat() if a.created_at else None,
        })
    # 리뷰/머지 대기 = 내 배정 in-review 스토리(member-private).
    reviews = (
        await session.execute(
            select(Story)
            .where(
                Story.org_id == org_id,
                Story.assignee_id == member_id,
                Story.status == "in-review",
                Story.deleted_at.is_(None),
            )
            .order_by(Story.updated_at.desc())
            .limit(50)
        )
    ).scalars().all()
    for s in reviews:
        queue.append({
            "type": "review_merge",
            "priority": "info",
            "title": s.title,
            "context": {"story_id": str(s.id), "status": s.status},
            "created_at": s.updated_at.isoformat() if s.updated_at else None,
        })

    # 자동 이상감지(org-scope) — CC-BE.1 1종: 에이전트 멈춤(step_run pending 정체). raw error/log 비노출.
    threshold = _now() - timedelta(minutes=_AGENT_STUCK_MINUTES)
    stuck = (
        await session.execute(
            select(WorkflowLineStepRun)
            .where(
                WorkflowLineStepRun.org_id == org_id,
                WorkflowLineStepRun.status == "pending",
                WorkflowLineStepRun.started_at < threshold,
            )
            .order_by(WorkflowLineStepRun.started_at.asc())
            .limit(20)
        )
    ).scalars().all()
    attention_items = [
        {
            "type": "agent_stuck",
            "severity": "warn",
            "auto_detected": True,
            # enum/summary·식별자만(민감 텍스트 0): entity·게이트타입·정체 분 수.
            "entity_type": r.entity_type,
            "entity_id": str(r.entity_id),
            "gate_type": r.effective_gate_type,
            "stuck_since": r.started_at.isoformat() if r.started_at else None,
        }
        for r in stuck
    ]

    return JSONResponse(content={
        "action_queue": {  # scope: member(caller) — 타 멤버 큐 노출 0.
            "scope": "member",
            "items": sorted(queue, key=lambda x: {"danger": 0, "warn": 1, "info": 2}.get(x["priority"], 9)),
        },
        "attention": {  # scope: org — 자동 이상감지(운영자 visibility).
            "scope": "org",
            "items": attention_items,
            "pending": ["story_stalled", "unanswered_blocker", "time_sensitive", "my_blockers"],  # CC-BE.2.
        },
        "is_clear": len(queue) == 0 and len(attention_items) == 0,
    })


@router.get("/overview")
async def overview(
    org_id: uuid.UUID = Depends(get_verified_org_id),
    _auth: AuthContext = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    """② 프로젝트 현황 + 헤더 함대. scope=org/team. 신규 집계는 pending_data(mock 0)."""
    # 헤더 — 함대: 총 에이전트(실)·상태 breakdown 은 pending_data(CC-BE.2 fleet status).
    total_agents = (
        await session.execute(
            select(func.count(Member.id)).where(
                Member.org_id == org_id, Member.type == "agent",
                Member.is_active.is_(True), Member.deleted_at.is_(None),
            )
        )
    ).scalar_one()

    # 에픽 진척(실): org 스토리 epic 별 done/total. is_excluded 제외(데이터 오염).
    rows = (
        await session.execute(
            select(
                Story.epic_id,
                func.count(Story.id),
                func.count(Story.id).filter(Story.status == "done"),
            )
            .where(
                Story.org_id == org_id, Story.deleted_at.is_(None),
                Story.epic_id.isnot(None), Story.is_excluded.is_(False),
            )
            .group_by(Story.epic_id)
        )
    ).all()
    counts = {epic_id: (total, done) for epic_id, total, done in rows}
    epics_q = (
        await session.execute(select(Epic).where(Epic.org_id == org_id))
    ).scalars().all()
    epics = []
    for e in epics_q:
        total, done = counts.get(e.id, (0, 0))
        if total == 0:
            continue  # 스토리 0 에픽은 진척 표시 제외(노이즈).
        epics.append({
            "epic_id": str(e.id), "title": e.title, "status": e.status,
            "total": total, "done": done,
            "completion_pct": round(done * 100 / total) if total else 0,
        })
    epics.sort(key=lambda x: x["completion_pct"])  # 덜 된 것 위(주의).

    # 성과(가설 적중·실): verified=hit / 전체.
    h_total, h_hit = (
        await session.execute(
            select(
                func.count(Hypothesis.id),
                func.count(Hypothesis.id).filter(Hypothesis.status == "verified"),
            ).where(Hypothesis.org_id == org_id)
        )
    ).one()

    # 최근 중요 변화(실·org): 최근 활동 이벤트(verb/object/시각만·raw payload 비노출).
    events = (
        await session.execute(
            select(ActivityEvent)
            .where(ActivityEvent.org_id == org_id)
            .order_by(ActivityEvent.occurred_at.desc())
            .limit(10)
        )
    ).scalars().all()
    recent_changes = [
        {
            "verb": ev.verb,
            "object_type": ev.object_type,
            "object_id": str(ev.object_id) if ev.object_id else None,
            "occurred_at": ev.occurred_at.isoformat() if ev.occurred_at else None,
        }
        for ev in events
    ]

    return JSONResponse(content={
        "scope": "org",
        "fleet": {  # 헤더 함대 라이브 요약.
            "total_agents": total_agents,
            "status_breakdown": _PENDING,  # 작업중/막힘/유휴 = CC-BE.2(workflow-line status).
        },
        "project_status": {
            "epics": epics,                                   # 실데이터.
            "outcome": {"hit": h_hit, "total": h_total},      # 실데이터.
            "recent_changes": recent_changes,                 # 실데이터.
            "risk": _PENDING,        # 지연/막힘/실패 — CC-BE.2(due/dependency/failed-run).
            "cycle_time": _PENDING,  # CC-BE.2.
            "contribution": _PENDING,  # 에이전트:사람 — CC-BE.2.
            "cost_trend": _PENDING,  # 토큰/비용 시계열 — CC-BE.2.
        },
    })
