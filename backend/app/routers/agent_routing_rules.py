import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user
from app.dependencies.database import get_db
from app.dependencies.project_scope import enforce_write_scope, resolve_required_project_id
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
    request: Request,
    body: CreateRoutingRuleRequest,
    auth: AuthContext = Depends(get_current_user),
    repo: AgentRoutingRuleRepository = Depends(_repo),
) -> JSONResponse:
    try:
        enforce_write_scope(auth, request)
    except HTTPException as exc:
        return _err("FORBIDDEN", str(exc.detail), exc.status_code)
    org_id, project_id = _get_org_project(auth)
    if not org_id:
        return _err("FORBIDDEN", "org_id required", 403)
    try:
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
    except ValueError as exc:
        return _err("BAD_REQUEST", str(exc), 400)
    return _ok(rule.model_dump(mode="json"), status=201)


@router.put("")
async def replace_or_update_rules(
    request: Request,
    body: dict,
    auth: AuthContext = Depends(get_current_user),
    repo: AgentRoutingRuleRepository = Depends(_repo),
) -> JSONResponse:
    try:
        enforce_write_scope(auth, request)
    except HTTPException as exc:
        return _err("FORBIDDEN", str(exc.detail), exc.status_code)
    # ⚠️org_id는 project_id와 독립적으로 먼저 해소(story f0c99070·reorder_or_disable_rules와 동일 이유).
    org_id_str = auth.claims.get("app_metadata", {}).get("org_id")
    if not org_id_str:
        return _err("FORBIDDEN", "org_id required", 403)
    org_id = uuid.UUID(str(org_id_str))

    if "items" in body:
        # E-MCP-OPT 후속(story f0c99070·doc legacy-project-fallback-sweep-audit §2.2 2단계): id 없이
        # (org_id,project_id)만으로 기존 룰 전부 soft-delete+재삽입 — fail-closed 앵커 0. FE 선행배선
        # (PR #2120)이 body.project_id를 명시 실어보내므로 최우선 소스로 소비(무회귀).
        # story d764522c LOW: `if explicit`(truthy) 대신 `is not None`(존재 여부) 기준 — ""/0/False
        # 같은 falsy 값을 "미지정"으로 오인해 malformed를 조용히 통과시키지 않는다.
        explicit = body.get("project_id")
        if explicit is not None:
            try:
                explicit_project_id = uuid.UUID(str(explicit))
            except ValueError:
                return _err("BAD_REQUEST", "Invalid project_id format", 400)
        else:
            explicit_project_id = None
        try:
            replace_project_id = await resolve_required_project_id(
                repo.session, request, auth, org_id,
                explicit_project_id=explicit_project_id,
            )
        except HTTPException as exc:
            return _err(
                exc.detail.get("code", "PROJECT_ID_REQUIRED") if isinstance(exc.detail, dict) else "FORBIDDEN",
                exc.detail.get("message", str(exc.detail)) if isinstance(exc.detail, dict) else str(exc.detail),
                exc.status_code,
            )
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
        try:
            rules = await repo.replace(org_id, replace_project_id, uuid.UUID(auth.user_id), items)
        except ValueError as exc:
            return _err("BAD_REQUEST", str(exc), 400)
        return _ok([r.model_dump(mode="json") for r in rules])

    # 단일-룰 update 분기: 기존 raw project_id 폴백 그대로(Tier 1 fail-closed — id 매치 요구라
    # 이번 스토리 스코프 아님, doc §2.2 4단계 후속).
    project_id_str = auth.claims.get("app_metadata", {}).get("project_id")
    project_id = uuid.UUID(str(project_id_str)) if project_id_str else None
    req_update = UpdateRoutingRuleRequest.model_validate(body)
    try:
        rule = await repo.update(
            req_update.id,
            org_id,
            project_id,
            **{k: v for k, v in req_update.model_dump().items() if k != "id"},
        )
    except ValueError as exc:
        return _err("BAD_REQUEST", str(exc), 400)
    if rule is None:
        return _err("NOT_FOUND", "Routing rule not found", 404)
    return _ok(rule.model_dump(mode="json"))


