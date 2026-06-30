"""E-CAGE-REFEREE P3: HITL Gate CRUD + 전이 엔드포인트."""
import logging
import uuid
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, field_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.doc import Doc
from app.models.gate import Gate
from app.services.gate_service import (
    create_gate,
    hold_gate,
    transition_gate,
    unhold_gate,
    void_gate,
)
from app.services.member_resolver import resolve_member
from app.services.project_auth import has_project_access, is_org_owner, is_org_owner_or_admin

logger = logging.getLogger(__name__)

# 사람 검증 행위(approve/reject) — "human-validated" 웨지 integrity상 휴먼 member만 허용.
_HUMAN_REVIEW_STATUSES = frozenset({"approved", "rejected"})

router = APIRouter(prefix="/api/v2/gates", tags=["gates"])


class GateCreateRequest(BaseModel):
    work_item_id: uuid.UUID
    work_item_type: str
    gate_type: str
    member_id: uuid.UUID
    role_id: uuid.UUID
    neutral_facts: dict[str, Any] | None = None

    @field_validator("gate_type")
    @classmethod
    def validate_gate_type(cls, v: str) -> str:
        from app.models.hitl_config import GATE_TYPES
        if v not in GATE_TYPES:
            raise ValueError(f"gate_type must be one of {sorted(GATE_TYPES)}")
        return v


class GateTransitionRequest(BaseModel):
    status: str
    resolver_id: uuid.UUID | None = None  # ⚠️RC#1: 무시됨(서버가 인증 caller 로 강제)·하위호환 잔류.
    note: str | None = None

    @field_validator("status")
    @classmethod
    def validate_status(cls, v: str) -> str:
        # ⭐RC#1(body-trust 봉인): generic transition 은 **사람 결재(approved/rejected)만** 허용.
        # voided/held/pending(S30/S31)은 전용 엔드포인트(/void·/hold·/unhold)로만 — 그쪽이 admin
        # 게이트(_require_gate_admin)+actor 강제+side-effect 를 보유. generic 으로 보내면 그 가드
        # 3중 우회(비-admin voided/held·voider/holder body-trust·step_run 미해소)되므로 차단.
        if v not in _HUMAN_REVIEW_STATUSES:
            raise ValueError(
                f"generic transition 은 {sorted(_HUMAN_REVIEW_STATUSES)} 만 허용합니다. "
                "voided/held/unhold 는 전용 엔드포인트(/void·/hold·/unhold)를 사용하세요."
            )
        return v


class WorkItemSummary(BaseModel):
    """doc-side 결재 UX(24f5ae18): 인박스 gate 가 work_item 을 렌더/링크하도록 title/slug 동봉.
    현재 doc gate 에 채움(향후 타 work_item_type 확장 여지)."""
    title: str
    slug: str | None = None


class GateResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    org_id: uuid.UUID
    work_item_id: uuid.UUID
    work_item_type: str
    # doc-side 결재 UX(24f5ae18): gate row 는 work_item_id 만이라 인박스가 doc 를 못 그림 → enrich.
    # additive·nullable(비-doc/미존재 시 None·하위호환). FE 는 별도 doc fetch 제거.
    work_item_summary: "WorkItemSummary | None" = None
    # decider 가시성(89484c8c): doc_approval 게이트에 **per-caller** can_approve(rule A) — FE in-doc
    # decider 버튼 게이팅 소스(parallel-approver 목록 아님). 비-doc/무자격/비-휴먼은 False(fail-closed·
    # additive 하위호환). ⚠️실 authz 는 BE transition 강제(이 필드는 가시성뿐). [[can_approve_doc_gate_reason]]
    can_approve: bool = False
    gate_type: str
    status: str
    resolver_id: uuid.UUID | None = None
    resolved_at: datetime | None = None
    resolution_note: str | None = None
    held_until: datetime | None = None  # S31: status='held' 시 시한부 만료(무기한이면 None)·additive
    neutral_facts: dict[str, Any] | None = None
    # H1-S3: merge verdict gate evidence metadata (0118)·additive·하위호환 default.
    requires_human: bool = False
    evidence_status: str | None = None
    decision_basis: str | None = None
    auto_decision_reason: str | None = None
    created_at: datetime
    updated_at: datetime


# rule-A can_approve 단일 규칙(48f064e5 transition 인라인 → 89484c8c 추출·DRY). transition 강제(403
# 분기)와 list_gates decider 가시성(can_approve bool) 이 공용 — 거동 분기 0.
_DOC_UNSET: Any = object()


