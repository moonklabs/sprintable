"""story #4101(#4095 그라운딩 doc c65ce586 §3-1·§3-4·PO Q②병렬 確定, 2026-09-21) — org
생성(연산) 커넥터 CRUD API. `channel_connections.py`의 권한 관례를 재사용(휴먼 전용 —
`is_org_owner_or_admin`이 org_members 행을 전제해 agent auth는 애초에 매치 안 됨) ·
org admin 이상만 등록/조회/revoke. 자격(credentials)은 write-only — 어떤 응답 Pydantic
모델에도 그 필드를 싣지 않는다(제외가 아니라 애초에 안 싣는 설계, gates.py의 «단일
직렬화 통로» 선례와 같은 "실수로도 못 새게" 원칙)."""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.org_generation_connector import (
    GENERATION_CONNECTOR_PROVIDER_KEYS,
    OrgGenerationConnector,
)
from app.services.org_generation_connector import (
    GenerationConnectorInvalidProviderError,
    GenerationConnectorNotFoundError,
    create_org_generation_connector,
    list_org_generation_connectors,
    revoke_org_generation_connector,
)
from app.services.project_auth import is_org_owner_or_admin

router = APIRouter(prefix="/api/v2/organizations", tags=["generation-connectors"])


async def _require_org_admin(
    db: AsyncSession, auth: AuthContext, org_id: uuid.UUID, verified_org_id: uuid.UUID,
) -> None:
    """channel_connections.py의 org_id/verified_org_id mismatch 관례(헤더 vs 경로 파라미터
    불일치 403) 그대로 — 이어서 org owner/admin 자격을 본다(agent auth는 org_members 행이
    없어 is_org_owner_or_admin이 자연히 False)."""
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")
    if not await is_org_owner_or_admin(db, uuid.UUID(auth.user_id), org_id):
        raise HTTPException(status_code=403, detail="org owner/admin only")


class GenerationConnectorCreateRequest(BaseModel):
    provider_key: str
    label: str = Field(min_length=1, max_length=200)
    model_config_json: dict = Field(default_factory=dict)
    # write-only — 요청 바디에만 존재, 어떤 응답에도 이 필드는 없다.
    credentials: str = Field(min_length=1)


class GenerationConnectorResponse(BaseModel):
    """⛔credentials/encrypted_credentials 필드를 절대 추가하지 않는다 — write-only 계약의
    정본은 이 클래스에 그 필드가 없다는 사실 자체."""
    id: uuid.UUID
    provider_key: str
    label: str
    model_config_json: dict
    status: str
    created_by: uuid.UUID | None = None


def _to_response(row: OrgGenerationConnector) -> GenerationConnectorResponse:
    return GenerationConnectorResponse(
        id=row.id, provider_key=row.provider_key, label=row.label,
        model_config_json=row.model_config_json, status=row.status, created_by=row.created_by,
    )


class GenerationConnectorListResponse(BaseModel):
    connectors: list[GenerationConnectorResponse]


@router.post(
    "/{org_id}/generation-connectors", response_model=GenerationConnectorResponse, status_code=201,
)
async def create_generation_connector_endpoint(
    org_id: uuid.UUID,
    body: GenerationConnectorCreateRequest,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
) -> GenerationConnectorResponse:
    await _require_org_admin(db, auth, org_id, verified_org_id)
    if body.provider_key not in GENERATION_CONNECTOR_PROVIDER_KEYS:
        raise HTTPException(
            status_code=422,
            detail=f"unsupported provider_key {body.provider_key!r} — must be one of "
                   f"{sorted(GENERATION_CONNECTOR_PROVIDER_KEYS)}",
        )
    try:
        row = await create_org_generation_connector(
            db, org_id=org_id, provider_key=body.provider_key, label=body.label,
            model_config_json=body.model_config_json, plaintext_credentials=body.credentials,
            created_by=uuid.UUID(auth.user_id),
        )
    except GenerationConnectorInvalidProviderError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return _to_response(row)


@router.get("/{org_id}/generation-connectors", response_model=GenerationConnectorListResponse)
async def list_generation_connectors_endpoint(
    org_id: uuid.UUID,
    active_only: bool = False,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
) -> GenerationConnectorListResponse:
    await _require_org_admin(db, auth, org_id, verified_org_id)
    rows = await list_org_generation_connectors(db, org_id=org_id, active_only=active_only)
    return GenerationConnectorListResponse(connectors=[_to_response(r) for r in rows])


@router.post(
    "/{org_id}/generation-connectors/{connector_id}/revoke", response_model=GenerationConnectorResponse,
)
async def revoke_generation_connector_endpoint(
    org_id: uuid.UUID,
    connector_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
) -> GenerationConnectorResponse:
    await _require_org_admin(db, auth, org_id, verified_org_id)
    try:
        row = await revoke_org_generation_connector(db, org_id=org_id, connector_id=connector_id)
    except GenerationConnectorNotFoundError as exc:
        raise HTTPException(status_code=404, detail="generation connector not found") from exc
    return _to_response(row)
