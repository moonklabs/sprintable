"""story #4101(#4095 그라운딩 doc c65ce586 §3-1·§3-4·PO Q②병렬 確定, 2026-09-21) —
org_generation_connectors CRUD 서비스. `channel_connection.py`의 등록/조회/revoke
패턴을 그대로 미러 — 새 계약을 발명하지 않는다. 자격은 write-only: 등록 시에만
받고, 어떤 조회 함수도 encrypted_credentials를 반환하지 않는다(라우터의 응답
Pydantic 모델 자체에 그 필드가 없는 것과 이중 방어)."""
from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.org_generation_connector import (
    GENERATION_CONNECTOR_PROVIDER_KEYS,
    UQ_ORG_LABEL_CONSTRAINT_NAME,
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


class GenerationConnectorLabelDuplicateError(Exception):
    """story #4117(라이브 실사고 그라운딩, 2026-09-21) — uq_org_generation_connectors_
    org_label 위반이 그동안 어디서도 안 잡혀 FastAPI 미처리 500(INTERNAL_ERROR)으로
    떨어졌다 — «같은 이름의 커넥터가 이미 있어요» 문구를 화면이 낼 자리가 없었다."""
    def __init__(self, label: str) -> None:
        self.label = label
        super().__init__(f"generation connector label already exists: {label!r}")


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
    # story #4117 — channel_posts.py의 SAVEPOINT + constraint-name 판별 관용구와 동형
    # (story #3808 교훈: constraint 이름을 확인하지 않고 "IntegrityError면 무조건 중복"
    # 으로 삼키면 미래에 이 테이블에 FK가 붙었을 때 그 위반까지 조용히 오판한다). 여기는
    # 동시 경합 재시도가 아니라 "그 즉시 사용자에게 409로 알리는" 용도라 begin_nested
    # 없이 바깥 트랜잭션 자체를 롤백해도 무방(이 함수가 그 트랜잭션의 유일한 쓰기).
    try:
        await session.commit()
    except IntegrityError as exc:
        await session.rollback()
        _orig = getattr(exc, "orig", None)
        constraint = getattr(_orig, "constraint_name", None) or getattr(
            getattr(_orig, "__cause__", None), "constraint_name", None,
        )
        if constraint != UQ_ORG_LABEL_CONSTRAINT_NAME:
            raise
        raise GenerationConnectorLabelDuplicateError(label) from exc
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
