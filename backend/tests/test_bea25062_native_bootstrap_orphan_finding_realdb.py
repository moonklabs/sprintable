"""story bea25062 게이트 — 산티아고 #2202 3차 재검토 orphan finding 직접 종결 증거:
firebase/provisioning 상태 code 발급 → user-wide revoke → 45초 내(코드 미만료) 소비 →
custom-token 새 세션 재생성 race가 실제로 차단되는지 실 DB로 실증.
"""
from __future__ import annotations

import os
import uuid

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


async def _seed_eligible_user_and_code(session):
    from app.core.security import hash_password
    from app.models.auth_identity import AuthIdentity, AuthMigration
    from app.models.user import User
    from app.services.native_bootstrap import issue_bootstrap_code

    user_id = uuid.uuid4()
    firebase_uid = f"fb-uid-{user_id.hex[:8]}"
    session.add(User(
        id=user_id, email=f"orphan-{user_id.hex[:8]}@test.com",
        hashed_password=hash_password("x"), is_active=True, email_verified=True,
    ))
    await session.commit()
    session.add(AuthMigration(user_id=user_id, state="firebase"))
    session.add(AuthIdentity(
        id=uuid.uuid4(), user_id=user_id,
        issuer=f"https://securetoken.google.com/{PROJECT_ID}", subject=firebase_uid,
        provider_id="password",
    ))
    await session.commit()

    raw_code = await issue_bootstrap_code(
        session, user_id=user_id, firebase_uid=firebase_uid, project_id=PROJECT_ID,
    )
    return raw_code, user_id


def _setup_common(monkeypatch):
    from app.core.config import settings
    monkeypatch.setattr(settings, "firebase_auth_mobile_issue", True)
    monkeypatch.setattr(settings, "firebase_project_id", PROJECT_ID)
    monkeypatch.setattr(settings, "firebase_bff_internal_secret", "")


@pytest.mark.anyio
async def test_orphan_finding_closed_revoke_after_issue_before_consume_rejects(monkeypatch):
    """핵심 회귀 가드: 코드 발급→revoke→(코드는 아직 미만료)소비 순서에서 세션 발급 거부."""
    import app.routers.auth_firebase_internal as router_mod
    from app.routers.auth_firebase_internal import NativeBootstrapConsumeRequest, consume_native_bootstrap
    from app.services.auth_cutover import revoke_user_sessions

    _setup_common(monkeypatch)

    async def fake_mint_for_uid(firebase_uid, project_id, web_api_key, valid_duration_seconds):
        return "should-never-be-returned"
    monkeypatch.setattr(router_mod, "mint_session_cookie_for_uid", fake_mint_for_uid)

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            raw_code, user_id = await _seed_eligible_user_and_code(s)

        # 코드 발급 "이후" 보안 이벤트로 revoke 발생(원본 finding: 이게 custom-token 재생성을 못 막던 갭).
        async with Session() as s:
            await revoke_user_sessions(s, user_id, firebase_uid=None)

        # 코드는 아직 TTL(45초) 내라 atomic consume 자체는 성공하지만, cutover 재검증에서 거부돼야 함.
        async with Session() as s:
            with pytest.raises(HTTPException) as exc_info:
                await consume_native_bootstrap(
                    NativeBootstrapConsumeRequest(code=raw_code), authorization=None, db=s
                )
            assert exc_info.value.status_code == 401
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_no_revoke_between_issue_and_consume_still_succeeds(monkeypatch):
    """회귀 가드 반대편 — revoke가 없으면(정상 케이스) 여전히 성공해야 한다."""
    import app.routers.auth_firebase_internal as router_mod
    from app.routers.auth_firebase_internal import NativeBootstrapConsumeRequest, consume_native_bootstrap

    _setup_common(monkeypatch)

    async def fake_mint_for_uid(firebase_uid, project_id, web_api_key, valid_duration_seconds):
        return "minted-cookie"
    monkeypatch.setattr(router_mod, "mint_session_cookie_for_uid", fake_mint_for_uid)

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            raw_code, _user_id = await _seed_eligible_user_and_code(s)

        async with Session() as s:
            result = await consume_native_bootstrap(
                NativeBootstrapConsumeRequest(code=raw_code), authorization=None, db=s
            )
        assert result.session_cookie == "minted-cookie"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_revoke_before_issue_does_not_block_new_code(monkeypatch):
    """§17d-1: revoke는 그 시점 이전 자격증명만 무효화한다 — revoke *이후*에 새로 발급된
    코드(=revoke 이후의 새 로그인/부트스트랩 흐름)까지 막으면 안 된다."""
    import app.routers.auth_firebase_internal as router_mod
    from app.routers.auth_firebase_internal import NativeBootstrapConsumeRequest, consume_native_bootstrap
    from app.services.auth_cutover import revoke_user_sessions
    from app.services.native_bootstrap import issue_bootstrap_code
    from app.core.security import hash_password
    from app.models.auth_identity import AuthIdentity, AuthMigration
    from app.models.user import User

    _setup_common(monkeypatch)

    async def fake_mint_for_uid(firebase_uid, project_id, web_api_key, valid_duration_seconds):
        return "minted-cookie-after-revoke"
    monkeypatch.setattr(router_mod, "mint_session_cookie_for_uid", fake_mint_for_uid)

    engine, Session = await _session_factory()
    try:
        user_id = uuid.uuid4()
        firebase_uid = f"fb-uid-{user_id.hex[:8]}"
        async with Session() as s:
            s.add(User(
                id=user_id, email=f"orphan-postrevoke-{user_id.hex[:8]}@test.com",
                hashed_password=hash_password("x"), is_active=True, email_verified=True,
            ))
            await s.commit()
            s.add(AuthMigration(user_id=user_id, state="firebase"))
            s.add(AuthIdentity(
                id=uuid.uuid4(), user_id=user_id,
                issuer=f"https://securetoken.google.com/{PROJECT_ID}", subject=firebase_uid,
                provider_id="password",
            ))
            await s.commit()

        async with Session() as s:
            await revoke_user_sessions(s, user_id, firebase_uid=None)

        # revoke *이후*에 새 코드 발급(새 로그인 흐름을 대표).
        async with Session() as s:
            raw_code = await issue_bootstrap_code(
                s, user_id=user_id, firebase_uid=firebase_uid, project_id=PROJECT_ID,
            )

        async with Session() as s:
            result = await consume_native_bootstrap(
                NativeBootstrapConsumeRequest(code=raw_code), authorization=None, db=s
            )
        assert result.session_cookie == "minted-cookie-after-revoke"
    finally:
        await engine.dispose()