@router.patch("")
async def reorder_or_disable_rules(
    request: Request,
    body: dict,
    auth: AuthContext = Depends(get_current_user),
    repo: AgentRoutingRuleRepository = Depends(_repo),
) -> JSONResponse:
    try:
        enforce_write_scope(auth, request)
    except HTTPException as exc:
        return _err("FORBIDDEN", str(exc.detail), exc.status_code)
    # ⚠️org_id는 project_id와 독립적으로 먼저 해소(story f0c99070) — 기존 `_get_org_project`는
    # project_id도 함께 없으면 org_id까지 None으로 뭉개(둘 다 app_metadata 필수 가정), 멀티프로젝트+
    # 미설정(정당 ambiguous) 에이전트가 "org_id required" 403으로 오판정된다(reorder-items 분기는
    # 기존 raw project_id 폴백을 그대로 보존 — 무회귀).
    org_id_str = auth.claims.get("app_metadata", {}).get("org_id")
    if not org_id_str:
        return _err("FORBIDDEN", "org_id required", 403)
    org_id = uuid.UUID(str(org_id_str))

    if body.get("disable_all") is True:
        # E-MCP-OPT 후속(story f0c99070·doc legacy-project-fallback-sweep-audit §2.2 2단계): id 없이
        # (org_id,project_id)만으로 전 룰 비활성화 — fail-closed 앵커 0. FE는 이 HTTP 분기를 안 타고
        # Supabase 직접쓰기(disableRules())로 우회하므로(실측 확인) 무회귀·즉시 강제 안전.
        try:
            disable_project_id = await resolve_required_project_id(repo.session, request, auth, org_id)
        except HTTPException as exc:
            return _err(
                exc.detail.get("code", "PROJECT_ID_REQUIRED") if isinstance(exc.detail, dict) else "FORBIDDEN",
                exc.detail.get("message", str(exc.detail)) if isinstance(exc.detail, dict) else str(exc.detail),
                exc.status_code,
            )
        rules = await repo.disable_all(org_id, disable_project_id)
        return _ok([r.model_dump(mode="json") for r in rules])

    # reorder-items 분기(story f0c99070·PO 확定 — FE 선행배선 PR #2120 착지 後 강제): id 매치라
    # Tier 1 fail-closed였지만, FE가 body.project_id를 이제 명시 실어보내므로 최우선 소스로 소비.
    # story d764522c LOW: `if explicit`(truthy) 대신 `is not None`(존재 여부) 기준 — ""/0/False
    # 같은 falsy 값을 "미지정"으로 오인해 malformed를 조용히 통과시키지 않는다.
    explicit = body.get("project_id")
    if explicit is not None:
        try:
            explicit_project_id = uuid.UUID(str(explicit))
        except ValueError:
            return _err("BAD_REQUEST", "Invalid project_id format", 400)
    else:
        explicit_project_id = None
    try:
        reorder_project_id = await resolve_required_project_id(
            repo.session, request, auth, org_id,
            explicit_project_id=explicit_project_id,
        )
    except HTTPException as exc:
        return _err(
            exc.detail.get("code", "PROJECT_ID_REQUIRED") if isinstance(exc.detail, dict) else "FORBIDDEN",
            exc.detail.get("message", str(exc.detail)) if isinstance(exc.detail, dict) else str(exc.detail),
            exc.status_code,
        )
    req = ReorderRulesRequest.model_validate(body)
    items = [{"id": str(item.id), "priority": item.priority} for item in req.items]
    rules = await repo.reorder(org_id, reorder_project_id, items)
    return _ok([r.model_dump(mode="json") for r in rules])


@router.delete("")
async def delete_rule(
    request: Request,
    id: uuid.UUID = Query(...),
    auth: AuthContext = Depends(get_current_user),
    repo: AgentRoutingRuleRepository = Depends(_repo),
) -> JSONResponse:
    try:
        enforce_write_scope(auth, request)
    except HTTPException as exc:
        return _err("FORBIDDEN", str(exc.detail), exc.status_code)
    org_id, project_id = _get_org_project(auth)
    if not org_id:
        return _err("FORBIDDEN", "org_id required", 403)
    ok = await repo.delete(id, org_id, project_id)
    if not ok:
        return _err("NOT_FOUND", "Routing rule not found", 404)
    return _ok({"ok": True, "id": str(id)})
