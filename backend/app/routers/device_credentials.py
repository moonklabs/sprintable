"""기기별 자격증명(`dt_live_*`) 등록·폐기 — 휴먼 셀프서브.

`sk_live_*`(org 전역 장수명 bearer)는 노트북 1대를 잃으면 org 전체 키를 회전해야 하고 그
회전이 연결된 모든 에이전트를 끊는다. 이 라우터는 그 blast radius를 기기 1대로 좁힌다 —
**폐기 1대 = 그 기기만 끊김**.

⚠️여기엔 앱 무결성(attestation) 계층이 없다. 의도적이다 — 이 경로는 자체호스팅(폐쇄망 로컬
docker)에서도 성립해야 하고, Apple App Attest/Play Integrity는 그 환경에서 쓸 수 없다.
서버는 등록 시 제출된 **공개키**를 저장하고 매 요청 서명을 그것으로 검증한다(개인키는 서버에
오지 않는다). `device_installations`(앱 무결성 증명)와 목적이 달라 테이블도 경로도 분리돼 있다.

⚠️평문 자격증명을 저장하지 않는다 — `dt_live_` 는 **기기 식별자**이지 bearer 비밀이 아니다.
개인키 없이는 서명을 만들 수 없으므로, 자격증명 문자열이 새도 그 자체로는 인증이 안 된다.
"""
from __future__ import annotations

import base64
import binascii
import logging
import uuid

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel
from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.rate_limit import limiter
from app.dependencies.auth import AuthContext, get_current_user
from app.dependencies.database import get_db
from app.models.agent_device_credential import AgentDeviceCredential
from app.models.member import Member
from app.services import device_credential as dc

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v2", tags=["device-credentials", "Organization"])

# 등록 기기 수 상한(멤버당). ⛔**어뷰징 방어(flood guard)이지 제품 한도가 아니다** — 정상
# 사용자가 이 수에 닿는 일은 없어야 하고, 닿으면 그건 무언가가 등록을 반복하고 있다는
# 신호다. 제품 한도(요금제·좌석)로 읽히게 만들지 말 것: 그 축이 필요해지면 별도로 설계한다.
MAX_DEVICES_PER_MEMBER = 50


class RegisterDeviceRequest(BaseModel):
    device_label: str
    # 공개키(SPKI DER) base64. 개인키는 절대 오지 않는다 — 오면 그대로 거부해야 하는 계약이다
    # (개인키를 서버로 보내는 클라이언트는 이 설계의 전제 자체를 깬다).
    public_key_der_b64: str
    # 선택: 특정 에이전트(team_member/member id)에 이 기기를 묶는다. 미지정이면 본인 소유
    # 에이전트 중 하나(결정적 순서)로 해소한다.
    agent_id: uuid.UUID | None = None


class DeviceCredentialResponse(BaseModel):
    id: uuid.UUID
    member_id: uuid.UUID
    agent_member_id: uuid.UUID
    device_label: str
    key_fingerprint: str
    status: str
    last_seen_at: object | None = None
    last_server_seq: int | None = None
    revoked_at: object | None = None
    created_at: object


class RegisterDeviceResponse(DeviceCredentialResponse):
    # `dt_live_<uuid>` — **비밀이 아니라 식별자**다(개인키 없이는 인증 불가). 그래도 평문
    # 시크릿이 아니므로 매 요청 재조회 가능하고, 발급 1회 노출 제약이 없다.
    device_credential: str
    # 서버가 발급하는 다음 요청 seq. 클라이언트는 이 값으로 서명해 보내고, 서버는 CAS로
    # "저장값보다 큰 값"만 받는다(재사용된 서명 거부).
    next_server_seq: int


