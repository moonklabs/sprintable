"""story 20da6347(E-AUTH-REBUILD 활성화게이트][C3]·산티아고 §7.4 SSOT 2026-07-16): Play
Integrity **Standard** token 서버측 검증 — Google Play Integrity API `decodeIntegrityToken`
호출.

⚠️mock-first 계약(S4 `firebase_session_mint.py`의 `_call_create_session_cookie` 패턴과
동일 원칙): 실 Google REST 왕복은 `_call_decode_integrity_token()` 한 지점으로 분리해
테스트가 모킹할 수 있게 한다 — non-prod Google Cloud 프로젝트 프로비저닝 전까지는 이
구조(호출 순서·실패 처리·응답 파싱)만 계약테스트로 검증한다.

**verdict 정책**(§7.4 명시): `appRecognitionVerdict=PLAY_RECOGNIZED`+exact package/cert/
version + 최소 `MEETS_DEVICE_INTEGRITY`. `MEETS_STRONG_INTEGRITY`는 이 스토리 스코프가
아닌 고위험 작업 강화정책용(호출부가 반환된 verdict 목록을 보고 자체 판단)."""
from __future__ import annotations

import logging
from dataclasses import dataclass

import google.auth
import google.auth.transport.requests
import httpx

logger = logging.getLogger(__name__)

_PLAY_INTEGRITY_SCOPE = "https://www.googleapis.com/auth/playintegrity"
_DECODE_URL_TEMPLATE = "https://playintegrity.googleapis.com/v1/{package_name}:decodeIntegrityToken"

MEETS_DEVICE_INTEGRITY = "MEETS_DEVICE_INTEGRITY"
MEETS_STRONG_INTEGRITY = "MEETS_STRONG_INTEGRITY"


class PlayIntegrityVerificationError(Exception):
    """검증 실패 — 메시지는 로그 전용(enumeration 방지는 호출부 401 통일 책임)."""


def _get_access_token() -> str:
    """ADC로 Play Integrity API 스코프 액세스 토큰 획득 — 테스트에서 모킹하는 지점
    (S4 firebase_session_mint._get_access_token과 동일 패턴)."""
    credentials, _project = google.auth.default(scopes=[_PLAY_INTEGRITY_SCOPE])
    request = google.auth.transport.requests.Request()
    credentials.refresh(request)
    return credentials.token


async def _call_decode_integrity_token(access_token: str, package_name: str, integrity_token: str) -> httpx.Response:
    """실 Google REST 호출 지점 — 테스트에서 모킹."""
    url = _DECODE_URL_TEMPLATE.format(package_name=package_name)
    async with httpx.AsyncClient() as client:
        return await client.post(
            url,
            headers={"Authorization": f"Bearer {access_token}"},
            json={"integrity_token": integrity_token},
        )


@dataclass
class VerifiedPlayIntegrity:
    device_recognition_verdicts: list[str]


async def verify_play_integrity_token(
    *,
    integrity_token: str,
    expected_package_name: str,
    expected_cert_sha256_digest_b64: str,
    minimum_version_code: int,
    request_hash: str,
) -> VerifiedPlayIntegrity:
    """실패 시 PlayIntegrityVerificationError. `request_hash`는 클라이언트가 토큰 요청 시
    바인딩한 canonical request hash — 서버가 기대하는 값과 정확히 일치해야 한다(다른
    요청 맥락의 토큰 재사용 방지, 이 세션의 canonical-transcript-binding 원칙과 동일)."""
    try:
        access_token = _get_access_token()
    except Exception as exc:
        logger.warning("play_integrity.verify failed reason=adc_token_unavailable")
        raise PlayIntegrityVerificationError("adc_token_unavailable") from exc

    try:
        response = await _call_decode_integrity_token(access_token, expected_package_name, integrity_token)
    except httpx.HTTPError as exc:
        logger.warning("play_integrity.verify failed reason=network_error")
        raise PlayIntegrityVerificationError("network_error") from exc

    if response.status_code != 200:
        logger.warning("play_integrity.verify failed reason=google_rejected status=%d", response.status_code)
        raise PlayIntegrityVerificationError("google_rejected")

    body = response.json()
    payload = body.get("tokenPayloadExternal")
    if not isinstance(payload, dict):
        logger.warning("play_integrity.verify failed reason=malformed_response")
        raise PlayIntegrityVerificationError("malformed_response")

    request_details = payload.get("requestDetails") or {}
    if request_details.get("requestPackageName") != expected_package_name:
        raise PlayIntegrityVerificationError("request_package_name_mismatch")
    if request_details.get("requestHash") != request_hash:
        raise PlayIntegrityVerificationError("request_hash_mismatch")

    app_integrity = payload.get("appIntegrity") or {}
    if app_integrity.get("appRecognitionVerdict") != "PLAY_RECOGNIZED":
        raise PlayIntegrityVerificationError("app_not_play_recognized")
    if app_integrity.get("packageName") != expected_package_name:
        raise PlayIntegrityVerificationError("app_package_name_mismatch")
    cert_digests = app_integrity.get("certificateSha256Digest") or []
    if expected_cert_sha256_digest_b64 not in cert_digests:
        raise PlayIntegrityVerificationError("cert_digest_mismatch")

    version_code = app_integrity.get("versionCode")
    try:
        version_code_int = int(version_code)
    except (TypeError, ValueError) as exc:
        raise PlayIntegrityVerificationError("version_code_malformed") from exc
    if version_code_int < minimum_version_code:
        raise PlayIntegrityVerificationError("version_code_below_minimum")

    device_integrity = payload.get("deviceIntegrity") or {}
    verdicts = device_integrity.get("deviceRecognitionVerdict") or []
    if MEETS_DEVICE_INTEGRITY not in verdicts:
        logger.warning("play_integrity.verify rejected reason=device_integrity_insufficient")
        raise PlayIntegrityVerificationError("device_integrity_insufficient")

    logger.info("play_integrity.verify success")
    return VerifiedPlayIntegrity(device_recognition_verdicts=list(verdicts))
