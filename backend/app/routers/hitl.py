import uuid

from fastapi import APIRouter, Depends, Query
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user
from app.dependencies.database import get_db
from app.repositories.hitl import HitlRepository
from app.schemas.hitl import PatchHitlPolicyRequest, ResolveHitlRequestBody

router = APIRouter(prefix="/api/v2/hitl", tags=["hitl"])


def _repo(session: AsyncSession = Depends(get_db)) -> HitlRepository:
    return HitlRepository(session)


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


@router.get("/policy")
async def get_hitl_policy(
    auth: AuthContext = Depends(get_current_user),
    repo: HitlRepository = Depends(_repo),
) -> JSONResponse:
    org_id, project_id = _get_org_project(auth)
    if not org_id:
        return _err("FORBIDDEN", "org_id required", 403)
    snapshot = await repo.get_policy(org_id, project_id)
    return _ok(snapshot.model_dump())


@router.patch("/policy")
async def update_hitl_policy(
    body: PatchHitlPolicyRequest,
    auth: AuthContext = Depends(get_current_user),
    repo: HitlRepository = Depends(_repo),
) -> JSONResponse:
    org_id, project_id = _get_org_project(auth)
    if not org_id:
        return _err("FORBIDDEN", "org_id required", 403)
    snapshot = await repo.save_policy(
        org_id=org_id,
        project_id=project_id,
        actor_id=auth.user_id,
        approval_rules=body.approval_rules,
        timeout_classes=body.timeout_classes,
    )
    return _ok(snapshot.model_dump())


@router.get("/requests")
async def list_hitl_requests(
    status: str | None = Query(default=None),
    auth: AuthContext = Depends(get_current_user),
    repo: HitlRepository = Depends(_repo),
) -> JSONResponse:
    org_id, project_id = _get_org_project(auth)
    if not org_id:
        return _err("FORBIDDEN", "org_id required", 403)
    requests = await repo.list_requests(org_id=org_id, project_id=project_id, status=status)
    return _ok([r.model_dump() for r in requests])


@router.patch("/requests/{request_id}")
async def resolve_hitl_request(
    request_id: uuid.UUID,
    body: ResolveHitlRequestBody,
    auth: AuthContext = Depends(get_current_user),
    repo: HitlRepository = Depends(_repo),
) -> JSONResponse:
    org_id, _ = _get_org_project(auth)
    if not org_id:
        return _err("FORBIDDEN", "org_id required", 403)
    row = await repo.resolve_request(
        request_id=request_id,
        org_id=org_id,
        actor_id=auth.user_id,
        status=body.status,
        response_text=body.response_text,
    )
    if row is None:
        return _err("NOT_FOUND_OR_NOT_PENDING", "Request not found or not in pending status", 404)
    return _ok({
        "id": str(row.id),
        "status": row.status,
        "responded_at": row.responded_at.isoformat() if row.responded_at else None,
    })
