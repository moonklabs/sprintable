"""story 20da6347(C3·산티아고 §7.4) mock-first 계약테스트: Play Integrity Standard token
검증 — S4 firebase_session_mint.py 패턴과 동일 원칙(실 Google 왕복은 non-prod 프로젝트
프로비저닝 후 별도 라이브 검증, 여기선 호출 순서/실패 처리/응답 파싱 구조만)."""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from app.services.play_integrity import (
    MEETS_DEVICE_INTEGRITY,
    PlayIntegrityVerificationError,
    verify_play_integrity_token,
)

PACKAGE_NAME = "com.sprintable.app"
CERT_DIGEST_B64 = "abcdef0123456789=="
REQUEST_HASH = "sha256-of-canonical-request"


def _valid_payload(**overrides) -> dict:
    payload = {
        "requestDetails": {"requestPackageName": PACKAGE_NAME, "requestHash": REQUEST_HASH},
        "appIntegrity": {
            "appRecognitionVerdict": "PLAY_RECOGNIZED",
            "packageName": PACKAGE_NAME,
            "certificateSha256Digest": [CERT_DIGEST_B64],
            "versionCode": "42",
        },
        "deviceIntegrity": {"deviceRecognitionVerdict": [MEETS_DEVICE_INTEGRITY]},
    }
    payload.update(overrides)
    return {"tokenPayloadExternal": payload}


def _mock_response(status_code: int, json_body: dict):
    resp = MagicMock()
    resp.status_code = status_code
    resp.json.return_value = json_body
    return resp


@pytest.mark.anyio
async def test_valid_token_accepted(monkeypatch):
    import app.services.play_integrity as module
    monkeypatch.setattr(module, "_get_access_token", lambda: "fake-access-token")
    monkeypatch.setattr(module, "_call_decode_integrity_token", AsyncMock(return_value=_mock_response(200, _valid_payload())))

    result = await verify_play_integrity_token(
        integrity_token="x", expected_package_name=PACKAGE_NAME, expected_cert_sha256_digest_b64=CERT_DIGEST_B64,
        minimum_version_code=10, request_hash=REQUEST_HASH,
    )
    assert result.device_recognition_verdicts == [MEETS_DEVICE_INTEGRITY]


@pytest.mark.anyio
async def test_adc_unavailable_rejected(monkeypatch):
    import app.services.play_integrity as module

    def fail_adc():
        raise RuntimeError("no ADC")
    monkeypatch.setattr(module, "_get_access_token", fail_adc)

    with pytest.raises(PlayIntegrityVerificationError, match="adc_token_unavailable"):
        await verify_play_integrity_token(
            integrity_token="x", expected_package_name=PACKAGE_NAME, expected_cert_sha256_digest_b64=CERT_DIGEST_B64,
            minimum_version_code=10, request_hash=REQUEST_HASH,
        )


@pytest.mark.anyio
async def test_google_rejects_non_200(monkeypatch):
    import app.services.play_integrity as module
    monkeypatch.setattr(module, "_get_access_token", lambda: "fake-access-token")
    monkeypatch.setattr(module, "_call_decode_integrity_token", AsyncMock(return_value=_mock_response(400, {})))

    with pytest.raises(PlayIntegrityVerificationError, match="google_rejected"):
        await verify_play_integrity_token(
            integrity_token="x", expected_package_name=PACKAGE_NAME, expected_cert_sha256_digest_b64=CERT_DIGEST_B64,
            minimum_version_code=10, request_hash=REQUEST_HASH,
        )


@pytest.mark.anyio
async def test_not_play_recognized_rejected(monkeypatch):
    import app.services.play_integrity as module
    monkeypatch.setattr(module, "_get_access_token", lambda: "fake-access-token")
    payload = _valid_payload()
    payload["tokenPayloadExternal"]["appIntegrity"]["appRecognitionVerdict"] = "UNRECOGNIZED_VERSION"
    monkeypatch.setattr(module, "_call_decode_integrity_token", AsyncMock(return_value=_mock_response(200, payload)))

    with pytest.raises(PlayIntegrityVerificationError, match="app_not_play_recognized"):
        await verify_play_integrity_token(
            integrity_token="x", expected_package_name=PACKAGE_NAME, expected_cert_sha256_digest_b64=CERT_DIGEST_B64,
            minimum_version_code=10, request_hash=REQUEST_HASH,
        )


