"""story #3649(BE·보안·prod 결함, 페드루 PO 確定 2026-09-07, 카디르 codex 재현 확定) —
비밀번호 설정/변경 확認 뒤에도 옛 세션이 살아남던 두 결함을 닫는다(재QA #3693/3250 codex
발견).

① 명시 폐기(logout·set-password confirm·switch-project·switch-org·admin 강제폐기)된
refresh token이 §2449 유예창(기본 180s, 회전 경합 straggler 구제용)을 그냥 통과해
refresh()에서 새 토큰을 fork했다 — 「경합」과 「명시 폐기」를 안 갈랐다. 처방: 명시 폐기
UPDATE가 `revoked_at`과 함께 `expires_at`도 now()로 내려, 유예창 select의 기존
`expires_at > now()` 조건이 구조적으로 이 RT를 걸러낸다(새 컬럼 0 — replaced_by 기반
1차 처방은 승자의 그 값이 새 row INSERT+commit "후" 별개 문장으로 채워지는 타이밍이라
진짜 동시 경합에서 오탐 401 회귀를 냈다, 되돌림).

② refresh·switch-project·switch-org·switch-account 재발급 경로에서 `session_started_at
< user.password_set_at`이면 401 SESSION_INVALIDATED — 옛 access token(비밀번호 변경
뒤에도 최대 60분 유효)으로 switch-*를 불러 새 refresh token을 얻는 우회를 막는다.
공용 판정 `_is_session_stale_after_password_change`(auth.py)는 기존 totp/disable
password 재검증(PR#3634)이 쓰던 비교식을 그대로 재사용(새 로직 0).
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
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


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _setup_db_override(app, Session):
    from app.dependencies.database import get_db

    async def _db():
        async with Session() as s:
            try:
                yield s
                await s.commit()
            except Exception:
                await s.rollback()
                raise

    app.dependency_overrides[get_db] = _db


def _override_auth(app, *, user_id, org_id, session_started_at):
    from app.dependencies.auth import AuthContext, get_current_user

    async def _auth():
        claims = {"app_metadata": {"org_id": str(org_id)}}
        if session_started_at is not None:
            claims["session_started_at"] = session_started_at
        return AuthContext(user_id=str(user_id), email="caller@test", claims=claims)

    app.dependency_overrides[get_current_user] = _auth


async def _seed_user_with_password(session, *, password_set_at: datetime | None):
    from app.core.security import hash_password
    from app.models.user import User

    user_id = uuid.uuid4()
    user = User(
        id=user_id, email=f"story3649-{user_id.hex[:8]}@test.com",
        hashed_password=hash_password("x"), is_active=True, email_verified=True,
        password_set_at=password_set_at,
    )
    session.add(user)
    await session.commit()
    return user_id


async def _seed_refresh_token(session, user_id, *, session_started_at: int | None):
    from app.core.security import create_refresh_token, hash_token

    raw, exp = create_refresh_token(str(user_id), session_started_at=session_started_at)
    from app.models.user import RefreshToken

    session.add(RefreshToken(
        id=uuid.uuid4(), user_id=user_id, token_hash=hash_token(raw), expires_at=exp, revoked_at=None,
    ))
    await session.commit()
    return raw


async def _seed_org_and_project(session, user_id):
    """team_members는 read-only VIEW라 직접 INSERT 불가 — has_project_access의
    owner/admin 분기(OrgMember.role)만으로 접근을 준다(team_member 행 불요,
    story #3629/#3635 그라운딩과 동형 관례)."""
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    om = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=user_id, role="owner")
    session.add(om)
    await session.commit()
    return {"org_id": org.id, "project_id": project.id}


# ── ② session_started_at < password_set_at → 401 (refresh/switch-*) ──────────


