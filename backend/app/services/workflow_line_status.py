"""E-DECISION-GATE S10: workflow-line status read model (P1-4 observability).

story 의 workflow-line 실행 상태를 한 번에 조립한다 — active step_run(route decision·
blocking_reason·gate·H1 evidence·approvers·SLA·delivery·last_event·correlation) 또는 active 가
없으면 terminal run 5개 history. PO/FE 가 "왜 막혔나·어디로 relay 됐나"를 채팅 없이 board/API 에서
안다(FE S11 의 데이터 소스).

⭐engine_degraded/grandfathered 를 명시해 "전이는 진행됨·관측만 실패/라인 도입 전 전이" 임을
사용자가 알고 불필요한 재시도를 안 하게 한다(AC④). no-N+1: active 1건의 gate/approvers/event 만
상수 쿼리로 조회하고 history 는 요약(per-run 확장 안 함).
"""
import uuid
from typing import Any

from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.gate import Gate
from app.models.event import Event
from app.models.workflow_line import WorkflowLineStepApproval, WorkflowLineStepRun
from app.services.workflow_line_resolution import _OPEN_STEP_RUN_STATUSES

# engine 관측 실패(전이는 진행)·라인 도입 전 grandfather 를 가리키는 신호.
_DEGRADED_FAILURE_CLASSES = frozenset({"engine_failed", "engine_exception"})
_HISTORY_LIMIT = 5


class ApproverView(BaseModel):
    member_id: uuid.UUID
    member_type: str
    kind: str
    blocking: bool
    status: str
    role_key: str | None = None
    resolved_at: Any = None


class LastEventView(BaseModel):
    id: uuid.UUID
    event_type: str
    recipient_seq: int | None = None
    status: str
    created_at: Any = None


class RecipientAgentView(BaseModel):
    """S12 Gap1: stuck handoff 의 막힌 recipient(dispatch event recipient 기반·assignee 파생 아님)."""
    id: uuid.UUID
    name: str | None = None
    type: str | None = None


class StepRunView(BaseModel):
    id: uuid.UUID
    status: str
    from_status: str | None = None
    to_status: str
    mode: str
    routing_decision: str | None = None
    routing_reason: str | None = None
    blocking_reason: str | None = None
    gate_id: uuid.UUID | None = None
    delivery_status: str
    delivery_error: str | None = None
    correlation_id: uuid.UUID
    sla_due_at: Any = None
    started_at: Any = None
    engine_degraded: bool = False
    grandfathered: bool = False
    observability_note: str | None = None
    h1_evidence: dict[str, Any] | None = None
    approvers: list[ApproverView] = []
    last_event: LastEventView | None = None
    recipient_agent: RecipientAgentView | None = None  # S12 Gap1: 막힌 agent(event recipient)


class HistoryItem(BaseModel):
    id: uuid.UUID
    status: str
    from_status: str | None = None
    to_status: str
    mode: str
    routing_decision: str | None = None
    resolved_at: Any = None
    correlation_id: uuid.UUID


class WorkflowLineStatusResponse(BaseModel):
    story_id: uuid.UUID
    has_active: bool
    active: StepRunView | None = None
    history: list[HistoryItem] = []


class LineStatusSummary(BaseModel):
    """보드 카드 badge 용 경량 요약(배치). full StepRunView/history 없이 flag 만."""
    story_id: uuid.UUID
    has_active: bool
    mode: str | None = None
    status: str | None = None
    engine_degraded: bool = False
    grandfathered: bool = False
    handoff_stuck: bool = False
    delivery_status: str | None = None
    recipient_agent: RecipientAgentView | None = None  # S12 Gap1: 막힌 agent(event recipient)


def _degraded_flags(run: WorkflowLineStepRun) -> tuple[bool, bool, str | None]:
    """(engine_degraded, grandfathered, note) 도출."""
    engine_degraded = bool(run.degraded_to_plain) or (run.failure_class in _DEGRADED_FAILURE_CLASSES)
    grandfathered = run.mode == "plain_transition"
    note = None
    if engine_degraded:
        note = "전이는 진행됨 · 라인 관측만 실패(재시도 불필요)"
    elif grandfathered:
        note = "라인 도입 전/off 전이(grandfathered) · 게이트 미적용"
    return engine_degraded, grandfathered, note


