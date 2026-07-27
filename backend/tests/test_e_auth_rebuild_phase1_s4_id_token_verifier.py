"""story 132e7204(E-AUTH-REBUILD M2 Phase1-S4) 계약 테스트: verify_firebase_id_token() 정확
검증(doc §4.2/§9.1) — S2 세션쿠키 검증기 계약테스트와 대칭 구조. 세션 issuer/키셋과 ID token
issuer/키셋이 각각 별도 캐시·별도 엔드포인트로 완전히 분리돼 서로 오염되지 않음도 함께 증명.
"""
from __future__ import annotations

import subprocess
import tempfile
import time
from pathlib import Path

import pytest
from jose import jwt as jose_jwt

from app.services import firebase_verifier as fv

PROJECT_ID = "test-project"
KID = "test-kid-1"


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
def _reset_cache():
    fv._reset_key_cache_for_tests()
    fv._reset_id_token_key_cache_for_tests()
    yield
    fv._reset_key_cache_for_tests()
    fv._reset_id_token_key_cache_for_tests()


def _make_self_signed_cert() -> tuple[str, str]:
    with tempfile.TemporaryDirectory() as d:
        key_path = Path(d) / "key.pem"
        cert_path = Path(d) / "cert.pem"
        subprocess.run(
            ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-keyout", str(key_path),
             "-out", str(cert_path), "-days", "1", "-nodes", "-subj", "/CN=test"],
            check=True, capture_output=True,
        )
        return key_path.read_text(), cert_path.read_text()


def _make_id_token(
    key_pem: str, *, iss: str | None = None, aud: str | None = None, sub: str = "firebase-uid-1",
    auth_time: int | None = None, kid: str = KID, exp_delta: int = 3600,
) -> str:
    now = int(time.time())
    claims = {
        "sub": sub,
        "email": "user@test.com",
        "auth_time": auth_time if auth_time is not None else now,
        "iat": now,
        "exp": now + exp_delta,
        "iss": iss or f"https://securetoken.google.com/{PROJECT_ID}",
        "aud": aud or PROJECT_ID,
    }
    return jose_jwt.encode(claims, key_pem, algorithm="RS256", headers={"kid": kid})


def _patch_fetch(monkeypatch, keys: dict[str, str]) -> None:
    async def fake_fetch():
        return keys
    monkeypatch.setattr(fv, "_fetch_id_token_public_keys", fake_fetch)


@pytest.mark.anyio
async def test_accepts_correctly_signed_id_token(monkeypatch):
    key_pem, cert_pem = _make_self_signed_cert()
    _patch_fetch(monkeypatch, {KID: cert_pem})
    token = _make_id_token(key_pem)
    result = await fv.verify_firebase_id_token(token, PROJECT_ID)
    assert result is not None
    assert result.firebase_uid == "firebase-uid-1"
    assert result.email == "user@test.com"
    assert result.issuer == f"https://securetoken.google.com/{PROJECT_ID}"


@pytest.mark.anyio
async def test_rejects_issuer_confusion_session_issuer_instead_of_id_token(monkeypatch):
    """세션쿠키 issuer(session.firebase.google.com)를 ID token 자리에 오인 수락하면 안 됨 —
    S2 테스트(반대 방향: ID token issuer를 세션쿠키 자리에)와 대칭."""
    key_pem, cert_pem = _make_self_signed_cert()
    _patch_fetch(monkeypatch, {KID: cert_pem})
    token = _make_id_token(key_pem, iss=f"https://session.firebase.google.com/{PROJECT_ID}")
    result = await fv.verify_firebase_id_token(token, PROJECT_ID)
    assert result is None


@pytest.mark.anyio
async def test_rejects_wrong_project_audience_mismatch(monkeypatch):
    key_pem, cert_pem = _make_self_signed_cert()
    _patch_fetch(monkeypatch, {KID: cert_pem})
    token = _make_id_token(key_pem, aud="other-project")
    result = await fv.verify_firebase_id_token(token, PROJECT_ID)
    assert result is None


