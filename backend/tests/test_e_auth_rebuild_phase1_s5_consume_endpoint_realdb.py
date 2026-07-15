"""story 4dee942b(E-AUTH-REBUILD M2 Phase1-S5) 게이트: POST /api/v2/internal/auth/
native-bootstrap/consume — 서비스-투-서비스 atomic consume+세션쿠키 mint 체인이 실 DB로
정확히 동작하는지 실증. mint_session_cookie_for_uid()의 Google 왕복은 모킹(S5 계약테스트가
그 체인 자체는 이미 검증), 여기선 라우터의 게이팅/consume 위임/응답 형태만 확인.
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


async def _seed_user_and_code(
    session, *, device_binding_hash=None, mapped=True, migration_state="firebase", link_identity_to_other_user=False
):
    from app.core.security import hash_password
    from app.models.auth_identity import AuthIdentity, AuthMigration
    from app.models.user import User
    from app.services.native_bootstrap import issue_bootstrap_code

    user_id = uuid.uuid4()
    firebase_uid = f"fb-uid-{user_id.hex[:8]}"
    session.add(User(
        id=user_id, email=f"authreb-s5-consume-{user_id.hex[:8]}@test.com",
        hashed_password=hash_password("x"), is_active=True, email_verified=True,
    ))
    await session.commit()

    if mapped:
        identity_owner = user_id
        if link_identity_to_other_user:
            other_user_id = uuid.uuid4()
            session.add(User(
                id=other_user_id, email=f"authreb-s5-other-{other_user_id.hex[:8]}@test.com",
                hashed_password=hash_password("x"), is_active=True, email_verified=True,
            ))
            await session.commit()
            identity_owner = other_user_id
        session.add(AuthIdentity(
            id=uuid.uuid4(), user_id=identity_owner,
            issuer=f"https://securetoken.google.com/{PROJECT_ID}", subject=firebase_uid,
            provider_id="password",
        ))
        await session.commit()

    if migration_state is not None:
        session.add(AuthMigration(user_id=user_id, state=migration_state))
        await session.commit()

    raw_code = await issue_bootstrap_code(
        session, user_id=user_id, firebase_uid=firebase_uid, project_id=PROJECT_ID,
        device_binding_hash=device_binding_hash,
    )
    return raw_code, user_id


def _setup_common(monkeypatch, *, mobile_issue: bool = True):
    from app.core.config import settings
    monkeypatch.setattr(settings, "firebase_auth_mobile_issue", mobile_issue)
    monkeypatch.setattr(settings, "firebase_project_id", PROJECT_ID)
    monkeypatch.setattr(settings, "firebase_bff_internal_secret", "")


@pytest.mark.anyio
async def test_flag_off_returns_501(monkeypatch):
    from app.routers.auth_firebase_internal import NativeBootstrapConsumeRequest, consume_native_bootstrap

    _setup_common(monkeypatch, mobile_issue=False)

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            with pytest.raises(HTTPException) as exc_info:
                await consume_native_bootstrap(
                    NativeBootstrapConsumeRequest(code="whatever"), authorization=None, db=s
                )
            assert exc_info.value.status_code == 501
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_wrong_internal_secret_rejected(monkeypatch):
    from app.core.config import settings
    from app.routers.auth_firebase_internal import NativeBootstrapConsumeRequest, consume_native_bootstrap

    _setup_common(monkeypatch)
    monkeypatch.setattr(settings, "firebase_bff_internal_secret", "correct-secret")

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            with pytest.raises(HTTPException) as exc_info:
                await consume_native_bootstrap(
                    NativeBootstrapConsumeRequest(code="whatever"),
                    authorization="Bearer wrong-secret", db=s,
                )
            assert exc_info.value.status_code == 401
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_invalid_code_rejected(monkeypatch):
    from app.routers.auth_firebase_internal import NativeBootstrapConsumeRequest, consume_native_bootstrap

    _setup_common(monkeypatch)

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            with pytest.raises(HTTPException) as exc_info:
                await consume_native_bootstrap(
                    NativeBootstrapConsumeRequest(code="never-issued-code"), authorization=None, db=s
                )
            assert exc_info.value.status_code == 401
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_success_returns_minted_cookie(monkeypatch):
    import app.routers.auth_firebase_internal as router_mod
    from app.routers.auth_firebase_internal import NativeBootstrapConsumeRequest, consume_native_bootstrap

    _setup_common(monkeypatch)

    async def fake_mint_for_uid(firebase_uid, project_id, web_api_key, valid_duration_seconds):
        assert project_id == PROJECT_ID
        return "minted-native-session-cookie"
    monkeypatch.setattr(router_mod, "mint_session_cookie_for_uid", fake_mint_for_uid)

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            raw_code, _user_id = await _seed_user_and_code(s)

        async with Session() as s:
            result = await consume_native_bootstrap(
                NativeBootstrapConsumeRequest(code=raw_code), authorization=None, db=s
            )
        assert result.session_cookie == "minted-native-session-cookie"
        assert result.expires_in == 5 * 24 * 60 * 60
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_replay_after_success_rejected(monkeypatch):
    import app.routers.auth_firebase_internal as router_mod
    from app.routers.auth_firebase_internal import NativeBootstrapConsumeRequest, consume_native_bootstrap

    _setup_common(monkeypatch)

    async def fake_mint_for_uid(firebase_uid, project_id, web_api_key, valid_duration_seconds):
        return "minted-cookie"
    monkeypatch.setattr(router_mod, "mint_session_cookie_for_uid", fake_mint_for_uid)

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            raw_code, _user_id = await _seed_user_and_code(s)

        async with Session() as s:
            first = await consume_native_bootstrap(
                NativeBootstrapConsumeRequest(code=raw_code), authorization=None, db=s
            )
        assert first.session_cookie == "minted-cookie"

        async with Session() as s:
            with pytest.raises(HTTPException) as exc_info:
                await consume_native_bootstrap(
                    NativeBootstrapConsumeRequest(code=raw_code), authorization=None, db=s
                )
            assert exc_info.value.status_code == 401
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_mint_failure_returns_502(monkeypatch):
    import app.routers.auth_firebase_internal as router_mod
    from app.routers.auth_firebase_internal import NativeBootstrapConsumeRequest, consume_native_bootstrap

    _setup_common(monkeypatch)

    async def fake_mint_for_uid(firebase_uid, project_id, web_api_key, valid_duration_seconds):
        return None
    monkeypatch.setattr(router_mod, "mint_session_cookie_for_uid", fake_mint_for_uid)

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            raw_code, _user_id = await _seed_user_and_code(s)

        async with Session() as s:
            with pytest.raises(HTTPException) as exc_info:
                await consume_native_bootstrap(
                    NativeBootstrapConsumeRequest(code=raw_code), authorization=None, db=s
                )
            assert exc_info.value.status_code == 502
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_device_binding_mismatch_rejected(monkeypatch):
    from app.routers.auth_firebase_internal import NativeBootstrapConsumeRequest, consume_native_bootstrap

    _setup_common(monkeypatch)

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            raw_code, _user_id = await _seed_user_and_code(s, device_binding_hash="correct-hash")

        async with Session() as s:
            with pytest.raises(HTTPException) as exc_info:
                await consume_native_bootstrap(
                    NativeBootstrapConsumeRequest(code=raw_code, device_binding_hash="wrong-hash"),
                    authorization=None, db=s,
                )
            assert exc_info.value.status_code == 401
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_prod_missing_internal_secret_fail_closed_503(monkeypatch):
    """산티아고 §9 finding 4(HIGH) 회귀 가드 — 최초 구현은 환경 무관 fail-open이었다
    (직접 probe: app_env=production+secret 미설정→prod_missing_internal_secret_allowed=True).
    non-local 환경은 secret 미설정 시 503 fail-closed로 바뀌었다."""
    from app.core.config import settings
    from app.routers.auth_firebase_internal import NativeBootstrapConsumeRequest, consume_native_bootstrap

    _setup_common(monkeypatch)
    monkeypatch.setattr(settings, "app_env", "production")

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            with pytest.raises(HTTPException) as exc_info:
                await consume_native_bootstrap(
                    NativeBootstrapConsumeRequest(code="whatever"), authorization=None, db=s
                )
            assert exc_info.value.status_code == 503
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_existing_session_different_user_rejected(monkeypatch):
    """산티아고 §9 finding 3(HIGH) 최소 반영 — attacker가 자기 code를 피해자 WebView에
    소비시키는 login-CSRF: 기존 __Host-sp_fs 세션의 검증된 user_id와 코드 소유자가 다르면
    무조건 거부(조용한 account-switch 금지)."""
    import app.routers.auth_firebase_internal as router_mod
    from app.routers.auth_firebase_internal import NativeBootstrapConsumeRequest, consume_native_bootstrap

    _setup_common(monkeypatch)

    async def fake_mint_for_uid(firebase_uid, project_id, web_api_key, valid_duration_seconds):
        return "should-never-be-returned"
    monkeypatch.setattr(router_mod, "mint_session_cookie_for_uid", fake_mint_for_uid)

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            raw_code, _code_owner_user_id = await _seed_user_and_code(s)

        attacker_controlled_different_user_id = str(uuid.uuid4())
        async with Session() as s:
            with pytest.raises(HTTPException) as exc_info:
                await consume_native_bootstrap(
                    NativeBootstrapConsumeRequest(
                        code=raw_code, existing_session_user_id=attacker_controlled_different_user_id
                    ),
                    authorization=None, db=s,
                )
            assert exc_info.value.status_code == 401
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_existing_session_same_user_allowed(monkeypatch):
    """finding 3 회귀 가드 반대편 — 기존 세션 사용자와 코드 소유자가 동일하면(정상 재인증)
    거부하면 안 된다."""
    import app.routers.auth_firebase_internal as router_mod
    from app.routers.auth_firebase_internal import NativeBootstrapConsumeRequest, consume_native_bootstrap

    _setup_common(monkeypatch)

    async def fake_mint_for_uid(firebase_uid, project_id, web_api_key, valid_duration_seconds):
        return "minted-cookie"
    monkeypatch.setattr(router_mod, "mint_session_cookie_for_uid", fake_mint_for_uid)

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            raw_code, code_owner_user_id = await _seed_user_and_code(s)

        async with Session() as s:
            result = await consume_native_bootstrap(
                NativeBootstrapConsumeRequest(
                    code=raw_code, existing_session_user_id=str(code_owner_user_id)
                ),
                authorization=None, db=s,
            )
        assert result.session_cookie == "minted-cookie"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_consume_time_reverify_rejects_user_disabled_after_issuance(monkeypatch):
    """산티아고 §9 finding 6 회귀 가드 — 발급~소비 사이(최대 45초)에 계정이 비활성화되면
    atomic consume 자체는 성공해도(코드는 유효) mint 직전 재검증에서 거부해야 한다."""
    from sqlalchemy import update
    from app.models.user import User
    from app.routers.auth_firebase_internal import NativeBootstrapConsumeRequest, consume_native_bootstrap

    _setup_common(monkeypatch)

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            raw_code, user_id = await _seed_user_and_code(s)
            await s.execute(update(User).where(User.id == user_id).values(is_active=False))
            await s.commit()

        async with Session() as s:
            with pytest.raises(HTTPException) as exc_info:
                await consume_native_bootstrap(
                    NativeBootstrapConsumeRequest(code=raw_code), authorization=None, db=s
                )
            assert exc_info.value.status_code == 401
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_consume_time_reverify_rejects_identity_unlinked_after_issuance(monkeypatch):
    """finding 6 회귀 가드 — 발급 후 identity가 unlink되면(보안 이벤트로 인한 강제 해제 등)
    atomic consume은 성공해도 mint 직전 재검증에서 거부해야 한다."""
    from sqlalchemy import update
    from app.models.auth_identity import AuthIdentity
    from app.routers.auth_firebase_internal import NativeBootstrapConsumeRequest, consume_native_bootstrap

    _setup_common(monkeypatch)

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            raw_code, user_id = await _seed_user_and_code(s)
            from datetime import datetime, timezone
            await s.execute(
                update(AuthIdentity).where(AuthIdentity.user_id == user_id)
                .values(unlinked_at=datetime.now(timezone.utc))
            )
            await s.commit()

        async with Session() as s:
            with pytest.raises(HTTPException) as exc_info:
                await consume_native_bootstrap(
                    NativeBootstrapConsumeRequest(code=raw_code), authorization=None, db=s
                )
            assert exc_info.value.status_code == 401
    finally:
        await engine.dispose()


@pytest.mark.anyio
@pytest.mark.parametrize("ineligible_state", ["reset_required", "rollback_hold", "legacy", "provisioning_typo"])
async def test_ineligible_migration_state_rejected(monkeypatch, ineligible_state):
    """산티아고 #2202 3차 재검토 잔여 2(HIGH): reset_required 사용자가 bootstrap
    custom-token으로 새 세션을 발급받으면 coordinated forced-reset 정책(doc §6.1)과
    충돌한다 — provisioning/firebase 외 모든 상태는 거부."""
    from app.routers.auth_firebase_internal import NativeBootstrapConsumeRequest, consume_native_bootstrap

    _setup_common(monkeypatch)

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            raw_code, _user_id = await _seed_user_and_code(s, migration_state=ineligible_state)

        async with Session() as s:
            with pytest.raises(HTTPException) as exc_info:
                await consume_native_bootstrap(
                    NativeBootstrapConsumeRequest(code=raw_code), authorization=None, db=s
                )
            assert exc_info.value.status_code == 401
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_missing_migration_row_rejected(monkeypatch):
    """auth_migrations 행 자체가 없는(Phase 3 cohort 미편입) 사용자는 fail-closed로 거부
    — 아직 아무도 migration state 행이 없는 현재(Phase 1) 시점의 안전한 기본값."""
    from app.routers.auth_firebase_internal import NativeBootstrapConsumeRequest, consume_native_bootstrap

    _setup_common(monkeypatch)

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            raw_code, _user_id = await _seed_user_and_code(s, migration_state=None)

        async with Session() as s:
            with pytest.raises(HTTPException) as exc_info:
                await consume_native_bootstrap(
                    NativeBootstrapConsumeRequest(code=raw_code), authorization=None, db=s
                )
            assert exc_info.value.status_code == 401
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_identity_reassigned_to_different_user_rejected(monkeypatch):
    """산티아고 #2202 3차 재검토 잔여 2: (issuer,subject)만 보고 unlinked 여부만 보면 그
    사이 identity가 다른 user_id로 재연결된 레이스를 못 잡는다 — consumed.user_id와
    정확히 같은 행인지까지 확인해야 한다."""
    from app.routers.auth_firebase_internal import NativeBootstrapConsumeRequest, consume_native_bootstrap

    _setup_common(monkeypatch)

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            raw_code, _user_id = await _seed_user_and_code(s, link_identity_to_other_user=True)

        async with Session() as s:
            with pytest.raises(HTTPException) as exc_info:
                await consume_native_bootstrap(
                    NativeBootstrapConsumeRequest(code=raw_code), authorization=None, db=s
                )
            assert exc_info.value.status_code == 401
    finally:
        await engine.dispose()