async def _resolve_caller_member(auth: AuthContext, session: AsyncSession) -> Member:
    """인증 주체(휴먼 JWT)의 canonical members 행.

    `me.py::_resolve_current_human_member` 와 달리 여기선 앵커를 **만들지 않는다** —
    기기 등록은 앵커를 만들 수 있는 write 경로지만, 조회 시점에 앵커를 지어내는 건 이
    라우터의 책임이 아니고(그건 member-SSOT write-sync의 몫), 없으면 404로 정직하게 거절한다.

    ⛔**에이전트 자격증명(`sk_live_`/`dt_live_`)과 휴먼 개인키(`hu_live_`)는 여기 도달하지
    않는다** — 이 라우터는 **휴먼 JWT 세션**만 받는다(fail-closed).

    ⚠️초판은 `api_key_id`·`device_credential_id`·`actor_type != 'human'` 세 조건만 봤는데,
    `hu_live_*`(휴먼 개인키)가 `human_api_key_id` + `actor_type: "human"` 을 실어
    **셋 다 통과**했다(auth.py `_resolve_human_api_key`). 그러면 새어나간 장수명 bearer
    하나가 **그 키를 폐기한 뒤에도 살아남는** 서명 기반 기기를 발급할 수 있다 —
    기기 자격증명이 막으려던 바로 그 실패 모드(blast radius 축이 무너진다).
    그래서 `human_api_key_id` 도 명시로 거부한다 — `actor_type` 만으로는 JWT 와 개인키가
    구분되지 않는다.
    """
    app_metadata = auth.claims.get("app_metadata", {})
    if (
        app_metadata.get("api_key_id")
        or app_metadata.get("device_credential_id")
        or app_metadata.get("human_api_key_id")  # hu_live_* — 아래 actor_type 판정만으로는 못 막는다
    ):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Human authentication required")
    if app_metadata.get("actor_type") and app_metadata.get("actor_type") != "human":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Human authentication required")

    try:
        user_id = uuid.UUID(auth.user_id)
    except (ValueError, TypeError) as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid subject") from exc

    org_raw = app_metadata.get("org_id")
    if not org_raw:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="org_id not resolvable from auth context")
    try:
        org_id = uuid.UUID(str(org_raw))
    except (ValueError, TypeError) as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid org_id") from exc

    member = (await session.execute(
        select(Member).where(
            Member.user_id == user_id,
            Member.org_id == org_id,
            Member.type == "human",
            Member.deleted_at.is_(None),
        )
    )).scalar_one_or_none()
    if member is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Member not found")
    return member


async def _resolve_own_agent_member_id(
    session: AsyncSession, *, member: Member, user_id: uuid.UUID | None, agent_id: uuid.UUID | None,
) -> uuid.UUID:
    """이 기기가 인증할 에이전트(members.id) 해소 — **본인 소유만**.

    소유 판정은 기존 공개 헬퍼(`ownership.assert_agent_owner`)를 그대로 쓴다(새 판정자
    발명 0) — 그 함수가 이미 "생성자 본인 또는 org admin/owner" 규칙과 404/403 응답을
    갖고 있다. 미지정이면 본인이 만든 에이전트(`owner_member_id`) 중 결정적 순서(id ASC)
    첫 값 — 무에이전트면 400(인증할 주체 없는 기기를 만들지 않는다).
    """
    if agent_id is not None:
        if user_id is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Agent not found")
        from app.dependencies.ownership import assert_agent_owner

        await assert_agent_owner(agent_id, session, member.org_id, user_id)
        return agent_id

    own_ids = (await session.execute(
        select(Member.id).where(
            Member.org_id == member.org_id,
            Member.type == "agent",
            Member.is_active.is_(True),
            Member.deleted_at.is_(None),
            Member.owner_member_id == member.id,
        ).order_by(Member.id.asc())
    )).scalars().all()
    if not own_ids:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="No agent available to bind this device to"
        )
    return own_ids[0]


def _decode_public_key(value: str) -> bytes:
    try:
        der = base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid public key encoding") from exc
    if not der:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid public key encoding")
    # 파싱 가능한 EC 공개키인지 여기서 확인한다 — 저장 후 매 요청 검증이 실패하는 것보다
    # 등록 시점에 거부하는 게 정직하다(잘못된 키로 등록해두면 그 기기는 영구히 인증 불가).
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec

    try:
        key = serialization.load_der_public_key(der)
        # P-256 만 받는다 — 검증 측이 `ec.ECDSA(SHA256)` 로 고정이라(services/device_credential.py)
        # 다른 곡선(P-384 등)을 등록해두면 **매 요청 검증이 실패**해 그 기기가 영구히 인증 불가가
        # 된다. 등록 시점에 거부하는 게 정직하다(모바일 경로도 P-256 전용 — apple_app_attest 의
        # "leaf_key_not_p256" 과 동일 축).
    except Exception as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid public key") from exc
    if not isinstance(key, ec.EllipticCurvePublicKey) or not isinstance(key.curve, ec.SECP256R1):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Unsupported public key: P-256 EC key required",
        )
    return der


