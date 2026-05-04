import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user
from app.dependencies.database import get_db
from app.models.team import TeamMember
from app.repositories.api_key import ApiKeyRepository
from app.schemas.api_key import (
    ApiKeyCreatedResponse,
    ApiKeyResponse,
    CreateApiKeyRequest,
    RotateApiKeyRequest,
)

router = APIRouter(prefix="/api/v2", tags=["api-keys"])


def _get_repo(session: AsyncSession = Depends(get_db)) -> ApiKeyRepository:
    return ApiKeyRepository(session)


@router.post("/api-keys/rotate", response_model=ApiKeyCreatedResponse, status_code=201)
async def rotate_api_key(
    body: RotateApiKeyRequest,
    _auth: AuthContext = Depends(get_current_user),
    repo: ApiKeyRepository = Depends(_get_repo),
) -> ApiKeyCreatedResponse:
    result = await repo.rotate(body.api_key_id)
    if result is None:
        raise HTTPException(status_code=404, detail="API key not found")
    new_key, plaintext = result
    data = ApiKeyResponse.model_validate(new_key)
    return ApiKeyCreatedResponse(**data.model_dump(), api_key=plaintext)


@router.get("/agents/{agent_id}/api-keys", response_model=list[ApiKeyResponse])
async def list_agent_api_keys(
    agent_id: uuid.UUID,
    session: AsyncSession = Depends(get_db),
    _auth: AuthContext = Depends(get_current_user),
    repo: ApiKeyRepository = Depends(_get_repo),
) -> list[ApiKeyResponse]:
    member_r = await session.execute(
        select(TeamMember.id).where(TeamMember.id == agent_id, TeamMember.type == "agent")
    )
    if member_r.scalar_one_or_none() is None:
        raise HTTPException(status_code=404, detail="Agent not found")
    keys = await repo.list_by_member(agent_id)
    return [ApiKeyResponse.model_validate(k) for k in keys]


@router.post("/agents/{agent_id}/api-keys", response_model=ApiKeyCreatedResponse, status_code=201)
async def create_agent_api_key(
    agent_id: uuid.UUID,
    body: CreateApiKeyRequest,
    session: AsyncSession = Depends(get_db),
    _auth: AuthContext = Depends(get_current_user),
    repo: ApiKeyRepository = Depends(_get_repo),
) -> ApiKeyCreatedResponse:
    member_r = await session.execute(
        select(TeamMember.id).where(TeamMember.id == agent_id, TeamMember.type == "agent")
    )
    if member_r.scalar_one_or_none() is None:
        raise HTTPException(status_code=404, detail="Agent not found")
    key, plaintext = await repo.create(
        team_member_id=agent_id,
        scope=body.scope,
        expires_at=body.expires_at,
    )
    data = ApiKeyResponse.model_validate(key)
    return ApiKeyCreatedResponse(**data.model_dump(), api_key=plaintext)


@router.delete("/agents/{agent_id}/api-keys/{key_id}", status_code=200)
async def revoke_agent_api_key(
    agent_id: uuid.UUID,
    key_id: uuid.UUID,
    _auth: AuthContext = Depends(get_current_user),
    repo: ApiKeyRepository = Depends(_get_repo),
) -> dict:
    key = await repo.get(key_id)
    if key is None or key.team_member_id != agent_id:
        raise HTTPException(status_code=404, detail="API key not found for this agent")
    result = await repo.revoke(key_id)
    if result is None:
        raise HTTPException(status_code=404, detail="API key not found")
    return {"ok": True}
