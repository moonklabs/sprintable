"""story #4101(#4095 그라운딩 doc c65ce586 §3-1·§3-4·PO Q②병렬 確定, 2026-09-21) —
org_generation_connectors CRUD 서비스. `channel_connection.py`의 등록/조회/revoke
패턴을 그대로 미러 — 새 계약을 발명하지 않는다. 자격은 write-only: 등록 시에만
받고, 어떤 조회 함수도 encrypted_credentials를 반환하지 않는다(라우터의 응답
Pydantic 모델 자체에 그 필드가 없는 것과 이중 방어)."""
from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.org_generation_connector import (
    GENERATION_CONNECTOR_PROVIDER_KEYS,
    OrgGenerationConnector,
)
from app.services.generation_connector_credential_crypto import (
    encrypt_generation_connector_credential,
)


class GenerationConnectorNotFoundError(Exception):
    pass


class GenerationConnectorInvalidProviderError(Exception):
    def __init__(self, provider_key: str) -> None:
        self.provider_key = provider_key
        super().__init__(f"unsupported provider_key: {provider_key!r}")


async def create_org_generation_connector(
    session: AsyncSession, *, org_id: uuid.UUID, provider_key: str, label: str,
    model_config_json: dict, plaintext_credentials: str, created_by: uuid.UUID | None,
) -> OrgGenerationConnector:
    if provider_key not in GENERATION_CONNECTOR_PROVIDER_KEYS:
        raise GenerationConnectorInvalidProviderError(provider_key)
    row = OrgGenerationConnector(
        org_id=org_id, provider_key=provider_key, label=label,
        model_config_json=model_config_json,
        encrypted_credentials=encrypt_generation_connector_credential(plaintext_credentials),
        status="active", created_by=created_by,
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return row


async def list_org_generation_connectors(
    session: AsyncSession, *, org_id: uuid.UUID, active_only: bool = False,
) -> list[OrgGenerationConnector]:
    stmt = select(OrgGenerationConnector).where(OrgGenerationConnector.org_id == org_id)
    if active_only:
        stmt = stmt.where(OrgGenerationConnector.status == "active")
    stmt = stmt.order_by(OrgGenerationConnector.created_at.desc())
    return list((await session.execute(stmt)).scalars().all())


async def get_org_generation_connector(
    session: AsyncSession, *, org_id: uuid.UUID, connector_id: uuid.UUID,
) -> OrgGenerationConnector | None:
    return (await session.execute(
        select(OrgGenerationConnector).where(
            OrgGenerationConnector.id == connector_id, OrgGenerationConnector.org_id == org_id,
        )
    )).scalar_one_or_none()


async def revoke_org_generation_connector(
    session: AsyncSession, *, org_id: uuid.UUID, connector_id: uuid.UUID,
) -> OrgGenerationConnector:
    from datetime import datetime, timezone

    row = await get_org_generation_connector(session, org_id=org_id, connector_id=connector_id)
    if row is None:
        raise GenerationConnectorNotFoundError(str(connector_id))
    row.status = "revoked"
    row.revoked_at = datetime.now(timezone.utc)
    await session.commit()
    await session.refresh(row)
    return row
