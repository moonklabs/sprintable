"""E-CAGE-REFEREE P3: HITL Gate CRUD + 전이 엔드포인트."""
import logging
import uuid
from datetime import datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.doc import Doc
from app.models.gate import Gate, is_valid_transition
from app.models.hitl import HitlRequest
from app.models.pm import Story, Task
from app.routers.agent_gateway import wake_agent
from app.services.gate_service import (
    RiskGrade,
    apply_gate_urgency_sort,
    create_gate,
    derive_risk_grade,
    get_org_posture,
    hold_gate,
    resolve_work_item_project_id,
    transition_gate,
    unhold_gate,
    void_gate,
)
from app.services.member_resolver import resolve_member
from app.services.project_auth import (
    get_project_role,
    has_project_access,
    is_org_owner,
    is_org_owner_or_admin,
)


def _schedule_pending_deliveries(
    background_tasks: BackgroundTasks, pending_deliveries: list[dict],
) -> None:
    """ccbcd9da(A-1): transition_gate/override_gate 가 모은 wake/delivery 페이로드를 commit 후
    발화(#1364/relay_agent_handoff 선례 동형 — recipient_seq 확정 commit 후 wake 불변식)."""
    from app.services.conversation_webhook import deliver_injected_event_webhook

    for payload in pending_deliveries:
        agent_wake = payload.get("agent_wake")
        if agent_wake:
            wake_agent(agent_wake["recipient_id"], agent_wake["recipient_seq"])
        delivery = payload.get("delivery")
        if delivery:
            background_tasks.add_task(deliver_injected_event_webhook, **delivery)

logger = logging.getLogger(__name__)

# 사람 검증 행위(approve/reject) — "human-validated" 웨지 integrity상 휴먼 member만 허용.
_HUMAN_REVIEW_STATUSES = frozenset({"approved", "rejected"})

router = APIRouter(prefix="/api/v2/gates", tags=["gates", "Trust"])


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

    # story #2054: 결재함 통합 인박스(/gates/inbox)에서 Gate/HitlRequest 두 출처를 구분하는
    # discriminator. 기존 단독 엔드포인트(list_gates/get_gate/transition 등)는 항상 "gate"
    # 고정값 — additive, 기존 응답 shape 비파괴.
    source: Literal["gate"] = "gate"
    id: uuid.UUID
    org_id: uuid.UUID
    # story #1970(P1a-S4): GET /{id} 단건 조회 신규 enrich(Gate 모델 자체엔 project_id 컬럼이
    # 없다 — resolve_work_item_project_id()로 조회해 채운다). additive·nullable(project-무관
    # work_item은 None — 정직한 값, feedback_infra_value 류 fallback 아님). 기존 create/list/
    # transition 등 타 엔드포인트는 Gate ORM 객체에 이 속성이 없어 from_attributes 기본값
    # None으로 조용히 통과(work_item_summary/can_approve와 동일 선례).
    project_id: uuid.UUID | None = None
    work_item_id: uuid.UUID
    work_item_type: str
    # doc-side 결재 UX(24f5ae18): gate row 는 work_item_id 만이라 인박스가 doc 를 못 그림 → enrich.
    # additive·nullable(비-doc/미존재 시 None·하위호환). FE 는 별도 doc fetch 제거.
    work_item_summary: "WorkItemSummary | None" = None
    # decider 가시성(89484c8c): doc_approval 게이트에 **per-caller** can_approve(rule A) — FE in-doc
    # decider 버튼 게이팅 소스(parallel-approver 목록 아님). 비-doc/무자격/비-휴먼은 False(fail-closed·
    # additive 하위호환). ⚠️실 authz 는 BE transition 강제(이 필드는 가시성뿐). [[can_approve_doc_gate_reason]]
    can_approve: bool = False
    # story #1972(P1a-S4): 게이트 위험도 UX 등급 — **새 위험도 판정 필드가 아니다**. 기존
    # OrgGatePolicy.posture + Gate.gate_type을 순수 파생(gate_service.derive_risk_grade)한 UX
    # 힌트일 뿐(doc `gate-risk-ux-classification-criteria` §2 SSOT). "risk_level" 이름은 의도적으로
    # 피했다 — 플랫폼이 위험도를 판정한다는 오인을 부르기 때문(models/hitl_config.py:3 철학과
    # 정면충돌). additive·nullable(project_id/work_item_summary와 동일 선례 — 이 필드를 채우지 않는
    # 타 엔드포인트(create/transition/void/hold/unhold/override)는 Gate ORM 객체에 이 속성이 없어
    # from_attributes 기본값 None으로 조용히 통과). list_gates·get_gate_endpoint 둘 다에서 채운다.
    risk_grade: "RiskGrade | None" = None
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
    # story #1968: 제네릭 게이트 생성은 story/doc/task 등 work_item 객체를 로드하지 않으므로
    # (client가 work_item_id/work_item_type만 보냄) resolve_work_item_project_id()로 신규 조회.
    project_id = await resolve_work_item_project_id(
        session, org_id, body.work_item_type, body.work_item_id,
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
        project_id=project_id,
    )
    await session.commit()
    return GateResponse.model_validate(gate)