async def can_approve_doc_gate_reason(
    session: AsyncSession,
    gate: Gate,
    resolved: Any,
    user_id: uuid.UUID,
    org_id: uuid.UUID,
    *,
    doc_project_id: Any = _DOC_UNSET,
) -> str | None:
    """doc_approval 게이트 rule A(PO) 판정. None=승인 가능·else 거부사유 코드("not_human"/"self_or_unverified"/
    "no_project_access"). rule A = human + 대상 doc project has_project_access + not-author(resolver≠
    requester·미기록=fail-closed). ⚠️single source: transition self-approval/can_approve 강제와 list_gates
    per-caller can_approve enrich 가 공용(분기 일치 보장). ``doc_project_id`` 미지정 시 대상 doc 직접 조회
    (transition 단건)·list_gates 는 배치 조회한 project_id 주입(N+1 0)·None 주입=삭제/미존재 doc."""
    if resolved.type != "human":
        return "not_human"
    requester = (gate.neutral_facts or {}).get("requested_by_member_id")
    # SoD: 상신자 본인 금지 + 미기록(forged/이상 게이트)=fail-closed.
    if requester is None or str(resolved.id) == str(requester):
        return "self_or_unverified"
    if doc_project_id is _DOC_UNSET:
        _doc = (await session.execute(
            select(Doc).where(
                Doc.id == gate.work_item_id, Doc.org_id == org_id, Doc.deleted_at.is_(None)
            )
        )).scalar_one_or_none()
        doc_project_id = _doc.project_id if _doc is not None else None
    if doc_project_id is None or not await has_project_access(
        session, user_id, doc_project_id, org_id
    ):
        return "no_project_access"
    return None


@router.post("", response_model=GateResponse, status_code=201)
async def create_gate_endpoint(
    body: GateCreateRequest,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    _auth=Depends(get_current_user),
) -> GateResponse:
    # ⚠️BLOCKER(codex gpt-5.5): doc_approval 게이트는 **doc 상신 경로(doc.py transition)로만** 생성.
    # 일반 엔드포인트는 client 가 work_item_id=<자기 doc>+forged neutral_facts.requested_by_member_id 로
    # pre-create 가능 → create_gate 멱등 재사용으로 transition self-approval 가드 우회. 직접 생성 거부
    # (방어심층·doc.py 가 caller 로 server-stamp 하는 것과 짝). 비-doc 게이트는 기존대로.
    if body.gate_type == "doc_approval":
        raise HTTPException(
            status_code=403,
            detail="doc 결재 게이트는 doc 상신 경로로만 생성됩니다 (직접 생성 불가).",
        )
    gate = await create_gate(
        session=session,
        org_id=org_id,
        work_item_id=body.work_item_id,
        work_item_type=body.work_item_type,
        gate_type=body.gate_type,
        member_id=body.member_id,
        role_id=body.role_id,
        neutral_facts=body.neutral_facts,
    )
    await session.commit()
    return GateResponse.model_validate(gate)


