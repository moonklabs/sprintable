"""story 822817a0(E-AUTH-REBUILD 활성화게이트][C1]·doc e-mobile-per-install-proof-feasibility
§7.1/§7.2·산티아고 §7 SSOT 2026-07-16): per-installation attestation protocol v1 — 챌린지
발급 + canonical transcript 구성.

**canonical transcript(§7.2)**: 서버가 payload를 직접 구성한다(클라이언트 재직렬화를 절대
신뢰하지 않는다). 도메인분리+버전 태그(`SP_DEVICE_PROOF_V1`)를 포함한 결정적(sorted-key)
JSON을 base64url로 인코딩해 `client_data_b64url`로 반환 — 네이티브 클라이언트는 이 바이트를
그대로 서명/CBOR에 바인딩만 하고 재구성하지 않는다.

**챌린지 소비(원자적 1회)는 이 스토리 스코프 밖**이다 — register/native-bootstrap 엔드포인트
본체(C4)가 attestation/assertion 검증(C2/C3)과 함께 단일 트랜잭션에서 처리한다. 여기서는
발급(issue)만 구현한다.
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

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.device_installation import DeviceProofChallenge

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
) -> IssuedChallenge:
    """raw nonce는 반환값에 별도로 노출되지 않는다 — canonical transcript 안에 이미
    인코딩되어 `client_data_b64url`로만 나간다. `ChallengeAlreadyActiveError`는 purpose당
    설치(또는 user, register 한정)당 이미 미소비 챌린지가 있을 때 발생 — 호출부가 409로
    매핑한다(§7.1: "One active challenge per purpose per installation")."""
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
        await db.commit()
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
        )
    )
    return IssuedChallenge(
        challenge_id=str(challenge_id),
        client_data_b64url=client_data_b64url(transcript),
        expires_at=row.expires_at,
    )
