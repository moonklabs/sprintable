"""기기별 자격증명(`dt_live_*`) 프로토콜 — 요청 서명 검증 + 리플레이 방어.

`device_proof.py`(앱 무결성 attestation 전용, `SP_DEVICE_PROOF_V1`)와 **다른 프로토콜**이다:
여기엔 attestation 계층이 없다. 기기 등록 시 **클라이언트가 제출한 공개키**를 그대로 저장하고
매 요청의 서명을 그 공개키로 검증한다 — "그 공개키가 진짜 그 앱에서 났다"는 보증은 이 계층의
책임이 아니고, 그 층(Apple App Attest/Play Integrity)은 자체호스팅에서도 성립해야 하는 이
경로와 목적이 달라 의도적으로 분리돼 있다.

`dt_live_` 는 **토큰이 아니라 기기 식별자**다 — 장수명 bearer 비밀이 아예 없다(개인키는
서버에 오지 않는다). 그래서 자격증명 문자열을 탈취해도 개인키 없이는 서명을 못 만든다.

canonical transcript 구성은 `device_proof.build_canonical_transcript` 와 같은 규율을 따른다:
서버가 payload를 직접 만들고(클라이언트 재직렬화를 신뢰하지 않는다), 도메인분리+버전 태그를
포함한 결정적(sorted-key) JSON을 쓴다 — 목적이 다른 프로토콜이라 태그(`SP_DEVICE_AUTH_V1`)와
필드 집합은 별개다.
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agent_device_credential import AgentDeviceCredential

DEVICE_CREDENTIAL_SCHEME = "dt_live_"

# 요청 서명 transcript의 버전 태그(도메인분리). attestation용 `SP_DEVICE_PROOF_V1`와
# 절대 섞이면 안 된다 — 같은 키로 두 프로토콜에 서명해도 서로 검증되지 않아야 한다.
DEVICE_AUTH_TRANSCRIPT_VERSION = "SP_DEVICE_AUTH_V1"

# 요청 타임스탬프 허용 윈도우(±). 클라이언트/서버 시계 오차를 흡수할 만큼 넓고, 리플레이
# 창을 좁게 유지할 만큼 좁다 — seq CAS가 실질 방어선이고 이 윈도우는 그 앞의 1차 거르개다.
DEVICE_REQUEST_MAX_SKEW_SECONDS = 300


class DeviceSignatureError(Exception):
    """서명/공개키 검증 실패 — 메시지는 로그 전용(호출부는 401 통일, enumeration 방지)."""


class DeviceTimestampError(Exception):
    """요청 타임스탬프가 허용 윈도우 밖(또는 형식 오류)."""


def _canonical_json(payload: dict) -> bytes:
    return json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()


def parse_device_credential_id(raw: str) -> uuid.UUID:
    """`dt_live_<uuid>` → credential id. 형식이 아니면 ValueError(호출부가 401로 매핑)."""
    if not raw.startswith(DEVICE_CREDENTIAL_SCHEME):
        raise ValueError("not a device credential")
    return uuid.UUID(raw[len(DEVICE_CREDENTIAL_SCHEME):])


def format_device_credential(credential_id: uuid.UUID) -> str:
    return f"{DEVICE_CREDENTIAL_SCHEME}{credential_id}"


def build_device_auth_transcript(
    *,
    credential_id: str,
    http_method: str,
    route: str,
    timestamp: int,
    server_seq: int,
    body_sha256: str | None = None,
) -> bytes:
    """요청 1건의 canonical transcript — 서버가 구성하고 클라이언트는 이 바이트를 그대로
    서명만 한다(재구성 금지). `route`를 함께 서명해 A 경로용 서명을 B 경로에 재사용하는
    교차 사용을 막는다."""
    payload = {
        "v": DEVICE_AUTH_TRANSCRIPT_VERSION,
        "credential_id": credential_id,
        "method": http_method,
        "route": route,
        "ts": timestamp,
        "seq": server_seq,
        "body_sha256": body_sha256,
    }
    return _canonical_json(payload)


def key_fingerprint(public_key_der: bytes) -> str:
    """저장된 공개키의 식별자(감사·조회용). `device_installations.public_key_fingerprint`와
    같은 알고리즘(SHA256 hex)."""
    import hashlib

    return hashlib.sha256(public_key_der).hexdigest()


def verify_device_request_signature(
    *, signed_bytes: bytes, signature: bytes, stored_public_key_der: bytes
) -> None:
    """등록된 공개키로 서명 검증. `android_key_attestation.verify_bootstrap_signature`와
    동형(ECDSA-SHA256)이되 별도 예외 타입 — 이 경로가 attestation 예외에 묶이면 계층이
    샌다. 순수 서명 유효성만 판단한다(리플레이는 seq CAS 몫)."""
    try:
        public_key = serialization.load_der_public_key(stored_public_key_der)
    except Exception as exc:
        raise DeviceSignatureError("stored_public_key_malformed") from exc
    if not isinstance(public_key, ec.EllipticCurvePublicKey):
        raise DeviceSignatureError("stored_public_key_not_ec")

    try:
        public_key.verify(signature, signed_bytes, ec.ECDSA(hashes.SHA256()))
    except InvalidSignature as exc:
        raise DeviceSignatureError("device_signature_invalid") from exc


def assert_timestamp_within_window(timestamp: int, *, now: datetime | None = None) -> None:
    """요청 타임스탬프가 now 기준 ±`DEVICE_REQUEST_MAX_SKEW_SECONDS` 안인지."""
    reference = (now or datetime.now(timezone.utc)).timestamp()
    if abs(reference - timestamp) > DEVICE_REQUEST_MAX_SKEW_SECONDS:
        raise DeviceTimestampError("timestamp_outside_window")


async def atomic_bump_device_credential_seq(
    db: AsyncSession, *, credential_id: uuid.UUID, new_value: int, touch_last_seen: bool = False
) -> bool:
    """리플레이 방어 compare-and-set — 새 seq가 저장값보다 크거나 저장값이 NULL일 때만 갱신
    (`atomic_bump_installation_counter`와 동형 의미론: 동시 요청 중 더 큰 counter가 먼저
    도착하면 낮은 요청은 정상 거부). **commit하지 않는다** — 호출부의 더 큰 원자 트랜잭션
    일부다.

    `status='active'` 조건이 함께 걸려 있다 — 조회~CAS 사이에 revoke가 끼어든 경우(TOCTOU)
    도 이 CAS가 0행으로 떨어져 인증이 성립하지 않는다(revoke가 즉시 유효해야 한다).

    `touch_last_seen`(스로틀 판정은 호출부)을 **같은 UPDATE 문에** 접어 넣는다 —
    `_touch_api_key_last_used` 처럼 전용 세션을 따로 열면 **이미 caller 세션이 이 행에 건
    잠금을 그 새 커넥션이 기다리는 교착**이 된다(실측: 인증이 30초 타임아웃까지 멈췄다).
    `_persist_first_auth_seen`/story #2457 이 같은 이유로 «인증 경로에서 같은 행을 두
    커넥션이 건드리지 않는다»를 이미 규율로 적어 뒀다 — 그 규율을 여기서 반복하지 않는다.
    한 행·한 문장·한 커넥션이라 추가 왕복도 없다."""
    values: dict = {"last_server_seq": new_value}
    if touch_last_seen:
        from datetime import datetime, timezone

        values["last_seen_at"] = datetime.now(timezone.utc)
    stmt = (
        update(AgentDeviceCredential)
        .where(
            AgentDeviceCredential.id == credential_id,
            AgentDeviceCredential.status == "active",
            AgentDeviceCredential.revoked_at.is_(None),
            (AgentDeviceCredential.last_server_seq.is_(None))
            | (AgentDeviceCredential.last_server_seq < new_value),
        )
        .values(**values)
        .returning(AgentDeviceCredential.id)
    )
    result = await db.execute(stmt)
    return result.first() is not None
