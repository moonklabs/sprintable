"""story 822817a0(E-AUTH-REBUILD 활성화게이트][C1]·doc e-mobile-per-install-proof-feasibility
§7.1/§7.2·산티아고 §7 SSOT 2026-07-16): per-installation attestation protocol v1 — 챌린지
발급 + canonical transcript 구성. story cbd578d4(C4)에서 챌린지 바인딩 검증+원자적 소비
헬퍼 추가.

**canonical transcript(§7.2)**: 서버가 payload를 직접 구성한다(클라이언트 재직렬화를 절대
신뢰하지 않는다). 도메인분리+버전 태그(`SP_DEVICE_PROOF_V1`)를 포함한 결정적(sorted-key)
JSON을 base64url로 인코딩해 `client_data_b64url`로 반환 — 네이티브 클라이언트는 이 바이트를
그대로 서명/CBOR에 바인딩만 하고 재구성하지 않는다.

**바인딩 검증(C4)**: raw nonce는 DB에 저장 안 하므로(hash만), 클라이언트가 attestation/
assertion과 함께 되돌려주는 `client_data_b64url`을 디코드해 그 안의 `nonce` 필드가
`nonce_hash`와 일치하는지로 진짜 서버 발급 챌린지에 대한 응답임을 증명한다 — 이게 통과해야
그 transcript bytes를 `client_data_hash` 계산에 안전하게 쓸 수 있다(위조 transcript로
공격자가 자기 nonce를 임의로 넣어도 nonce_hash 불일치로 걸러짐).
"""
from __future__ import annotations

import base64
import hashlib
import json
import logging
import secrets
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy import update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.device_installation import DeviceInstallation, DeviceProofChallenge

logger = logging.getLogger(__name__)

TRANSCRIPT_VERSION = "SP_DEVICE_PROOF_V1"

# 산티아고 §7 SSOT 확정 TTL(2026-07-16).
TTL_REGISTER_SECONDS = 120
TTL_BOOTSTRAP_ISSUE_SECONDS = 60
TTL_BOOTSTRAP_REDEEM_SECONDS = 45

PURPOSE_REGISTER = "register"
PURPOSE_BOOTSTRAP_ISSUE = "bootstrap_issue"
PURPOSE_BOOTSTRAP_REDEEM = "bootstrap_redeem"


class ChallengeAlreadyActiveError(Exception):
    """purpose당 설치(또는 register는 user)당 active 챌린지 1개 제약(부분 유니크 인덱스)
    위반 — 호출부는 409로 매핑."""


def _canonical_json(payload: dict) -> bytes:
    return json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


@dataclass
class TranscriptContext:
    purpose: str
    challenge_id: str
    raw_nonce: str
    user_id: str
    firebase_uid: str
    project_id: str
    tenant_id: str | None
    environment: str
    platform: str
    app_id: str
    installation_id: str | None
    key_version: int | None
    http_method: str
    route: str
    web_origin: str
    body_sha256: str | None
    bootstrap_code_sha256: str | None = None


def build_canonical_transcript(ctx: TranscriptContext) -> bytes:
    """§7.2: 도메인분리+버전 태그 포함 결정적 payload. bootstrap redeem은
    `bootstrap_code_sha256`(SHA256(raw bootstrap code))을 반드시 포함(§7.5) — 그 외
    purpose는 이 필드를 아예 생략(포함 유무 자체가 purpose 구분 신호이자, None 값을 넣어
    직렬화하면 redeem 위조 시 easy-guess 필드가 되는 것을 피한다)."""
    payload = {
        "v": TRANSCRIPT_VERSION,
        "purpose": ctx.purpose,
        "challenge_id": ctx.challenge_id,
        "nonce": ctx.raw_nonce,
        "user_id": ctx.user_id,
        "firebase_uid": ctx.firebase_uid,
        "project_id": ctx.project_id,
        "tenant_id": ctx.tenant_id,
        "environment": ctx.environment,
        "platform": ctx.platform,
        "app_id": ctx.app_id,
        "installation_id": ctx.installation_id,
        "key_version": ctx.key_version,
        "method": ctx.http_method,
        "route": ctx.route,
        "origin": ctx.web_origin,
        "body_sha256": ctx.body_sha256,
    }
    if ctx.bootstrap_code_sha256 is not None:
        payload["bootstrap_code_sha256"] = ctx.bootstrap_code_sha256
    return _canonical_json(payload)


