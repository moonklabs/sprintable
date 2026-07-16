"""story cbd578d4(E-AUTH-REBUILD 활성화게이트][C4]·산티아고 §7.3 SSOT) 게이트:
`POST /api/v2/auth/device-installations/register` — 최초 등록 3증거(재인증+App Check+
challenge-bound attestation)가 실제로 강제되는지, C2/C3 verifier가 정확히 배선됐는지,
bounded-N+MFA가 동작하는지 실 DB로 실증.

iOS 경로는 C2 테스트 파일의 attestation object 빌더를 재사용(중복 방지) — 동일 알고리즘을
register 엔드포인트 레벨에서 다시 실증한다.
"""
from __future__ import annotations

import base64
import hashlib
import os
import time
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.x509.oid import NameOID
from fastapi import HTTPException, Response
from jose import jwt as jose_jwt

from app.services.apple_app_attest import ENV_PRODUCTION
from tests.test_20f49099_c2_apple_app_attest import (
    BUNDLE_ID as IOS_BUNDLE_ID,
)
from tests.test_20f49099_c2_apple_app_attest import (
    TEAM_ID,
    _AAGUID_PRODUCTION,
    _auth_data,
    _nonce_extension_der,
    _rp_id_hash,
    _self_signed_root,
    _signed_intermediate,
)

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
]

PROJECT_ID = "test-project"
PROJECT_NUMBER = "1234567890"
KID = "test-kid-1"


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_after():
    from app.services import firebase_verifier as fv
    fv._reset_key_cache_for_tests()
    fv._reset_id_token_key_cache_for_tests()
    fv._reset_app_check_key_cache_for_tests()
    yield
    fv._reset_key_cache_for_tests()
    fv._reset_id_token_key_cache_for_tests()
    fv._reset_app_check_key_cache_for_tests()
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _session_factory():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    engine = create_async_engine(_async_url())
    return engine, async_sessionmaker(engine, expire_on_commit=False)


def _setup_common(monkeypatch):
    from app.core.config import settings
    monkeypatch.setattr(settings, "firebase_auth_mobile_issue", True)
    monkeypatch.setattr(settings, "firebase_project_id", PROJECT_ID)
    monkeypatch.setattr(settings, "firebase_project_number", PROJECT_NUMBER)
    monkeypatch.setattr(settings, "firebase_app_check_allowed_app_ids", "1:123:ios:abc")
    monkeypatch.setattr(settings, "ios_team_id", TEAM_ID)


def _make_self_signed_id_cert():
    import subprocess
    import tempfile
    from pathlib import Path
    with tempfile.TemporaryDirectory() as d:
        key_path = Path(d) / "key.pem"
        cert_path = Path(d) / "cert.pem"
        subprocess.run(
            ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-keyout", str(key_path),
             "-out", str(cert_path), "-days", "1", "-nodes", "-subj", "/CN=test"],
            check=True, capture_output=True,
        )
        return key_path.read_text(), cert_path.read_text()


def _make_id_token(key_pem: str, sub: str, *, auth_time: int | None = None) -> str:
    now = int(time.time())
    claims = {
        "sub": sub, "email": "user@test.com", "auth_time": auth_time if auth_time is not None else now,
        "iat": now, "exp": now + 3600,
        "iss": f"https://securetoken.google.com/{PROJECT_ID}", "aud": PROJECT_ID,
    }
    return jose_jwt.encode(claims, key_pem, algorithm="RS256", headers={"kid": KID})


def _make_app_check_token(key_pem: str, kid: str, app_id: str) -> str:
    now = int(time.time())
    claims = {
        "sub": app_id, "iat": now, "exp": now + 3600,
        "iss": f"https://firebaseappcheck.googleapis.com/{PROJECT_NUMBER}", "aud": [f"projects/{PROJECT_NUMBER}"],
    }
    return jose_jwt.encode(claims, key_pem, algorithm="RS256", headers={"kid": kid})


async def _seed_eligible_user(session):
    from app.core.security import hash_password
    from app.models.auth_identity import AuthIdentity, AuthMigration
    from app.models.user import User

    user_id = uuid.uuid4()
    firebase_uid = f"fb-uid-{user_id.hex[:8]}"
    session.add(User(
        id=user_id, email=f"c4-register-{user_id.hex[:8]}@test.com",
        hashed_password=hash_password("x"), is_active=True, email_verified=True,
    ))
    await session.commit()
    session.add(AuthMigration(user_id=user_id, state="firebase"))
    session.add(AuthIdentity(
        id=uuid.uuid4(), user_id=user_id,
        issuer=f"https://securetoken.google.com/{PROJECT_ID}", subject=firebase_uid, provider_id="password",
    ))
    await session.commit()
    return user_id, firebase_uid


