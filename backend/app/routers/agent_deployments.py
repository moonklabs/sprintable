import uuid

from fastapi import APIRouter, Depends, Response
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user
from app.dependencies.database import get_db
from app.schemas.agent_deployment import (
    AgentDeploymentResponse,
    CreateDeploymentRequest,
    PatchDeploymentRequest,
)
from app.services.deployment_lifecycle import DeploymentLifecycleError, DeploymentLifecycleService

router = APIRouter(prefix="/api/v2/agent-deployments", tags=["agent-deployments"])


def _svc(session: AsyncSession = Depends(get_db)) -> DeploymentLifecycleService:
    return DeploymentLifecycleService(session)


def _ok(data: object, status: int = 200) -> JSONResponse:
    return JSONResponse({"data": data, "error": None, "meta": None}, status_code=status)


def _err(code: str, message: str, status: int, details: dict | None = None) -> JSONResponse:
    error: dict = {"code": code, "message": message}
    if details:
        error["details"] = details
    return JSONResponse({"data": None, "error": error, "meta": None}, status_code=status)


def _get_org_project(auth: AuthContext) -> tuple[uuid.UUID, uuid.UUID]:
    meta = auth.claims.get("app_metadata", {})
    org_id_str = meta.get("org_id")
    project_id_str = meta.get("project_id")
    if not org_id_str or not project_id_str:
        return None, None
    return uuid.UUID(str(org_id_str)), uuid.UUID(str(project_id_str))


@router.get("")
async def list_deployment_cards(
    auth: AuthContext = Depends(get_current_user),
    svc: DeploymentLifecycleService = Depends(_svc),
) -> JSONResponse:
    org_id, project_id = _get_org_project(auth)
    if not org_id:
        return _err("FORBIDDEN", "org_id required", 403)
    cards = await svc.build_cards(org_id, project_id, requested_for_member_id=auth.user_id)
    return _ok([c.model_dump() for c in cards])


@router.post("")
async def create_deployment(
    body: CreateDeploymentRequest,
    auth: AuthContext = Depends(get_current_user),
    svc: DeploymentLifecycleService = Depends(_svc),
) -> JSONResponse:
    org_id, project_id = _get_org_project(auth)
    if not org_id:
        return _err("FORBIDDEN", "org_id required", 403)
    try:
        result = await svc.create_deployment(
            org_id=org_id,
            project_id=project_id,
            agent_id=body.agent_id,
            actor_id=uuid.UUID(auth.user_id),
            name=body.name,
            runtime=body.runtime,
            model=body.model,
            version=body.version,
            persona_id=body.persona_id,
            config=body.config,
            overwrite_routing_rules=body.overwrite_routing_rules,
        )
        return _ok(result.model_dump(mode="json"), status=202)
    except DeploymentLifecycleError as e:
        return _err(e.code, str(e), e.status, e.details or None)


@router.post("/preflight")
async def run_preflight(
    body: CreateDeploymentRequest,
    auth: AuthContext = Depends(get_current_user),
    svc: DeploymentLifecycleService = Depends(_svc),
) -> JSONResponse:
    org_id, project_id = _get_org_project(auth)
    if not org_id:
        return _err("FORBIDDEN", "org_id required", 403)
    preflight = await svc.run_deployment_preflight(
        org_id=org_id,
        project_id=project_id,
        agent_id=body.agent_id,
        name=body.name,
        runtime=body.runtime,
        model=body.model,
        version=body.version,
        persona_id=body.persona_id,
        config=body.config,
        overwrite_routing_rules=body.overwrite_routing_rules,
        actor_id=uuid.UUID(auth.user_id),
    )
    return _ok({"preflight": preflight.model_dump(mode="json")})


@router.get("/{id}")
async def get_deployment(
    id: uuid.UUID,
    auth: AuthContext = Depends(get_current_user),
    svc: DeploymentLifecycleService = Depends(_svc),
) -> JSONResponse:
    org_id, project_id = _get_org_project(auth)
    if not org_id:
        return _err("FORBIDDEN", "org_id required", 403)
    try:
        dep = await svc._get_deployment(org_id, project_id, id)
        return _ok(AgentDeploymentResponse.model_validate(dep).model_dump(mode="json"))
    except DeploymentLifecycleError as e:
        return _err(e.code, str(e), e.status)


@router.patch("/{id}")
async def patch_deployment(
    id: uuid.UUID,
    body: PatchDeploymentRequest,
    auth: AuthContext = Depends(get_current_user),
    svc: DeploymentLifecycleService = Depends(_svc),
) -> JSONResponse:
    org_id, project_id = _get_org_project(auth)
    if not org_id:
        return _err("FORBIDDEN", "org_id required", 403)
    try:
        result = await svc.transition_deployment(
            org_id=org_id,
            project_id=project_id,
            actor_id=uuid.UUID(auth.user_id),
            deployment_id=id,
            status=body.status,
            failure=body.failure,
        )
        return _ok(result.model_dump(mode="json"))
    except DeploymentLifecycleError as e:
        return _err(e.code, str(e), e.status)


@router.delete("/{id}")
async def delete_deployment(
    id: uuid.UUID,
    auth: AuthContext = Depends(get_current_user),
    svc: DeploymentLifecycleService = Depends(_svc),
) -> JSONResponse:
    org_id, project_id = _get_org_project(auth)
    if not org_id:
        return _err("FORBIDDEN", "org_id required", 403)
    try:
        result = await svc.terminate_deployment(
            org_id=org_id,
            project_id=project_id,
            actor_id=uuid.UUID(auth.user_id),
            deployment_id=id,
        )
        return _ok(result.model_dump(mode="json"))
    except DeploymentLifecycleError as e:
        return _err(e.code, str(e), e.status)


@router.post("/{id}/verification")
async def complete_verification(
    id: uuid.UUID,
    auth: AuthContext = Depends(get_current_user),
    svc: DeploymentLifecycleService = Depends(_svc),
) -> JSONResponse:
    org_id, project_id = _get_org_project(auth)
    if not org_id:
        return _err("FORBIDDEN", "org_id required", 403)
    try:
        dep = await svc.complete_verification(
            org_id=org_id,
            project_id=project_id,
            actor_id=uuid.UUID(auth.user_id),
            deployment_id=id,
        )
        return _ok({"deployment": dep.model_dump(mode="json")})
    except DeploymentLifecycleError as e:
        return _err(e.code, str(e), e.status)