def _blocking_reason(run: WorkflowLineStepRun) -> str | None:
    """막힌 이유 1줄 — failure_message > routing_reason 우선(blocked/gate 대기 시)."""
    if run.failure_message:
        return run.failure_message
    if run.status in ("gate_pending", "waiting_gate", "waiting_parallel"):
        return run.routing_reason or "awaiting_gate_decision"
    if run.status in ("blocked", "blocked_by_policy"):
        return run.routing_reason or "blocked_by_policy"
    return run.routing_reason


async def build_workflow_line_status(
    session: AsyncSession, org_id: uuid.UUID, story_id: uuid.UUID,
) -> WorkflowLineStatusResponse:
    """story 의 workflow-line 상태 read model 을 조립한다(active 또는 terminal history).

    ⭐bounded query(SME): runs 전체를 .all() 로 읽지 않고 active 는 LIMIT 1, history 는 LIMIT 5
    로 DB-level 제한한다(스토리당 run 누적이 커도 상수 비용).
    """
    _story_runs = select(WorkflowLineStepRun).where(
        WorkflowLineStepRun.org_id == org_id,
        WorkflowLineStepRun.entity_type == "story",
        WorkflowLineStepRun.entity_id == story_id,
    )
    # active = 미해소(open) run 중 가장 최근 1건(LIMIT 1).
    active = (await session.execute(
        _story_runs.where(WorkflowLineStepRun.status.in_(_OPEN_STEP_RUN_STATUSES))
        .order_by(WorkflowLineStepRun.started_at.desc()).limit(1)
    )).scalar_one_or_none()

    if active is None:
        # active 없음 → terminal run 5개 history(LIMIT 5·AC③). open 이 없으니 최근 run 들은 terminal.
        rows = (await session.execute(
            _story_runs.where(WorkflowLineStepRun.status.not_in(_OPEN_STEP_RUN_STATUSES))
            .order_by(WorkflowLineStepRun.started_at.desc()).limit(_HISTORY_LIMIT)
        )).scalars().all()
        history = [
            HistoryItem(
                id=r.id, status=r.status, from_status=r.from_status, to_status=r.to_status,
                mode=r.mode, routing_decision=r.routing_decision, resolved_at=r.resolved_at,
                correlation_id=r.correlation_id,
            )
            for r in rows
        ]
        return WorkflowLineStatusResponse(story_id=story_id, has_active=False, history=history)

    # active 1건의 gate / approvers / event 만 상수 쿼리(no-N+1·AC⑥).
    gate = None
    if active.gate_id is not None:
        gate = (await session.execute(
            select(Gate).where(Gate.id == active.gate_id, Gate.org_id == org_id)
        )).scalar_one_or_none()
    h1_evidence = None
    if gate is not None:
        h1_evidence = {
            "requires_human": gate.requires_human,
            "evidence_status": gate.evidence_status,
            "decision_basis": gate.decision_basis,
            "auto_decision_reason": gate.auto_decision_reason,
            "gate_status": gate.status,
        }

    approvers: list[ApproverView] = []
    if active.approval_group_id is not None:
        appr_rows = (await session.execute(
            select(WorkflowLineStepApproval).where(
                WorkflowLineStepApproval.approval_group_id == active.approval_group_id,
            ).order_by(WorkflowLineStepApproval.created_at.asc())
        )).scalars().all()
        approvers = [
            ApproverView(
                member_id=a.approver_member_id, member_type=a.approver_member_type, kind=a.kind,
                blocking=a.blocking, status=a.status, role_key=a.role_key, resolved_at=a.resolved_at,
            )
            for a in appr_rows
        ]

    last_event = None
    recipient_agent = None
    if active.event_id is not None:
        ev = (await session.execute(
            select(Event).where(Event.id == active.event_id)
        )).scalar_one_or_none()
        if ev is not None:
            last_event = LastEventView(
                id=ev.id, event_type=ev.event_type, recipient_seq=ev.recipient_seq,
                status=ev.status, created_at=ev.created_at,
            )
            # S12 Gap1: 막힌 recipient agent(event recipient 기반·assignee 파생 X).
            recipient_agent = await _resolve_recipient_agent(session, ev.recipient_id)

    engine_degraded, grandfathered, note = _degraded_flags(active)
    view = StepRunView(
        id=active.id, status=active.status, from_status=active.from_status, to_status=active.to_status,
        mode=active.mode, routing_decision=active.routing_decision, routing_reason=active.routing_reason,
        blocking_reason=_blocking_reason(active), gate_id=active.gate_id,
        delivery_status=active.delivery_status, delivery_error=active.delivery_error,
        correlation_id=active.correlation_id, sla_due_at=active.sla_due_at, started_at=active.started_at,
        engine_degraded=engine_degraded, grandfathered=grandfathered, observability_note=note,
        h1_evidence=h1_evidence, approvers=approvers, last_event=last_event, recipient_agent=recipient_agent,
    )
    return WorkflowLineStatusResponse(story_id=story_id, has_active=True, active=view)


