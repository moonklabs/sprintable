"""E-DECISION-GATE S2: workflow line config 거버넌스 API (P0-4).

라인 config 의 draft 관리 + publish lint + publish gate(org owner/admin 승인·self-approval 금지).
RBAC: draft 관리 = project admin+(또는 org owner/admin) / publish(요청·승인) = org owner/admin.
스키마/엔진은 S1/S3. 본 라우터는 거버넌스 lifecycle 만 노출한다.
"""
import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, field_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.gate import Gate
from app.models.workflow_line import ENTITY_TYPES, WorkflowLineDefinitionVersion
from app.services.gate_service import transition_gate
from app.services.project_auth import get_project_role, is_org_owner_or_admin
from app.services.workflow_line_config import (
    PublishLintError,
    SelfApprovalError,
    assert_not_self_approval,
    complete_publish,
    create_draft,
    lint_config,
    request_publish,
    transition_version,
)
from app.services.workflow_line_engine import evaluate_line_for_transition
from app.services.workflow_line_resolver import resolve_routing_context

router = APIRouter(prefix="/api/v2/workflow-line-config", tags=["workflow-line-config"])


# ── schemas ───────────────────────────────────────────────────────────────────
class CreateDraftRequest(BaseModel):
    entity_type: str
    config: dict[str, Any]
    project_id: uuid.UUID | None = None

    @field_validator("entity_type")
    @classmethod
    def _validate_entity_type(cls, v: str) -> str:
        if v not in ENTITY_TYPES:
            raise ValueError(f"entity_type must be one of {sorted(ENTITY_TYPES)}")
        return v


class VersionResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    org_id: uuid.UUID
    project_id: uuid.UUID | None
    entity_type: str
    version: int
    status: str
    config_hash: str
    lint_status: str
    lint_errors: list
    line_definition_id: uuid.UUID | None
    review_gate_id: uuid.UUID | None


class LintResponse(BaseModel):
    lint_status: str
    errors: list[dict[str, str]]


class PublishResponse(BaseModel):
    version: VersionResponse
    gate_id: uuid.UUID
    gate_status: str


# ── helpers ────────────────────────────────────────────────────────────────────
async def _load_version(session: AsyncSession, org_id: uuid.UUID, version_id: uuid.UUID) -> WorkflowLineDefinitionVersion:
    r = await session.execute(
        select(WorkflowLineDefinitionVersion).where(
            WorkflowLineDefinitionVersion.id == version_id,
            WorkflowLineDefinitionVersion.org_id == org_id,
        )
    )
    version = r.scalar_one_or_none()
    if version is None:
        raise HTTPException(status_code=404, detail="version not found")
    return version


async def _require_draft_author(session, actor, org_id, project_id) -> None:
    """draft 관리 권한: project 스코프면 project admin/owner 또는 org owner/admin, org 스코프면 org owner/admin."""
    if project_id is not None:
        role = await get_project_role(session, actor, project_id)
        if role in ("owner", "admin") or await is_org_owner_or_admin(session, actor, org_id):
            return
        raise HTTPException(status_code=403, detail="project admin or org owner/admin required")
    if not await is_org_owner_or_admin(session, actor, org_id):
        raise HTTPException(status_code=403, detail="org owner/admin required for org-level config")


async def _require_publisher(session, actor, org_id) -> None:
    """publish(요청·승인) = org owner/admin 전용(AC ②)."""
    if not await is_org_owner_or_admin(session, actor, org_id):
        raise HTTPException(status_code=403, detail="org owner/admin required to publish workflow config")