def client_data_b64url(transcript: bytes) -> str:
    return _b64url(transcript)


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


@dataclass
class IssuedChallenge:
    challenge_id: str
    client_data_b64url: str
    expires_at: datetime


async def issue_challenge(
    db: AsyncSession,
    *,
    purpose: str,
    user_id,
    firebase_uid: str,
    project_id: str,
    tenant_id: str | None,
    environment: str,
    platform: str,
    app_id: str,
    http_method: str,
    route: str,
    web_origin: str,
    ttl_seconds: int,
    installation_id=None,
    key_version: int | None = None,
    server_seq: int | None = None,
    request_body_hash: str | None = None,
    bootstrap_code_sha256: str | None = None,
    commit: bool = True,
) -> IssuedChallenge:
    """raw nonce는 반환값에 별도로 노출되지 않는다 — canonical transcript 안에 이미
    인코딩되어 `client_data_b64url`로만 나간다. `ChallengeAlreadyActiveError`는 purpose당
    설치(또는 user, register 한정)당 이미 미소비 챌린지가 있을 때 발생 — 호출부가 409로
    매핑한다(§7.1: "One active challenge per purpose per installation").

    `commit=False`(story cbd578d4·C4 §7.5): bootstrap_redeem 챌린지는 bootstrap_issue
    챌린지 소비+코드 생성과 **같은 트랜잭션**에 속해야 한다 — 호출부가 이 흐름의 마지막에
    한 번만 커밋한다. 커밋 전이라도 `IntegrityError`(활성 챌린지 중복)는 `flush()`로 즉시
    감지해 호출부에 정확히 알린다."""
    raw_nonce = secrets.token_hex(32)  # 256bit CSPRNG(§7.1)
    challenge_id = uuid.uuid4()
    now = datetime.now(timezone.utc)

    row = DeviceProofChallenge(
        id=challenge_id,
        nonce_hash=sha256_hex(raw_nonce.encode()),
        purpose=purpose,
        user_id=user_id,
        firebase_uid=firebase_uid,
        project_id=project_id,
        tenant_id=tenant_id,
        environment=environment,
        app_id=app_id,
        platform=platform,
        installation_id=installation_id,
        key_version=key_version,
        server_seq=server_seq,
        web_origin=web_origin,
        request_body_hash=request_body_hash,
        expires_at=now + timedelta(seconds=ttl_seconds),
        created_at=now,
    )
    db.add(row)
    try:
        if commit:
            await db.commit()
        else:
            await db.flush()
    except IntegrityError as exc:
        await db.rollback()
        logger.warning("device_proof.issue_challenge rejected reason=already_active purpose=%s", purpose)
        raise ChallengeAlreadyActiveError() from exc

    transcript = build_canonical_transcript(
        TranscriptContext(
            purpose=purpose,
            challenge_id=str(challenge_id),
            raw_nonce=raw_nonce,
            user_id=str(user_id),
            firebase_uid=firebase_uid,
            project_id=project_id,
            tenant_id=tenant_id,
            environment=environment,
            platform=platform,
            app_id=app_id,
            installation_id=str(installation_id) if installation_id else None,
            key_version=key_version,
            http_method=http_method,
            route=route,
            web_origin=web_origin,
            body_sha256=request_body_hash,
            bootstrap_code_sha256=bootstrap_code_sha256,
        )
    )
    return IssuedChallenge(
        challenge_id=str(challenge_id),
        client_data_b64url=client_data_b64url(transcript),
        expires_at=row.expires_at,
    )


class ChallengeVerificationError(Exception):
    """챌린지 바인딩 검증 실패 — 메시지는 로그 전용(enumeration 방지는 호출부 401 통일)."""


def _b64url_decode(s: str) -> bytes:
    padded = s + "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(padded.encode())


@dataclass
class VerifiedChallengeBinding:
    challenge: DeviceProofChallenge
    transcript_bytes: bytes
    transcript: dict


