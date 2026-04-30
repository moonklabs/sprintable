import uuid
from typing import Any

from fastapi import APIRouter, Depends, Query
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user
from app.dependencies.database import get_db
from app.repositories.agent_routing_rule import AgentRoutingRuleRepository
from app.schemas.agent_routing_rule import (
    CreateRoutingRuleRequest,
    DisableAllRequest,
    ReorderRulesRequest,
    ReplaceRulesRequest,
    UpdateRoutingRuleRequest,
)

router = APIRouter(prefix="/api/v2/agent-routing-rules", tags=["agent-routing-rules"])


def _repo(session: AsyncSession = Depends(get_db)) -> AgentRoutingRuleRepository:
    return AgentRoutingRuleRepository(session)


def _ok(data: object, status: int = 200) -> JSONResponse:
    return JSONResponse({"data": data, "error": None, "meta": None}, status_code=status)


def _err(code: str, message: str, status: int) -> JSONResponse:
    return JSONResponse({"data": None, "error": {"code": code, "message": message}, "meta": None}, status_code=status)


def _get_org_project(auth: AuthContext) -> tuple[uuid.UUID | None, uuid.UUID | None]:
    meta = auth.claims.get("app_metadata", {})
    org_id_str = meta.get("org_id")
    project_id_str = meta.get("project_id")
    if not org_id_str or not project_id_str:
        return None, None
    return uuid.UUID(str(org_id_str)), uuid.UUID(str(project_id_str))


@router.get("")
async def list_or_get_rules(
    id: uuid.UUID | None = Query(default=None),
    auth: AuthContext = Depends(get_current_user),
    repo: AgentRoutingRuleRepository = Depends(_repo),
) -> JSONResponse:
    org_id, project_id = _get_org_project(auth)
    if not org_id:
        return _err("FORBIDDEN", "org_id required", 403)
    if id:
        rule = await repo.get(id, org_id, project_id)
        if rule is None:
            return _err("NOT_FOUND", "Routing rule not found", 404)
        return _ok(rule.model_dump(mode="json"))
    rules = await repo.list(org_id, project_id)
    return _ok([r.model_dump(mode="json") for r in rules])


@router.post("")
async def create_rule(
    body: CreateRoutingRuleRequest,
    auth: AuthContext = Depends(get_current_user),
    repo: AgentRoutingRuleRepository = Depends(_repo),
) -> JSONResponse:
    org_id, project_id = _get_org_project(auth)
    if not org_id:
        return _err("FORBIDDEN", "org_id required", 403)
    rule = await repo.create(
        org_id=org_id,
        project_id=project_id,
        actor_id=uuid.UUID(auth.user_id),
        agent_id=body.agent_id,
        name=body.name,
        priority=body.priority or 100,
        match_type=body.match_type or "event",
        conditions=body.conditions,
        action=body.action,
        target_runtime=body.target_runtime or "openclaw",
        target_model=body.target_model,
        is_enabled=body.is_enabled if body.is_enabled is not None else True,
        persona_id=body.persona_id,
        deployment_id=body.deployment_id,
    )
    return _ok(rule.model_dump(mode="json"), status=201)


@router.put("")
async def replace_or_update_rules(
    body: dict,
    auth: AuthContext = Depends(get_current_user),
    repo: AgentRoutingRuleRepository = Depends(_repo),
) -> JSONResponse:
    org_id, project_id = _get_org_project(auth)
    if not org_id:
        return _err("FORBIDDEN", "org_id required", 403)

    if "items" in body:
        req = ReplaceRulesRequest.model_validate(body)
        items = [
            {
                "id": str(item.id) if item.id else None,
                "agent_id": str(item.agent_id),
                "persona_id": str(item.persona_id) if item.persona_id else None,
                "deployment_id": str(item.deployment_id) if item.deployment_id else None,
                "name": item.name,
                "priority": item.priority or 100,
                "match_type": item.match_type or "event",
                "conditions": item.conditions or {"memo_type": []},
                "action": item.action or {"auto_reply_mode": "process_and_report", "forward_to_agent_id": None},
                "target_runtime": item.target_runtime or "openclaw",
                "target_model": item.target_model,
                "is_enabled": item.is_enabled if item.is_enabled is not None else True,
                "metadata": item.metadata or {},
            }
            for item in req.items
        ]
        rules = await repo.replace(org_id, project_id, uuid.UUID(auth.user_id), items)
        return _ok([r.model_dump(mode="json") for r in rules])

    req_update = UpdateRoutingRuleRequest.model_validate(body)
    rule = await repo.update(
        req_update.id,
        org_id,
        project_id,
        **{k: v for k, v in req_update.model_dump().items() if k != "id"},
    )
    if rule is None:
        return _err("NOT_FOUND", "Routing rule not found", 404)
    return _ok(rule.model_dump(mode="json"))


@router.patch("")
async def reorder_or_disable_rules(
    body: dict,
    auth: AuthContext = Depends(get_current_user),
    repo: AgentRoutingRuleRepository = Depends(_repo),
) -> JSONResponse:
    org_id, project_id = _get_org_project(auth)
    if not org_id:
        return _err("FORBIDDEN", "org_id required", 403)

    if body.get("disable_all") is True:
        rules = await repo.disable_all(org_id, project_id)
        return _ok([r.model_dump(mode="json") for r in rules])

    req = ReorderRulesRequest.model_validate(body)
    items = [{"id": str(item.id), "priority": item.priority} for item in req.items]
    rules = await repo.reorder(org_id, project_id, items)
    return _ok([r.model_dump(mode="json") for r in rules])


@router.delete("")
async def delete_rule(
    id: uuid.UUID = Query(...),
    auth: AuthContext = Depends(get_current_user),
    repo: AgentRoutingRuleRepository = Depends(_repo),
) -> JSONResponse:
    org_id, project_id = _get_org_project(auth)
    if not org_id:
        return _err("FORBIDDEN", "org_id required", 403)
    ok = await repo.delete(id, org_id, project_id)
    if not ok:
        return _err("NOT_FOUND", "Routing rule not found", 404)
    return _ok({"ok": True, "id": str(id)})