@router.post("/device-credentials", response_model=RegisterDeviceResponse, status_code=201)
@limiter.limit("10/minute")
async def register_device_credential(
    request: Request,
    body: RegisterDeviceRequest,
    auth: AuthContext = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> RegisterDeviceResponse:
    """기기 자격증명 등록 — 인가: 인증한 휴먼 **본인**의 기기만.

    응답의 `device_credential`(`dt_live_<uuid>`)은 **비밀이 아니다**(개인키 없이는 인증 불가).
    `sk_live_*` 처럼 "1회만 노출" 제약을 두지 않는다 — 그 제약은 탈취 가능한 bearer 비밀에만
    의미가 있다.
    """
    member = await _resolve_caller_member(auth, session)
    org_id = member.org_id
    try:
        user_id: uuid.UUID | None = uuid.UUID(auth.user_id)
    except (ValueError, TypeError):
        user_id = None

    label = (body.device_label or "").strip()
    if not label:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="device_label required")
    if len(label) > 200:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="device_label too long")

    public_key_der = _decode_public_key(body.public_key_der_b64)
    agent_member_id = await _resolve_own_agent_member_id(
        session, member=member, user_id=user_id, agent_id=body.agent_id,
    )

    # 어뷰징 방어(제품 한도 아님 — 위 상수 주석 참고). active 기준으로 센다: 폐기한 기기는
    # 자리를 반환한다(정상 사용자가 폐기→재등록을 반복해 상한에 걸리면 그건 가드의 오작동).
    active_count = (await session.execute(
        select(func.count(AgentDeviceCredential.id)).where(
            AgentDeviceCredential.member_id == member.id,
            AgentDeviceCredential.status == "active",
        )
    )).scalar_one()
    if active_count >= MAX_DEVICES_PER_MEMBER:
        logger.warning("device_credentials.register rejected reason=member_device_cap member=%s", member.id)
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many registered devices for this member",
        )

    # ⚠️rollback 뒤에는 `member`(ORM 객체)가 expire돼 `member.id` 접근이 lazy refresh를
    # 시도한다 — 이미 죽은 greenlet에서 터져 409가 500으로 둔갑한다. 그래서 아래 두 로그가
    # 쓰는 값은 **rollback 전에** 불변 스냅샷으로 떠 둔다.
    member_id = member.id
    row = AgentDeviceCredential(
        member_id=member_id,
        agent_member_id=agent_member_id,
        device_label=label,
        public_key_der=public_key_der,
        key_fingerprint=dc.key_fingerprint(public_key_der),
        status="active",
    )
    session.add(row)
    try:
        await session.commit()
    except IntegrityError:
        # UNIQUE(member_id, device_label) — 같은 라벨 재등록은 409(클라이언트가 폐기 후 재사용).
        await session.rollback()
        logger.warning("device_credentials.register rejected reason=duplicate_label member=%s", member_id)
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Device label already registered")
    await session.refresh(row)

    logger.info("device_credentials.register success member=%s", member_id)
    return RegisterDeviceResponse(
        **_row_payload(row),
        device_credential=dc.format_device_credential(row.id),
        next_server_seq=(row.last_server_seq or 0) + 1,
    )


@router.get("/device-credentials", response_model=list[DeviceCredentialResponse])
async def list_device_credentials(
    auth: AuthContext = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> list[DeviceCredentialResponse]:
    """본인 기기만 목록(경로에 임의 id가 없어 IDOR 표면 자체가 없다 — `me.py` 관례)."""
    member = await _resolve_caller_member(auth, session)
    rows = (await session.execute(
        select(AgentDeviceCredential)
        .where(AgentDeviceCredential.member_id == member.id)
        .order_by(AgentDeviceCredential.created_at.desc())
    )).scalars().all()
    return [DeviceCredentialResponse(**_row_payload(r)) for r in rows]


@router.delete("/device-credentials/{credential_id}", status_code=200)
async def revoke_device_credential(
    credential_id: uuid.UUID,
    auth: AuthContext = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> dict:
    """기기 폐기 — **본인 기기만**(타인 소유는 404, 존재 여부 누설 없음).

    폐기는 다음 요청부터 즉시 유효하다: `_resolve_device_credential` 이 조회 조건에
    `status='active' AND revoked_at IS NULL` 을 걸고, seq CAS에도 같은 조건이 걸려 있어
    조회~CAS 사이에 revoke가 끼어들어도(TOCTOU) 인증이 성립하지 않는다.
    """
    member = await _resolve_caller_member(auth, session)
    row = (await session.execute(
        select(AgentDeviceCredential).where(
            AgentDeviceCredential.id == credential_id,
            # member_id 조건이 인가 그 자체다 — 타인이면 "없음"과 동일한 404.
            AgentDeviceCredential.member_id == member.id,
        )
    )).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Device credential not found")

    from datetime import datetime, timezone
    result = await session.execute(
        update(AgentDeviceCredential)
        .where(
            AgentDeviceCredential.id == credential_id,
            AgentDeviceCredential.member_id == member.id,
            AgentDeviceCredential.revoked_at.is_(None),
        )
        .values(status="revoked", revoked_at=datetime.now(timezone.utc))
        .returning(AgentDeviceCredential.id)
    )
    if result.first() is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Device credential not found")
    await session.commit()
    logger.info("device_credentials.revoke success member=%s", member.id)
    return {"ok": True}


def _row_payload(row: AgentDeviceCredential) -> dict:
    return {
        "id": row.id,
        "member_id": row.member_id,
        "agent_member_id": row.agent_member_id,
        "device_label": row.device_label,
        "key_fingerprint": row.key_fingerprint,
        "status": row.status,
        "last_seen_at": row.last_seen_at,
        "last_server_seq": row.last_server_seq,
        "revoked_at": row.revoked_at,
        "created_at": row.created_at,
    }
