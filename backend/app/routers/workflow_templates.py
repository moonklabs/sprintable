"""WorkflowTemplate CRUD + apply API — S5-2."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.agent_routing_rule import AgentRoutingRule
from app.models.team import TeamMember
from app.repositories.agent_routing_rule import _normalize_action, _normalize_conditions
from app.repositories.workflow_template import WorkflowTemplateRepository, resolve_rules_template

router = APIRouter(prefix="/api/v2/workflow-templates", tags=["workflow-templates"])


class TemplateStepResponse(BaseModel):
    pattern: str
    role_ref: str
    default_label: str | None = None


class WorkflowTemplateResponse(BaseModel):
    slug: str
    name: str
    description: str
    chain_length: int
    steps: list[dict]
    presets: dict
    rules_template: list[dict]
    is_system: bool
    is_enabled: bool

    model_config = {"from_attributes": True}


class WorkflowTemplateListItem(BaseModel):
    slug: str
    name: str
    description: str
    chain_length: int
    presets: dict
    is_system: bool

    model_config = {"from_attributes": True}


class ApplyTemplateRequest(BaseModel):
    project_id: uuid.UUID
    preset: str | None = None
    role_mapping: dict[str, str]
    custom_labels: dict[str, str] | None = None
    overwrite_existing: bool = False


class ApplyTemplateResponse(BaseModel):
    ok: bool
    rules_created: int
    rules_deleted: int


@router.get("", response_model=list[WorkflowTemplateListItem])
async def list_templates(
    db: AsyncSession = Depends(get_db),
    _auth: AuthContext = Depends(get_current_user),
) -> list[WorkflowTemplateListItem]:
    repo = WorkflowTemplateRepository(db)
    templates = await repo.list()
    return [WorkflowTemplateListItem.model_validate(t) for t in templates]


@router.get("/{slug}", response_model=WorkflowTemplateResponse)
async def get_template(
    slug: str,
    db: AsyncSession = Depends(get_db),
    _auth: AuthContext = Depends(get_current_user),
) -> WorkflowTemplateResponse:
    repo = WorkflowTemplateRepository(db)
    tmpl = await repo.get_by_slug(slug)
    if tmpl is None:
        raise HTTPException(status_code=404, detail="Template not found")
    return WorkflowTemplateResponse.model_validate(tmpl)


@router.post("/{slug}/apply", response_model=ApplyTemplateResponse, status_code=201)
async def apply_template(
    slug: str,
    body: ApplyTemplateRequest,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
) -> ApplyTemplateResponse:
    # E-SECURITY SEC-S8(story 83ea3d6a) BB(까심 전수스윕, CRITICAL·라이브 확定): body.project_id에
    # has_project_access 검증 자체가 없어, project_a member가 project_b에 AgentRoutingRule을
    # 생성(201)할 수 있었다 — overwrite_existing=true면 기존 룰 삭제까지 겸해 파괴적 쓰기(남의
    # project 자동화 룰 심기/지우기).
    from app.services.project_auth import has_project_access
    if not await has_project_access(db, uuid.UUID(auth.user_id), body.project_id, org_id):
        raise HTTPException(status_code=404, detail="Project not found")

    repo = WorkflowTemplateRepository(db)
    tmpl = await repo.get_by_slug(slug)
    if tmpl is None:
        raise HTTPException(status_code=404, detail="Template not found")

    # role_mapping의 step_X → agent_id 매핑 검증 및 role_map 구성
    step_refs = {step["role_ref"] for step in tmpl.steps if step.get("role_ref")}
    missing = [ref for ref in step_refs if ref not in body.role_mapping]
    if missing:
        raise HTTPException(
            status_code=422,
            detail=f"role_mapping missing required step refs: {missing}",
        )

    agent_ids = [uuid.UUID(v) for v in body.role_mapping.values()]
    agents_result = await db.execute(
        select(TeamMember.id, TeamMember.name, TeamMember.role).where(
            TeamMember.id.in_(agent_ids),
            TeamMember.org_id == org_id,
        )
    )
    agent_info_by_id: dict[uuid.UUID, dict] = {
        row.id: {"agent_id": str(row.id), "agent_name": row.name or str(row.id), "role": row.role or ""}
        for row in agents_result.all()
    }

    # org 스코프 검증 — 조회 안 된 UUID는 타 org이거나 존재하지 않는 멤버
    missing_agents = [v for v in body.role_mapping.values() if uuid.UUID(v) not in agent_info_by_id]
    if missing_agents:
        raise HTTPException(
            status_code=422,
            detail=f"agent(s) not found in this org: {missing_agents}",
        )

    custom_labels = body.custom_labels or {}
    role_map: dict[str, dict[str, Any]] = {}
    for step_ref, agent_id_str in body.role_mapping.items():
        agent_uuid = uuid.UUID(agent_id_str)
        info = agent_info_by_id.get(agent_uuid, {
            "agent_id": agent_id_str,
            "agent_name": custom_labels.get(step_ref, step_ref),
            "role": "",
        })
        role_map[step_ref] = {
            **info,
            "agent_name": custom_labels.get(step_ref, info.get("agent_name", step_ref)),
            "persona_id": None,
            "deployment_id": None,
            "target_runtime": "openclaw",
            "target_model": None,
        }

    now = datetime.now(timezone.utc)
    deleted_count = 0

    if body.overwrite_existing:
        existing = await db.execute(
            select(AgentRoutingRule.id).where(
                AgentRoutingRule.org_id == org_id,
                AgentRoutingRule.project_id == body.project_id,
                AgentRoutingRule.deleted_at.is_(None),
                AgentRoutingRule.rule_metadata["from_workflow_template"].astext == "true",
            )
        )
        ids_to_delete = [row[0] for row in existing.all()]
        if ids_to_delete:
            await db.execute(
                update(AgentRoutingRule)
                .where(AgentRoutingRule.id.in_(ids_to_delete))
                .values(deleted_at=now, updated_at=now)
            )
            deleted_count = len(ids_to_delete)

    resolved = resolve_rules_template(tmpl.rules_template, role_map)
    meta: dict[str, Any] = {
        "template_slug": slug,
        "from_workflow_template": True,
        "applied_at": now.isoformat(),
    }

    actor_id: uuid.UUID | None = None
    try:
        actor_id = uuid.UUID(str(auth.user_id))
    except Exception:
        pass

    for r in resolved:
        agent_id_val = r.get("agent_id")
        if not agent_id_val:
            continue
        db.add(AgentRoutingRule(
            org_id=org_id,
            project_id=body.project_id,
            agent_id=uuid.UUID(str(agent_id_val)),
            persona_id=uuid.UUID(str(r["persona_id"])) if r.get("persona_id") else None,
            deployment_id=uuid.UUID(str(r["deployment_id"])) if r.get("deployment_id") else None,
            name=str(r.get("name") or ""),
            priority=r.get("priority", 100),
            match_type=str(r.get("match_type") or "event"),
            conditions=_normalize_conditions(r.get("conditions")),
            action=_normalize_action(r.get("action")),
            target_runtime=str(r.get("target_runtime") or "openclaw"),
            target_model=r.get("target_model"),
            is_enabled=r.get("is_enabled", True),
            rule_metadata=meta,
            created_by=actor_id,
        ))

    await db.flush()
    return ApplyTemplateResponse(ok=True, rules_created=len(resolved), rules_deleted=deleted_count)
