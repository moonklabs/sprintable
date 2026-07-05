import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.dependencies.ownership import assert_agent_owner
from app.repositories.api_key import ApiKeyRepository
from app.schemas.api_key import (
    ApiKeyCreatedResponse,
    ApiKeyResponse,
    CreateApiKeyRequest,
    RotateApiKeyRequest,
)
from app.services.recruit_service import acquire_agent_mutation_lock

router = APIRouter(prefix="/api/v2", tags=["api-keys"])


def _get_repo(session: AsyncSession = Depends(get_db)) -> ApiKeyRepository:
    return ApiKeyRepository(session)


@router.post("/api-keys/rotate", response_model=ApiKeyCreatedResponse, status_code=201)
async def rotate_api_key(
    body: RotateApiKeyRequest,
    _auth: AuthContext = Depends(get_current_user),
    repo: ApiKeyRepository = Depends(_get_repo),
    session: AsyncSession = Depends(get_db),
) -> ApiKeyCreatedResponse:
    existing = await repo.get(body.api_key_id)
    if existing is None:
        raise HTTPException(status_code=404, detail="API key not found")
    # E-RECRUIT S3 QA 재QA 잔여1건(크로스엔드포인트 레이스): recruit_agent()와 같은 agent-scoped
    # lock을 여기도 걸어 동시 rotate가 CAS 손실→AssertionError→500으로 새는 걸 막는다(PO 선호안 a).
    await acquire_agent_mutation_lock(session, existing.team_member_id)
    result = await repo.rotate(body.api_key_id)
    if result is None:
        raise HTTPException(status_code=404, detail="API key not found")
    new_key, plaintext = result
    # E-MSG-POLICY S2: rotate 시에도 creator allow_list entry 보장(멱등 — 기존 entry 보존, 중복 없음).
    from app.services.agent_message_policy import ensure_creator_allowlisted
    await ensure_creator_allowlisted(session, new_key.team_member_id)
    data = ApiKeyResponse.model_validate(new_key)
    return ApiKeyCreatedResponse(**data.model_dump(), api_key=plaintext)


@router.get("/agents/{agent_id}/api-keys", response_model=list[ApiKeyResponse])
async def list_agent_api_keys(
    agent_id: uuid.UUID,
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    repo: ApiKeyRepository = Depends(_get_repo),
) -> list[ApiKeyResponse]:
    await assert_agent_owner(agent_id, session, org_id, uuid.UUID(auth.user_id))
    keys = await repo.list_by_member(agent_id)
    return [ApiKeyResponse.model_validate(k) for k in keys]


@router.post("/agents/{agent_id}/api-keys", response_model=ApiKeyCreatedResponse, status_code=201)
async def create_agent_api_key(
    agent_id: uuid.UUID,
    body: CreateApiKeyRequest,
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    repo: ApiKeyRepository = Depends(_get_repo),
) -> ApiKeyCreatedResponse:
    await assert_agent_owner(agent_id, session, org_id, uuid.UUID(auth.user_id))
    key, plaintext = await repo.create(
        team_member_id=agent_id,
        scope=body.scope,
        expires_at=body.expires_at,
    )
    # E-MSG-POLICY S2: creator를 agent allow_list에 자동 등록(멱등).
    from app.services.agent_message_policy import ensure_creator_allowlisted
    await ensure_creator_allowlisted(session, agent_id)
    data = ApiKeyResponse.model_validate(key)
    return ApiKeyCreatedResponse(**data.model_dump(), api_key=plaintext)


@router.delete("/agents/{agent_id}/api-keys/{key_id}", status_code=200)
async def revoke_agent_api_key(
    agent_id: uuid.UUID,
    key_id: uuid.UUID,
    session: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    repo: ApiKeyRepository = Depends(_get_repo),
) -> dict:
    await assert_agent_owner(agent_id, session, org_id, uuid.UUID(auth.user_id))
    key = await repo.get(key_id)
    if key is None or key.team_member_id != agent_id:
        raise HTTPException(status_code=404, detail="API key not found for this agent")
    result = await repo.revoke(key_id)
    if result is None:
        raise HTTPException(status_code=404, detail="API key not found")
    return {"ok": True}