@router.get("", response_model=list[GateResponse])
async def list_gates(
    work_item_id: uuid.UUID | None = Query(default=None),
    work_item_type: str | None = Query(default=None),
    status: str | None = Query(default=None),
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth=Depends(get_current_user),
) -> list[GateResponse]:
    q = select(Gate).where(Gate.org_id == org_id)
    if work_item_id:
        q = q.where(Gate.work_item_id == work_item_id)
    if work_item_type:
        q = q.where(Gate.work_item_type == work_item_type)
    if status:
        q = q.where(Gate.status == status)
    result = await session.execute(q)
    gates = list(result.scalars().all())
    responses = [GateResponse.model_validate(g) for g in gates]

    # doc-side 결재 UX(24f5ae18): doc gate 는 work_item_id(doc id)만이라 인박스가 doc 를 못 그림 →
    # doc title/slug batch enrich(org-scope·soft-delete 가드·N+1 0). FE 가 "결재: <title>" 렌더 + /docs/<slug>
    # 링크. 비-doc/삭제 doc 은 None(하위호환). project_id 도 같이 조회해 can_approve enrich 에 재사용.
    doc_ids = {g.work_item_id for g in gates if g.work_item_type == "doc"}
    doc_proj: dict[uuid.UUID, uuid.UUID] = {}
    if doc_ids:
        from app.models.doc import Doc
        rows = (await session.execute(
            select(Doc.id, Doc.title, Doc.slug, Doc.project_id).where(
                Doc.id.in_(doc_ids), Doc.org_id == org_id, Doc.deleted_at.is_(None),
            )
        )).all()
        summaries = {did: WorkItemSummary(title=title, slug=slug) for did, title, slug, _ in rows}
        doc_proj = {did: pid for did, _, _, pid in rows}
        for resp in responses:
            if resp.work_item_type == "doc":
                resp.work_item_summary = summaries.get(resp.work_item_id)

    # decider 가시성(89484c8c): doc_approval 게이트에 **per-caller** can_approve(rule A) enrich — FE in-doc
    # decider 버튼 게이팅 소스(parallel /approvers 아님·그건 admin-only·plain doc-gate 빈목록=dead-path).
    # transition 강제와 can_approve_doc_gate_reason 단일 규칙 공용(DRY). 배치 project_id 주입(N+1 0)·비-휴먼/
    # 무자격/삭제 doc = False(default·fail-closed). additive — 실 authz 는 transition BE 가 강제(이 필드=가시성뿐).
    doc_gates = [(resp, g) for resp, g in zip(responses, gates) if g.gate_type == "doc_approval"]
    if doc_gates:
        try:
            resolved = await resolve_member(auth, org_id, session)
            _uid = uuid.UUID(auth.user_id)
            for resp, g in doc_gates:
                _reason = await can_approve_doc_gate_reason(
                    session, g, resolved, _uid, org_id,
                    doc_project_id=doc_proj.get(g.work_item_id),
                )
                resp.can_approve = _reason is None
        except Exception:  # noqa: BLE001 — can_approve 가시성 enrich 실패는 목록 비중단(fail-closed=False 유지).
            logger.warning("list_gates can_approve enrich 실패(비중단) org=%s", org_id, exc_info=True)
    return responses


@router.post("/{id}/transition", response_model=GateResponse)
async def transition_gate_endpoint(
    id: uuid.UUID,
    body: GateTransitionRequest,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth=Depends(get_current_user),
) -> GateResponse:
    # authz(93fc7aeb): 게이트 approve/reject는 **휴먼 member만**. 에이전트(API key)가 사람 검증
    # 게이트를 승인하면 "agent-assisted·human-validated" 웨지 전제가 무너지므로 차단(403).
    # 시스템 auto-resolution(resolve_gate_from_verdict)은 transition_gate 서비스 직호출이라 무영향.
    # ⭐RC#1: status 는 validator 가 approved/rejected 로 제한 → 도달하는 전이는 전부 사람 결재.
    resolved = await resolve_member(auth, org_id, session)
    if resolved.type != "human":
        raise HTTPException(
            status_code=403,
            detail="게이트 승인/거부는 휴먼 멤버만 가능합니다 (에이전트 승인 불가).",
        )
    # E-DG 48f064e5: doc 결재 게이트 BE-level can_approve 강제(FE 게이팅은 가시성뿐·실 authz는 BE).
    # 룰(A·PO 결정): human(위) + 대상 doc project has_project_access + not-author(resolver≠requester).
    # 89484c8c: rule 을 can_approve_doc_gate_reason 단일 규칙으로 추출 — list_gates per-caller can_approve
    # 가시성과 **공용**(거동 분기 0·DRY). 거부사유별 403 메시지는 여기서 보존(self vs 권한). 휴먼 체크는
    # 위에서 선행되므로 여기 not_human 미도달(방어적으로 권한 403 매핑). 비-doc 게이트는 기존 경로 무변경.
    _gate = (await session.execute(
        select(Gate).where(Gate.id == id, Gate.org_id == org_id)
    )).scalar_one_or_none()
    if _gate is not None and _gate.gate_type == "doc_approval":  # doc.py DOC_GATE_TYPE
        _reason = await can_approve_doc_gate_reason(
            session, _gate, resolved, uuid.UUID(auth.user_id), org_id
        )
        # ① self-approval(SoD)·상신자 미기록(forged/이상 게이트) fail-closed.
        if _reason == "self_or_unverified":
            raise HTTPException(
                status_code=403,
                detail="본인이 상신한 doc 결재는 본인이 승인/거부할 수 없습니다 (self-approval 금지·상신자 미검증 차단).",
            )
        # ② can_approve 자격(no_project_access·삭제 doc·방어적 not_human): project-scope·random org-member 차단.
        if _reason is not None:
            raise HTTPException(
                status_code=403,
                detail="doc 결재 권한이 없습니다 (대상 프로젝트 접근 필요).",
            )
    # ⭐S23 RC① + RC#1(방어심층): resolver_id 를 **전 status 무조건 인증 caller 로 강제**(body 무시).
    # body 조작(타인 UUID)으로 SoD(approver≠owner) 우회·confirmed_by_member_id 위조 차단.
    _resolver_id = resolved.id
    try:
        gate = await transition_gate(session, org_id, id, body.status, _resolver_id, body.note)
        await session.commit()
        return GateResponse.model_validate(gate)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))