async def _issue_registration_challenge(db, *, user_id, firebase_uid, platform="ios", app_id=IOS_BUNDLE_ID, environment=ENV_PRODUCTION):
    from app.services.device_proof import PURPOSE_REGISTER, TTL_REGISTER_SECONDS, issue_challenge
    issued = await issue_challenge(
        db, purpose=PURPOSE_REGISTER, user_id=user_id, firebase_uid=firebase_uid, project_id=PROJECT_ID,
        tenant_id=None, environment=environment, platform=platform, app_id=app_id,
        http_method="POST", route="/api/v2/auth/device-installations/register",
        web_origin="https://sprintable.app", ttl_seconds=TTL_REGISTER_SECONDS,
    )
    return issued


def _build_ios_attestation(monkeypatch, *, client_data_hash: bytes):
    import app.services.apple_app_attest as aa_module
    root_key, root_cert = _self_signed_root()
    monkeypatch.setattr(aa_module, "APPLE_APP_ATTEST_ROOT_CA_PEM", root_cert.public_bytes(serialization.Encoding.PEM))
    intermediate_key, intermediate_cert = _signed_intermediate(root_key, root_cert)

    from cryptography.hazmat.primitives.asymmetric import ec
    probe_key = ec.generate_private_key(ec.SECP256R1())
    probe_pub_raw = probe_key.public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
    )
    key_id = hashlib.sha256(probe_pub_raw).digest()
    auth_data = _auth_data(_rp_id_hash(TEAM_ID, IOS_BUNDLE_ID), 0, _AAGUID_PRODUCTION, key_id)
    nonce = hashlib.sha256(auth_data + client_data_hash).digest()

    from cryptography import x509
    from cryptography.hazmat.primitives import hashes
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Test Leaf")])
    leaf_cert = (
        x509.CertificateBuilder()
        .subject_name(name).issuer_name(intermediate_cert.subject).public_key(probe_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(datetime.now(timezone.utc) - timedelta(days=1))
        .not_valid_after(datetime.now(timezone.utc) + timedelta(days=365))
        .add_extension(x509.UnrecognizedExtension(
            x509.ObjectIdentifier("1.2.840.113635.100.8.2"), _nonce_extension_der(nonce)
        ), critical=False)
        .sign(intermediate_key, hashes.SHA256())
    )

    import cbor2
    x5c = [leaf_cert.public_bytes(serialization.Encoding.DER), intermediate_cert.public_bytes(serialization.Encoding.DER)]
    attestation_object = cbor2.dumps({
        "fmt": "apple-appattest", "attStmt": {"x5c": x5c, "receipt": b"x"}, "authData": auth_data,
    })
    return attestation_object, key_id


@pytest.mark.anyio
async def test_ios_register_success(monkeypatch):
    from app.routers.device_installations import RegisterRequest, register_device_installation
    from app.services import firebase_verifier as fv

    _setup_common(monkeypatch)
    id_key_pem, id_cert_pem = _make_self_signed_id_cert()

    async def fake_id_fetch():
        return {KID: id_cert_pem}
    monkeypatch.setattr(fv, "_fetch_id_token_public_keys", fake_id_fetch)

    from cryptography.hazmat.primitives.asymmetric import rsa
    from jose.utils import long_to_base64
    app_check_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    app_check_key_pem = app_check_key.private_bytes(
        encoding=serialization.Encoding.PEM, format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode()
    numbers = app_check_key.public_key().public_numbers()
    app_check_jwk = {
        "kty": "RSA", "kid": "ack-1", "use": "sig", "alg": "RS256",
        "n": long_to_base64(numbers.n).decode(), "e": long_to_base64(numbers.e).decode(),
    }

    async def fake_app_check_fetch():
        return {"ack-1": app_check_jwk}
    monkeypatch.setattr(fv, "_fetch_app_check_jwks", fake_app_check_fetch)

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            user_id, firebase_uid = await _seed_eligible_user(s)
            issued = await _issue_registration_challenge(s, user_id=user_id, firebase_uid=firebase_uid)

        transcript_bytes = _b64url_decode(issued.client_data_b64url)
        client_data_hash = hashlib.sha256(transcript_bytes).digest()
        attestation_object, key_id = _build_ios_attestation(monkeypatch, client_data_hash=client_data_hash)

        id_token = _make_id_token(id_key_pem, firebase_uid)
        app_check_token = _make_app_check_token(app_check_key_pem, "ack-1", "1:123:ios:abc")

        async with Session() as s:
            result = await register_device_installation(
                request=None,
                body=RegisterRequest(
                    challenge_id=issued.challenge_id, client_data_b64url=issued.client_data_b64url,
                    app_check_token=app_check_token, platform="ios", app_id=IOS_BUNDLE_ID,
                    environment=ENV_PRODUCTION, key_id_b64=base64.b64encode(key_id).decode(),
                    attestation_object_b64=base64.b64encode(attestation_object).decode(),
                ),
                response=Response(), authorization=f"Bearer {id_token}", x_firebase_appcheck=None, db=s,
            )
        assert result.installation_id
        assert result.key_version == 1
    finally:
        await engine.dispose()


def _b64url_decode(s: str) -> bytes:
    padded = s + "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(padded.encode())


@pytest.mark.anyio
async def test_flag_off_returns_501(monkeypatch):
    from app.routers.device_installations import RegisterRequest, register_device_installation
    from app.core.config import settings
    monkeypatch.setattr(settings, "firebase_auth_mobile_issue", False)

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            with pytest.raises(HTTPException) as exc_info:
                await register_device_installation(
                    request=None,
                    body=RegisterRequest(
                        challenge_id=str(uuid.uuid4()), client_data_b64url="x", platform="ios",
                        app_id="a", environment=ENV_PRODUCTION,
                    ),
                    response=Response(), authorization=None, x_firebase_appcheck=None, db=s,
                )
            assert exc_info.value.status_code == 501
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_unsupported_platform_rejected(monkeypatch):
    from app.routers.device_installations import RegisterRequest, register_device_installation
    _setup_common(monkeypatch)

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            with pytest.raises(HTTPException) as exc_info:
                await register_device_installation(
                    request=None,
                    body=RegisterRequest(
                        challenge_id=str(uuid.uuid4()), client_data_b64url="x", platform="windows",
                        app_id="a", environment=ENV_PRODUCTION,
                    ),
                    response=Response(), authorization=None, x_firebase_appcheck=None, db=s,
                )
            assert exc_info.value.status_code == 400
    finally:
        await engine.dispose()


def _make_app_check_keypair():
    from cryptography.hazmat.primitives.asymmetric import rsa
    from jose.utils import long_to_base64
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    key_pem = key.private_bytes(
        encoding=serialization.Encoding.PEM, format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode()
    numbers = key.public_key().public_numbers()
    jwk = {
        "kty": "RSA", "kid": "ack-1", "use": "sig", "alg": "RS256",
        "n": long_to_base64(numbers.n).decode(), "e": long_to_base64(numbers.e).decode(),
    }
    return key_pem, jwk


@pytest.mark.anyio
async def test_bounded_installation_cap_without_mfa_rejected(monkeypatch):
    """§7.3: 사용자당 bounded N(1, 테스트용으로 축소)개 active installation — 초과+MFA
    미등록(totp_enabled=False)은 403 거부, attestation 검증까지 가지도 않는다."""
    from app.routers.device_installations import RegisterRequest, register_device_installation
    from app.services import firebase_verifier as fv
    from app.core.config import settings
    from app.models.device_installation import DeviceInstallation

    _setup_common(monkeypatch)
    monkeypatch.setattr(settings, "device_installation_max_active_per_user", 1)
    id_key_pem, id_cert_pem = _make_self_signed_id_cert()

    async def fake_id_fetch():
        return {KID: id_cert_pem}
    monkeypatch.setattr(fv, "_fetch_id_token_public_keys", fake_id_fetch)

    app_check_key_pem, app_check_jwk = _make_app_check_keypair()

    async def fake_app_check_fetch():
        return {"ack-1": app_check_jwk}
    monkeypatch.setattr(fv, "_fetch_app_check_jwks", fake_app_check_fetch)

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            user_id, firebase_uid = await _seed_eligible_user(s)
            s.add(DeviceInstallation(
                id=uuid.uuid4(), user_id=user_id, firebase_uid=firebase_uid, project_id=PROJECT_ID,
                environment=ENV_PRODUCTION, platform="ios", app_id=IOS_BUNDLE_ID, key_version=1,
                public_key_fingerprint=f"fp-{uuid.uuid4().hex[:12]}", public_key_der=b"\x00",
                attestation_type="app_attest", status="active", attested_at=datetime.now(timezone.utc),
                created_at=datetime.now(timezone.utc),
            ))
            await s.commit()
            issued = await _issue_registration_challenge(s, user_id=user_id, firebase_uid=firebase_uid)

        id_token = _make_id_token(id_key_pem, firebase_uid)
        app_check_token = _make_app_check_token(app_check_key_pem, "ack-1", "1:123:ios:abc")
        async with Session() as s:
            with pytest.raises(HTTPException) as exc_info:
                await register_device_installation(
                    request=None,
                    body=RegisterRequest(
                        challenge_id=issued.challenge_id, client_data_b64url=issued.client_data_b64url,
                        app_check_token=app_check_token, platform="ios", app_id=IOS_BUNDLE_ID,
                        environment=ENV_PRODUCTION,
                        key_id_b64=base64.b64encode(b"x" * 32).decode(),
                        attestation_object_b64=base64.b64encode(b"irrelevant").decode(),
                    ),
                    response=Response(), authorization=f"Bearer {id_token}", x_firebase_appcheck=None, db=s,
                )
            assert exc_info.value.status_code == 403
    finally:
        await engine.dispose()
