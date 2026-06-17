import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id, require_admin
from app.dependencies.database import get_db
from app.repositories.project_api_key import ProjectApiKeyRepository
from app.schemas.project_api_key import (
    CreateProjectApiKeyRequest,
    ProjectApiKeyCreatedResponse,
    ProjectApiKeyResponse,
)

router = APIRouter(prefix="/api/v2", tags=["open-api-keys"])


def _get_repo(session: AsyncSession = Depends(get_db)) -> ProjectApiKeyRepository:
    return ProjectApiKeyRepository(session)


def _get_project_id(auth: AuthContext = Depends(get_current_user)) -> uuid.UUID:
    raw = auth.claims.get("app_metadata", {}).get("project_id")
    if not raw:
        raise HTTPException(status_code=400, detail="project_id required in JWT app_metadata")
    try:
        return uuid.UUID(str(raw))
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid project_id in JWT")


@router.post("/api-keys", response_model=ProjectApiKeyCreatedResponse, status_code=201)
async def create_project_api_key(
    body: CreateProjectApiKeyRequest,
    auth: AuthContext = Depends(require_admin),
    # QA RC HIGH②(#1549): get_verified_org_id 가 X-Project-Id override 로 claims.project_id 를
    # 갱신하므로, claims 를 읽는 _get_project_id 보다 **먼저** 선언해야(의존성 해소 순서=선언 순서)
    # stale JWT project_id 대신 override 된 값을 캡처한다.
    _org_id: uuid.UUID = Depends(get_verified_org_id),
    project_id: uuid.UUID = Depends(_get_project_id),
    repo: ProjectApiKeyRepository = Depends(_get_repo),
    session: AsyncSession = Depends(get_db),
) -> ProjectApiKeyCreatedResponse:
    created_by = uuid.UUID(auth.user_id) if auth.user_id else None
    key, plaintext = await repo.create(
        project_id=project_id,
        created_by=created_by,
        name=body.name,
        scope=body.scope,
        plan_feature_ids=body.plan_feature_ids,
    )
    await session.commit()
    await session.refresh(key)
    data = ProjectApiKeyResponse.model_validate(key)
    return ProjectApiKeyCreatedResponse(**data.model_dump(), api_key=plaintext)


@router.get("/api-keys", response_model=list[ProjectApiKeyResponse])
async def list_project_api_keys(
    _auth: AuthContext = Depends(require_admin),
    # QA RC HIGH②(#1549): get_verified_org_id 가 X-Project-Id override 로 claims.project_id 를
    # 갱신하므로, claims 를 읽는 _get_project_id 보다 **먼저** 선언해야(의존성 해소 순서=선언 순서)
    # stale JWT project_id 대신 override 된 값을 캡처한다.
    _org_id: uuid.UUID = Depends(get_verified_org_id),
    project_id: uuid.UUID = Depends(_get_project_id),
    repo: ProjectApiKeyRepository = Depends(_get_repo),
) -> list[ProjectApiKeyResponse]:
    keys = await repo.list_by_project(project_id)
    return [ProjectApiKeyResponse.model_validate(k) for k in keys]


@router.delete("/api-keys/{key_id}", status_code=204)
async def revoke_project_api_key(
    key_id: uuid.UUID,
    _auth: AuthContext = Depends(require_admin),
    # QA RC HIGH②(#1549): get_verified_org_id 가 X-Project-Id override 로 claims.project_id 를
    # 갱신하므로, claims 를 읽는 _get_project_id 보다 **먼저** 선언해야(의존성 해소 순서=선언 순서)
    # stale JWT project_id 대신 override 된 값을 캡처한다.
    _org_id: uuid.UUID = Depends(get_verified_org_id),
    project_id: uuid.UUID = Depends(_get_project_id),
    repo: ProjectApiKeyRepository = Depends(_get_repo),
    session: AsyncSession = Depends(get_db),
) -> None:
    key = await repo.get(key_id)
    if key is None or key.project_id != project_id:
        raise HTTPException(status_code=404, detail="API key not found")
    if key.revoked_at is not None:
        raise HTTPException(status_code=409, detail="API key already revoked")
    await repo.revoke(key)
    await session.commit()
