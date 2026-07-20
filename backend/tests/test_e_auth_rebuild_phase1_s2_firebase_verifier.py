"""story 455e528d(E-AUTH-REBUILD M2 Phase1-S2) 계약 테스트: verify_firebase_session() 정확
검증(doc §4.2) — 6개 실패 카테고리 전부 실 self-signed X.509 인증서로 서명까지 실증(raw SPKI
PEM 사용 시 importX509류가 파싱 자체에 실패해 거짓양성 나던 FE(#2193) 함정을 처음부터 회피).
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
    yield
    fv._reset_key_cache_for_tests()


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


def _make_session_cookie(
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
        "iss": iss or f"https://session.firebase.google.com/{PROJECT_ID}",
        "aud": aud or PROJECT_ID,
    }
    return jose_jwt.encode(claims, key_pem, algorithm="RS256", headers={"kid": kid})


def _patch_fetch(monkeypatch, keys: dict[str, str]) -> None:
    async def fake_fetch():
        return keys
    monkeypatch.setattr(fv, "_fetch_public_keys", fake_fetch)


@pytest.mark.anyio
async def test_accepts_correctly_signed_session(monkeypatch):
    key_pem, cert_pem = _make_self_signed_cert()
    _patch_fetch(monkeypatch, {KID: cert_pem})
    cookie = _make_session_cookie(key_pem)
    result = await fv.verify_firebase_session(cookie, PROJECT_ID)
    assert result is not None
    assert result.firebase_uid == "firebase-uid-1"
    assert result.email == "user@test.com"


@pytest.mark.anyio
async def test_rejects_issuer_confusion_id_token_issuer(monkeypatch):
    """ID token issuer(securetoken.google.com)를 세션 issuer로 오인 수락하면 안 됨(doc §4.2)."""
    key_pem, cert_pem = _make_self_signed_cert()
    _patch_fetch(monkeypatch, {KID: cert_pem})
    cookie = _make_session_cookie(key_pem, iss=f"https://securetoken.google.com/{PROJECT_ID}")
    result = await fv.verify_firebase_session(cookie, PROJECT_ID)
    assert result is None


@pytest.mark.anyio
async def test_rejects_wrong_project_audience_mismatch(monkeypatch):
    key_pem, cert_pem = _make_self_signed_cert()
    _patch_fetch(monkeypatch, {KID: cert_pem})
    cookie = _make_session_cookie(key_pem, aud="other-project")
    result = await fv.verify_firebase_session(cookie, PROJECT_ID)
    assert result is None


@pytest.mark.anyio
async def test_rejects_wrong_algorithm_hs256_forged(monkeypatch):
    """alg=HS256로 위조(권장 RS256 대신) — jose가 RS256 공개키로 HS256 서명을 절대 검증 못 함."""
    key_pem, cert_pem = _make_self_signed_cert()
    _patch_fetch(monkeypatch, {KID: cert_pem})
    now = int(time.time())
    forged = jose_jwt.encode(
        {"sub": "firebase-uid-1", "auth_time": now, "iat": now, "exp": now + 3600,
         "iss": f"https://session.firebase.google.com/{PROJECT_ID}", "aud": PROJECT_ID},
        "attacker-guessed-secret", algorithm="HS256", headers={"kid": KID},
    )
    result = await fv.verify_firebase_session(forged, PROJECT_ID)
    assert result is None


@pytest.mark.anyio
async def test_rejects_missing_kid(monkeypatch):
    key_pem, cert_pem = _make_self_signed_cert()
    _patch_fetch(monkeypatch, {KID: cert_pem})
    now = int(time.time())
    no_kid = jose_jwt.encode(
        {"sub": "firebase-uid-1", "auth_time": now, "iat": now, "exp": now + 3600,
         "iss": f"https://session.firebase.google.com/{PROJECT_ID}", "aud": PROJECT_ID},
        key_pem, algorithm="RS256",  # headers 미지정 — kid 없음
    )
    result = await fv.verify_firebase_session(no_kid, PROJECT_ID)
    assert result is None


@pytest.mark.anyio
async def test_rejects_unknown_kid(monkeypatch):
    key_pem, cert_pem = _make_self_signed_cert()
    _patch_fetch(monkeypatch, {"some-other-kid": cert_pem})  # KID가 published set에 없음
    cookie = _make_session_cookie(key_pem, kid=KID)
    result = await fv.verify_firebase_session(cookie, PROJECT_ID)
    assert result is None


@pytest.mark.anyio
async def test_rejects_expired_token(monkeypatch):
    key_pem, cert_pem = _make_self_signed_cert()
    _patch_fetch(monkeypatch, {KID: cert_pem})
    cookie = _make_session_cookie(key_pem, exp_delta=-3600)  # 이미 만료
    result = await fv.verify_firebase_session(cookie, PROJECT_ID)
    assert result is None


@pytest.mark.anyio
async def test_rejects_forged_signature_untrusted_key(monkeypatch):
    """까심: 공격자가 자기 키로 서명하고 신뢰된 kid를 사칭 — 서버는 published cert로만 검증."""
    _key_pem, cert_pem = _make_self_signed_cert()  # published(서버가 신뢰하는) cert
    attacker_key_pem, _attacker_cert = _make_self_signed_cert()  # 공격자 자신의 키
    _patch_fetch(monkeypatch, {KID: cert_pem})
    forged = _make_session_cookie(attacker_key_pem, kid=KID)  # 공격자 키로 서명, published kid 사칭
    result = await fv.verify_firebase_session(forged, PROJECT_ID)
    assert result is None
