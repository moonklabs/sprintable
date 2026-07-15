"""story 4dee942b(E-AUTH-REBUILD M2 Phase1-S5) 계약 테스트: verify_app_check_token() 정확
검증. App Check JWKS는 표준 kid→JWK dict 포맷(세션쿠키/ID token의 kid→X.509 PEM과 다름) —
raw RSA 키페어로 직접 JWK 구성해 파싱 경로 자체를 실증한다.
"""
from __future__ import annotations

import time

import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives import serialization
from jose import jwt as jose_jwt
from jose.utils import long_to_base64

from app.services import firebase_verifier as fv

PROJECT_NUMBER = "1234567890"
KID = "app-check-kid-1"


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
def _reset_cache():
    fv._reset_app_check_key_cache_for_tests()
    yield
    fv._reset_app_check_key_cache_for_tests()


def _make_rsa_keypair() -> tuple[str, dict]:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode()
    numbers = key.public_key().public_numbers()
    jwk = {
        "kty": "RSA", "kid": KID, "use": "sig", "alg": "RS256",
        "n": long_to_base64(numbers.n).decode(), "e": long_to_base64(numbers.e).decode(),
    }
    return pem, jwk


def _make_app_check_token(key_pem: str, *, iss: str | None = None, sub: str = "1:123:android:abc", kid: str = KID, exp_delta: int = 3600) -> str:
    now = int(time.time())
    claims = {
        "sub": sub, "iat": now, "exp": now + exp_delta,
        "iss": iss or f"https://firebaseappcheck.googleapis.com/{PROJECT_NUMBER}",
        "aud": [f"projects/{PROJECT_NUMBER}"],
    }
    return jose_jwt.encode(claims, key_pem, algorithm="RS256", headers={"kid": kid})


def _patch_fetch(monkeypatch, jwks: dict[str, dict]) -> None:
    async def fake_fetch():
        return jwks
    monkeypatch.setattr(fv, "_fetch_app_check_jwks", fake_fetch)


@pytest.mark.anyio
async def test_accepts_correctly_signed_app_check_token(monkeypatch):
    key_pem, jwk = _make_rsa_keypair()
    _patch_fetch(monkeypatch, {KID: jwk})
    token = _make_app_check_token(key_pem)
    result = await fv.verify_app_check_token(token, PROJECT_NUMBER)
    assert result is not None
    assert result.app_id == "1:123:android:abc"


@pytest.mark.anyio
async def test_rejects_wrong_issuer(monkeypatch):
    key_pem, jwk = _make_rsa_keypair()
    _patch_fetch(monkeypatch, {KID: jwk})
    token = _make_app_check_token(key_pem, iss="https://securetoken.google.com/other")
    result = await fv.verify_app_check_token(token, PROJECT_NUMBER)
    assert result is None


@pytest.mark.anyio
async def test_rejects_wrong_project_number_in_issuer(monkeypatch):
    key_pem, jwk = _make_rsa_keypair()
    _patch_fetch(monkeypatch, {KID: jwk})
    token = _make_app_check_token(key_pem, iss="https://firebaseappcheck.googleapis.com/other-project")
    result = await fv.verify_app_check_token(token, PROJECT_NUMBER)
    assert result is None


@pytest.mark.anyio
async def test_rejects_missing_kid(monkeypatch):
    key_pem, jwk = _make_rsa_keypair()
    _patch_fetch(monkeypatch, {KID: jwk})
    now = int(time.time())
    no_kid = jose_jwt.encode(
        {"sub": "1:123:android:abc", "iat": now, "exp": now + 3600,
         "iss": f"https://firebaseappcheck.googleapis.com/{PROJECT_NUMBER}", "aud": [f"projects/{PROJECT_NUMBER}"]},
        key_pem, algorithm="RS256",
    )
    result = await fv.verify_app_check_token(no_kid, PROJECT_NUMBER)
    assert result is None


@pytest.mark.anyio
async def test_rejects_unknown_kid(monkeypatch):
    key_pem, jwk = _make_rsa_keypair()
    _patch_fetch(monkeypatch, {"some-other-kid": jwk})
    token = _make_app_check_token(key_pem, kid=KID)
    result = await fv.verify_app_check_token(token, PROJECT_NUMBER)
    assert result is None


@pytest.mark.anyio
async def test_rejects_expired_token(monkeypatch):
    key_pem, jwk = _make_rsa_keypair()
    _patch_fetch(monkeypatch, {KID: jwk})
    token = _make_app_check_token(key_pem, exp_delta=-3600)
    result = await fv.verify_app_check_token(token, PROJECT_NUMBER)
    assert result is None


@pytest.mark.anyio
async def test_rejects_forged_signature_untrusted_key(monkeypatch):
    _key_pem, jwk = _make_rsa_keypair()
    attacker_key_pem, _attacker_jwk = _make_rsa_keypair()
    _patch_fetch(monkeypatch, {KID: jwk})
    forged = _make_app_check_token(attacker_key_pem, kid=KID)
    result = await fv.verify_app_check_token(forged, PROJECT_NUMBER)
    assert result is None
