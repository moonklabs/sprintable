"""story bea25062 게이트 — 산티아고 #2202 3차 재검토 orphan finding 직접 종결 증거:
firebase/provisioning 상태 code 발급 → user-wide revoke → 45초 내(코드 미만료) 소비 →
custom-token 새 세션 재생성 race가 실제로 차단되는지 실 DB로 실증.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

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


async def _seed_eligible_user_and_code(session, *, auth_time=None):
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

    # story bea25062 BLOCKER 2: auth_time을 명시하지 않으면 이 헬퍼가 "방금 정상 로그인"을
    # 대표하도록 기본값 now()를 쓴다 — None으로 두면 consume 시 fail-closed(missing_auth_time)
    # 되어 대부분의 정상 케이스 테스트가 공허해진다.
    if auth_time is None:
        auth_time = datetime.now(timezone.utc)

    raw_code = await issue_bootstrap_code(
        session, user_id=user_id, firebase_uid=firebase_uid, project_id=PROJECT_ID, auth_time=auth_time,
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

        # revoke *이후*에 새 코드 발급(새 로그인 흐름을 대표) — ⚠️§17d-1 BLOCKER 2 시정
        # (산티아고 2026-07-16): 이전 버전의 이 테스트는 auth_time을 아예 안 실어(issue_
        # bootstrap_code() 직접 호출) "새 코드 생성"과 "새 로그인"을 잘못 동일시하는 공허
        # 테스트였다 — 실제로 대표해야 할 건 "revoke *이후*에 실제로 재인증한" 새 Firebase
        # 로그인이므로, auth_time을 revoke epoch 이후 시각으로 명시해야 이 테스트가 실제로
        # 검증하는 바(post-cutover 재인증은 여전히 허용)를 정확히 대표한다.
        async with Session() as s:
            raw_code = await issue_bootstrap_code(
                s, user_id=user_id, firebase_uid=firebase_uid, project_id=PROJECT_ID,
                auth_time=datetime.now(timezone.utc),
            )

        async with Session() as s:
            result = await consume_native_bootstrap(
                NativeBootstrapConsumeRequest(code=raw_code), authorization=None, db=s
            )
        assert result.session_cookie == "minted-cookie-after-revoke"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_old_auth_time_reused_after_revoke_still_rejected(monkeypatch):
    """산티아고 RED 포워딩 BLOCKER 2 정확한 공격 재현: pre-cutover ID token(auth_time=T0)으로
    revoke(auth_valid_after=T1>T0) *이후*에 새 bootstrap 코드를 발급받아도(created_at=T2>T1)
    저장된 원본 auth_time(T0)이 여전히 cutover 이전이라 consume이 거부해야 한다 — created_at
    만 보던 낡은 계약에서는 이게 통과했다(원 orphan finding의 정확한 우회 경로)."""
    import app.routers.auth_firebase_internal as router_mod
    from app.routers.auth_firebase_internal import NativeBootstrapConsumeRequest, consume_native_bootstrap
    from app.services.auth_cutover import revoke_user_sessions
    from app.services.native_bootstrap import issue_bootstrap_code

    _setup_common(monkeypatch)

    async def fake_mint_for_uid(firebase_uid, project_id, web_api_key, valid_duration_seconds):
        return "should-never-be-returned"
    monkeypatch.setattr(router_mod, "mint_session_cookie_for_uid", fake_mint_for_uid)

    engine, Session = await _session_factory()
    try:
        old_auth_time = datetime.now(timezone.utc) - timedelta(minutes=4)  # T0: 아직 5분 freshness 내
        async with Session() as s:
            _raw_code_unused, user_id = await _seed_eligible_user_and_code(s, auth_time=old_auth_time)

        # revoke(T1 > T0) — old ID token은 이미 cutover 대상.
        async with Session() as s:
            await revoke_user_sessions(s, user_id, firebase_uid=None)

        # revoke *이후* 같은 old ID token(auth_time=T0, 아직 5분 freshness 내)으로 새 코드
        # 발급(created_at=T2 > T1) — 이게 BLOCKER 2의 정확한 공격.
        async with Session() as s:
            from app.models.auth_identity import AuthIdentity
            from sqlalchemy import select
            identity = (await s.execute(
                select(AuthIdentity).where(AuthIdentity.user_id == user_id)
            )).scalar_one()
            raw_code = await issue_bootstrap_code(
                s, user_id=user_id, firebase_uid=identity.subject, project_id=PROJECT_ID,
                auth_time=old_auth_time,
            )

        async with Session() as s:
            with pytest.raises(HTTPException) as exc_info:
                await consume_native_bootstrap(
                    NativeBootstrapConsumeRequest(code=raw_code), authorization=None, db=s
                )
            assert exc_info.value.status_code == 401
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_consume_mint_interleaved_revoke_rejected(monkeypatch):
    """산티아고 RED 조건 ⑤: consume의 첫 cutover 판정과 실제 mint 호출 사이에 revoke가
    끼어들면(TOCTOU) mint 직전 강제 재조회(`populate_existing=True`)가 이를 잡아야 한다."""
    import app.routers.auth_firebase_internal as router_mod
    from app.routers.auth_firebase_internal import NativeBootstrapConsumeRequest, consume_native_bootstrap
    from app.services.auth_cutover import revoke_user_sessions
    from app.models.auth_identity import AuthMigration

    _setup_common(monkeypatch)

    mint_called = {"value": False}

    async def fake_mint_for_uid(firebase_uid, project_id, web_api_key, valid_duration_seconds):
        mint_called["value"] = True
        return "should-never-be-returned"
    monkeypatch.setattr(router_mod, "mint_session_cookie_for_uid", fake_mint_for_uid)

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            raw_code, user_id = await _seed_eligible_user_and_code(s)

        async with Session() as s:
            original_get = s.get
            call_count = {"n": 0}

            async def get_with_interleaved_revoke(model, pk, *a, **kw):
                result = await original_get(model, pk, *a, **kw)
                if model is AuthMigration:
                    call_count["n"] += 1
                    if call_count["n"] == 1:
                        # 첫 조회(정상 eligibility 판정)는 이 결과(아직 pre-revoke)를 그대로
                        # 쓰게 두고, 반환 "직후" 별도 세션으로 revoke를 커밋 — 실제 세계에서
                        # 이 두 조회 사이의 짧은 창(consume 판정→mint 호출)에 revoke가 도착한
                        # 상황을 흉내낸다.
                        async with Session() as revoke_session:
                            await revoke_user_sessions(revoke_session, user_id, firebase_uid=None)
                return result

            s.get = get_with_interleaved_revoke

            with pytest.raises(HTTPException) as exc_info:
                await consume_native_bootstrap(
                    NativeBootstrapConsumeRequest(code=raw_code), authorization=None, db=s
                )
            assert exc_info.value.status_code == 401
        assert mint_called["value"] is False
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_revoke_during_mint_network_roundtrip_rejects_and_discards_cookie(monkeypatch):
    """산티아고 #2206 갱신 재검토(2026-07-16) 정확한 지적: mint 직전 재확인만으론 Firebase
    네트워크 왕복(custom-token 발급→signInWithCustomToken→createSessionCookie) '도중'의
    revoke를 못 잡는다(probe: revoke_during_mint_cookie_returned=True). 여기선 fake mint
    함수 **내부**(=mint 네트워크 호출이 실제로 진행 중인 시점을 대표)에서 별도 DB session으로
    revoke를 커밋한 뒤 cookie를 반환하게 해 그 정확한 타이밍을 재현 — cookie 반환 직전 세
    번째 authoritative 재조회가 이를 잡아 최종 401이어야 하고, 절대 그 cookie 값이
    호출부까지 반환되면 안 된다."""
    import app.routers.auth_firebase_internal as router_mod
    from app.routers.auth_firebase_internal import NativeBootstrapConsumeRequest, consume_native_bootstrap
    from app.services.auth_cutover import revoke_user_sessions

    _setup_common(monkeypatch)

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            raw_code, user_id = await _seed_eligible_user_and_code(s)

        async def fake_mint_for_uid_with_interleaved_revoke(firebase_uid, project_id, web_api_key, valid_duration_seconds):
            # mint 네트워크 호출이 "진행 중"인 시점에 별도 트랜잭션으로 revoke가 커밋되는
            # 상황을 정확히 대표 — mint 직전 재확인(2번째 조회)은 이미 통과한 뒤다.
            async with Session() as revoke_session:
                await revoke_user_sessions(revoke_session, user_id, firebase_uid=None)
            return "cookie-minted-during-race-must-never-be-returned"

        monkeypatch.setattr(router_mod, "mint_session_cookie_for_uid", fake_mint_for_uid_with_interleaved_revoke)

        async with Session() as s:
            with pytest.raises(HTTPException) as exc_info:
                await consume_native_bootstrap(
                    NativeBootstrapConsumeRequest(code=raw_code), authorization=None, db=s
                )
            assert exc_info.value.status_code == 401
            # cookie 값이 예외 detail 등 어디에도 새어나가지 않았는지 확인.
            assert "cookie-minted-during-race" not in str(exc_info.value.detail)
    finally:
        await engine.dispose()
