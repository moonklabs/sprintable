"""story #4101(#4095 그라운딩 doc c65ce586 §3-1·§3-4·PO Q②병렬 確定, 2026-09-21) — org
생성(연산) 커넥터 CRUD API. `channel_connections.py`의 권한 관례를 그대로 재사용 —
**목록 열람은 휴먼 org 멤버 전원**(member 이상, channel_connections.py 449행
`_require_human` 동형), **등록/revoke는 owner/admin**(자격을 실제로 다루는 쓰기
축만 좁힌다). 자격(credentials)은 write-only — 어떤 응답 Pydantic 모델에도 그
필드를 싣지 않는다(제외가 아니라 애초에 안 싣는 설계, gates.py의 «단일 직렬화
통로» 선례와 같은 "실수로도 못 새게" 원칙).

⛔페드루 PO CHANGES-1(PR #4479 리뷰) — 1차 구현은 목록 열람에도 org admin+를
요구해(is_org_owner_or_admin) 마케팅 담당(member role)이 403을 받았다. FE는 그
403을 "이 org에 커넥터가 0건"과 구분하지 못해 항상 «없어요»로 오인시켰다 —
channel_connections.py처럼 목록은 human이면 누구나, 자격을 실제로 만지는
등록·revoke만 admin+로 좁힌다."""
from __future__ import annotations

import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.org_generation_connector import (
    GENERATION_CONNECTOR_LOCATIONS,
    GENERATION_CONNECTOR_PROVIDER_KEYS,
    OrgGenerationConnector,
)
from app.services.member_resolver import resolve_member
from app.services.org_generation_connector import (
    GenerationConnectorInvalidLocationError,
    GenerationConnectorInvalidProviderError,
    GenerationConnectorLabelDuplicateError,
    GenerationConnectorNotActiveError,
    GenerationConnectorNotFoundError,
    create_org_generation_connector,
    list_org_generation_connectors,
    resolve_generation_connector_location,
    revoke_org_generation_connector,
    update_org_generation_connector_location,
)

router = APIRouter(prefix="/api/v2/organizations", tags=["generation-connectors"])


def _require_org_match(org_id: uuid.UUID, verified_org_id: uuid.UUID) -> None:
    """channel_connections.py의 org_id/verified_org_id mismatch 관례(헤더 vs 경로
    파라미터 불일치 403) 그대로 — 모든 엔드포인트 공통 첫 관문."""
    if org_id != verified_org_id:
        raise HTTPException(status_code=403, detail="org_id mismatch")


async def _require_human(db: AsyncSession, auth: AuthContext, org_id: uuid.UUID):
    """channel_connections.py::_require_human 동형 — resolve_member()가 agent를
    type="agent"로 정확히 판정(에이전트는 목록 열람도 403 — 자격 인접 정보라
    channel_connections AC6과 같은 폭)."""
    # story #4101 CHANGES-2 소소(story #3779 BE 한글 사용자 문장 가드, PO 처방②) —
    # channel_connections.py::_require_human의 Korean message는 그 가드 도입 前
    # grandfather된 자리라 신규 코드가 그대로 베끼면 baseline 초과로 RED. detail은
    # 닫힌 코드만(사람이 읽을 문장은 FE가 그 코드를 보고 번역 — publishOutcomeLabel과
    # 같은 축, 새 한글 문장 0).
    resolved = await resolve_member(auth, org_id, db)
    if resolved.type != "human":
        raise HTTPException(status_code=403, detail={"code": "GENERATION_CONNECTOR_HUMAN_ONLY"})
    return resolved


async def _require_org_admin(db: AsyncSession, auth: AuthContext, org_id: uuid.UUID):
    """등록·revoke — 자격을 실제로 쓰거나 폐기하는 축만 owner/admin으로 좁힌다
    (channel_connections.py::_require_owner_or_admin과 동형 폭, credentials가
    실제로 오가는 쓰기 엔드포인트만).

    story #4166 CHANGES-1(페드루 PO 리뷰) — resolved member를 호출부에 돌려준다.
    activity_logs.actor_id는 member id다(services/activity_log.py:83 —
    record_created_activity가 resolve_member(...).id를 쓰는 것과 동일 관례).
    PATCH 엔드포인트가 이 반환값 대신 auth.user_id(JWT 휴먼 계정 id)를 그대로
    실었더니 피드에서 아무 member에게도 안 붙는 실사고(member-id lint +
    test_3370 RED로 발견) — 여기서 이미 조회한 member를 재사용해 재조회 0."""
    resolved = await _require_human(db, auth, org_id)
    if resolved.role not in ("owner", "admin"):
        raise HTTPException(status_code=403, detail={"code": "GENERATION_CONNECTOR_OWNER_OR_ADMIN_ONLY"})
    return resolved


class GenerationConnectorCreateRequest(BaseModel):
    # story #4101 CHANGES-2 소소(페드루 PO 리뷰) — `model_`로 시작하는 필드명은
    # Pydantic의 기본 protected_namespaces("model_",)와 부딪혀 클래스 정의 시점에
    # UserWarning을 낸다. DB 컬럼명(org_generation_connectors.model_config_json)과의
    # 1:1 대응은 서비스 계층(create_org_generation_connector 등)에서만 유지하고,
    # API 계약 필드명은 그 프리픽스를 피한다 — 신규 경고 발명 대신 필드명 자체를 고친다.
    model_config = {"protected_namespaces": ()}

    provider_key: str
    label: str = Field(min_length=1, max_length=200)
    model_config_json: dict = Field(default_factory=dict)
    # write-only — 요청 바디에만 존재, 어떤 응답에도 이 필드는 없다.
    credentials: str = Field(min_length=1)