class GateVoidRequest(BaseModel):
    reason: str  # 사유 필수(audit·파괴적 액션). 빈 사유는 서비스서 422.


@router.post("/{id}/void", response_model=GateResponse)
async def void_gate_endpoint(
    id: uuid.UUID,
    body: GateVoidRequest,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth=Depends(get_current_user),
) -> GateResponse:
    """⭐S30 admin recovery: 잘못 생성된 pending gate 무효화(void). admin-only(project_auth canonical).

    voider 는 **인증 caller 강제**(body 신뢰 0·S23 RC① 패턴). void≠approval — 묶인 step_run 해소로
    엔티티 unblock(re-route 가능)되되 전이 미적용. transition 단일경로(void 는 void_gate SSOT)."""
    resolved = await resolve_member(auth, org_id, session)
    # Q4: canonical project_auth admin 게이팅(ad-hoc role 금지·S27/S29 교훈). org owner/admin 만.
    if not await is_org_owner_or_admin(session, uuid.UUID(auth.user_id), org_id):
        raise HTTPException(status_code=403, detail="게이트 무효화는 org owner/admin 만 가능합니다.")
    try:
        gate = await void_gate(session, org_id, id, resolved.id, body.reason)
        await session.commit()
        return GateResponse.model_validate(gate)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))


class GateHoldRequest(BaseModel):
    reason: str | None = None       # S31: 보류 사유(선택·가역적 일시정지라 마찰↓)
    held_until: datetime | None = None  # 시한부 만료(무기한이면 None)


async def _require_gate_admin(session, auth, org_id):
    """⭐S31/S30 공통: gate 파괴적/관리 액션 admin 게이팅(canonical project_auth·ad-hoc role 금지).
    반환 resolved member(holder/voider=인증 caller 강제용·body 신뢰 0)."""
    resolved = await resolve_member(auth, org_id, session)
    if not await is_org_owner_or_admin(session, uuid.UUID(auth.user_id), org_id):
        raise HTTPException(status_code=403, detail="이 액션은 org owner/admin 만 가능합니다.")
    return resolved


@router.post("/{id}/hold", response_model=GateResponse)
async def hold_gate_endpoint(
    id: uuid.UUID,
    body: GateHoldRequest,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth=Depends(get_current_user),
) -> GateResponse:
    """⭐S31 admin hold: pending gate 일시 보류(held·SLA pause). admin-only·holder=인증 caller 강제."""
    resolved = await _require_gate_admin(session, auth, org_id)
    try:
        gate = await hold_gate(session, org_id, id, resolved.id, body.reason, body.held_until)
        await session.commit()
        return GateResponse.model_validate(gate)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))


@router.post("/{id}/unhold", response_model=GateResponse)
async def unhold_gate_endpoint(
    id: uuid.UUID,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth=Depends(get_current_user),
) -> GateResponse:
    """⭐S31 admin unhold: held gate 재개(→pending·SLA resume). admin-only·actor=인증 caller."""
    resolved = await _require_gate_admin(session, auth, org_id)
    try:
        gate = await unhold_gate(session, org_id, id, resolved.id)
        await session.commit()
        return GateResponse.model_validate(gate)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))


class GateReassignRequest(BaseModel):
    new_approver_id: uuid.UUID
    old_approver_id: uuid.UUID | None = None  # approver row 여러 개면 지정(1개면 생략)
    reason: str | None = None


class GateApproverResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    approver_member_id: uuid.UUID
    approver_member_type: str
    status: str
    kind: str
    blocking: bool
    reassigned_from_member_id: uuid.UUID | None = None
    original_approver_member_id: uuid.UUID | None = None
    # ⭐S32: "재지정됨 · {admin} · {시각}" 출처(마이그0·신규 컬럼 아님). reassign 이벤트
    # (WorkflowLineStepRunEvent approver_reassigned)서 최신 actor/time enrich. 재지정 안 됐으면 None.
    reassigned_by_member_id: uuid.UUID | None = None
    reassigned_at: datetime | None = None


