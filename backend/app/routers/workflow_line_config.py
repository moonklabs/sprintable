"""E-DECISION-GATE S2: workflow line config 거버넌스 API (P0-4).

라인 config 의 draft 관리 + publish lint + publish gate(org owner/admin 승인·self-approval 금지).
RBAC: draft 관리 = project admin+(또는 org owner/admin) / publish(요청·승인) = org owner/admin.
스키마/엔진은 S1/S3. 본 라우터는 거버넌스 lifecycle 만 노출한다.
"""
import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
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
