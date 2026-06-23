"""E-MODERN Track C: 커맨드 센터 BE — CC-BE.1 + CC-BE.2 (집계 2 엔드포인트).

운영자 대시보드의 cross-cut 집계. **2 엔드포인트**(FE N+1 차단):
- `GET /api/v2/command-center/my-actions` — ⭐**혼합 scope**: `action_queue`(=caller **member-private**·타 멤버 큐 노출 0)
  + `attention`(=**org-scope** 자동 이상감지). 두 섹션 scope label·배열 분리(산티아고 lock).
- `GET /api/v2/command-center/overview` — **org/team** scope: 헤더 함대 + 프로젝트 현황.

**mock-0 금지선**: 미구현은 `{"status": "pending_data"}`·실데이터 없으면 empty(가짜 수치 0).
**민감 정보 비노출**(산티아고): 이상감지·blocker 는 enum/ids/age 만(raw error/log/blocker text 0). 비용·기여는
org **aggregate only**(개인별 비용/blame/랭킹 노출 0).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from sqlalchemy import func, select
from sqlalchemy.orm import aliased
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.activity_event import ActivityEvent
from app.models.agent_run import AgentRun
from app.models.dependency import ItemDependency
from app.models.hypothesis import Hypothesis
from app.models.member import AgentProjectProfile, Member
from app.models.pm import Epic, Story, StoryActivity
from app.models.workflow_line import WorkflowLineStepApproval, WorkflowLineStepRun
from app.services.member_resolver import resolve_member

router = APIRouter(prefix="/api/v2/command-center", tags=["command-center"])

# 자동 이상감지 임계. step_run pending 정체=에이전트 멈춤·story 무진행=정체·blocker 무응답.
_AGENT_STUCK_MINUTES = 30
_STORY_STALLED_DAYS = 3
_BLOCKER_UNANSWERED_DAYS = 2
_PENDING = {"status": "pending_data"}  # mock-0: 미구현 집계 — 가짜 수치 대신 명시.
# recent_changes 의미 이벤트 allowlist(저신호 conversation.* 등 제외·unknown 기본 제외).
_MEANINGFUL_VERB_PREFIXES = ("story.", "gate.", "pr.", "epic.", "sprint.", "dependency.", "merge")
_OPEN_EXCLUDED_STATUSES = ("done",)  # blocked/stalled 판정의 "open" = non-done.


def _now() -> datetime:
    return datetime.now(timezone.utc)


@router.get("/my-actions")
async def my_actions(
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    """① 지금 내 할 일. `action_queue`=caller member-private·`attention`=org 자동 이상감지(scope 분리)."""
    # ⭐caller member_id 는 **canonical resolver** 로 서버 resolve(API키=team_member·JWT human=org_member).
    # auth.user_id 직사용 금지 — human JWT 는 users.id 라 approver_member_id/assignee_id(member계열)와 불일치.
    member = await resolve_member(auth, org_id, session)
    member_id = member.id
    now = _now()

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
    # CC-BE.2 내가 풀 블로커(member-private): 내 담당(blocker) 스토리가 막은 open 스토리. caller-bound.
    _Blocker = aliased(Story)
    _Blocked = aliased(Story)
    my_blockers = (
        await session.execute(
            select(ItemDependency.from_id, ItemDependency.to_id)
            .select_from(ItemDependency)
            .join(_Blocker, _Blocker.id == ItemDependency.from_id)
            .join(_Blocked, _Blocked.id == ItemDependency.to_id)
            .where(
                ItemDependency.org_id == org_id,
                ItemDependency.dep_type == "blocks",
                ItemDependency.item_type == "story",
                _Blocker.assignee_id == member_id,        # 막은 쪽이 내 담당.
                _Blocker.deleted_at.is_(None),
                _Blocked.status.not_in(_OPEN_EXCLUDED_STATUSES),  # 막힌 쪽이 아직 open.
                _Blocked.deleted_at.is_(None),
            )
            .limit(50)
        )
    ).all()
    for blocker_id, blocked_id in my_blockers:
        queue.append({
            "type": "my_blockers",
            "priority": "danger",  # 내가 푸는 게 남을 막고 있음 — 최우선.
            "context": {"blocker_story_id": str(blocker_id), "blocked_story_id": str(blocked_id)},
        })

    # ── 자동 이상감지(org-scope) — enum/ids/age 만(민감 텍스트 0) ──────────────────────
    attention_items: list[dict] = []
    # 1) 에이전트 멈춤(step_run pending 정체·agent-only). raw error/log 비노출.
    stuck = (
        await session.execute(
            select(WorkflowLineStepRun)
            .where(
                WorkflowLineStepRun.org_id == org_id,
                WorkflowLineStepRun.status == "pending",
                WorkflowLineStepRun.started_at < now - timedelta(minutes=_AGENT_STUCK_MINUTES),
                WorkflowLineStepRun.resolved_member_type == "agent",  # HIGH2: agent run 만.
            )
            .order_by(WorkflowLineStepRun.started_at.asc())
            .limit(20)
        )
    ).scalars().all()
    for r in stuck:
        attention_items.append({
            "type": "agent_stuck", "severity": "warn", "auto_detected": True,
            "entity_type": r.entity_type, "entity_id": str(r.entity_id),
            "gate_type": r.effective_gate_type,
            "stuck_since": r.started_at.isoformat() if r.started_at else None,
        })
    # 2) CC-BE.2 스토리 N일 정체(org-visible 필드만).
    stalled = (
        await session.execute(
            select(Story.id, Story.updated_at)
            .where(
                Story.org_id == org_id,
                Story.status.not_in(("done", "backlog")),
                Story.deleted_at.is_(None),
                Story.is_excluded.is_(False),
                Story.updated_at < now - timedelta(days=_STORY_STALLED_DAYS),
            )
            .order_by(Story.updated_at.asc())
            .limit(20)
        )
    ).all()
    for sid, updated_at in stalled:
        attention_items.append({
            "type": "story_stalled", "severity": "warn", "auto_detected": True,
            "story_id": str(sid),
            "stalled_days": (now - updated_at).days if updated_at else None,
        })
    # 3) CC-BE.2 답없는 블로커(enum/ids/age — raw blocker text 0).
    _BlockedU = aliased(Story)
    unanswered = (
        await session.execute(
            select(ItemDependency.from_id, ItemDependency.to_id, ItemDependency.created_at)
            .select_from(ItemDependency)
            .join(_BlockedU, _BlockedU.id == ItemDependency.to_id)
            .where(
                ItemDependency.org_id == org_id,
                ItemDependency.dep_type == "blocks",
                ItemDependency.item_type == "story",
                ItemDependency.created_at < now - timedelta(days=_BLOCKER_UNANSWERED_DAYS),
                _BlockedU.status.not_in(_OPEN_EXCLUDED_STATUSES),
                _BlockedU.deleted_at.is_(None),
            )
            .order_by(ItemDependency.created_at.asc())
            .limit(20)
        )
    ).all()
    for blocker_id, blocked_id, created_at in unanswered:
        attention_items.append({
            "type": "unanswered_blocker", "severity": "warn", "auto_detected": True,
            "blocked_story_id": str(blocked_id), "blocker_id": str(blocker_id),
            "age_days": (now - created_at).days if created_at else None,
        })

    return JSONResponse(content={
        "action_queue": {  # scope: member(caller) — 타 멤버 큐 노출 0.
            "scope": "member",
            "items": sorted(queue, key=lambda x: {"danger": 0, "warn": 1, "info": 2}.get(x["priority"], 9)),
        },
        "attention": {  # scope: org — 자동 이상감지(운영자 visibility).
            "scope": "org",
            "items": attention_items,
            "pending": ["time_sensitive"],  # 잔여 미구현(overdue/스프린트 D-N·due 소스 부재).
        },
        "is_clear": len(queue) == 0 and len(attention_items) == 0,
    })


@router.get("/overview")
async def overview(
    org_id: uuid.UUID = Depends(get_verified_org_id),
    _auth: AuthContext = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    """② 프로젝트 현황 + 헤더 함대. scope=org/team. 비용·기여는 org aggregate only(개인 노출 0)."""
    now = _now()
    # 헤더 — 함대: 총 에이전트(실).
    total_agents = (
        await session.execute(
            select(func.count(Member.id)).where(
                Member.org_id == org_id, Member.type == "agent",
                Member.is_active.is_(True), Member.deleted_at.is_(None),
            )
        )
    ).scalar_one()

    # 에픽 진척(실): org 스토리 epic 별 done/total. is_excluded 제외.
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
            continue
        epics.append({
            "epic_id": str(e.id), "title": e.title, "status": e.status,
            "total": total, "done": done,
            "completion_pct": round(done * 100 / total) if total else 0,
        })
    epics.sort(key=lambda x: x["completion_pct"])

    # 성과(가설 적중·실): verified=hit / 전체.
    h_total, h_hit = (
        await session.execute(
            select(
                func.count(Hypothesis.id),
                func.count(Hypothesis.id).filter(Hypothesis.status == "verified"),
            ).where(Hypothesis.org_id == org_id)
        )
    ).one()

    # 최근 중요 변화(실·org): 의미 이벤트만(저신호 conversation.* 등 제외·unknown 기본 제외).
    events = (
        await session.execute(
            select(ActivityEvent)
            .where(ActivityEvent.org_id == org_id)
            .order_by(ActivityEvent.occurred_at.desc())
            .limit(40)
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
        if ev.verb and ev.verb.startswith(_MEANINGFUL_VERB_PREFIXES)
    ][:10]

    # CC-BE.2 기여(에이전트 vs 사람·aggregate only·개인 blame/랭킹 0): done 스토리 assignee type 집계.
    contrib_rows = (
        await session.execute(
            select(Member.type, func.count(Story.id))
            .select_from(Story)
            .join(Member, Member.id == Story.assignee_id, isouter=True)
            .where(
                Story.org_id == org_id, Story.status == "done",
                Story.deleted_at.is_(None), Story.is_excluded.is_(False),
            )
            .group_by(Member.type)
        )
    ).all()
    contribution = {"agent": 0, "human": 0, "unassigned": 0}
    for mtype, cnt in contrib_rows:
        if mtype == "agent":
            contribution["agent"] = cnt
        elif mtype == "human":
            contribution["human"] = cnt
        else:  # assignee 없음(None) 또는 미상 type → unassigned.
            contribution["unassigned"] += cnt

    # CC-BE.2 사이클타임(실·org): created→done 평균 일수(최근 30일 done·excluded/deleted 제외).
    avg_secs, cycle_sample = (
        await session.execute(
            select(
                func.avg(func.extract("epoch", StoryActivity.created_at - Story.created_at)),
                func.count(StoryActivity.id),
            )
            .select_from(StoryActivity)
            .join(Story, Story.id == StoryActivity.story_id)
            .where(
                StoryActivity.org_id == org_id,
                StoryActivity.activity_type == "status_changed",
                StoryActivity.new_value == "done",
                StoryActivity.created_at > now - timedelta(days=30),
                Story.deleted_at.is_(None), Story.is_excluded.is_(False),
            )
        )
    ).one()
    cycle_time = {
        "avg_days": round(float(avg_secs) / 86400, 1) if avg_secs is not None else None,
        "sample": int(cycle_sample or 0),
    }

    # CC-BE.2 비용 추세(실·org aggregate only·개인별 비용 노출 0): agent_runs 일별 합. 없으면 honest empty.
    cost_rows = (
        await session.execute(
            select(
                func.date(AgentRun.started_at),
                func.sum(AgentRun.cost_usd),
                func.sum(func.coalesce(AgentRun.input_tokens, 0) + func.coalesce(AgentRun.output_tokens, 0)),
            )
            .where(AgentRun.org_id == org_id, AgentRun.started_at > now - timedelta(days=14))
            .group_by(func.date(AgentRun.started_at))
            .order_by(func.date(AgentRun.started_at))
        )
    ).all()
    points = [
        {"date": str(d), "cost_usd": round(float(c or 0), 4), "tokens": int(t or 0)}
        for d, c, t in cost_rows
    ]
    cost_trend = {
        "points": points,
        "total_cost_usd": round(sum(p["cost_usd"] for p in points), 4),
        "delta_pct": None,  # 직전 기간 대비 증감은 후속(현 14일 합만).
    }

    # CC-BE.2 위험(실): 막힌 open 스토리 수 + 실패 run 수. overdue 는 due 필드 부재 → pending_data.
    _BlockedR = aliased(Story)
    blocked_cnt = (
        await session.execute(
            select(func.count(func.distinct(ItemDependency.to_id)))
            .select_from(ItemDependency)
            .join(_BlockedR, _BlockedR.id == ItemDependency.to_id)
            .where(
                ItemDependency.org_id == org_id,
                ItemDependency.dep_type == "blocks",
                ItemDependency.item_type == "story",
                _BlockedR.status.not_in(_OPEN_EXCLUDED_STATUSES),
                _BlockedR.deleted_at.is_(None),
            )
        )
    ).scalar_one()
    failed_runs = (
        await session.execute(
            select(func.count(AgentRun.id)).where(
                AgentRun.org_id == org_id, AgentRun.status == "failed",
                AgentRun.started_at > now - timedelta(days=7),
            )
        )
    ).scalar_one()
    risk = {"blocked": int(blocked_cnt or 0), "failed_runs": int(failed_runs or 0), "overdue": _PENDING}

    # CC-BE.2 함대 status breakdown(실·org agent profile). working=online+active_story.
    fleet_rows = (
        await session.execute(
            select(
                AgentProjectProfile.agent_status,
                func.count(func.distinct(AgentProjectProfile.member_id)),
                func.count(func.distinct(AgentProjectProfile.member_id)).filter(
                    AgentProjectProfile.active_story_id.isnot(None)
                ),
            )
            .select_from(AgentProjectProfile)
            .join(Member, Member.id == AgentProjectProfile.member_id)
            .where(
                Member.org_id == org_id, Member.type == "agent",
                Member.is_active.is_(True), Member.deleted_at.is_(None),
            )
            .group_by(AgentProjectProfile.agent_status)
        )
    ).all()
    fleet_breakdown = {"online": 0, "offline": 0, "working": 0}
    for status_val, cnt, working_cnt in fleet_rows:
        if status_val == "online":
            fleet_breakdown["online"] += cnt
            fleet_breakdown["working"] += working_cnt
        elif status_val == "offline":
            fleet_breakdown["offline"] += cnt
        # status NULL(미접속) 등은 online/offline 어디에도 안 셈(보수적).

    return JSONResponse(content={
        "scope": "org",
        "fleet": {
            "total_agents": total_agents,
            "status_breakdown": fleet_breakdown,  # CC-BE.2 실데이터.
        },
        "project_status": {
            "epics": epics,
            "outcome": {"hit": h_hit, "total": h_total},
            "recent_changes": recent_changes,
            "risk": risk,                # CC-BE.2(overdue 만 pending).
            "cycle_time": cycle_time,    # CC-BE.2.
            "contribution": contribution,  # CC-BE.2 aggregate.
            "cost_trend": cost_trend,    # CC-BE.2.
        },
    })
