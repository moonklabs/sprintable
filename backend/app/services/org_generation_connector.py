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
    DEFAULT_GENERATION_CONNECTOR_LOCATION,
    GENERATION_CONNECTOR_LOCATIONS,
    GENERATION_CONNECTOR_PROVIDER_KEYS,
    UQ_ORG_LABEL_CONSTRAINT_NAME,
    OrgGenerationConnector,
)
from app.services.generation_connector_credential_crypto import (
    encrypt_generation_connector_credential,
)


class GenerationConnectorNotFoundError(Exception):
    pass


class GenerationConnectorNotActiveError(Exception):
    """story #4166 — revoked 커넥터의 리전을 바꿔 봐야 크루가 다시 쓸 방법이 없다
    (바인딩은 active 커넥터만 가리킨다, #4101). 조용히 받아 주지 않고 409로 거부."""
    def __init__(self, connector_id: uuid.UUID) -> None:
        self.connector_id = connector_id
        super().__init__(f"generation connector not active: {connector_id}")


class GenerationConnectorInvalidProviderError(Exception):
    def __init__(self, provider_key: str) -> None:
        self.provider_key = provider_key
        super().__init__(f"unsupported provider_key: {provider_key!r}")


class GenerationConnectorInvalidLocationError(Exception):
    def __init__(self, location: str) -> None:
        self.location = location
        super().__init__(f"unsupported location: {location!r}")


def resolve_generation_connector_location(model_config_json: dict) -> str:
    """story #4140 — 응답에 실을 «제품 정책값» 리전 해소. crew는 이 값으로만 호출한다
    (재량 0, PO 처방 ②). 허용 목록 밖이거나 아예 없는 값(마이그레이션 0으로 남은 기존
    커넥터 포함)은 `DEFAULT_GENERATION_CONNECTOR_LOCATION`("global")로 폴백 —
    거짓 확信 0: 이 폴백은 "이 리전에서 된다"는 보장이 아니라 "제품이 아는 값이 없으니
    2호에서 실제로 통과한 안전 기본값을 쓴다"는 뜻."""
    location = model_config_json.get("location")
    if location in GENERATION_CONNECTOR_LOCATIONS:
        return location
    return DEFAULT_GENERATION_CONNECTOR_LOCATION


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
    location = model_config_json.get("location")
    if location is not None and location not in GENERATION_CONNECTOR_LOCATIONS:
        raise GenerationConnectorInvalidLocationError(location)
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


async def update_org_generation_connector_location(
    session: AsyncSession, *, org_id: uuid.UUID, connector_id: uuid.UUID, location: str,
    actor_id: uuid.UUID,
) -> OrgGenerationConnector:
    """story #4166(3호 실측, 2026-09-22 — 리전만 바꾸려면 자격 재발급·재등록·재바인딩·
    구 커넥터 해지 4단계가 필요했다) — 자격 무접촉으로 `model_config_json.location`만
    갱신. `create_org_generation_connector`와 동일 허용 목록 검증(GENERATION_
    CONNECTOR_INVALID_LOCATION 재사용, 새 판정 0). 딕셔너리를 **재할당**(in-place
    mutate 아님) — SQLAlchemy가 JSONB 컬럼의 in-place 변경을 감지 못하는 클래스
    (#2832 교훈, 이 세션의 approval_delivery.py existing_root.msg_metadata 처방과
    동형)를 여기서도 피한다.

    감사 로그: 이 커넥터 패밀리(create/revoke) 자체엔 등록 시점 감사 로그가 아직 없다
    (그라운딩 실측 — `channel_connections.py`도 동형, 이 모듈이 미러하는 그 원본에도
    없음) — «등록과 동일 관례»를 그대로 재현할 기존 자리는 없었으므로, 제품 전반의
    기존 `ActivityLogService`(신규 테이블·마이그 0, #4156 등에서 이미 쓰는 그 관례)를
    이 쓰기 축에 새로 배선한다(발명이 아니라 일반 감사 관례의 첫 적용)."""
    if location not in GENERATION_CONNECTOR_LOCATIONS:
        raise GenerationConnectorInvalidLocationError(location)
    row = await get_org_generation_connector(session, org_id=org_id, connector_id=connector_id)
    if row is None:
        raise GenerationConnectorNotFoundError(str(connector_id))
    if row.status != "active":
        raise GenerationConnectorNotActiveError(connector_id)

    old_location = resolve_generation_connector_location(row.model_config_json)
    row.model_config_json = {**row.model_config_json, "location": location}

    from app.services.activity_log import ActivityLogService

    await ActivityLogService(session).record(
        org_id=org_id, action="generation_connector_location_changed", actor_type="human",
        actor_id=actor_id, entity_type="generation_connector", entity_id=connector_id,
        context={"from_location": old_location, "to_location": location},
    )
    await session.commit()
    await session.refresh(row)
    return row
