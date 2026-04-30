import uuid

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user
from app.dependencies.database import get_db
from app.repositories.workflow_version import WorkflowVersionRepository

router = APIRouter(prefix="/api/v2/workflow-versions", tags=["workflow-versions"])


def _repo(session: AsyncSession = Depends(get_db)) -> WorkflowVersionRepository:
    return WorkflowVersionRepository(session)


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
async def list_workflow_versions(
    auth: AuthContext = Depends(get_current_user),
    repo: WorkflowVersionRepository = Depends(_repo),
) -> JSONResponse:
    org_id, project_id = _get_org_project(auth)
    if not org_id:
        return _err("FORBIDDEN", "org_id required", 403)
    versions = await repo.list(org_id=org_id, project_id=project_id)
    return _ok([v.model_dump() for v in versions])


@router.post("/{version_id}/rollback")
async def rollback_to_version(
    version_id: uuid.UUID,
    auth: AuthContext = Depends(get_current_user),
    repo: WorkflowVersionRepository = Depends(_repo),
) -> JSONResponse:
    org_id, project_id = _get_org_project(auth)
    if not org_id:
        return _err("FORBIDDEN", "org_id required", 403)
    rules = await repo.rollback(
        version_id=version_id,
        org_id=org_id,
        project_id=project_id,
        actor_id=auth.user_id,
    )
    if rules is None:
        return _err("NOT_FOUND", "Workflow version not found", 404)
    return _ok([r.model_dump() for r in rules])
