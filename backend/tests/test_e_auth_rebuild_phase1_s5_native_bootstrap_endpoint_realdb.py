"""story 4dee942b(E-AUTH-REBUILD M2 Phase1-S5) 게이트: POST /api/v2/auth/native-bootstrap
(공개 API, Firebase ID token Bearer 인증) — 플래그 게이팅·auth_time 최근성·identity 매핑·
App Check 필수 정책이 doc §9.1/산티아고 §9 순서대로 실 DB로 동작하는지 실증.
"""
from __future__ import annotations

import os
import subprocess
import tempfile
import time
import uuid
from pathlib import Path

import pytest
from fastapi import Response
from jose import jwt as jose_jwt
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives import serialization
from jose.utils import long_to_base64

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
]

PROJECT_ID = "test-project"
PROJECT_NUMBER = "1234567890"
KID = "test-kid-1"
APP_CHECK_KID = "app-check-kid-1"


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _reset_caches_and_dispose():
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


def _make_id_token(key_pem: str, sub: str, *, auth_time: int | None = None, exp_delta: int = 3600) -> str:
    now = int(time.time())
    claims = {
        "sub": sub, "email": "user@test.com",
        "auth_time": auth_time if auth_time is not None else now,
        "iat": now, "exp": now + exp_delta,
        "iss": f"https://securetoken.google.com/{PROJECT_ID}", "aud": PROJECT_ID,
    }
    return jose_jwt.encode(claims, key_pem, algorithm="RS256", headers={"kid": KID})


def _make_rsa_keypair_jwk(kid: str) -> tuple[str, dict]:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode()
    numbers = key.public_key().public_numbers()
    jwk = {
        "kty": "RSA", "kid": kid, "use": "sig", "alg": "RS256",
        "n": long_to_base64(numbers.n).decode(), "e": long_to_base64(numbers.e).decode(),
    }
    return pem, jwk


def _make_app_check_token(key_pem: str, *, kid: str = APP_CHECK_KID, app_id: str = "1:123:android:abc") -> str:
    now = int(time.time())
    claims = {
        "sub": app_id, "iat": now, "exp": now + 3600,
        "iss": f"https://firebaseappcheck.googleapis.com/{PROJECT_NUMBER}",
        "aud": [f"projects/{PROJECT_NUMBER}"],
    }
    return jose_jwt.encode(claims, key_pem, algorithm="RS256", headers={"kid": kid})


async def _seed(session, *, user_active: bool = True, mapped: bool = True, eligible: bool = True):
    from app.core.security import hash_password
    from app.models.auth_identity import AuthIdentity, AuthMigration
    from app.models.user import User

    user_id = uuid.uuid4()
    session.add(User(
        id=user_id, email=f"authreb-s5-endpoint-{user_id.hex[:8]}@test.com",
        hashed_password=hash_password("x"), is_active=user_active, email_verified=True,
    ))
    await session.commit()

    firebase_uid = f"fb-uid-{uuid.uuid4().hex[:8]}"
    if mapped:
        issuer = f"https://securetoken.google.com/{PROJECT_ID}"
        session.add(AuthIdentity(
            id=uuid.uuid4(), user_id=user_id, issuer=issuer, subject=firebase_uid,
            provider_id="password",
        ))
        await session.commit()

    # story bea25062(§17d-1 RED 조건 ②⑥·2026-07-16): issue 엔드포인트도 이제 migration
    # state+cutover epoch를 검사한다 — eligible=True(기본값)가 이 fixture의 사용자를 실
    # 프로덕션에서 이 엔드포인트를 호출할 수 있는 정상(이미 Firebase 마이그레이션됨) 상태로
    # 정확히 대표한다.
    if eligible:
        session.add(AuthMigration(user_id=user_id, state="firebase"))
        await session.commit()

    return {"user_id": user_id, "firebase_uid": firebase_uid}


def _setup_common(monkeypatch, *, mobile_issue: bool = True, app_check_required: bool = False):
    from app.core.config import settings
    monkeypatch.setattr(settings, "firebase_auth_mobile_issue", mobile_issue)
    monkeypatch.setattr(settings, "firebase_project_id", PROJECT_ID)
    monkeypatch.setattr(settings, "firebase_project_number", PROJECT_NUMBER)
    monkeypatch.setattr(settings, "firebase_auth_mobile_app_check_required", app_check_required)
    monkeypatch.setattr(settings, "firebase_app_check_allowed_app_ids", "1:123:android:abc")


