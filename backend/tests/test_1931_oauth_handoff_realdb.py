"""story 1931(계약 doc `e-mobile-oauth-native-handoff-contract` §4/§7.5(b)·산티아고 §10 MUST
2026-07-16 조건부 GREEN): 경량 OAuth-handoff issue/consume — attested native-bootstrap
(§7.5, C4)과 물리적으로 분리된 PKCE 기반 단회코드 발급/소비. issue는 Firebase ID token
검증+identity/migration eligibility(mint_firebase_session과 동형 게이트), consume은
code_verifier→code_challenge 재계산 원자 검증+세션쿠키 mint(native consume과 동형 TOCTOU
재검증)를 실증한다.

§10.6 필수 음성 테스트 7종 중 이 파일이 커버하는 것: 1(Firebase/install assertion류 필드
주입 거부)·3(잘못된 verifier 거부)·4(동시 소비 정확히 1회)·7(purpose/user ID 위조 필드
schema 거부, 무시 아님) — 2(구 attested consume이 신규 코드를 소비 못 함)는 물리적 테이블
분리 자체가 증명(별도 테스트로 명시)."""
from __future__ import annotations

import asyncio
import os
import secrets
import uuid
from datetime import datetime, timezone

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

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


# ─── §10.6 음성 테스트 — schema-level 거부(extra="forbid") ─────────────────────

def test_consume_schema_rejects_unknown_fields():
    """§10.6 voice test 7: purpose/user·install ID 등 위조 필드는 조용히 무시되면 안 되고
    스키마 자체가 거부해야 한다."""
    from app.routers.auth_firebase_internal import OAuthHandoffConsumeRequest

    with pytest.raises(ValidationError):
        OAuthHandoffConsumeRequest(code="c", code_verifier="v", existing_session_user_id="attacker-uid")


def test_consume_schema_rejects_attestation_shaped_fields():
    """§10.6 voice test 1: Firebase/install assertion류 필드(installation_id/assertion_b64/
    signature_b64/challenge_id)를 이 스키마에 주입하면 거부돼야 한다 — attested 흐름과 섞일
    여지 자체를 스키마 레벨에서 차단."""
    from app.routers.auth_firebase_internal import OAuthHandoffConsumeRequest

    for bad_field in ("installation_id", "assertion_b64", "signature_b64", "challenge_id", "key_version"):
        with pytest.raises(ValidationError):
            OAuthHandoffConsumeRequest(code="c", code_verifier="v", **{bad_field: "x"})


def test_issue_schema_rejects_unknown_fields():
    from app.routers.auth_firebase_internal import OAuthHandoffIssueRequest

    with pytest.raises(ValidationError):
        OAuthHandoffIssueRequest(id_token="t", code_challenge="c" * 43, installation_id="x")


# ─── §10.6 voice test 2 — 물리적 테이블 분리(구 attested consume이 신규 코드 소비 불가) ──

@pytest.mark.anyio
async def test_oauth_handoff_code_not_consumable_via_attested_native_consume(monkeypatch):
    """§10.6 voice test 2: native-handoff 코드로 #14 attested consume을 태우면 거부돼야
    한다 — oauth_handoff_codes와 auth_native_bootstrap_codes는 물리적으로 다른 테이블이라
    거기서 조회 자체가 안 되고(0 rows), attested 스키마가 요구하는 installation_id/
    challenge_id도 애초에 없어 값 자체를 구성할 수 없다(구성 시도만으로도 무의미함을 실증)."""
    from app.routers.auth_firebase_internal import (
        NativeBootstrapConsumeRequest, OAuthHandoffIssueRequest, consume_native_bootstrap, issue_oauth_handoff,
    )

    from app.core.config import settings

    _setup_common(monkeypatch)
    monkeypatch.setattr(settings, "firebase_auth_mobile_issue", True)  # attested consume 501-off 게이트 우회
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

        # oauth-handoff 코드에는 대응하는 installation/challenge가 애초에 존재하지 않는다 —
        # 임의(존재하지 않는) installation_id/challenge_id로 시도해도 attested 테이블에서
        # 코드 자체가 조회조차 안 된다(별도 테이블).
        async with Session() as s:
            with pytest.raises(HTTPException) as exc_info:
                await consume_native_bootstrap(
                    NativeBootstrapConsumeRequest(
                        code=issued.code, installation_id=str(uuid.uuid4()),
                        challenge_id=str(uuid.uuid4()), client_data_b64url="x", key_version=1,
                        assertion_b64="eA==",
                    ),
                    authorization=None, db=s,
                )
            assert exc_info.value.status_code in (401, 400)
    finally:
        await engine.dispose()
