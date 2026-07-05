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

router = APIRouter(prefix="/api/v2", tags=["api-keys"])


def _get_repo(session: AsyncSession = Depends(get_db)) -> ApiKeyRepository:
    return ApiKeyRepository(session)


@router.post("/api-keys/rotate", response_model=ApiKeyCreatedResponse, status_code=201)
async def rotate_api_key(
    body: RotateApiKeyRequest,
    auth: AuthContext = Depends(get_current_user),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    repo: ApiKeyRepository = Depends(_get_repo),
    session: AsyncSession = Depends(get_db),
) -> ApiKeyCreatedResponse:
    """story 561fd294(CRITICAL 보안 핫픽스): cross-org IDOR fix — 자매 3엔드포인트(list/create/
    revoke)와 달리 이 엔드포인트만 org_id dependency 자체가 없어 rotate 대상 조회가 org 무관
    글로벌 lookup이었다 — 인증만 되면 타 org api_key_id로 그 키를 회전시켜 새 평문 시크릿을
    탈취할 수 있었다(크로스-테넌트, prod 실존 확認·까심 실 exploit 재현). 자매 엔드포인트와
    동일하게 ``assert_agent_owner``로 대상 키가 가리키는 agent가 호출자의 org 소속(+생성자 or
    org admin/owner)인지 검증 — rotate 전에 반드시 통과해야 한다."""
    existing = await repo.get(body.api_key_id)
    if existing is None:
        raise HTTPException(status_code=404, detail="API key not found")
    await assert_agent_owner(existing.team_member_id, session, org_id, uuid.UUID(auth.user_id))
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