@pytest.mark.anyio
async def test_flag_off_returns_501(monkeypatch):
    from app.routers.auth_native_bootstrap import NativeBootstrapRequest, native_bootstrap

    _setup_common(monkeypatch, mobile_issue=False)

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            from fastapi import HTTPException
            with pytest.raises(HTTPException) as exc_info:
                await native_bootstrap(request=None, body=NativeBootstrapRequest(), response=Response(), authorization=None, db=s)
            assert exc_info.value.status_code == 501
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_missing_bearer_rejected(monkeypatch):
    from app.routers.auth_native_bootstrap import NativeBootstrapRequest, native_bootstrap
    from fastapi import HTTPException

    _setup_common(monkeypatch)

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            with pytest.raises(HTTPException) as exc_info:
                await native_bootstrap(request=None, body=NativeBootstrapRequest(), response=Response(), authorization=None, db=s)
            assert exc_info.value.status_code == 401
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_success_issues_code(monkeypatch):
    from app.routers.auth_native_bootstrap import NativeBootstrapRequest, native_bootstrap
    from app.services import firebase_verifier as fv

    _setup_common(monkeypatch)
    key_pem, cert_pem = _make_self_signed_cert()

    async def fake_id_fetch():
        return {KID: cert_pem}
    monkeypatch.setattr(fv, "_fetch_id_token_public_keys", fake_id_fetch)

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        token = _make_id_token(key_pem, seeded["firebase_uid"])
        async with Session() as s:
            response = Response()
            result = await native_bootstrap(
                request=None, body=NativeBootstrapRequest(), response=response,
                authorization=f"Bearer {token}", db=s,
            )
        assert result.code
        assert result.expires_in == 45
        assert response.headers["Cache-Control"] == "no-store"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_stale_auth_time_rejected(monkeypatch):
    from app.routers.auth_native_bootstrap import NativeBootstrapRequest, native_bootstrap
    from app.services import firebase_verifier as fv
    from fastapi import HTTPException

    _setup_common(monkeypatch)
    key_pem, cert_pem = _make_self_signed_cert()

    async def fake_id_fetch():
        return {KID: cert_pem}
    monkeypatch.setattr(fv, "_fetch_id_token_public_keys", fake_id_fetch)

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        stale_token = _make_id_token(key_pem, seeded["firebase_uid"], auth_time=int(time.time()) - 3600)
        async with Session() as s:
            with pytest.raises(HTTPException) as exc_info:
                await native_bootstrap(request=None, body=NativeBootstrapRequest(), response=Response(), authorization=f"Bearer {stale_token}", db=s)
            assert exc_info.value.status_code == 401
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_unmapped_identity_rejected(monkeypatch):
    from app.routers.auth_native_bootstrap import NativeBootstrapRequest, native_bootstrap
    from app.services import firebase_verifier as fv
    from fastapi import HTTPException

    _setup_common(monkeypatch)
    key_pem, cert_pem = _make_self_signed_cert()

    async def fake_id_fetch():
        return {KID: cert_pem}
    monkeypatch.setattr(fv, "_fetch_id_token_public_keys", fake_id_fetch)

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s, mapped=False)

        token = _make_id_token(key_pem, seeded["firebase_uid"])
        async with Session() as s:
            with pytest.raises(HTTPException) as exc_info:
                await native_bootstrap(request=None, body=NativeBootstrapRequest(), response=Response(), authorization=f"Bearer {token}", db=s)
            assert exc_info.value.status_code == 401
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_inactive_user_rejected(monkeypatch):
    from app.routers.auth_native_bootstrap import NativeBootstrapRequest, native_bootstrap
    from app.services import firebase_verifier as fv
    from fastapi import HTTPException

    _setup_common(monkeypatch)
    key_pem, cert_pem = _make_self_signed_cert()

    async def fake_id_fetch():
        return {KID: cert_pem}
    monkeypatch.setattr(fv, "_fetch_id_token_public_keys", fake_id_fetch)

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s, user_active=False)

        token = _make_id_token(key_pem, seeded["firebase_uid"])
        async with Session() as s:
            with pytest.raises(HTTPException) as exc_info:
                await native_bootstrap(request=None, body=NativeBootstrapRequest(), response=Response(), authorization=f"Bearer {token}", db=s)
            assert exc_info.value.status_code == 401
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_ineligible_migration_state_rejected(monkeypatch):
    """story bea25062(2026-07-16): issue 엔드포인트도 이제 consume과 동일하게 provisioning/
    firebase 외 state는 거부 — reset_required 사용자가 새 코드를 발급받는 첫 단계를 막는다."""
    from app.routers.auth_native_bootstrap import NativeBootstrapRequest, native_bootstrap
    from app.services import firebase_verifier as fv
    from fastapi import HTTPException

    _setup_common(monkeypatch)
    key_pem, cert_pem = _make_self_signed_cert()

    async def fake_id_fetch():
        return {KID: cert_pem}
    monkeypatch.setattr(fv, "_fetch_id_token_public_keys", fake_id_fetch)

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            from app.models.auth_identity import AuthMigration
            seeded = await _seed(s, eligible=False)
            s.add(AuthMigration(user_id=seeded["user_id"], state="reset_required"))
            await s.commit()

        token = _make_id_token(key_pem, seeded["firebase_uid"])
        async with Session() as s:
            with pytest.raises(HTTPException) as exc_info:
                await native_bootstrap(request=None, body=NativeBootstrapRequest(), response=Response(), authorization=f"Bearer {token}", db=s)
            assert exc_info.value.status_code == 401
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_issue_pre_cutover_auth_after_revoke_rejected(monkeypatch):
    """산티아고 BLOCKER 2 정확한 공격 시나리오의 issue-time 절반: revoke *이후* 예전
    (pre-cutover) ID token으로 새 코드 발급을 시도해도 issue 시점에 이미 거부돼야 한다
    (consume에만 있던 방어를 issue에도 대칭 반영)."""
    from app.routers.auth_native_bootstrap import NativeBootstrapRequest, native_bootstrap
    from app.services import firebase_verifier as fv
    from app.services.auth_cutover import revoke_user_sessions
    from fastapi import HTTPException

    _setup_common(monkeypatch)
    key_pem, cert_pem = _make_self_signed_cert()

    async def fake_id_fetch():
        return {KID: cert_pem}
    monkeypatch.setattr(fv, "_fetch_id_token_public_keys", fake_id_fetch)

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        pre_cutover_auth_time = int(time.time()) - 60  # 아직 5분 freshness 내
        async with Session() as s:
            await revoke_user_sessions(s, seeded["user_id"], firebase_uid=None)

        old_token = _make_id_token(key_pem, seeded["firebase_uid"], auth_time=pre_cutover_auth_time)
        async with Session() as s:
            with pytest.raises(HTTPException) as exc_info:
                await native_bootstrap(request=None, body=NativeBootstrapRequest(), response=Response(), authorization=f"Bearer {old_token}", db=s)
            assert exc_info.value.status_code == 401
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_app_check_required_but_missing_rejected(monkeypatch):
    from app.routers.auth_native_bootstrap import NativeBootstrapRequest, native_bootstrap
    from app.services import firebase_verifier as fv
    from fastapi import HTTPException

    _setup_common(monkeypatch, app_check_required=True)
    key_pem, cert_pem = _make_self_signed_cert()

    async def fake_id_fetch():
        return {KID: cert_pem}
    monkeypatch.setattr(fv, "_fetch_id_token_public_keys", fake_id_fetch)

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        token = _make_id_token(key_pem, seeded["firebase_uid"])
        async with Session() as s:
            with pytest.raises(HTTPException) as exc_info:
                await native_bootstrap(request=None, body=NativeBootstrapRequest(), response=Response(), authorization=f"Bearer {token}", db=s)
            assert exc_info.value.status_code == 401
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_app_check_required_and_valid_binds_device_hash(monkeypatch):
    from app.routers.auth_native_bootstrap import NativeBootstrapRequest, native_bootstrap
    from app.services import firebase_verifier as fv
    from app.models.auth_native_bootstrap import AuthNativeBootstrapCode
    from sqlalchemy import select

    _setup_common(monkeypatch, app_check_required=True)
    key_pem, cert_pem = _make_self_signed_cert()
    app_check_key_pem, app_check_jwk = _make_rsa_keypair_jwk(APP_CHECK_KID)

    async def fake_id_fetch():
        return {KID: cert_pem}
    monkeypatch.setattr(fv, "_fetch_id_token_public_keys", fake_id_fetch)

    async def fake_app_check_fetch():
        return {APP_CHECK_KID: app_check_jwk}
    monkeypatch.setattr(fv, "_fetch_app_check_jwks", fake_app_check_fetch)

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        token = _make_id_token(key_pem, seeded["firebase_uid"])
        app_check_token = _make_app_check_token(app_check_key_pem)
        async with Session() as s:
            result = await native_bootstrap(
                request=None,
                body=NativeBootstrapRequest(app_check_token=app_check_token, device_install_hint="install-1"),
                response=Response(),
                authorization=f"Bearer {token}", db=s,
            )
        assert result.code

        async with Session() as s:
            row = (await s.execute(
                select(AuthNativeBootstrapCode).where(AuthNativeBootstrapCode.user_id == seeded["user_id"])
            )).scalar_one()
            assert row.device_binding_hash is not None
    finally:
        await engine.dispose()
