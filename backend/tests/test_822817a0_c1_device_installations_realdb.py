"""story 822817a0(E-AUTH-REBUILD 활성화게이트][C1]·doc e-mobile-per-install-proof-feasibility
§7.1/§7.2·산티아고 §7 SSOT 2026-07-16) 게이트: 스키마+canonical transcript+챌린지 발급
2종(registration-challenges·native-bootstrap/challenges) 실증. 플랫폼 attestation 검증
(C2/C3)·register/consume 본체(C4)는 이 스토리 스코프 밖 — 여기선 발급 인프라만.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException, Response

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
]

PROJECT_ID = "test-project"


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_after():
    yield
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


class _FakeRequest:
    base_url = "http://testserver/"


def _setup_common(monkeypatch):
    from app.core.config import settings
    monkeypatch.setattr(settings, "firebase_auth_mobile_issue", True)
    monkeypatch.setattr(settings, "firebase_project_id", PROJECT_ID)
    monkeypatch.setattr(settings, "firebase_project_number", "123456")
    monkeypatch.setattr(settings, "firebase_app_check_allowed_app_ids", "1:123456:ios:approved")


def _mock_verifiers(monkeypatch, *, firebase_uid: str, auth_time: int | None = None):
    from app.services.firebase_verifier import VerifiedAppCheck, VerifiedFirebaseIdToken
    import app.services.native_request_auth as nra_mod

    if auth_time is None:
        auth_time = int(datetime.now(timezone.utc).timestamp())

    async def fake_verify_id_token(token, project_id):
        if token != "valid-id-token":
            return None
        return VerifiedFirebaseIdToken(
            issuer=f"https://securetoken.google.com/{PROJECT_ID}",
            firebase_uid=firebase_uid, email="u@test.com", auth_time=auth_time,
        )

    async def fake_verify_app_check(token, project_number, allowed_app_ids):
        if token != "valid-app-check":
            return None
        return VerifiedAppCheck(issuer="https://firebaseappcheck.googleapis.com/123456", app_id="1:123456:ios:approved")

    monkeypatch.setattr(nra_mod, "verify_firebase_id_token", fake_verify_id_token)
    monkeypatch.setattr(nra_mod, "verify_app_check_token", fake_verify_app_check)


async def _seed_eligible_user(session, *, state="firebase"):
    from app.core.security import hash_password
    from app.models.auth_identity import AuthIdentity, AuthMigration
    from app.models.user import User

    user_id = uuid.uuid4()
    firebase_uid = f"fb-uid-{user_id.hex[:8]}"
    session.add(User(
        id=user_id, email=f"c1-{user_id.hex[:8]}@test.com",
        hashed_password=hash_password("x"), is_active=True, email_verified=True,
    ))
    await session.commit()
    session.add(AuthMigration(user_id=user_id, state=state))
    session.add(AuthIdentity(
        id=uuid.uuid4(), user_id=user_id,
        issuer=f"https://securetoken.google.com/{PROJECT_ID}", subject=firebase_uid,
        provider_id="password",
    ))
    await session.commit()
    return user_id, firebase_uid


async def _seed_installation(session, *, user_id, status="active", environment="production", platform="ios", app_id="com.sprintable.app"):
    from app.models.device_installation import DeviceInstallation

    installation = DeviceInstallation(
        id=uuid.uuid4(), user_id=user_id, firebase_uid=f"fb-uid-{user_id.hex[:8]}",
        project_id=PROJECT_ID, environment=environment, platform=platform, app_id=app_id,
        key_version=1, public_key_fingerprint=f"fp-{uuid.uuid4().hex[:12]}", public_key_der=b"\x00\x01\x02",
        attestation_type="app_attest", status=status, attested_at=datetime.now(timezone.utc),
        created_at=datetime.now(timezone.utc),
    )
    session.add(installation)
    await session.commit()
    return installation.id


# ─── canonical transcript 순수 로직 ─────────────────────────────────────────

def test_canonical_transcript_deterministic():
    from app.services.device_proof import TranscriptContext, build_canonical_transcript

    ctx = TranscriptContext(
        purpose="register", challenge_id="chal-1", raw_nonce="nonce-abc", user_id="user-1",
        firebase_uid="fb-1", project_id=PROJECT_ID, tenant_id=None, environment="production",
        platform="ios", app_id="com.sprintable.app", installation_id=None, key_version=None,
        http_method="POST", route="/api/v2/auth/device-installations/register",
        web_origin="https://sprintable.app", body_sha256=None,
    )
    t1 = build_canonical_transcript(ctx)
    t2 = build_canonical_transcript(ctx)
    assert t1 == t2
    assert b"SP_DEVICE_PROOF_V1" in t1
    assert b"register" in t1


def test_canonical_transcript_redeem_includes_bootstrap_code_hash():
    from app.services.device_proof import TranscriptContext, build_canonical_transcript

    base_kwargs = dict(
        purpose="bootstrap_redeem", challenge_id="chal-2", raw_nonce="nonce-xyz", user_id="user-1",
        firebase_uid="fb-1", project_id=PROJECT_ID, tenant_id=None, environment="production",
        platform="android", app_id="com.sprintable.app", installation_id="inst-1", key_version=1,
        http_method="POST", route="/auth/native", web_origin="https://sprintable.app", body_sha256=None,
    )
    without_code = build_canonical_transcript(TranscriptContext(**base_kwargs))
    with_code = build_canonical_transcript(TranscriptContext(**base_kwargs, bootstrap_code_sha256="a" * 64))
    assert b"bootstrap_code_sha256" not in without_code
    assert b"bootstrap_code_sha256" in with_code


def test_client_data_b64url_roundtrip_decodable():
    import base64
    from app.services.device_proof import TranscriptContext, build_canonical_transcript, client_data_b64url

    ctx = TranscriptContext(
        purpose="register", challenge_id="chal-3", raw_nonce="n", user_id="u", firebase_uid="fb",
        project_id=PROJECT_ID, tenant_id=None, environment="production", platform="ios", app_id="app",
        installation_id=None, key_version=None, http_method="POST", route="/x",
        web_origin="https://sprintable.app", body_sha256=None,
    )
    transcript = build_canonical_transcript(ctx)
    encoded = client_data_b64url(transcript)
    # urlsafe_b64decode requires padding restored
    padded = encoded + "=" * (-len(encoded) % 4)
    assert base64.urlsafe_b64decode(padded) == transcript


# ─── issue_challenge() 서비스 계약 ──────────────────────────────────────────

@pytest.mark.anyio
async def test_issue_challenge_creates_row_matching_ttl():
    from app.services.device_proof import PURPOSE_REGISTER, issue_challenge

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            user_id, firebase_uid = await _seed_eligible_user(s)
        async with Session() as s:
            issued = await issue_challenge(
                s, purpose=PURPOSE_REGISTER, user_id=user_id, firebase_uid=firebase_uid,
                project_id=PROJECT_ID, tenant_id=None, environment="production", platform="ios",
                app_id="com.sprintable.app", http_method="POST", route="/register",
                web_origin="https://sprintable.app", ttl_seconds=120,
            )
        assert issued.challenge_id
        assert issued.client_data_b64url
        delta = (issued.expires_at - datetime.now(timezone.utc)).total_seconds()
        assert 110 < delta <= 120
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_issue_challenge_duplicate_active_raises():
    from app.services.device_proof import ChallengeAlreadyActiveError, PURPOSE_REGISTER, issue_challenge

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            user_id, firebase_uid = await _seed_eligible_user(s)

        kwargs = dict(
            purpose=PURPOSE_REGISTER, user_id=user_id, firebase_uid=firebase_uid, project_id=PROJECT_ID,
            tenant_id=None, environment="production", platform="ios", app_id="com.sprintable.app",
            http_method="POST", route="/register", web_origin="https://sprintable.app", ttl_seconds=120,
        )
        async with Session() as s:
            await issue_challenge(s, **kwargs)
        async with Session() as s:
            with pytest.raises(ChallengeAlreadyActiveError):
                await issue_challenge(s, **kwargs)
    finally:
        await engine.dispose()


# ─── POST /api/v2/auth/device-installations/registration-challenges ────────

@pytest.mark.anyio
async def test_registration_challenge_default_off_501(monkeypatch):
    from app.routers.device_installations import RegistrationChallengeRequest, registration_challenge

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            with pytest.raises(HTTPException) as exc:
                await registration_challenge(
                    _FakeRequest(),
                    RegistrationChallengeRequest(app_check_token="x", platform="ios", app_id="a", environment="production"),
                    Response(), authorization="Bearer valid-id-token", x_firebase_appcheck="valid-app-check", db=s,
                )
            assert exc.value.status_code == 501
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_registration_challenge_missing_bearer_401(monkeypatch):
    from app.routers.device_installations import RegistrationChallengeRequest, registration_challenge

    _setup_common(monkeypatch)
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            with pytest.raises(HTTPException) as exc:
                await registration_challenge(
                    _FakeRequest(),
                    RegistrationChallengeRequest(app_check_token="valid-app-check", platform="ios", app_id="a", environment="production"),
                    Response(), authorization=None, x_firebase_appcheck="valid-app-check", db=s,
                )
            assert exc.value.status_code == 401
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_registration_challenge_missing_app_check_401(monkeypatch):
    from app.routers.device_installations import RegistrationChallengeRequest, registration_challenge

    _setup_common(monkeypatch)
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            user_id, firebase_uid = await _seed_eligible_user(s)
        _mock_verifiers(monkeypatch, firebase_uid=firebase_uid)
        async with Session() as s:
            with pytest.raises(HTTPException) as exc:
                await registration_challenge(
                    _FakeRequest(),
                    RegistrationChallengeRequest(app_check_token=None, platform="ios", app_id="a", environment="production"),
                    Response(), authorization="Bearer valid-id-token", x_firebase_appcheck=None, db=s,
                )
            assert exc.value.status_code == 401
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_registration_challenge_success(monkeypatch):
    from app.routers.device_installations import RegistrationChallengeRequest, registration_challenge

    _setup_common(monkeypatch)
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            user_id, firebase_uid = await _seed_eligible_user(s)
        _mock_verifiers(monkeypatch, firebase_uid=firebase_uid)
        async with Session() as s:
            result = await registration_challenge(
                _FakeRequest(),
                RegistrationChallengeRequest(app_check_token="valid-app-check", platform="ios", app_id="com.sprintable.app", environment="production"),
                Response(), authorization="Bearer valid-id-token", x_firebase_appcheck=None, db=s,
            )
        assert result.challenge_id
        assert result.client_data_b64url
        assert result.expires_in == 120
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_registration_challenge_unsupported_platform_400(monkeypatch):
    from app.routers.device_installations import RegistrationChallengeRequest, registration_challenge

    _setup_common(monkeypatch)
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            with pytest.raises(HTTPException) as exc:
                await registration_challenge(
                    _FakeRequest(),
                    RegistrationChallengeRequest(app_check_token="x", platform="windows", app_id="a", environment="production"),
                    Response(), authorization="Bearer valid-id-token", x_firebase_appcheck="valid-app-check", db=s,
                )
            assert exc.value.status_code == 400
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_registration_challenge_ineligible_migration_state_401(monkeypatch):
    from app.routers.device_installations import RegistrationChallengeRequest, registration_challenge

    _setup_common(monkeypatch)
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            user_id, firebase_uid = await _seed_eligible_user(s, state="reset_required")
        _mock_verifiers(monkeypatch, firebase_uid=firebase_uid)
        async with Session() as s:
            with pytest.raises(HTTPException) as exc:
                await registration_challenge(
                    _FakeRequest(),
                    RegistrationChallengeRequest(app_check_token="valid-app-check", platform="ios", app_id="a", environment="production"),
                    Response(), authorization="Bearer valid-id-token", x_firebase_appcheck=None, db=s,
                )
            assert exc.value.status_code == 401
    finally:
        await engine.dispose()


# ─── POST /api/v2/auth/native-bootstrap/challenges ──────────────────────────

@pytest.mark.anyio
async def test_native_bootstrap_challenge_default_off_501(monkeypatch):
    from app.routers.auth_native_bootstrap import NativeBootstrapChallengeRequest, native_bootstrap_challenge

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            with pytest.raises(HTTPException) as exc:
                await native_bootstrap_challenge(
                    _FakeRequest(),
                    NativeBootstrapChallengeRequest(app_check_token="x", installation_id=str(uuid.uuid4())),
                    Response(), authorization="Bearer valid-id-token", x_firebase_appcheck="valid-app-check", db=s,
                )
            assert exc.value.status_code == 501
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_native_bootstrap_challenge_unknown_installation_401(monkeypatch):
    from app.routers.auth_native_bootstrap import NativeBootstrapChallengeRequest, native_bootstrap_challenge

    _setup_common(monkeypatch)
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            user_id, firebase_uid = await _seed_eligible_user(s)
        _mock_verifiers(monkeypatch, firebase_uid=firebase_uid)
        async with Session() as s:
            with pytest.raises(HTTPException) as exc:
                await native_bootstrap_challenge(
                    _FakeRequest(),
                    NativeBootstrapChallengeRequest(app_check_token="valid-app-check", installation_id=str(uuid.uuid4())),
                    Response(), authorization="Bearer valid-id-token", x_firebase_appcheck=None, db=s,
                )
            assert exc.value.status_code == 401
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_native_bootstrap_challenge_foreign_installation_401(monkeypatch):
    """다른 사용자 소유 installation_id를 대면 401 — IDOR 방지."""
    from app.routers.auth_native_bootstrap import NativeBootstrapChallengeRequest, native_bootstrap_challenge

    _setup_common(monkeypatch)
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            user_id, firebase_uid = await _seed_eligible_user(s)
            other_user_id, _ = await _seed_eligible_user(s)
            other_installation_id = await _seed_installation(s, user_id=other_user_id)
        _mock_verifiers(monkeypatch, firebase_uid=firebase_uid)
        async with Session() as s:
            with pytest.raises(HTTPException) as exc:
                await native_bootstrap_challenge(
                    _FakeRequest(),
                    NativeBootstrapChallengeRequest(app_check_token="valid-app-check", installation_id=str(other_installation_id)),
                    Response(), authorization="Bearer valid-id-token", x_firebase_appcheck=None, db=s,
                )
            assert exc.value.status_code == 401
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_native_bootstrap_challenge_revoked_installation_401(monkeypatch):
    from app.routers.auth_native_bootstrap import NativeBootstrapChallengeRequest, native_bootstrap_challenge

    _setup_common(monkeypatch)
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            user_id, firebase_uid = await _seed_eligible_user(s)
            installation_id = await _seed_installation(s, user_id=user_id, status="revoked")
        _mock_verifiers(monkeypatch, firebase_uid=firebase_uid)
        async with Session() as s:
            with pytest.raises(HTTPException) as exc:
                await native_bootstrap_challenge(
                    _FakeRequest(),
                    NativeBootstrapChallengeRequest(app_check_token="valid-app-check", installation_id=str(installation_id)),
                    Response(), authorization="Bearer valid-id-token", x_firebase_appcheck=None, db=s,
                )
            assert exc.value.status_code == 401
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_native_bootstrap_challenge_success(monkeypatch):
    from app.routers.auth_native_bootstrap import NativeBootstrapChallengeRequest, native_bootstrap_challenge

    _setup_common(monkeypatch)
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            user_id, firebase_uid = await _seed_eligible_user(s)
            installation_id = await _seed_installation(s, user_id=user_id, status="active")
        _mock_verifiers(monkeypatch, firebase_uid=firebase_uid)
        async with Session() as s:
            result = await native_bootstrap_challenge(
                _FakeRequest(),
                NativeBootstrapChallengeRequest(app_check_token="valid-app-check", installation_id=str(installation_id)),
                Response(), authorization="Bearer valid-id-token", x_firebase_appcheck=None, db=s,
            )
        assert result.challenge_id
        assert result.client_data_b64url
        assert result.expires_in == 60
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_native_bootstrap_challenge_duplicate_active_409(monkeypatch):
    from app.routers.auth_native_bootstrap import NativeBootstrapChallengeRequest, native_bootstrap_challenge

    _setup_common(monkeypatch)
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            user_id, firebase_uid = await _seed_eligible_user(s)
            installation_id = await _seed_installation(s, user_id=user_id, status="active")
        _mock_verifiers(monkeypatch, firebase_uid=firebase_uid)
        body = NativeBootstrapChallengeRequest(app_check_token="valid-app-check", installation_id=str(installation_id))
        async with Session() as s:
            await native_bootstrap_challenge(_FakeRequest(), body, Response(), authorization="Bearer valid-id-token", x_firebase_appcheck=None, db=s)
        async with Session() as s:
            with pytest.raises(HTTPException) as exc:
                await native_bootstrap_challenge(_FakeRequest(), body, Response(), authorization="Bearer valid-id-token", x_firebase_appcheck=None, db=s)
            assert exc.value.status_code == 409
    finally:
        await engine.dispose()