async def _resolve_recipient_agent(
    session: AsyncSession, recipient_id: uuid.UUID | None,
) -> RecipientAgentView | None:
    """event recipient_id → TeamMember(id/name/type). 없으면 id만(FE 폴백 '에이전트')."""
    if recipient_id is None:
        return None
    from app.models.team import TeamMember
    m = await session.get(TeamMember, recipient_id)
    if m is None:
        return RecipientAgentView(id=recipient_id)
    return RecipientAgentView(id=recipient_id, name=m.name, type=m.type)


async def build_workflow_line_status_batch(
    session: AsyncSession, org_id: uuid.UUID, story_ids: list[uuid.UUID],
) -> list[LineStatusSummary]:
    """여러 story 의 line-status 경량 요약(보드 badge 용). 단일 쿼리·N+1 0.

    ⭐active-only(open status) + entity_id IN (ids) 1쿼리(unbounded .all() 금지·ids 가 bound·S10 교훈).
    story 당 가장 최근 active run 1건으로 요약하고, run 없는 story 는 has_active=False 로 반환한다.
    handoff_stuck = delivery_status=='timed_out'(S8 watchdog 가 stuck 을 timed_out 으로 기록).
    """
    if not story_ids:
        return []
    rows = (await session.execute(
        select(WorkflowLineStepRun).where(
            WorkflowLineStepRun.org_id == org_id,
            WorkflowLineStepRun.entity_type == "story",
            WorkflowLineStepRun.entity_id.in_(story_ids),
            WorkflowLineStepRun.status.in_(_OPEN_STEP_RUN_STATUSES),
        ).order_by(WorkflowLineStepRun.started_at.desc())
    )).scalars().all()

    latest: dict[uuid.UUID, WorkflowLineStepRun] = {}
    for r in rows:  # started_at desc → story 당 첫 등장이 최신
        latest.setdefault(r.entity_id, r)

    # S12 Gap1: recipient_agent 배치 해소(N+1 0) — event_ids→Event.recipient_id, recipient_ids→
    # TeamMember 를 각 1쿼리(IN). per-run 추가 fetch 없음.
    agent_by_run: dict[uuid.UUID, RecipientAgentView] = {}
    event_ids = [r.event_id for r in latest.values() if r.event_id is not None]
    if event_ids:
        from app.models.team import TeamMember
        evs = (await session.execute(
            select(Event.id, Event.recipient_id).where(Event.id.in_(event_ids))
        )).all()
        ev_recipient = {eid: rid for eid, rid in evs}
        rids = [rid for rid in ev_recipient.values() if rid is not None]
        members = {}
        if rids:
            members = {m.id: m for m in (await session.execute(
                select(TeamMember).where(TeamMember.id.in_(rids))
            )).scalars().all()}
        for r in latest.values():
            rid = ev_recipient.get(r.event_id) if r.event_id is not None else None
            if rid is None:
                continue
            m = members.get(rid)
            agent_by_run[r.id] = (RecipientAgentView(id=rid, name=m.name, type=m.type)
                                  if m is not None else RecipientAgentView(id=rid))

    out: list[LineStatusSummary] = []
    for sid in story_ids:
        r = latest.get(sid)
        if r is None:
            out.append(LineStatusSummary(story_id=sid, has_active=False))
            continue
        engine_degraded, grandfathered, _ = _degraded_flags(r)
        out.append(LineStatusSummary(
            story_id=sid, has_active=True, mode=r.mode, status=r.status,
            engine_degraded=engine_degraded, grandfathered=grandfathered,
            handoff_stuck=(r.delivery_status == "timed_out"), delivery_status=r.delivery_status,
            recipient_agent=agent_by_run.get(r.id),
        ))
    return out
