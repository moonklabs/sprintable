"""story #3317(마케팅자동화·레시피 결함, PO 확定 2026-09-02①②③) — 조직 커넥터 레지스트리 API.

POST   /api/v2/organizations/{org_id}/connectors/{key}         — 스키마 upsert(설정 스킬 호출, org owner/admin write).
PUT    /api/v2/organizations/{org_id}/connectors/{key}/config  — org_config 값 병합(선언된 키만, org owner/admin write).
GET    /api/v2/organizations/{org_id}/connectors/{key}         — 스키마+값 조회(org 멤버 read, 에이전트 publish 합성용).
GET    /api/v2/organizations/{org_id}/connectors                — org에 등록된 커넥터 전체 목록(story 4180f67f, org 멤버 read).

권한 모델은 domain_labels.py와 동형(write=owner/admin, read=org 멤버 전원) — 커넥터 설정도
그 org 전체가 쓰는 조직 자산이라 같은 축."""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.services.connector_registry import (
    ConnectorNotRegisteredError,
    InvalidConnectorConfigError,
    InvalidConnectorSchemaError,
    get_org_connector,
    list_org_connectors,
    set_org_connector_config,
    set_org_connector_schema,
)
from app.services.project_auth import is_org_owner_or_admin

router = APIRouter(prefix="/api/v2/organizations", tags=["connectors"])


class ConnectorFieldEntry(BaseModel):
    name: str
    source: str
    type: str | None = None
    required: bool | None = None
    constraints: dict | None = None
    setup_hint: str | None = None


class ConnectorResponse(BaseModel):
    connector_key: str
    version: str
    channel: str
    fields: list[ConnectorFieldEntry]
    requires_env: list[str]
    kinds: list[str] | None = None
    org_config: dict


class SetConnectorSchemaRequest(BaseModel):
    version: str
    channel: str
    fields: list[ConnectorFieldEntry]
    requires_env: list[str] = []
    kinds: list[str] | None = None


class SetConnectorConfigRequest(BaseModel):
    config: dict


def _to_response(row) -> ConnectorResponse:
    return ConnectorResponse(
        connector_key=row.connector_key, version=row.version, channel=row.channel,
        fields=[ConnectorFieldEntry(**f) for f in row.fields], requires_env=row.requires_env,
        kinds=row.kinds, org_config=row.org_config,
    )


@router.get("/{org_id}/connectors", response_model=list[ConnectorResponse])
async def list_connectors(
    org_id: uuid.UUID,
    session: AsyncSession = Depends(get_db),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> list[ConnectorResponse]:
    """story 4180f67f(2026-09-02, PO 확定) — org에 등록된 커넥터 전체 목록(빈 배열=0건).
    단건 GET과 같은 권한 축(org 멤버 read, owner/admin 아니어도 됨) — 조직 설정 화면이
    connector_key를 미리 몰라도 이 목록으로 카드를 그린다(connector_key 하드코딩 금지,
    PO 명시 기각)."""
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")
    rows = await list_org_connectors(session, org_id=org_id)
    return [_to_response(row) for row in rows]


@router.get("/{org_id}/connectors/{key}", response_model=ConnectorResponse)
async def get_connector(
    org_id: uuid.UUID,
    key: str,
    session: AsyncSession = Depends(get_db),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> ConnectorResponse:
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")
    row = await get_org_connector(session, org_id=org_id, connector_key=key)
    if row is None:
        raise HTTPException(status_code=404, detail="connector not registered")
    return _to_response(row)


@router.post("/{org_id}/connectors/{key}", response_model=ConnectorResponse, status_code=201)
async def post_connector_schema(
    org_id: uuid.UUID,
    key: str,
    body: SetConnectorSchemaRequest,
    session: AsyncSession = Depends(get_db),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> ConnectorResponse:
    """PO 리뷰(페드루, 2026-09-02①) — 이 POST를 부르는 건 설정 스킬을 실행하는 org
    member(에이전트)다. owner/admin 전용이면 그 흐름이 첫 호출에서 403으로 죽는다 — 스키마
    등록은 org 멤버(get_verified_org_id가 이미 그 org 소속임을 강제) 누구나 가능. PUT
    config(실 조직 설정값 변경)만 owner/admin 유지(아래)."""
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")

    try:
        row = await set_org_connector_schema(
            session, org_id=org_id, connector_key=key, version=body.version, channel=body.channel,
            fields=[f.model_dump(exclude_none=True) for f in body.fields], requires_env=body.requires_env,
            kinds=body.kinds, created_by=uuid.UUID(auth.user_id),
        )
    except InvalidConnectorSchemaError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    await session.commit()
    return _to_response(row)


@router.put("/{org_id}/connectors/{key}/config", response_model=ConnectorResponse)
async def put_connector_config(
    org_id: uuid.UUID,
    key: str,
    body: SetConnectorConfigRequest,
    session: AsyncSession = Depends(get_db),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> ConnectorResponse:
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")
    if not await is_org_owner_or_admin(session, uuid.UUID(auth.user_id), org_id):
        raise HTTPException(status_code=403, detail="org owner/admin required to set connector config")

    try:
        row = await set_org_connector_config(session, org_id=org_id, connector_key=key, config=body.config)
    except ConnectorNotRegisteredError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except InvalidConnectorConfigError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    await session.commit()
    return _to_response(row)