@pytest.mark.anyio
async def test_package_name_mismatch_rejected(monkeypatch):
    import app.services.play_integrity as module
    monkeypatch.setattr(module, "_get_access_token", lambda: "fake-access-token")
    payload = _valid_payload()
    payload["tokenPayloadExternal"]["appIntegrity"]["packageName"] = "com.attacker.app"
    monkeypatch.setattr(module, "_call_decode_integrity_token", AsyncMock(return_value=_mock_response(200, payload)))

    with pytest.raises(PlayIntegrityVerificationError, match="app_package_name_mismatch"):
        await verify_play_integrity_token(
            integrity_token="x", expected_package_name=PACKAGE_NAME, expected_cert_sha256_digest_b64=CERT_DIGEST_B64,
            minimum_version_code=10, request_hash=REQUEST_HASH,
        )


@pytest.mark.anyio
async def test_cert_digest_mismatch_rejected(monkeypatch):
    import app.services.play_integrity as module
    monkeypatch.setattr(module, "_get_access_token", lambda: "fake-access-token")
    payload = _valid_payload()
    payload["tokenPayloadExternal"]["appIntegrity"]["certificateSha256Digest"] = ["wrong-digest"]
    monkeypatch.setattr(module, "_call_decode_integrity_token", AsyncMock(return_value=_mock_response(200, payload)))

    with pytest.raises(PlayIntegrityVerificationError, match="cert_digest_mismatch"):
        await verify_play_integrity_token(
            integrity_token="x", expected_package_name=PACKAGE_NAME, expected_cert_sha256_digest_b64=CERT_DIGEST_B64,
            minimum_version_code=10, request_hash=REQUEST_HASH,
        )


@pytest.mark.anyio
async def test_version_code_below_minimum_rejected(monkeypatch):
    import app.services.play_integrity as module
    monkeypatch.setattr(module, "_get_access_token", lambda: "fake-access-token")
    payload = _valid_payload()
    payload["tokenPayloadExternal"]["appIntegrity"]["versionCode"] = "5"
    monkeypatch.setattr(module, "_call_decode_integrity_token", AsyncMock(return_value=_mock_response(200, payload)))

    with pytest.raises(PlayIntegrityVerificationError, match="version_code_below_minimum"):
        await verify_play_integrity_token(
            integrity_token="x", expected_package_name=PACKAGE_NAME, expected_cert_sha256_digest_b64=CERT_DIGEST_B64,
            minimum_version_code=10, request_hash=REQUEST_HASH,
        )


@pytest.mark.anyio
async def test_device_integrity_insufficient_rejected(monkeypatch):
    import app.services.play_integrity as module
    monkeypatch.setattr(module, "_get_access_token", lambda: "fake-access-token")
    payload = _valid_payload()
    payload["tokenPayloadExternal"]["deviceIntegrity"]["deviceRecognitionVerdict"] = []
    monkeypatch.setattr(module, "_call_decode_integrity_token", AsyncMock(return_value=_mock_response(200, payload)))

    with pytest.raises(PlayIntegrityVerificationError, match="device_integrity_insufficient"):
        await verify_play_integrity_token(
            integrity_token="x", expected_package_name=PACKAGE_NAME, expected_cert_sha256_digest_b64=CERT_DIGEST_B64,
            minimum_version_code=10, request_hash=REQUEST_HASH,
        )


@pytest.mark.anyio
async def test_request_hash_mismatch_rejected(monkeypatch):
    """다른 요청 맥락에서 발급된 토큰을 재사용하는 시나리오 — request_hash 불일치는 거부."""
    import app.services.play_integrity as module
    monkeypatch.setattr(module, "_get_access_token", lambda: "fake-access-token")
    payload = _valid_payload()
    payload["tokenPayloadExternal"]["requestDetails"]["requestHash"] = "different-request-hash"
    monkeypatch.setattr(module, "_call_decode_integrity_token", AsyncMock(return_value=_mock_response(200, payload)))

    with pytest.raises(PlayIntegrityVerificationError, match="request_hash_mismatch"):
        await verify_play_integrity_token(
            integrity_token="x", expected_package_name=PACKAGE_NAME, expected_cert_sha256_digest_b64=CERT_DIGEST_B64,
            minimum_version_code=10, request_hash=REQUEST_HASH,
        )


@pytest.mark.anyio
async def test_malformed_response_rejected(monkeypatch):
    import app.services.play_integrity as module
    monkeypatch.setattr(module, "_get_access_token", lambda: "fake-access-token")
    monkeypatch.setattr(module, "_call_decode_integrity_token", AsyncMock(return_value=_mock_response(200, {})))

    with pytest.raises(PlayIntegrityVerificationError, match="malformed_response"):
        await verify_play_integrity_token(
            integrity_token="x", expected_package_name=PACKAGE_NAME, expected_cert_sha256_digest_b64=CERT_DIGEST_B64,
            minimum_version_code=10, request_hash=REQUEST_HASH,
        )