async def verify_challenge_binding(
    db: AsyncSession,
    *,
    challenge_id: str,
    client_data_b64url_value: str,
    purpose: str,
    expected_user_id,
    expected_app_id: str,
    expected_platform: str,
    expected_environment: str,
    expected_installation_id: str | None = None,
) -> VerifiedChallengeBinding:
    """읽기 전용 검증(소비는 별도 — 각 엔드포인트가 나머지 원자 트랜잭션과 같은 UPDATE로
    묶는다). client_data_b64url이 진짜 이 challenge_id에 대한 서버 발급 챌린지에 대한
    응답인지 nonce_hash로 증명 — 그래야 그 bytes를 attestation/assertion의
    client_data_hash 계산에 신뢰해 쓸 수 있다."""
    try:
        challenge_uuid = uuid.UUID(challenge_id)
    except (ValueError, TypeError) as exc:
        raise ChallengeVerificationError("invalid_challenge_id") from exc

    challenge = await db.get(DeviceProofChallenge, challenge_uuid)
    if challenge is None or challenge.purpose != purpose:
        raise ChallengeVerificationError("challenge_not_found")
    if challenge.consumed_at is not None:
        raise ChallengeVerificationError("challenge_already_consumed")
    if challenge.expires_at <= datetime.now(timezone.utc):
        raise ChallengeVerificationError("challenge_expired")
    if challenge.user_id != expected_user_id:
        raise ChallengeVerificationError("challenge_user_mismatch")
    if challenge.app_id != expected_app_id or challenge.platform != expected_platform:
        raise ChallengeVerificationError("challenge_app_platform_mismatch")
    if challenge.environment != expected_environment:
        raise ChallengeVerificationError("challenge_environment_mismatch")
    if expected_installation_id is not None and str(challenge.installation_id) != expected_installation_id:
        raise ChallengeVerificationError("challenge_installation_mismatch")

    try:
        transcript_bytes = _b64url_decode(client_data_b64url_value)
        transcript = json.loads(transcript_bytes)
    except Exception as exc:
        raise ChallengeVerificationError("malformed_client_data") from exc

    if not isinstance(transcript, dict) or transcript.get("challenge_id") != challenge_id:
        raise ChallengeVerificationError("transcript_challenge_id_mismatch")
    nonce = transcript.get("nonce")
    if not isinstance(nonce, str) or sha256_hex(nonce.encode()) != challenge.nonce_hash:
        raise ChallengeVerificationError("nonce_hash_mismatch")

    return VerifiedChallengeBinding(challenge=challenge, transcript_bytes=transcript_bytes, transcript=transcript)


async def consume_device_proof_challenge(db: AsyncSession, *, challenge_id, purpose: str) -> bool:
    """원자적 1회 소비 — `UPDATE...WHERE id=? AND purpose=? AND consumed_at IS NULL AND
    expires_at>now() RETURNING id`(native_bootstrap.consume_bootstrap_code와 동일 패턴,
    SELECT-then-UPDATE 아님). **commit하지 않는다** — 호출부의 더 큰 원자 트랜잭션(register
    행 insert·bootstrap code+redeem challenge 동시생성·6조건 consume)의 일부로 쓰여야
    하므로 커밋 시점은 호출부 책임. True=성공(1행 갱신), False=실패(0행 — 이미 소비/만료/
    존재 안 함, 사유 구분 없음)."""
    now = datetime.now(timezone.utc)
    stmt = (
        update(DeviceProofChallenge)
        .where(
            DeviceProofChallenge.id == challenge_id,
            DeviceProofChallenge.purpose == purpose,
            DeviceProofChallenge.consumed_at.is_(None),
            DeviceProofChallenge.expires_at > now,
        )
        .values(consumed_at=now)
        .returning(DeviceProofChallenge.id)
    )
    result = await db.execute(stmt)
    return result.first() is not None


async def atomic_bump_installation_counter(
    db: AsyncSession, *, installation_id, field: str, new_value: int
) -> bool:
    """story cbd578d4(C4·§7.4/§7.5): iOS `last_sign_count`/Android `last_server_seq`
    compare-and-set — 새 값이 저장값보다 크거나 저장값이 NULL일 때만 갱신(동시 요청 중
    더 큰 counter가 먼저 도착하면 낮은 요청은 정상 거부, counter_cas_race와 동형).
    **commit하지 않는다** — 호출부의 더 큰 원자 트랜잭션 일부."""
    column = getattr(DeviceInstallation, field)
    stmt = (
        update(DeviceInstallation)
        .where(DeviceInstallation.id == installation_id, (column.is_(None)) | (column < new_value))
        .values(**{field: new_value})
        .returning(DeviceInstallation.id)
    )
    result = await db.execute(stmt)
    return result.first() is not None