# ── endpoints ──────────────────────────────────────────────────────────────────
@router.post("/versions", response_model=VersionResponse, status_code=201)
async def create_draft_version(
    body: CreateDraftRequest,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> VersionResponse:
    actor = uuid.UUID(auth.user_id)
    await _require_draft_author(session, actor, org_id, body.project_id)
    version = await create_draft(session, org_id, body.project_id, body.entity_type, body.config, actor)
    await session.commit()
    return VersionResponse.model_validate(version)


@router.get("/versions/{version_id}", response_model=VersionResponse)
async def get_version(
    version_id: uuid.UUID,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    _auth: AuthContext = Depends(get_current_user),
) -> VersionResponse:
    return VersionResponse.model_validate(await _load_version(session, org_id, version_id))


@router.post("/versions/{version_id}/lint", response_model=LintResponse)
async def lint_version(
    version_id: uuid.UUID,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    _auth: AuthContext = Depends(get_current_user),
) -> LintResponse:
    version = await _load_version(session, org_id, version_id)
    errors = lint_config(version.config)
    return LintResponse(lint_status="failed" if errors else "passed", errors=errors)


@router.post("/versions/{version_id}/request-publish", response_model=PublishResponse)
async def request_publish_version(
    version_id: uuid.UUID,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> PublishResponse:
    actor = uuid.UUID(auth.user_id)
    await _require_publisher(session, actor, org_id)
    version = await _load_version(session, org_id, version_id)
    try:
        version, gate = await request_publish(session, org_id, version, actor)
    except PublishLintError as e:
        await session.commit()  # lint_status/errors persist
        raise HTTPException(status_code=422, detail={"error": "publish_lint_failed", "lint_errors": e.errors})
    await session.commit()
    return PublishResponse(
        version=VersionResponse.model_validate(version), gate_id=gate.id, gate_status=gate.status
    )


@router.post("/versions/{version_id}/approve", response_model=VersionResponse)
async def approve_publish(
    version_id: uuid.UUID,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> VersionResponse:
    """publish gate 승인 → version published 확정. org owner/admin + self-approval 금지."""
    actor = uuid.UUID(auth.user_id)
    await _require_publisher(session, actor, org_id)
    version = await _load_version(session, org_id, version_id)
    if version.review_gate_id is None:
        raise HTTPException(status_code=409, detail="version has no publish gate (request-publish first)")
    # self-approval 선검증 — transition_gate side-effect(verdict 기록 등) 타기 전에 차단(SME 권장).
    gate_r = await session.execute(
        select(Gate).where(Gate.id == version.review_gate_id, Gate.org_id == org_id)
    )
    gate = gate_r.scalar_one_or_none()
    if gate is None:
        raise HTTPException(status_code=409, detail="publish gate not found")
    try:
        assert_not_self_approval(gate, actor, version.id)
    except SelfApprovalError:
        raise HTTPException(status_code=403, detail="self-approval forbidden: requester cannot approve own publish")
    try:
        # transition_gate 레일 재사용 → 직후 complete_publish 콜백(내부 특수분기 금지).
        gate = await transition_gate(session, org_id, version.review_gate_id, "approved", resolver_id=actor)
        version = await complete_publish(session, version, gate, resolver_id=actor)
    except SelfApprovalError:
        raise HTTPException(status_code=403, detail="self-approval forbidden: requester cannot approve own publish")
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    await session.commit()
    return VersionResponse.model_validate(version)


@router.post("/versions/{version_id}/reject", response_model=VersionResponse)
async def reject_publish(
    version_id: uuid.UUID,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> VersionResponse:
    actor = uuid.UUID(auth.user_id)
    await _require_publisher(session, actor, org_id)
    version = await _load_version(session, org_id, version_id)
    if version.review_gate_id is not None:
        try:
            await transition_gate(session, org_id, version.review_gate_id, "rejected", resolver_id=actor)
        except ValueError:
            pass  # gate already resolved — version 전이만 반영
    version = await transition_version(session, version, "rejected")
    await session.commit()
    return VersionResponse.model_validate(version)


@router.post("/versions/{version_id}/retire", response_model=VersionResponse)
async def retire_version(
    version_id: uuid.UUID,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> VersionResponse:
    actor = uuid.UUID(auth.user_id)
    await _require_publisher(session, actor, org_id)
    version = await _load_version(session, org_id, version_id)
    version = await transition_version(session, version, "retired")
    await session.commit()
    return VersionResponse.model_validate(version)


class ResolvePreviewRequest(BaseModel):
    entity_type: str
    entity_id: uuid.UUID
    from_status: str | None = None
    to_status: str
    actor_id: uuid.UUID | None = None
    actor_type: str | None = None
    project_id: uuid.UUID | None = None

    @field_validator("entity_type")
    @classmethod
    def _valid_entity(cls, v: str) -> str:
        if v not in ENTITY_TYPES:
            raise ValueError(f"entity_type must be one of {sorted(ENTITY_TYPES)}")
        return v


# ⭐FE(유나) 3축 계약(cross-layer 사전정합): routing_path·gates·trust_branch.
class PreviewStep(BaseModel):
    from_status: str | None = None
    to_status: str
    route: str | None = None  # 이 전이가 거치는 라우팅 결정 라벨


class PreviewGate(BaseModel):
    gate_type: str | None = None      # human | policy | merge
    target: str | None = None         # 게이트 대상 설명(blocking_reason)
    gate_id: uuid.UUID | None = None


class PreviewTrustBranch(BaseModel):
    # ⚠️ null="데이터 없음(cold-start)" ≠ 0(실값) — FE 가 다르게 렌더하므로 null 보존(hypothesis_hit_rate).
    trust: float | None = None
    decision: str | None = None       # auto_merge | ask_human | block
    cold_start: bool = False          # trust=null 사유(FE null≠0 렌더 보조)


class ResolvePreviewResponse(BaseModel):
    mode: str
    proceeds: bool
    blocking_reason: str | None = None
    http_status: int | None = None
    matched: bool  # 이 전이를 거버닝하는 published 라인 step 존재(mode != plain_transition)
    routing_path: list[PreviewStep] = []   # ① 거치는 step 시퀀스(Phase-1=단일 전이)
    gates: list[PreviewGate] = []          # ② 걸리는 게이트
    trust_branch: PreviewTrustBranch       # ③ trust + decision
    routing_context: dict[str, Any] = {}   # raw(디버그·완전성·additive)


_MODE_TO_DECISION = {
    "plain_transition": "auto_merge", "advisory_only": "auto_merge",
    "engine_failed": "auto_merge", "gate_pending": "ask_human", "blocked_by_policy": "block",
}
_MODE_TO_GATE_TYPE = {"gate_pending": "human", "blocked_by_policy": "policy"}


def _project_preview(decision, from_status, to_status, routing_context) -> "ResolvePreviewResponse":
    """LineDecision + routing_context 를 FE 3축으로 투영(documented mapping·PO 요청)."""
    trust = routing_context.get("trust") if isinstance(routing_context, dict) else {}
    trust = trust if isinstance(trust, dict) else {}
    matched = decision.mode != "plain_transition"
    decision_label = _MODE_TO_DECISION.get(decision.mode)
    routing_path = (
        [PreviewStep(from_status=from_status, to_status=to_status, route=decision_label)]
        if matched else []
    )
    gates = []
    if decision.mode in _MODE_TO_GATE_TYPE:
        # ⭐QA Nit2: merge-gate dry-run 은 mode=gate_pending 이지만 effective_gate_type="merge" 로
        # 정확 라벨(human 오라벨 방지·FE 가 merge_verdict 배지 렌더). effective_gate_type 우선.
        gates.append(PreviewGate(
            gate_type=decision.effective_gate_type or _MODE_TO_GATE_TYPE[decision.mode],
            target=decision.blocking_reason, gate_id=decision.gate_id,
        ))
    return ResolvePreviewResponse(
        mode=decision.mode, proceeds=decision.proceeds,
        blocking_reason=decision.blocking_reason, http_status=decision.http_status,
        matched=matched, routing_path=routing_path, gates=gates,
        trust_branch=PreviewTrustBranch(
            trust=trust.get("hypothesis_hit_rate"),   # ⭐None=cold-start 보존(0점 금지)
            decision=decision_label, cold_start=bool(trust.get("cold_start", False)),
        ),
        routing_context=routing_context if isinstance(routing_context, dict) else {},
    )


@router.post("/resolve-preview", response_model=ResolvePreviewResponse)
async def resolve_preview(
    body: ResolvePreviewRequest,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> ResolvePreviewResponse:
    """⭐S29 Phase-1: dry-run resolve-preview — 현 published 라인이 이 전이를 어떻게 라우팅/게이팅하는지
    **실제 전이/write 없이** 미리보기(admin-only). evaluate_line_for_transition(dry_run=True)로 동일
    결정 로직(preview≠real 드리프트 회피)·resolve_routing_context(side-effect-free)로 표시용 routing/
    trust. candidate-config diff/what-if 는 S29-followup(PO Q1 published-only)."""
    actor = uuid.UUID(auth.user_id)
    # Q4: admin-only 게이트. ⚠️네이밍 주의(QA Nit1)=`_require_draft_author` 는 이름과 달리 **admin 강제**
    # (project owner/admin ∪ org owner/admin·project_auth canonical·ad-hoc role 금지·S27 교훈). 공유
    # 헬퍼라 rename 안 하고 호출부 노트로 의도 명시 — 라인 config 편집권과 동일 레벨이 policy 미리보기 권한.
    await _require_draft_author(session, actor, org_id, body.project_id)

    decision = await evaluate_line_for_transition(
        session, org_id=org_id, project_id=body.project_id,
        entity_type=body.entity_type, entity_id=body.entity_id,
        from_status=body.from_status, to_status=body.to_status,
        actor_id=body.actor_id, actor_type=body.actor_type, dry_run=True,
    )
    # 표시용 routing/trust: 엔진이 쓰는 동일 함수(side-effect-free) 재사용 → preview 와 real 일치.
    routing_context = await resolve_routing_context(
        session, org_id, entity_type=body.entity_type, entity_id=body.entity_id,
        actor_member_id=body.actor_id, actor_type=body.actor_type,
    )
    # ⭐dry-run write-0 보장(QA 집중 항목): 평가 경로는 write 0 이지만 잔여 0 을 명시적으로 rollback.
    await session.rollback()
    return _project_preview(decision, body.from_status, body.to_status, routing_context)


class ActiveLineResponse(BaseModel):
    entity_type: str
    project_id: uuid.UUID | None = None
    has_active: bool                       # 활성 published 라인 존재(default-off/미발행→false)
    definition_id: uuid.UUID | None = None
    config: dict[str, Any] = {}            # 현 published config(steps/gates 시퀀스). 없으면 {}


@router.get("/active", response_model=ActiveLineResponse)
async def get_active_line(
    entity_type: str = Query(...),
    project_id: uuid.UUID | None = Query(default=None),
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> ActiveLineResponse:
    """⭐S29 좌-pane 데이터소스: (entity_type, project)의 현 active published 라인 config(steps/gates).

    admin-only(project_auth canonical·S29 패턴 재사용)·read-only·마이그0. SSOT=WorkflowLineDefinition
    (is_active=True·project override>org-default) + 최신 published version config. 엔진 헬퍼 재사용
    (preview≠real 드리프트 회피). 활성 라인 없으면 has_active=false·config={}(default-off 정상)."""
    if entity_type not in ENTITY_TYPES:
        raise HTTPException(status_code=422, detail=f"entity_type must be one of {sorted(ENTITY_TYPES)}")
    actor = uuid.UUID(auth.user_id)
    await _require_draft_author(session, actor, org_id, project_id)  # admin 게이팅(이름≠동작·admin 강제)
    from app.services.workflow_line_engine import _active_definition, _published_config
    definition = await _active_definition(session, org_id, project_id, entity_type)
    if definition is None:
        return ActiveLineResponse(entity_type=entity_type, project_id=project_id, has_active=False)
    config = await _published_config(session, definition)
    return ActiveLineResponse(
        entity_type=entity_type, project_id=project_id, has_active=True,
        definition_id=definition.id, config=config,
    )