async def _non_doc_gate_approvable(
    session: AsyncSession,
    user_id: uuid.UUID,
    org_id: uuid.UUID,
    project_id: uuid.UUID | None,
) -> bool:
    """story #1974(P1a-S5): ``assigned_to_me`` 판정 rule B — doc_approval **이 아닌** gate_type
    (pr_review/qa/merge/deploy/workflow_config_publish)의 "caller 가 승인 가능한가" 단일 규칙.

    project_id 가 해소되면(story/task/doc 은 항상 해소) 그 project 의 **effective** 역할
    (``get_project_role`` — project_access ∪ org owner/admin floor, project_auth.py SSOT 재사용·
    재구현 금지)이 owner/admin 이면 승인 가능. project_id 가 구조적으로 None 이면(project-무관
    work_item — 예: workflow_line_config 류) project 경계가 없으므로 **org owner/admin**
    (``is_org_owner_or_admin``)에게만 노출 — doc.py:36 의 org owner/admin 체크와 동일 기준."""
    if project_id is not None:
        role = await get_project_role(session, user_id, project_id)
        return role in ("owner", "admin")
    return await is_org_owner_or_admin(session, user_id, org_id)


@router.get("", response_model=list[GateResponse])
async def list_gates(
    work_item_id: uuid.UUID | None = Query(default=None),
    work_item_type: str | None = Query(default=None),
    status: str | None = Query(default=None),
    sort: str | None = Query(default=None),
    assigned_to_me: bool = Query(default=False),
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
    # story #1973(P1a-S4): ?sort=urgency = SLA overdue 최상위 → age(created_at) 오래된 순 →
    # held(향후 만료) 최하단(gate_service.apply_gate_urgency_sort). 미지정 시(기본) 기존 동작
    # (무정렬/삽입순) 그대로 — 회귀 없음.
    if sort == "urgency":
        q = apply_gate_urgency_sort(q)
    result = await session.execute(q)
    gates = list(result.scalars().all())
    responses = [GateResponse.model_validate(g) for g in gates]

    # story #1972(P1a-S4): 위험도 UX 등급 enrich — org posture는 org_id 단일값(gate당 축 없음)이라
    # 목록 전체에 **1회**만 조회(N+1 0). gate_type은 gate별 값이라 derive_risk_grade는 gate마다 호출.
    # ⚠️resp.gate_type이 아닌 원본 gate.gate_type을 쓴다(zip) — can_approve enrich와 동일하게 원본
    # ORM 객체에서 읽어 GateResponse.model_validate를 대체하는 테스트 더블과도 무관하게 동작.
    if gates:
        _posture = await get_org_posture(session, org_id)
        for resp, g in zip(responses, gates):
            resp.risk_grade = derive_risk_grade(_posture, g.gate_type)

    # doc-side enrich 2종 Doc 조회를 **한 배치**로(org-scope·soft-delete 가드·N+1 0):
    #  ⓐ work_item_summary(24f5ae18): work_item_type=='doc' gate → title/slug.
    #  ⓑ can_approve(89484c8c): gate_type=='doc_approval' gate → project_id.
    # ⚠️project_id 소스 predicate 는 transition(gate_type=='doc_approval'·work_item_id→Doc)와 **동일**해야
    # DRY 정합 — work_item_type 으로 키잉하면 doc_approval 인데 work_item_type≠doc 인 이상 게이트에서 enrich
    # (can_approve)와 transition 강제가 갈림. 두 predicate 의 work_item_id 합집합으로 조회.
    summary_doc_ids = {g.work_item_id for g in gates if g.work_item_type == "doc"}
    approval_doc_ids = {g.work_item_id for g in gates if g.gate_type == "doc_approval"}
    doc_proj: dict[uuid.UUID, uuid.UUID] = {}
    fetch_ids = summary_doc_ids | approval_doc_ids
    if fetch_ids:
        from app.models.doc import Doc
        rows = (await session.execute(
            select(Doc.id, Doc.title, Doc.slug, Doc.project_id).where(
                Doc.id.in_(fetch_ids), Doc.org_id == org_id, Doc.deleted_at.is_(None),
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
    # story #1974(P1a-S5): assigned_to_me 도 doc_approval 경로는 can_approve 와 **동일 계산**이라
    # caller 식별(resolve_member)을 can_approve enrich 와 공유 — 1회만 resolve(중복 계산 0).
    resolved = None
    _uid: uuid.UUID | None = None
    if doc_gates or assigned_to_me:
        try:
            resolved = await resolve_member(auth, org_id, session)
            _uid = uuid.UUID(auth.user_id)
        except Exception:  # noqa: BLE001 — caller resolve 실패는 목록 비중단(fail-closed).
            logger.warning("list_gates caller resolve 실패(비중단) org=%s", org_id, exc_info=True)
            resolved = None
            _uid = None

    # story #1983(까심 #1960 QA 적출 회귀, story #2259 후속 — non-doc gate 대칭): can_approve_doc_gate_reason
    # 의 반환값(_reason) 자체는 WHO-only(human·project-access·not-author) 판정이라 FSM 을 전혀 안 담고 있다 —
    # 아래 resp.can_approve 계산에서 is_valid_transition(...)을 **별도로 AND** 붙이는 게 그 증거. assigned_to_me
    # 필터링(하단)은 이 WHO-only reason 을 그대로 재사용해야 하므로, doc_gates enrich 루프에서 이미 계산하는
    # _reason 을 {gate_id: reason} dict 로 들고 간다(이중 쿼리·이중 계산 0 — can_approve_doc_gate_reason 재호출 없음).
    doc_gate_who_reason: dict[uuid.UUID, str | None] = {}
    if doc_gates and resolved is not None:
        for resp, g in doc_gates:
            _reason = await can_approve_doc_gate_reason(
                session, g, resolved, _uid, org_id,
                doc_project_id=doc_proj.get(g.work_item_id),
            )
            doc_gate_who_reason[g.id] = _reason
            # 완전 DRY(codex): "지금 승인 가능" = authz(rule A·helper) **AND** FSM 으로 resolvable
            # (pending). transition 도 authz(helper) + transition_gate FSM(is_valid_transition) 이중이므로
            # enrich 도 동일 is_valid_transition 으로 FSM 반영 — terminal/held gate 는 can_approve=False(승인/
            # 반려 둘 다 pending 전제라 "approved" 한 방향 검사로 충분). authz-only 의미 갈림 제거.
            # ⚠️story #1983: 이 필드는 FE "지금 버튼 눌러도 되는가" 게이팅용이라 FSM-aware 가 **정답**
            # (held→approved 직접 전이 불가하니 held 게이트는 can_approve=False 가 맞다) — 건드리지 않는다.
            resp.can_approve = _reason is None and is_valid_transition(g.status, "approved")

    if not assigned_to_me:
        return responses

    # story #1974(P1a-S5)/#1983: assigned_to_me=true → "caller 가 승인 자격(WHO)이 있는 게이트만"
    # (대원칙 — STATE(pending/held/terminal) 는 바깥 status 쿼리가 관장, 여기서 재필터 안 함).
    # ⚠️휴먼 전용 불변식: transition_gate_endpoint(위 383~392)는 gate_type 무관
    # resolved.type != "human" 이면 무조건 403("사람 검증 행위는 휴먼 member만" — 웨지 integrity).
    # doc_approval 은 can_approve_doc_gate_reason 이 이미 not_human 을 거부사유로 반환해 자동 배제되지만,
    # rule B(project-role/org-role)는 human 체크가 없어 그대로 두면 "에이전트가 owner/admin project
    # role 을 가진 경우 배지엔 뜨는데 transition 에서 403" 모순이 재발한다 — 여기서 한 번 더 fail-closed.
    if resolved is None or resolved.type != "human":
        return []

    # 오르테가 정정(까심 #1960 QA 적출, story #1974 후속): assigned_to_me 은 게이트가 **누구
    # 것인지(WHO)** 의 문제지 pending/held 등 상태와 무관하다 — held 게이트도 같은 approver가
    # 승인할 대상이고 paused 일 뿐 "내 것"이다. 바깥 `status` 쿼리 필터가 이미 gates 를 원하는
    # 상태로 좁혀놨으니(예: status=held) 여기서 다시 "pending" 으로 하드코딩해 재필터하면 안
    # 된다 — 예전엔 그래서 `status=held&assigned_to_me=true` 가 항상 빈 배열이었다.
    non_doc_gates = [
        (resp, g) for resp, g in zip(responses, gates)
        if g.gate_type != "doc_approval"
    ]

    # project_id 배치 해소(story #1968 resolve_work_item_project_id 의 IN-clause 배치 버전 — 개별
    # gate 마다 신규 쿼리 금지). doc 은 위에서 이미 배치 조회한 doc_proj 재사용(중복 쿼리 0).
    project_id_by_work_item: dict[uuid.UUID, uuid.UUID | None] = dict(doc_proj)
    story_ids = {g.work_item_id for _, g in non_doc_gates if g.work_item_type == "story"}
    task_ids = {g.work_item_id for _, g in non_doc_gates if g.work_item_type == "task"}
    if story_ids:
        rows = (await session.execute(
            select(Story.id, Story.project_id).where(
                Story.id.in_(story_ids), Story.org_id == org_id,
            )
        )).all()
        project_id_by_work_item.update({sid: pid for sid, pid in rows})
    if task_ids:
        rows = (await session.execute(
            select(Task.id, Story.project_id)
            .join(Story, Task.story_id == Story.id)
            .where(Task.id.in_(task_ids), Task.org_id == org_id)
        )).all()
        project_id_by_work_item.update({tid: pid for tid, pid in rows})

    # N+1 방지: gate 여러 건이 같은 project 를 가리켜도 get_project_role/is_org_owner_or_admin 은
    # **고유 project_id(및 org-fallback 1회)당 1회**만 호출(캐시) — gate 개수와 무관.
    role_cache: dict[uuid.UUID, bool] = {}
    org_admin_cache: bool | None = None
    eligible_ids: set[uuid.UUID] = set()
    for _resp, g in non_doc_gates:
        pid = project_id_by_work_item.get(g.work_item_id)
        if pid is not None:
            if pid not in role_cache:
                role_cache[pid] = await _non_doc_gate_approvable(session, _uid, org_id, pid)
            if role_cache[pid]:
                eligible_ids.add(g.id)
        else:
            if org_admin_cache is None:
                org_admin_cache = await _non_doc_gate_approvable(session, _uid, org_id, None)
            if org_admin_cache:
                eligible_ids.add(g.id)

    filtered: list[GateResponse] = []
    for resp, g in zip(responses, gates):
        if g.gate_type == "doc_approval":
            # story #1983(까심 #1960 QA 적출 회귀, story #2259 후속): doc_approval assigned_to_me
            # 도 WHO(승인 자격) 판정이지 STATE(pending/held) 판정이 아니다 — story #2259가 non-doc
            # gate 에서 g.status != "pending" 하드코딩 2곳을 제거한 것과 동일 원칙을 여기 대칭
            # 적용한다. 예전엔 resp.can_approve(FSM-aware — is_valid_transition AND)를 그대로
            # 재사용해서 held doc_approval 게이트가 자격자(reviewer·non-author·project-access 有)
            # 여도 사라졌다(held→approved 직접 전이 불가라 FSM 이 항상 False). 여기서는
            # doc_gate_who_reason(WHO-only·FSM 미포함)만 본다 — .get(..., sentinel)로 dict 에
            # 없는 경우도 fail-closed(미enrich=배제). 바깥 status 쿼리 파라미터가 STATE 를 관장.
            if doc_gate_who_reason.get(g.id, "not_enriched") is None:
                filtered.append(resp)
        elif g.id in eligible_ids:
            filtered.append(resp)
    return filtered


class HitlInboxItem(BaseModel):
    """story #2054: `agent_hitl_requests`(gate_approval 종류) 결재함 인박스 노출용 최소 스키마.

    Gate와 별도 API로 승인/거부(`PATCH /hitl/requests/{id}`)하므로 GateResponse 필드를 그대로
    빌리지 않는다 — `source` 로 FE가 액션 라우팅. 미르코(FE)와 합의한 계약(conversation
    eaa1b6cb-5d73-4019-bca8-7e320087f827) 그대로: id/request_type/title/prompt/status/
    requires_human/work_item_id/work_type/created_at/expires_at.
    """
    model_config = ConfigDict(from_attributes=True)

    source: Literal["hitl"] = "hitl"
    id: uuid.UUID
    request_type: str
    title: str
    prompt: str
    status: str
    # gate_enforce.py _SAFETY_FLOOR: work_type='merge'는 최소 ask — HitlRequest로 park된 항목은
    # 정의상 항상 사람 승인 대상이라 고정 True(Gate.requires_human과 동형 의미).
    requires_human: bool = True
    work_item_id: uuid.UUID | None = None
    work_type: str | None = None
    created_at: datetime
    expires_at: datetime | None = None


# gate_enforce.py:22/gate_metrics.py:24 선례(cross-module import 대신 로컬 재선언) — HitlRequest 중
# 결재함 인박스가 다루는 부분집합(merge/done 게이트 승인 park)만. 그 외 request_type(예: 수동
# HITL 승인 요청)은 #2054 스코프 밖(별도 화면 유지) — Gate와 동일 병목에서 충돌하는 것만 통합.
_GATE_REQUEST_TYPE = "gate_approval"


async def _list_hitl_inbox_rows(
    session: AsyncSession, org_id: uuid.UUID, status: str | None,
) -> list[HitlRequest]:
    q = select(HitlRequest).where(
        HitlRequest.org_id == org_id,
        HitlRequest.request_type == _GATE_REQUEST_TYPE,
        HitlRequest.deleted_at.is_(None),
    )
    if status:
        q = q.where(HitlRequest.status == status)
    return list((await session.execute(q)).scalars().all())


def _hitl_item_from_row(r: HitlRequest) -> HitlInboxItem:
    meta = r.hitl_metadata or {}
    wi_raw = meta.get("work_item_id")
    try:
        work_item_id = uuid.UUID(wi_raw) if wi_raw else None
    except (ValueError, TypeError, AttributeError):
        work_item_id = None
    return HitlInboxItem(
        id=r.id,
        request_type=r.request_type,
        title=r.title,
        prompt=r.prompt,
        status=r.status,
        work_item_id=work_item_id,
        work_type=meta.get("work_type"),
        created_at=r.created_at,
        expires_at=r.expires_at,
    )


@router.get(
    "/inbox",
    response_model=list[Annotated[GateResponse | HitlInboxItem, Field(discriminator="source")]],
)
async def list_gate_inbox(
    status: str | None = Query(default=None),
    sort: str | None = Query(default=None),
    assigned_to_me: bool = Query(default=False),
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth=Depends(get_current_user),
) -> list[GateResponse | HitlInboxItem]:
    """story #2054: `Gate`(결재함)와 `HitlRequest`(gate_approval park) 통합 조회 — 두 체계가
    같은 승인 병목(merge)에서 서로를 못 보던 결함 해소. 데이터모델은 안 합치고(Gate 미러 생성
    금지 — 오르테가 판정) 이 read-layer에서만 통합. 액션은 각자 native API로
    (`PATCH /gates/{id}/transition` vs `PATCH /hitl/requests/{id}`) — `source` 필드로 라우팅.

    미르코(FE)와 합의한 계약(conversation eaa1b6cb): 페이지네이션 없음(기존 GET /gates 관례 유지)·
    기본 정렬 created_at DESC·`sort=urgency`는 Gate 쪽 기존 SLA 로직 그대로 + HitlRequest는
    age(created_at)만으로 같은 정렬축에 끼워 넣는 best-effort(HitlRequest엔 SLA/held 개념이 없어
    완전 동형 아님 — 이는 미리 합의된 단순화).
    """
    gate_items = await list_gates(
        work_item_id=None, work_item_type=None, status=status, sort=sort,
        assigned_to_me=assigned_to_me, session=session, org_id=org_id, auth=auth,
    )
    hitl_rows = await _list_hitl_inbox_rows(session, org_id, status)

    if assigned_to_me:
        # Gate의 non-doc assigned_to_me(WHO)와 동일 규칙 재사용: gate_approval park 대상
        # work_item_id는 실무상 항상 Story(work_type∈{done,merge}는 story 라이프사이클 단계) —
        # project 해소되면 project owner/admin, 구조적으로 project-무관이면 org owner/admin.
        resolved = None
        _uid: uuid.UUID | None = None
        if hitl_rows:
            try:
                resolved = await resolve_member(auth, org_id, session)
                _uid = uuid.UUID(auth.user_id)
            except Exception:  # noqa: BLE001 — caller resolve 실패는 목록 비중단(fail-closed).
                logger.warning(
                    "list_gate_inbox hitl caller resolve 실패(비중단) org=%s", org_id, exc_info=True,
                )
        if resolved is None or resolved.type != "human":
            hitl_rows = []
        else:
            story_ids = set()
            parsed: dict[uuid.UUID, uuid.UUID | None] = {}
            for r in hitl_rows:
                wi_raw = (r.hitl_metadata or {}).get("work_item_id")
                try:
                    wid = uuid.UUID(wi_raw) if wi_raw else None
                except (ValueError, TypeError, AttributeError):
                    wid = None
                parsed[r.id] = wid
                if wid is not None:
                    story_ids.add(wid)
            project_by_story: dict[uuid.UUID, uuid.UUID] = {}
            if story_ids:
                rows = (await session.execute(
                    select(Story.id, Story.project_id).where(
                        Story.id.in_(story_ids), Story.org_id == org_id,
                    )
                )).all()
                project_by_story = {sid: pid for sid, pid in rows}
            role_cache: dict[uuid.UUID, bool] = {}
            org_admin_cache: bool | None = None
            eligible: list[HitlRequest] = []
            for r in hitl_rows:
                pid = project_by_story.get(parsed.get(r.id))
                if pid is not None:
                    if pid not in role_cache:
                        role_cache[pid] = await _non_doc_gate_approvable(session, _uid, org_id, pid)
                    ok = role_cache[pid]
                else:
                    if org_admin_cache is None:
                        org_admin_cache = await _non_doc_gate_approvable(session, _uid, org_id, None)
                    ok = org_admin_cache
                if ok:
                    eligible.append(r)
            hitl_rows = eligible

    hitl_items = [_hitl_item_from_row(r) for r in hitl_rows]

    if sort == "urgency":
        # Gate 쪽은 이미 (held_rank, overdue_rank, created_at ASC)로 정렬돼 도착 — HitlRequest는
        # SLA/held 개념이 없어 "non-held·non-overdue" 티어(각 rank=0/1 아님 held=0-tier 아님 →
        # overdue_rank=1 동일 티어)로 취급하고 age(created_at ASC)만으로 그 안에 merge. 안정 정렬
        # (Python Timsort)로 gate_items의 기존 상대순서는 보존된다.
        # ⚠️정직한 단순화(미리 합의): gate_items의 overdue 여부는 SQL(apply_gate_urgency_sort의
        # correlated EXISTS)에서만 판정되고 GateResponse엔 그 필드가 노출되지 않는다 — 파이썬
        # 레벨에서 gate/hitl 총정렬을 다시 만드는 이상 overdue 랭크는 재구성 불가하므로 여기선
        # held(가진 필드로 재확인 가능)만 최하단 유지하고, 나머지는 age(created_at ASC) 단일
        # 축으로 합친다. 결과적으로 "overdue gate가 항상 non-overdue보다 위"라는 하드 보장은
        # 없어지고 age로 근사(실무상 overdue는 대개 오래된 항목이라 대체로 유지되나 보장은 아님) —
        # 미르코와 합의한 "HitlRequest는 age 기준으로만 끼워 넣는다"는 문구 그대로의 트레이드오프.
        combined: list[GateResponse | HitlInboxItem] = list(gate_items) + list(hitl_items)
        combined.sort(
            key=lambda it: (
                1 if (isinstance(it, GateResponse) and it.held_until and it.held_until > datetime.now(it.held_until.tzinfo)) else 0,
                it.created_at,
            )
        )
        return combined

    combined = list(gate_items) + list(hitl_items)
    combined.sort(key=lambda it: it.created_at, reverse=True)
    return combined


async def _resolve_work_item_summary(
    session: AsyncSession, org_id: uuid.UUID, work_item_type: str, work_item_id: uuid.UUID,
) -> WorkItemSummary | None:
    """story #1970(P1a-S4): GET /{id} 단건 조회 전용 work_item_summary 조립 — list_gates 의
    doc-only 배치 enrich(24f5ae18)를 story/task 까지 확장한다. 단건 조회라 배치 최적화(N+1 회피)
    필요 없음 — 타입별 단일 쿼리로 충분. doc=title+slug(기존 로직 그대로), story/task=title만
    (slug 개념 자체가 없어 항상 None), 그 외/미인식 타입·미존재 엔티티는 None(list_gates 비-doc
    분기와 동일하게 fail-soft — work_item_summary 는 additive enrich 이지 authz 게이트가 아니다).
    ⚠️list_gates 의 배치 doc 조회와 별도 코드경로 — 강제 공유하면 단건 쿼리가 불필요한 다건
    IN-clause 배치 인프라를 상속해 오히려 복잡해진다(1건 조회에 배치 이점 없음)."""
    if work_item_type == "doc":
        row = (await session.execute(
            select(Doc.title, Doc.slug).where(
                Doc.id == work_item_id, Doc.org_id == org_id, Doc.deleted_at.is_(None),
            )
        )).one_or_none()
        return WorkItemSummary(title=row[0], slug=row[1]) if row is not None else None
    if work_item_type == "story":
        title = (await session.execute(
            select(Story.title).where(
                Story.id == work_item_id, Story.org_id == org_id, Story.deleted_at.is_(None),
            )
        )).scalar_one_or_none()
        return WorkItemSummary(title=title) if title is not None else None
    if work_item_type == "task":
        title = (await session.execute(
            select(Task.title).where(
                Task.id == work_item_id, Task.org_id == org_id, Task.deleted_at.is_(None),
            )
        )).scalar_one_or_none()
        return WorkItemSummary(title=title) if title is not None else None
    return None


@router.get("/{id}", response_model=GateResponse)
async def get_gate_endpoint(
    id: uuid.UUID,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth=Depends(get_current_user),
) -> GateResponse:
    """story #1970(P1a-S4): gate 단건 조회 — 알림 payload 의 reference_id(gate.id, gate_service.py
    :150,774)로 딥링크 콜드 진입(목록 경유 없이 상세 화면 직행)을 지원한다. 응답 shape=list 아이템과
    동일(GateResponse, 단건)·미르코(FE) canonical 게이트 상세 화면이 그대로 소비하는 스레드 합의
    계약(변경 금지). project_id/work_item_summary 만 신규 enrich(risk_grade는 story #1972가 추가).

    authz: gate 의 work_item 실제 project(resolve_work_item_project_id — story #1968 SSOT 재사용)
    에 has_project_access 강제. project_id 가 해소되면(story/task/doc 은 항상 해소) 그 project
    접근권 필수·무권한은 403 이 아닌 404(participation.py `_assert_story_project_access` 와 동일
    SSOT 패턴 — 존재 여부 자체를 비노출). project_id 가 None 이면(구조적으로 project-무관 work_item
    — resolve_work_item_project_id 주석 참고) project 경계가 없으므로 접근 차단 대상이 아니다 —
    get_verified_org_id 가 이미 강제한 org 멤버십으로 충분(gate 조회 자체가 org_id 로 스코프됨).
    미존재 gate 도 동일하게 404 로 흡수(존재 비노출 규율)."""
    gate = (await session.execute(
        select(Gate).where(Gate.id == id, Gate.org_id == org_id)
    )).scalar_one_or_none()
    if gate is None:
        raise HTTPException(status_code=404, detail="Gate not found")

    project_id = await resolve_work_item_project_id(
        session, org_id, gate.work_item_type, gate.work_item_id,
    )
    if project_id is not None and not await has_project_access(
        session, uuid.UUID(auth.user_id), project_id, org_id
    ):
        raise HTTPException(status_code=404, detail="Gate not found")

    resp = GateResponse.model_validate(gate)
    resp.project_id = project_id
    resp.work_item_summary = await _resolve_work_item_summary(
        session, org_id, gate.work_item_type, gate.work_item_id,
    )
    # story #1972(P1a-S4): 위험도 UX 등급 — org posture(org_id 단일 쿼리·resolve_disposition()
    # 미경유) + 이 gate의 gate_type을 derive_risk_grade()로 파생(doc §2 SSOT).
    _posture = await get_org_posture(session, org_id)
    resp.risk_grade = derive_risk_grade(_posture, gate.gate_type)
    return resp


@router.post("/{id}/transition", response_model=GateResponse)
async def transition_gate_endpoint(
    id: uuid.UUID,
    body: GateTransitionRequest,
    background_tasks: BackgroundTasks,
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
    # story #2027(까심 QA 적출): 고위험(risk_grade=high) 게이트의 approved 전이는 사유(note) 서버측
    # 강제 — void_gate/override_gate 기존 관례(reason 없으면 ValueError→422, void_gate 참고)에
    # 맞추는 작업이다(신규 규칙 아님). 이전엔 FE 버튼 disable(evidenceViewed && reason.trim())만
    # 있고 서버는 무검증이라 POST /transition 직접 호출 시 사유 없이 통과했다. 저위험은 기존대로
    # note 없이 통과(과도 강제 금지 — PO AC). risk_grade 는 list_gates/get_gate 와 동일 파생 경로
    # (derive_risk_grade+get_org_posture) 재사용(DRY·N+1 0 — org당 posture 1쿼리).
    if body.status == "approved" and _gate is not None:
        _posture = await get_org_posture(session, org_id)
        if derive_risk_grade(_posture, _gate.gate_type) == "high" and not (body.note or "").strip():
            raise HTTPException(
                status_code=422,
                detail="고위험(risk_grade=high) 게이트 승인은 사유(note) 입력이 필수입니다.",
            )
    # ⭐S23 RC① + RC#1(방어심층): resolver_id 를 **전 status 무조건 인증 caller 로 강제**(body 무시).
    # body 조작(타인 UUID)으로 SoD(approver≠owner) 우회·confirmed_by_member_id 위조 차단.
    _resolver_id = resolved.id
    _pending_deliveries: list[dict] = []
    try:
        gate = await transition_gate(
            session, org_id, id, body.status, _resolver_id, body.note,
            pending_deliveries=_pending_deliveries,
        )
        await session.commit()
        # ccbcd9da(A-1): doc/epic 자동재개 wake — commit(recipient_seq 확정) 후 발화(이중전달 방지).
        _schedule_pending_deliveries(background_tasks, _pending_deliveries)
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
    background_tasks: BackgroundTasks,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth=Depends(get_current_user),
) -> GateResponse:
    """⭐S33 owner force-resolve: owner 가 막힌/긴급 gate 를 강제 결정(approved|rejected). owner-only·
    reason 필수·owner_id=인증 caller 강제(S23 RC①)·정상 결재(quorum/SoD) 우회. 가장 민감한 액션."""
    from app.services.gate_service import override_gate
    resolved = await _require_gate_owner(session, auth, org_id)
    _pending_deliveries: list[dict] = []
    try:
        gate = await override_gate(
            session, org_id, id, resolved.id, body.decision, body.reason,
            pending_deliveries=_pending_deliveries,
        )
        await session.commit()
        # ccbcd9da(A-1): override 도 transition_gate 재사용 경로라 동일하게 doc/epic wake 대상.
        _schedule_pending_deliveries(background_tasks, _pending_deliveries)
        return GateResponse.model_validate(gate)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
