"""story 1931(계약 doc `e-mobile-oauth-native-handoff-contract` §4/§7.5(b)): 경량 OAuth-handoff
issue/consume — attested native-bootstrap(§7.5, C4)과 물리적으로 분리된 PKCE 기반 단회코드
발급/소비. issue는 Firebase ID token 검증+identity/migration eligibility(mint_firebase_
session과 동형 게이트), consume은 code_verifier→code_challenge 재계산 원자 검증+세션쿠키
mint(native consume과 동형 TOCTOU 재검증)를 실증한다."""
from __future__ import annotations

import asyncio
import os
import secrets
import uuid
from datetime import datetime, timezone

import pytest
from fastapi import HTTPException

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


def _setup_common(monkeypatch):
    from app.core.config import settings
    monkeypatch.setattr(settings, "firebase_oauth_handoff_enabled", True)
    monkeypatch.setattr(settings, "firebase_project_id", PROJECT_ID)
    monkeypatch.setattr(settings, "firebase_bff_internal_secret", "")
    monkeypatch.setattr(settings, "app_env", "development")


async def _seed_eligible_user(session):
    from app.core.security import hash_password
    from app.models.auth_identity import AuthIdentity, AuthMigration
    from app.models.user import User

    user_id = uuid.uuid4()
    firebase_uid = f"fb-uid-{user_id.hex[:8]}"
    session.add(User(
        id=user_id, email=f"oauth-handoff-{user_id.hex[:8]}@test.com",
        hashed_password=hash_password("x"), is_active=True, email_verified=True,
    ))
    await session.commit()
    session.add(AuthMigration(user_id=user_id, state="firebase"))
    session.add(AuthIdentity(
        id=uuid.uuid4(), user_id=user_id,
        issuer=f"https://securetoken.google.com/{PROJECT_ID}", subject=firebase_uid, provider_id="google.com",
    ))
    await session.commit()
    return user_id, firebase_uid


def _mock_verify_id_token(monkeypatch, *, firebase_uid: str, auth_time: int | None = None):
    import app.routers.auth_firebase_internal as internal_mod
    from app.services.firebase_verifier import VerifiedFirebaseIdToken

    if auth_time is None:
        auth_time = int(datetime.now(timezone.utc).timestamp())

    async def fake_verify(id_token, project_id):
        if id_token != "valid-id-token":
            return None
        return VerifiedFirebaseIdToken(
            issuer=f"https://securetoken.google.com/{PROJECT_ID}", firebase_uid=firebase_uid,
            email=None, auth_time=auth_time,
        )
    monkeypatch.setattr(internal_mod, "verify_firebase_id_token", fake_verify)


def _pkce_pair():
    from app.services.oauth_handoff import pkce_challenge_from_verifier
    verifier = secrets.token_urlsafe(32)
    return verifier, pkce_challenge_from_verifier(verifier)