class GenerationConnectorResponse(BaseModel):
    """⛔credentials/encrypted_credentials 필드를 절대 추가하지 않는다 — write-only 계약의
    정본은 이 클래스에 그 필드가 없다는 사실 자체.

    story #4117 — created_at·revoked_at 노출(모델엔 이미 있었다, TimestampMixin·
    org_generation_connector.py 58행 — DTO만 빠뜨렸었다). 설정 화면 «등록 시각»/
    «해지 시각» 행(#4112 시안 프레임①)이 이 두 필드가 있어야 그려진다."""
    model_config = {"protected_namespaces": ()}

    id: uuid.UUID
    provider_key: str
    label: str
    model_config_json: dict
    # story #4140 — 제품 정책값(crew 재량 0). model_config_json 원본과 별도 top-level
    # 필드로 노출(저장값 그대로와 "해소된 유효값"을 섞지 않는다 — resolve_generation_
    # connector_location() 단일 통로, 기존 커넥터(location 없음)도 이 필드로 "global"을
    # 받는다).
    location: str
    status: str
    created_by: uuid.UUID | None = None
    created_at: datetime
    revoked_at: datetime | None = None


def _to_response(row: OrgGenerationConnector) -> GenerationConnectorResponse:
    return GenerationConnectorResponse(
        id=row.id, provider_key=row.provider_key, label=row.label,
        model_config_json=row.model_config_json,
        location=resolve_generation_connector_location(row.model_config_json),
        status=row.status, created_by=row.created_by,
        created_at=row.created_at, revoked_at=row.revoked_at,
    )


class GenerationConnectorListResponse(BaseModel):
    connectors: list[GenerationConnectorResponse]


class GenerationConnectorLocationPatchRequest(BaseModel):
    """story #4166 — 자격 무접촉. `location`만 받는다(다른 필드는 이 엔드포인트의
    스코프 밖 — 있어도 무시가 아니라 애초에 스키마에 없어 422)."""
    location: str


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
    _require_org_match(org_id, verified_org_id)
    await _require_org_admin(db, auth, org_id)
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
    except GenerationConnectorInvalidLocationError as exc:
        raise HTTPException(
            status_code=422,
            detail=f"unsupported location {exc.location!r} — must be one of "
                   f"{sorted(GENERATION_CONNECTOR_LOCATIONS)}",
        ) from exc
    except GenerationConnectorLabelDuplicateError as exc:
        raise HTTPException(
            status_code=409, detail={"code": "GENERATION_CONNECTOR_LABEL_DUPLICATE"},
        ) from exc
    return _to_response(row)


@router.get("/{org_id}/generation-connectors", response_model=GenerationConnectorListResponse)
async def list_generation_connectors_endpoint(
    org_id: uuid.UUID,
    active_only: bool = False,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
) -> GenerationConnectorListResponse:
    _require_org_match(org_id, verified_org_id)
    await _require_human(db, auth, org_id)
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
    _require_org_match(org_id, verified_org_id)
    await _require_org_admin(db, auth, org_id)
    try:
        row = await revoke_org_generation_connector(db, org_id=org_id, connector_id=connector_id)
    except GenerationConnectorNotFoundError as exc:
        raise HTTPException(status_code=404, detail="generation connector not found") from exc
    return _to_response(row)


@router.patch(
    "/{org_id}/generation-connectors/{connector_id}", response_model=GenerationConnectorResponse,
)
async def patch_generation_connector_location_endpoint(
    org_id: uuid.UUID,
    connector_id: uuid.UUID,
    body: GenerationConnectorLocationPatchRequest,
    db: AsyncSession = Depends(get_db),
    auth: AuthContext = Depends(get_current_user),
    verified_org_id: uuid.UUID = Depends(get_verified_org_id),
) -> GenerationConnectorResponse:
    """story #4166 — 리전만 바꾼다(자격 무접촉·응답에 credentials 0, 등록/revoke와
    동일 write-only 계약). active 커넥터만(409) — 바인딩이 revoked 커넥터를 가리킬
    일이 없으므로(#4101) 바꿔 봐야 쓸모가 없다."""
    _require_org_match(org_id, verified_org_id)
    resolved = await _require_org_admin(db, auth, org_id)
    try:
        row = await update_org_generation_connector_location(
            db, org_id=org_id, connector_id=connector_id, location=body.location,
            actor_id=resolved.id,
        )
    except GenerationConnectorInvalidLocationError as exc:
        raise HTTPException(
            status_code=422,
            detail=f"unsupported location {exc.location!r} — must be one of "
                   f"{sorted(GENERATION_CONNECTOR_LOCATIONS)}",
        ) from exc
    except GenerationConnectorNotFoundError as exc:
        raise HTTPException(status_code=404, detail="generation connector not found") from exc
    except GenerationConnectorNotActiveError as exc:
        raise HTTPException(
            status_code=409, detail={"code": "GENERATION_CONNECTOR_NOT_ACTIVE"},
        ) from exc
    return _to_response(row)