@pytest.mark.anyio
async def test_refresh_with_session_started_before_password_change_401_session_invalidated():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        password_set_at = datetime.now(timezone.utc)
        async with Session() as s:
            user_id = await _seed_user_with_password(s, password_set_at=password_set_at)
            stale_started_at = int((password_set_at - timedelta(minutes=5)).timestamp())
            raw_rt = await _seed_refresh_token(s, user_id, session_started_at=stale_started_at)

        await _setup_db_override(app, Session)
        client = _client_for(app)
        try:
            resp = await client.post("/api/v2/auth/refresh", json={"refresh_token": raw_rt})
            assert resp.status_code == 401, resp.text
            assert resp.json()["error"]["code"] == "SESSION_INVALIDATED"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_refresh_with_session_started_after_password_change_succeeds_200_no_false_positive():
    """회귀 0 — 비밀번호 변경 «뒤에» 새로 로그인한 정상 세션은 refresh가 계속 통과해야 한다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        password_set_at = datetime.now(timezone.utc) - timedelta(hours=1)
        async with Session() as s:
            user_id = await _seed_user_with_password(s, password_set_at=password_set_at)
            fresh_started_at = int(datetime.now(timezone.utc).timestamp())
            raw_rt = await _seed_refresh_token(s, user_id, session_started_at=fresh_started_at)

        await _setup_db_override(app, Session)
        client = _client_for(app)
        try:
            resp = await client.post("/api/v2/auth/refresh", json={"refresh_token": raw_rt})
            assert resp.status_code == 200, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_switch_project_with_stale_session_401():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        password_set_at = datetime.now(timezone.utc)
        async with Session() as s:
            user_id = await _seed_user_with_password(s, password_set_at=password_set_at)
            seeded = await _seed_org_and_project(s, user_id)

        await _setup_db_override(app, Session)
        stale_started_at = int((password_set_at - timedelta(minutes=5)).timestamp())
        _override_auth(app, user_id=user_id, org_id=seeded["org_id"], session_started_at=stale_started_at)
        client = _client_for(app)
        try:
            resp = await client.post(
                "/api/v2/auth/switch-project", json={"project_id": str(seeded["project_id"])},
            )
            assert resp.status_code == 401, resp.text
            assert resp.json()["error"]["code"] == "SESSION_INVALIDATED"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_switch_org_with_stale_session_401():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        password_set_at = datetime.now(timezone.utc)
        async with Session() as s:
            user_id = await _seed_user_with_password(s, password_set_at=password_set_at)
            seeded = await _seed_org_and_project(s, user_id)

        await _setup_db_override(app, Session)
        stale_started_at = int((password_set_at - timedelta(minutes=5)).timestamp())
        _override_auth(app, user_id=user_id, org_id=seeded["org_id"], session_started_at=stale_started_at)
        client = _client_for(app)
        try:
            resp = await client.post("/api/v2/auth/switch-org", json={"org_id": str(seeded["org_id"])})
            assert resp.status_code == 401, resp.text
            assert resp.json()["error"]["code"] == "SESSION_INVALIDATED"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_switch_account_with_stale_session_401():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        password_set_at = datetime.now(timezone.utc)
        async with Session() as s:
            user_id = await _seed_user_with_password(s, password_set_at=password_set_at)
            stale_started_at = int((password_set_at - timedelta(minutes=5)).timestamp())
            raw_rt = await _seed_refresh_token(s, user_id, session_started_at=stale_started_at)

        await _setup_db_override(app, Session)
        client = _client_for(app)
        try:
            resp = await client.post("/api/v2/auth/switch-account", json={"refresh_token": raw_rt})
            assert resp.status_code == 401, resp.text
            assert resp.json()["error"]["code"] == "SESSION_INVALIDATED"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ── ① 명시 폐기(logout) RT가 §2449 유예창을 못 통과 ───────────────────────────


@pytest.mark.anyio
async def test_logout_itself_backdates_expires_at_to_now():
    """logout 엔드포인트 자체가 expires_at을 now()로 내리는지 직접 확認(DB row 조회 —
    이 축이 실제로 실행되는지의 1차 증거, 아래 refresh 재현 테스트와 상호보완)."""
    from app.main import app
    from app.core.security import hash_token
    from app.models.user import RefreshToken
    from sqlalchemy import select as sa_select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            user_id = await _seed_user_with_password(s, password_set_at=None)
            raw_rt = await _seed_refresh_token(s, user_id, session_started_at=None)

        await _setup_db_override(app, Session)
        client = _client_for(app)
        try:
            before = datetime.now(timezone.utc)
            logout_resp = await client.post("/api/v2/auth/logout", json={"refresh_token": raw_rt})
            assert logout_resp.status_code == 200, logout_resp.text

            async with Session() as s:
                row = (await s.execute(
                    sa_select(RefreshToken).where(RefreshToken.token_hash == hash_token(raw_rt))
                )).scalar_one()
            assert row.revoked_at is not None
            assert row.expires_at <= before + timedelta(seconds=5), (
                f"logout이 expires_at을 원래 만료일(수 일 뒤)에서 안 내렸다: {row.expires_at}"
            )
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_refresh_after_logout_401_on_repeated_retries_within_grace_window():
    """카디르 재현(confirm 뒤 즉시·60s·170s refresh 200 — 결함) 대응 회귀. logout이
    expires_at을 now()로 내려두면(위 테스트) 그 뒤 §2449 유예창의 `expires_at > now()`
    조건이 시간 경과와 무관하게 항상 거짓이 된다 — 실제 로그아웃 1회 뒤, 별도 DB
    조작 없이 refresh를 반복(3회, 공격자의 재시도 흉내) 재시도해도 매번 401이어야
    한다(카디르가 재현한 즉시/60s/170s 케이스 전부가 이 하나의 메커니즘으로 닫힌다
    — 시간 오프셋을 흉내 낼 필요 자체가 없다는 것도 이 처방의 성질)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            user_id = await _seed_user_with_password(s, password_set_at=None)
            raw_rt = await _seed_refresh_token(s, user_id, session_started_at=None)

        await _setup_db_override(app, Session)
        client = _client_for(app)
        try:
            logout_resp = await client.post("/api/v2/auth/logout", json={"refresh_token": raw_rt})
            assert logout_resp.status_code == 200, logout_resp.text

            for attempt in range(3):
                resp = await client.post("/api/v2/auth/refresh", json={"refresh_token": raw_rt})
                assert resp.status_code == 401, f"attempt={attempt}: {resp.text}"
                assert resp.json()["error"]["code"] == "TOKEN_REVOKED"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_refresh_genuine_rotation_race_within_window_still_succeeds_200_regression():
    """회귀 0(§2449 핵심 계약) — «명시 폐기»가 아니라 «진짜 회전 경합»(원자 rotation UPDATE로
    죽은 RT, expires_at 무접촉)은 유예창 안에서 여전히 200(fork)이어야 한다. 이 파일의 처방이
    §2449 구제를 깨지 않았다는 직접 증거(test_e5225c0a_refresh_atomic_realdb.py의 동시성
    테스트와 상호보완 — 여기는 순차 재현으로 명시 폐기와 대비시킨다)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            user_id = await _seed_user_with_password(s, password_set_at=None)
            raw_rt = await _seed_refresh_token(s, user_id, session_started_at=None)

        await _setup_db_override(app, Session)
        client = _client_for(app)
        try:
            first = await client.post("/api/v2/auth/refresh", json={"refresh_token": raw_rt})
            assert first.status_code == 200, first.text
            # 같은(이미 원자 rotation으로 소비된) RT를 다시 제시 — expires_at 무접촉이라
            # 유예창 안이면 fork(200).
            second = await client.post("/api/v2/auth/refresh", json={"refresh_token": raw_rt})
            assert second.status_code == 200, second.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ── 뮤테이션 ───────────────────────────────────────────────────────────────────


@pytest.mark.anyio
async def test_mutation_removing_expires_at_backdate_from_shared_helper_reopens_reuse_window(monkeypatch):
    """뮤테이션① — 명시 폐기 5곳이 공유하는 단일 seam(_explicit_revoke_values)이
    expires_at을 안 내리면(옛 동작 재현) logout 뒤에도 유예창 재사용이 다시 200으로
    통과해야 한다(이 스토리의 처방이 실제로 이 결함을 잡는다는 증거 — 5곳 전부를
    한 번에 검증하는 단일 seam이라 여기 하나만 패치해도 대표성 있음)."""
    from app.main import app
    import app.routers.auth as auth_module

    monkeypatch.setattr(auth_module, "_explicit_revoke_values", lambda now: {"revoked_at": now})

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            user_id = await _seed_user_with_password(s, password_set_at=None)
            raw_rt = await _seed_refresh_token(s, user_id, session_started_at=None)

        await _setup_db_override(app, Session)
        client = _client_for(app)
        try:
            logout_resp = await client.post("/api/v2/auth/logout", json={"refresh_token": raw_rt})
            assert logout_resp.status_code == 200, logout_resp.text

            resp = await client.post("/api/v2/auth/refresh", json={"refresh_token": raw_rt})
            assert resp.status_code == 200, (
                f"뮤테이션 재현인데 401 — expires_at 무접촉 옛 동작에서도 이 케이스는 "
                f"원래 200이어야 정상(이 테스트 자체가 그 옛 결함을 재현): {resp.text}"
            )
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_mutation_removing_session_invalidation_check_from_refresh_allows_stale_session(monkeypatch):
    """뮤테이션② — _is_session_stale_after_password_change를 no-op으로 되돌리면
    stale 세션 refresh가 다시 200으로 통과해야 한다."""
    from app.main import app
    import app.routers.auth as auth_module

    monkeypatch.setattr(auth_module, "_is_session_stale_after_password_change", lambda user, sid: False)

    engine, Session = await _session_factory()
    try:
        password_set_at = datetime.now(timezone.utc)
        async with Session() as s:
            user_id = await _seed_user_with_password(s, password_set_at=password_set_at)
            stale_started_at = int((password_set_at - timedelta(minutes=5)).timestamp())
            raw_rt = await _seed_refresh_token(s, user_id, session_started_at=stale_started_at)

        await _setup_db_override(app, Session)
        client = _client_for(app)
        try:
            resp = await client.post("/api/v2/auth/refresh", json={"refresh_token": raw_rt})
            assert resp.status_code == 200, (
                f"뮤테이션 재현인데 401 — 판정 제거 후에도 여전히 막히면 이 축의 실제 효과를 "
                f"증명 못 한 것: {resp.text}"
            )
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
