"""story 132e7204(E-AUTH-REBUILD M2 Phase1-S4) 게이트: 내부 세션쿠키 발급 엔드포인트
(`POST /api/v2/internal/auth/firebase-session`)가 doc §4.4 체크 순서(플래그→내부시크릿→
ID token 검증→auth_time 최근성→identity 매핑→활성 사용자→mint)를 실 DB로 정확히 지키는지
실증. mint_session_cookie() 자체는 S4의 별도 계약테스트(mock-first)가 커버하므로 여기선
mint 성공/실패를 모킹하고 라우터의 게이팅/거부 로직만 realdb로 검증한다.
"""
from __future__ import annotations

import os
import subprocess
import tempfile
import time
import uuid
from pathlib import Path

import pytest
from fastapi import HTTPException
from jose import jwt as jose_jwt

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
]

PROJECT_ID = "test-project"
KID = "test-kid-1"


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _reset_caches_and_dispose():
    from app.services import firebase_verifier as fv
    fv._reset_key_cache_for_tests()
    fv._reset_id_token_key_cache_for_tests()
    yield
    fv._reset_key_cache_for_tests()
    fv._reset_id_token_key_cache_for_tests()
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


async def _seed(session, *, user_active: bool = True, mapped: bool = True, eligible: bool = True):
    from app.core.security import hash_password
    from app.models.auth_identity import AuthIdentity, AuthMigration
    from app.models.user import User

    user_id = uuid.uuid4()
    session.add(User(
        id=user_id, email=f"authreb-s4-{user_id.hex[:8]}@test.com",
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

    # story bea25062(§17d-1 갱신 재검토 2026-07-16): 이 엔드포인트도 이제 issue-time에
    # migration state+cutover epoch를 검사한다(산티아고 "native issue와 동일 guard") —
    # eligible=True(기본값)가 이 fixture로 만드는 사용자가 실 프로덕션에서 이 엔드포인트를
    # 호출할 수 있는 정상 상태(이미 Firebase 마이그레이션됨)를 정확히 대표한다.
    if eligible:
        session.add(AuthMigration(user_id=user_id, state="firebase"))
        await session.commit()

    return {"user_id": user_id, "firebase_uid": firebase_uid}


def _setup_common(monkeypatch, *, issue_session: bool = True):
    from app.core.config import settings
    from app.services import firebase_verifier as fv

    monkeypatch.setattr(settings, "firebase_auth_issue_session", issue_session)
    monkeypatch.setattr(settings, "firebase_project_id", PROJECT_ID)
    monkeypatch.setattr(settings, "firebase_bff_internal_secret", "")  # 로컬 개발 허용 경로

    async def fake_fetch():
        return {}
    monkeypatch.setattr(fv, "_fetch_public_keys", fake_fetch)


@pytest.mark.anyio
async def test_flag_off_returns_501(monkeypatch):
    from app.routers.auth_firebase_internal import FirebaseSessionMintRequest, mint_firebase_session

    _setup_common(monkeypatch, issue_session=False)

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            with pytest.raises(HTTPException) as exc_info:
                await mint_firebase_session(
                    FirebaseSessionMintRequest(id_token="whatever"), authorization=None, db=s
                )
            assert exc_info.value.status_code == 501
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_wrong_internal_secret_rejected(monkeypatch):
    from app.core.config import settings
    from app.routers.auth_firebase_internal import FirebaseSessionMintRequest, mint_firebase_session

    _setup_common(monkeypatch)
    monkeypatch.setattr(settings, "firebase_bff_internal_secret", "correct-secret")

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            with pytest.raises(HTTPException) as exc_info:
                await mint_firebase_session(
                    FirebaseSessionMintRequest(id_token="whatever"),
                    authorization="Bearer wrong-secret", db=s,
                )
            assert exc_info.value.status_code == 401
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_invalid_id_token_rejected(monkeypatch):
    from app.routers.auth_firebase_internal import FirebaseSessionMintRequest, mint_firebase_session

    _setup_common(monkeypatch)

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            with pytest.raises(HTTPException) as exc_info:
                await mint_firebase_session(
                    FirebaseSessionMintRequest(id_token="not-a-real-jwt"), authorization=None, db=s
                )
            assert exc_info.value.status_code == 401
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_stale_auth_time_rejected(monkeypatch):
    from app.routers.auth_firebase_internal import FirebaseSessionMintRequest, mint_firebase_session
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

        stale_token = _make_id_token(key_pem, seeded["firebase_uid"], auth_time=int(time.time()) - 3600)
        async with Session() as s:
            with pytest.raises(HTTPException) as exc_info:
                await mint_firebase_session(
                    FirebaseSessionMintRequest(id_token=stale_token), authorization=None, db=s
                )
            assert exc_info.value.status_code == 401
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_unmapped_identity_rejected(monkeypatch):
    from app.routers.auth_firebase_internal import FirebaseSessionMintRequest, mint_firebase_session
    from app.services import firebase_verifier as fv

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
                await mint_firebase_session(
                    FirebaseSessionMintRequest(id_token=token), authorization=None, db=s
                )
            assert exc_info.value.status_code == 401
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_inactive_user_rejected(monkeypatch):
    from app.routers.auth_firebase_internal import FirebaseSessionMintRequest, mint_firebase_session
    from app.services import firebase_verifier as fv

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
                await mint_firebase_session(
                    FirebaseSessionMintRequest(id_token=token), authorization=None, db=s
                )
            assert exc_info.value.status_code == 401
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_success_returns_minted_cookie(monkeypatch):
    from app.routers.auth_firebase_internal import FirebaseSessionMintRequest, mint_firebase_session
    import app.routers.auth_firebase_internal as router_mod
    from app.services import firebase_verifier as fv

    _setup_common(monkeypatch)
    key_pem, cert_pem = _make_self_signed_cert()

    async def fake_id_fetch():
        return {KID: cert_pem}
    monkeypatch.setattr(fv, "_fetch_id_token_public_keys", fake_id_fetch)

    async def fake_mint(id_token, project_id, valid_duration_seconds):
        assert project_id == PROJECT_ID
        return "minted-cookie-xyz"
    monkeypatch.setattr(router_mod, "mint_session_cookie", fake_mint)

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        token = _make_id_token(key_pem, seeded["firebase_uid"])
        async with Session() as s:
            result = await mint_firebase_session(
                FirebaseSessionMintRequest(id_token=token), authorization=None, db=s
            )
        assert result.session_cookie == "minted-cookie-xyz"
        assert result.expires_in == 5 * 24 * 60 * 60
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_ineligible_migration_state_rejected(monkeypatch):
    """story bea25062(2026-07-16): reset_required 등 부적격 state는 mint 전 거부 — 산티아고
    "native issue와 동일 guard를 session-cookie mint 전에도" 반영."""
    from app.routers.auth_firebase_internal import FirebaseSessionMintRequest, mint_firebase_session
    from app.services import firebase_verifier as fv

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
                await mint_firebase_session(
                    FirebaseSessionMintRequest(id_token=token), authorization=None, db=s
                )
            assert exc_info.value.status_code == 401
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_revoked_before_cutover_rejected(monkeypatch):
    from app.routers.auth_firebase_internal import FirebaseSessionMintRequest, mint_firebase_session
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
        auth_time = int(time.time())
        async with Session() as s:
            from app.services.auth_cutover import revoke_user_sessions
            await revoke_user_sessions(s, seeded["user_id"], firebase_uid=None)

        token = _make_id_token(key_pem, seeded["firebase_uid"], auth_time=auth_time)
        async with Session() as s:
            with pytest.raises(HTTPException) as exc_info:
                await mint_firebase_session(
                    FirebaseSessionMintRequest(id_token=token), authorization=None, db=s
                )
            assert exc_info.value.status_code == 401
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_revoke_during_mint_network_roundtrip_rejects_and_discards_cookie(monkeypatch):
    """산티아고 갱신 재검토(2026-07-16): mint 네트워크 호출 도중 revoke가 커밋되면 cookie
    반환 직전 세 번째 재확인이 잡아야 한다 — fake mint 내부에서 별도 세션으로 revoke."""
    from app.routers.auth_firebase_internal import FirebaseSessionMintRequest, mint_firebase_session
    import app.routers.auth_firebase_internal as router_mod
    from app.services import firebase_verifier as fv
    from app.services.auth_cutover import revoke_user_sessions

    _setup_common(monkeypatch)
    key_pem, cert_pem = _make_self_signed_cert()

    async def fake_id_fetch():
        return {KID: cert_pem}
    monkeypatch.setattr(fv, "_fetch_id_token_public_keys", fake_id_fetch)

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        async def fake_mint_with_interleaved_revoke(id_token, project_id, valid_duration_seconds):
            async with Session() as revoke_session:
                await revoke_user_sessions(revoke_session, seeded["user_id"], firebase_uid=None)
            return "cookie-minted-during-race-must-never-be-returned"
        monkeypatch.setattr(router_mod, "mint_session_cookie", fake_mint_with_interleaved_revoke)

        token = _make_id_token(key_pem, seeded["firebase_uid"])
        async with Session() as s:
            with pytest.raises(HTTPException) as exc_info:
                await mint_firebase_session(
                    FirebaseSessionMintRequest(id_token=token), authorization=None, db=s
                )
            assert exc_info.value.status_code == 401
            assert "cookie-minted-during-race" not in str(exc_info.value.detail)
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_mint_failure_returns_502(monkeypatch):
    from app.routers.auth_firebase_internal import FirebaseSessionMintRequest, mint_firebase_session
    import app.routers.auth_firebase_internal as router_mod
    from app.services import firebase_verifier as fv

    _setup_common(monkeypatch)
    key_pem, cert_pem = _make_self_signed_cert()

    async def fake_id_fetch():
        return {KID: cert_pem}
    monkeypatch.setattr(fv, "_fetch_id_token_public_keys", fake_id_fetch)

    async def fake_mint(id_token, project_id, valid_duration_seconds):
        return None
    monkeypatch.setattr(router_mod, "mint_session_cookie", fake_mint)

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        token = _make_id_token(key_pem, seeded["firebase_uid"])
        async with Session() as s:
            with pytest.raises(HTTPException) as exc_info:
                await mint_firebase_session(
                    FirebaseSessionMintRequest(id_token=token), authorization=None, db=s
                )
            assert exc_info.value.status_code == 502
    finally:
        await engine.dispose()