@pytest.mark.anyio
async def test_issue_and_consume_round_trip_success(monkeypatch):
    from app.routers.auth_firebase_internal import (
        OAuthHandoffConsumeRequest, OAuthHandoffIssueRequest, consume_oauth_handoff, issue_oauth_handoff,
    )

    _setup_common(monkeypatch)
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            user_id, firebase_uid = await _seed_eligible_user(s)
        _mock_verify_id_token(monkeypatch, firebase_uid=firebase_uid)

        verifier, challenge = _pkce_pair()
        async with Session() as s:
            issued = await issue_oauth_handoff(
                OAuthHandoffIssueRequest(id_token="valid-id-token", code_challenge=challenge),
                authorization=None, db=s,
            )
        assert issued.code

        async def fake_mint(firebase_uid, project_id, web_api_key, valid_duration_seconds):
            return "minted-cookie"
        import app.routers.auth_firebase_internal as internal_mod
        monkeypatch.setattr(internal_mod, "mint_session_cookie_for_uid", fake_mint)

        async with Session() as s:
            consumed = await consume_oauth_handoff(
                OAuthHandoffConsumeRequest(code=issued.code, code_verifier=verifier), authorization=None, db=s,
            )
        assert consumed.session_cookie == "minted-cookie"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_consume_wrong_verifier_rejected(monkeypatch):
    from app.routers.auth_firebase_internal import (
        OAuthHandoffConsumeRequest, OAuthHandoffIssueRequest, consume_oauth_handoff, issue_oauth_handoff,
    )

    _setup_common(monkeypatch)
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            user_id, firebase_uid = await _seed_eligible_user(s)
        _mock_verify_id_token(monkeypatch, firebase_uid=firebase_uid)

        _verifier, challenge = _pkce_pair()
        async with Session() as s:
            issued = await issue_oauth_handoff(
                OAuthHandoffIssueRequest(id_token="valid-id-token", code_challenge=challenge),
                authorization=None, db=s,
            )

        wrong_verifier, _ = _pkce_pair()
        async with Session() as s:
            with pytest.raises(HTTPException) as exc_info:
                await consume_oauth_handoff(
                    OAuthHandoffConsumeRequest(code=issued.code, code_verifier=wrong_verifier),
                    authorization=None, db=s,
                )
            assert exc_info.value.status_code == 401
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_consume_replay_after_success_rejected(monkeypatch):
    from app.routers.auth_firebase_internal import (
        OAuthHandoffConsumeRequest, OAuthHandoffIssueRequest, consume_oauth_handoff, issue_oauth_handoff,
    )
    import app.routers.auth_firebase_internal as internal_mod

    _setup_common(monkeypatch)
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            user_id, firebase_uid = await _seed_eligible_user(s)
        _mock_verify_id_token(monkeypatch, firebase_uid=firebase_uid)

        verifier, challenge = _pkce_pair()
        async with Session() as s:
            issued = await issue_oauth_handoff(
                OAuthHandoffIssueRequest(id_token="valid-id-token", code_challenge=challenge),
                authorization=None, db=s,
            )

        async def fake_mint(*a, **kw):
            return "minted-cookie"
        monkeypatch.setattr(internal_mod, "mint_session_cookie_for_uid", fake_mint)

        req = OAuthHandoffConsumeRequest(code=issued.code, code_verifier=verifier)
        async with Session() as s:
            first = await consume_oauth_handoff(req, authorization=None, db=s)
        assert first.session_cookie == "minted-cookie"

        async with Session() as s:
            with pytest.raises(HTTPException) as exc_info:
                await consume_oauth_handoff(req, authorization=None, db=s)
            assert exc_info.value.status_code == 401
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_concurrent_consume_exactly_one_succeeds(monkeypatch):
    """산티아고 §9 native consume 게이트와 동형 요구 — 병렬 N-way 동시성에도 정확히 1회만 mint."""
    from app.routers.auth_firebase_internal import (
        OAuthHandoffConsumeRequest, OAuthHandoffIssueRequest, consume_oauth_handoff, issue_oauth_handoff,
    )
    import app.routers.auth_firebase_internal as internal_mod

    _setup_common(monkeypatch)
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            user_id, firebase_uid = await _seed_eligible_user(s)
        _mock_verify_id_token(monkeypatch, firebase_uid=firebase_uid)

        verifier, challenge = _pkce_pair()
        async with Session() as s:
            issued = await issue_oauth_handoff(
                OAuthHandoffIssueRequest(id_token="valid-id-token", code_challenge=challenge),
                authorization=None, db=s,
            )

        mint_call_count = {"n": 0}

        async def fake_mint(*a, **kw):
            mint_call_count["n"] += 1
            return "minted-cookie"
        monkeypatch.setattr(internal_mod, "mint_session_cookie_for_uid", fake_mint)

        req = OAuthHandoffConsumeRequest(code=issued.code, code_verifier=verifier)

        async def _attempt():
            async with Session() as s:
                try:
                    return await consume_oauth_handoff(req, authorization=None, db=s)
                except HTTPException:
                    return None

        results = await asyncio.gather(*[_attempt() for _ in range(5)])
        successes = [r for r in results if r is not None]
        assert len(successes) == 1
        assert mint_call_count["n"] == 1
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_issue_rejected_when_feature_disabled(monkeypatch):
    from app.routers.auth_firebase_internal import OAuthHandoffIssueRequest, issue_oauth_handoff
    from app.core.config import settings

    _setup_common(monkeypatch)
    monkeypatch.setattr(settings, "firebase_oauth_handoff_enabled", False)
    engine, Session = await _session_factory()
    try:
        _verifier, challenge = _pkce_pair()
        async with Session() as s:
            with pytest.raises(HTTPException) as exc_info:
                await issue_oauth_handoff(
                    OAuthHandoffIssueRequest(id_token="valid-id-token", code_challenge=challenge),
                    authorization=None, db=s,
                )
            assert exc_info.value.status_code == 501
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_issue_rejected_unmapped_identity(monkeypatch):
    from app.routers.auth_firebase_internal import OAuthHandoffIssueRequest, issue_oauth_handoff

    _setup_common(monkeypatch)
    _mock_verify_id_token(monkeypatch, firebase_uid="fb-uid-never-registered")
    engine, Session = await _session_factory()
    try:
        _verifier, challenge = _pkce_pair()
        async with Session() as s:
            with pytest.raises(HTTPException) as exc_info:
                await issue_oauth_handoff(
                    OAuthHandoffIssueRequest(id_token="valid-id-token", code_challenge=challenge),
                    authorization=None, db=s,
                )
            assert exc_info.value.status_code == 401
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_issue_rejected_short_code_challenge(monkeypatch):
    from app.routers.auth_firebase_internal import OAuthHandoffIssueRequest, issue_oauth_handoff

    _setup_common(monkeypatch)
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            _user_id, firebase_uid = await _seed_eligible_user(s)
        _mock_verify_id_token(monkeypatch, firebase_uid=firebase_uid)

        async with Session() as s:
            with pytest.raises(HTTPException) as exc_info:
                await issue_oauth_handoff(
                    OAuthHandoffIssueRequest(id_token="valid-id-token", code_challenge="too-short"),
                    authorization=None, db=s,
                )
            assert exc_info.value.status_code == 400
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_orphan_finding_revoke_between_issue_and_consume_rejected(monkeypatch):
    """Story A(bea25062)/C4 orphan-finding 회귀와 동형 — issue 이후(45초 내 미만료) revoke가
    발생하면 consume이 cutover 재검증에서 거부돼야 한다."""
    from app.routers.auth_firebase_internal import (
        OAuthHandoffConsumeRequest, OAuthHandoffIssueRequest, consume_oauth_handoff, issue_oauth_handoff,
    )
    import app.routers.auth_firebase_internal as internal_mod
    from app.services.auth_cutover import revoke_user_sessions

    _setup_common(monkeypatch)
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            user_id, firebase_uid = await _seed_eligible_user(s)
        _mock_verify_id_token(monkeypatch, firebase_uid=firebase_uid)

        verifier, challenge = _pkce_pair()
        async with Session() as s:
            issued = await issue_oauth_handoff(
                OAuthHandoffIssueRequest(id_token="valid-id-token", code_challenge=challenge),
                authorization=None, db=s,
            )

        async with Session() as s:
            await revoke_user_sessions(s, user_id, firebase_uid=None)

        async def fake_mint(*a, **kw):
            return "should-never-be-returned"
        monkeypatch.setattr(internal_mod, "mint_session_cookie_for_uid", fake_mint)

        async with Session() as s:
            with pytest.raises(HTTPException) as exc_info:
                await consume_oauth_handoff(
                    OAuthHandoffConsumeRequest(code=issued.code, code_verifier=verifier),
                    authorization=None, db=s,
                )
            assert exc_info.value.status_code == 401
    finally:
        await engine.dispose()