@pytest.mark.anyio
async def test_rejects_wrong_algorithm_hs256_forged(monkeypatch):
    key_pem, cert_pem = _make_self_signed_cert()
    _patch_fetch(monkeypatch, {KID: cert_pem})
    now = int(time.time())
    forged = jose_jwt.encode(
        {"sub": "firebase-uid-1", "auth_time": now, "iat": now, "exp": now + 3600,
         "iss": f"https://securetoken.google.com/{PROJECT_ID}", "aud": PROJECT_ID},
        "attacker-guessed-secret", algorithm="HS256", headers={"kid": KID},
    )
    result = await fv.verify_firebase_id_token(forged, PROJECT_ID)
    assert result is None


@pytest.mark.anyio
async def test_rejects_missing_kid(monkeypatch):
    key_pem, cert_pem = _make_self_signed_cert()
    _patch_fetch(monkeypatch, {KID: cert_pem})
    now = int(time.time())
    no_kid = jose_jwt.encode(
        {"sub": "firebase-uid-1", "auth_time": now, "iat": now, "exp": now + 3600,
         "iss": f"https://securetoken.google.com/{PROJECT_ID}", "aud": PROJECT_ID},
        key_pem, algorithm="RS256",
    )
    result = await fv.verify_firebase_id_token(no_kid, PROJECT_ID)
    assert result is None


@pytest.mark.anyio
async def test_rejects_unknown_kid(monkeypatch):
    key_pem, cert_pem = _make_self_signed_cert()
    _patch_fetch(monkeypatch, {"some-other-kid": cert_pem})
    token = _make_id_token(key_pem, kid=KID)
    result = await fv.verify_firebase_id_token(token, PROJECT_ID)
    assert result is None


@pytest.mark.anyio
async def test_rejects_expired_token(monkeypatch):
    key_pem, cert_pem = _make_self_signed_cert()
    _patch_fetch(monkeypatch, {KID: cert_pem})
    token = _make_id_token(key_pem, exp_delta=-3600)
    result = await fv.verify_firebase_id_token(token, PROJECT_ID)
    assert result is None


@pytest.mark.anyio
async def test_rejects_forged_signature_untrusted_key(monkeypatch):
    _key_pem, cert_pem = _make_self_signed_cert()
    attacker_key_pem, _attacker_cert = _make_self_signed_cert()
    _patch_fetch(monkeypatch, {KID: cert_pem})
    forged = _make_id_token(attacker_key_pem, kid=KID)
    result = await fv.verify_firebase_id_token(forged, PROJECT_ID)
    assert result is None


@pytest.mark.anyio
async def test_id_token_and_session_key_caches_are_independent(monkeypatch):
    """세션쿠키용 키 캐시에 심어둔 kid가 ID token 검증엔 절대 안 쓰인다(별도 캐시·별도
    엔드포인트) — 캐시 오염으로 인한 issuer confusion 우회 경로 원천 차단 확인."""
    id_key_pem, id_cert_pem = _make_self_signed_cert()
    session_key_pem, session_cert_pem = _make_self_signed_cert()

    async def fake_session_fetch():
        return {KID: session_cert_pem}

    async def fake_id_fetch():
        return {KID: id_cert_pem}

    monkeypatch.setattr(fv, "_fetch_public_keys", fake_session_fetch)
    monkeypatch.setattr(fv, "_fetch_id_token_public_keys", fake_id_fetch)

    # ID token은 id_key_pem으로 서명 — session_cert_pem(다른 키)로는 검증 불가해야 정상.
    id_token = _make_id_token(id_key_pem)
    result = await fv.verify_firebase_id_token(id_token, PROJECT_ID)
    assert result is not None  # 올바른 키 사용 시 통과

    # 동일 kid로 서명됐지만 세션쿠키 키(session_key_pem)로 서명한 토큰은 ID token 검증기가
    # id_cert_pem으로 검증 시도하므로 서명 불일치로 거부돼야 함.
    cross_signed = _make_id_token(session_key_pem)
    cross_result = await fv.verify_firebase_id_token(cross_signed, PROJECT_ID)
    assert cross_result is None