async def _enrich_approvers(session, org_id, rows) -> list[GateApproverResponse]:
    """approver row → response. 재지정된 row 는 최신 approver_reassigned 이벤트서 reassigned_by/at enrich
    (FE "재지정됨 · admin · 시각" 렌더용·마이그0·이벤트가 메타 SSOT)."""
    from app.models.workflow_line import WorkflowLineStepRunEvent
    out = []
    for r in rows:
        resp = GateApproverResponse.model_validate(r)
        if r.reassigned_from_member_id is not None:
            ev = (await session.execute(
                select(WorkflowLineStepRunEvent).where(
                    WorkflowLineStepRunEvent.org_id == org_id,
                    WorkflowLineStepRunEvent.step_run_id == r.step_run_id,
                    WorkflowLineStepRunEvent.event_type == "approver_reassigned",
                    WorkflowLineStepRunEvent.target_member_id == r.approver_member_id,
                ).order_by(WorkflowLineStepRunEvent.created_at.desc()).limit(1)
            )).scalar_one_or_none()
            if ev is not None:
                resp.reassigned_by_member_id = ev.actor_member_id
                resp.reassigned_at = ev.created_at
        out.append(resp)
    return out


@router.get("/{id}/approvers", response_model=list[GateApproverResponse])
async def list_gate_approvers_endpoint(
    id: uuid.UUID,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth=Depends(get_current_user),
) -> list[GateApproverResponse]:
    """⭐S32 FE conditional-display: gate approver row 목록(있으면 parallel gate→reassign 노출·없으면
    단일/merge gate→reassign 미노출로 422 원천차단). admin-only. 재지정 메타(누가/언제) enrich."""
    await _require_gate_admin(session, auth, org_id)
    from app.services.workflow_parallel_approval import list_gate_approvers
    rows = await list_gate_approvers(session, org_id, id)
    return await _enrich_approvers(session, org_id, rows)


@router.post("/{id}/reassign", response_model=list[GateApproverResponse])
async def reassign_gate_approver_endpoint(
    id: uuid.UUID,
    body: GateReassignRequest,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth=Depends(get_current_user),
) -> list[GateApproverResponse]:
    """⭐S32 admin reassign: parallel gate 의 pending 결재자 교체. admin-only·reassigner=인증 caller 강제
    (body 신뢰 0·S23 RC①). gate.status 불변(pending 유지·재결정 대상). 단일 gate=422(parallel 전용)."""
    resolved = await _require_gate_admin(session, auth, org_id)
    from app.services.workflow_parallel_approval import list_gate_approvers, reassign_approver
    try:
        await reassign_approver(
            session, org_id, id, body.new_approver_id, resolved.id,
            old_approver_id=body.old_approver_id, reason=body.reason,
        )
        rows = await list_gate_approvers(session, org_id, id)  # 갱신된 approver 목록 반환
        result = await _enrich_approvers(session, org_id, rows)  # reassigned_by/at enrich(이벤트서)
        await session.commit()
        return result
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))


class GateOverrideRequest(BaseModel):
    decision: str  # "approved" | "rejected" (owner 강제 결정)
    reason: str    # 필수 — 가장 민감한 액션이라 사유 의무


async def _require_gate_owner(session, auth, org_id):
    """⭐S33 owner-only 게이팅 — override 는 SoD 우회=가장 강력이라 admin(void/hold/reassign)보다 좁게
    owner 만. is_org_owner(role='owner') canonical. 반환 resolved(owner_id=인증 caller 강제·body 신뢰 0)."""
    resolved = await resolve_member(auth, org_id, session)
    if not await is_org_owner(session, uuid.UUID(auth.user_id), org_id):
        raise HTTPException(status_code=403, detail="이 액션은 org owner 만 가능합니다.")
    return resolved


@router.post("/{id}/override", response_model=GateResponse)
async def override_gate_endpoint(
    id: uuid.UUID,
    body: GateOverrideRequest,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth=Depends(get_current_user),
) -> GateResponse:
    """⭐S33 owner force-resolve: owner 가 막힌/긴급 gate 를 강제 결정(approved|rejected). owner-only·
    reason 필수·owner_id=인증 caller 강제(S23 RC①)·정상 결재(quorum/SoD) 우회. 가장 민감한 액션."""
    from app.services.gate_service import override_gate
    resolved = await _require_gate_owner(session, auth, org_id)
    try:
        gate = await override_gate(session, org_id, id, resolved.id, body.decision, body.reason)
        await session.commit()
        return GateResponse.model_validate(gate)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
