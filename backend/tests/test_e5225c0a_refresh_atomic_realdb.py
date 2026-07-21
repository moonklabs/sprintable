"""story e5225c0a(P0): prod 로그인 풀림 근본 fix — /auth/refresh 원자화 realdb 게이트.

산티아고 실측: SELECT→UPDATE 비원자 rotation이 Cloud Run 멀티 인스턴스 간 race를 유발해
/auth/refresh 239건 중 230건 401(30일 sp_rt 쿠키가 실패를 무한 재생산). 이 테스트는 동일
refresh_token으로 동시 2요청을 쏴 원자 single-use rotation(switch_account 선례와 동형)이
정확히 1건만 실제로 revoke함을 라이브 PG로 실증한다.

⛔story cd10e123(P0, e5225c0a와 별개 신 클래스) 갱신: 원자 rotation 자체는 여전히
single-use(위 불변식 유지)이나, "진 쪽에게 무엇을 응답하는지"가 바뀌었다 — 예전엔 하드
401(TOKEN_REVOKED)로 FE가 clearAuthCookies() 실행해 강제 로그아웃됐다(멀티인스턴스 in-memory
dedup 미공유 때문에 이게 진짜 race의 정상 경로로 발생). 이제는 grace window(config.py
auth_refresh_grace_seconds, 기본 5s) 내 revoke된 토큰이면 진짜 stale/replay가 아니라 race
패자로 판정해 독립적인 새 rotation(fork)을 발급, 200으로 응답한다 — 그래서 아래
`test_concurrent_refresh_same_token_exactly_one_succeeds_realdb`는 [200,401]이 아니라
[200,200](양쪽 다 독립적으로 유효한, 그러나 서로 다른 토큰)을 기대하도록 갱신됐다.
grace window 밖(진짜 stale)은 여전히 401 — 아래 `_after_grace` 테스트가 그 경계를 증명한다.
"""
from __future__ import annotations

import asyncio
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


async def _seed_user_with_refresh_token(session):
    from app.core.security import create_refresh_token, hash_token, hash_password
    from app.models.user import RefreshToken, User

    user_id = uuid.uuid4()
    user = User(
        id=user_id, email=f"e5225c0a-{user_id.hex[:8]}@test.com",
        hashed_password=hash_password("x"), is_active=True, email_verified=True,
    )
    session.add(user)
    await session.commit()

    raw_refresh, exp = create_refresh_token(str(user_id))
    session.add(RefreshToken(
        id=uuid.uuid4(), user_id=user_id, token_hash=hash_token(raw_refresh),
        expires_at=exp, revoked_at=None,
    ))
    await session.commit()

    return {"user_id": user_id, "raw_refresh": raw_refresh}


async def _setup_app(app, Session):
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


@pytest.mark.anyio
async def test_concurrent_refresh_same_token_exactly_one_succeeds_realdb():
    """까심 race 재현 — 갱신(story cd10e123): 동일 refresh_token 동시 2요청 → 이제 둘 다 200
    (grace-window fork). 원자성 불변식은 "둘이 서로 다른 독립 토큰을 받는지"로 증명한다 —
    같은 토큰을 공유해 받으면 그건 그것대로 버그(양쪽이 같은 세션을 오인)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_user_with_refresh_token(s)

        await _setup_app(app, Session)
        client = _client_for(app)
        try:
            results = await asyncio.gather(
                client.post("/api/v2/auth/refresh", json={"refresh_token": seeded["raw_refresh"]}),
                client.post("/api/v2/auth/refresh", json={"refresh_token": seeded["raw_refresh"]}),
            )
            statuses = sorted(r.status_code for r in results)
            assert statuses == [200, 200], (
                f"grace-window fork 실패 — 동시 2요청 결과가 [200,200]이 아님: {statuses} "
                f"(1건이라도 401이면 멀티인스턴스 race 강제로그아웃 재발)"
            )
            rt_a = results[0].json()["data"]["refresh_token"]
            rt_b = results[1].json()["data"]["refresh_token"]
            assert rt_a != rt_b, "두 race 요청이 같은 refresh_token을 받음 — double-spend/세션 혼선"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_refresh_replay_within_grace_window_forks_new_session_realdb():
    """story cd10e123: grace window(기본 5s) 내 순차 재사용 → 200(fork) — race 패자가 강제
    로그아웃되지 않고 독립적인 새 세션을 받는다는 게 이 신 클래스 fix의 핵심 계약."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_user_with_refresh_token(s)

        await _setup_app(app, Session)
        client = _client_for(app)
        try:
            first = await client.post("/api/v2/auth/refresh", json={"refresh_token": seeded["raw_refresh"]})
            assert first.status_code == 200, first.text
            second = await client.post("/api/v2/auth/refresh", json={"refresh_token": seeded["raw_refresh"]})
            assert second.status_code == 200, second.text
            assert first.json()["data"]["refresh_token"] != second.json()["data"]["refresh_token"]
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_refresh_replay_after_grace_window_still_401_realdb():
    """회귀 0(갱신): grace window *밖*의 진짜 stale replay는 여전히 401 — grace가 무기한
    재사용을 허용하는 게 아님을 경계값으로 증명(revoked_at을 grace+1s 과거로 직접 backdate)."""
    from app.main import app
    from app.core.config import settings

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_user_with_refresh_token(s)

        await _setup_app(app, Session)
        client = _client_for(app)
        try:
            first = await client.post("/api/v2/auth/refresh", json={"refresh_token": seeded["raw_refresh"]})
            assert first.status_code == 200, first.text

            from app.core.security import hash_token
            from app.models.user import RefreshToken
            from sqlalchemy import update as sa_update
            stale_at = datetime.now(timezone.utc) - timedelta(seconds=settings.auth_refresh_grace_seconds + 1)
            async with Session() as s:
                await s.execute(
                    sa_update(RefreshToken)
                    .where(RefreshToken.token_hash == hash_token(seeded["raw_refresh"]))
                    .values(revoked_at=stale_at)
                )
                await s.commit()

            second = await client.post("/api/v2/auth/refresh", json={"refresh_token": seeded["raw_refresh"]})
            assert second.status_code == 401
            assert second.json()["error"]["code"] == "TOKEN_REVOKED"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_refresh_failure_logs_reason_and_correlation_key_realdb(caplog):
    """산티아고 관측성 요구(item 3): grace window 밖 실패 시 reason+상관키가 로그에 남는지 실증
    (story cd10e123 갱신: grace 안쪽은 이제 성공이라 이 테스트는 grace 밖 시나리오로 검증)."""
    import logging
    from app.main import app
    from app.core.config import settings

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_user_with_refresh_token(s)

        await _setup_app(app, Session)
        client = _client_for(app)
        try:
            first = await client.post("/api/v2/auth/refresh", json={"refresh_token": seeded["raw_refresh"]})
            assert first.status_code == 200

            from app.core.security import hash_token
            from app.models.user import RefreshToken
            from sqlalchemy import update as sa_update
            stale_at = datetime.now(timezone.utc) - timedelta(seconds=settings.auth_refresh_grace_seconds + 1)
            async with Session() as s:
                await s.execute(
                    sa_update(RefreshToken)
                    .where(RefreshToken.token_hash == hash_token(seeded["raw_refresh"]))
                    .values(revoked_at=stale_at)
                )
                await s.commit()

            with caplog.at_level(logging.WARNING, logger="app.routers.auth"):
                second = await client.post(
                    "/api/v2/auth/refresh", json={"refresh_token": seeded["raw_refresh"]},
                )
            assert second.status_code == 401
            assert any(
                "reason=token_not_found_or_revoked_or_expired" in r.message and "key=" in r.message
                for r in caplog.records
            ), f"관측성 로그 누락: {[r.message for r in caplog.records]}"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_refresh_expired_token_401_realdb():
    from app.main import app
    from app.core.security import create_refresh_token, hash_token, hash_password
    from app.models.user import RefreshToken, User

    engine, Session = await _session_factory()
    try:
        user_id = uuid.uuid4()
        async with Session() as s:
            s.add(User(
                id=user_id, email=f"e5225c0a-exp-{user_id.hex[:8]}@test.com",
                hashed_password=hash_password("x"), is_active=True, email_verified=True,
            ))
            await s.commit()
            raw_refresh, _ = create_refresh_token(str(user_id))
            s.add(RefreshToken(
                id=uuid.uuid4(), user_id=user_id, token_hash=hash_token(raw_refresh),
                expires_at=datetime.now(timezone.utc) - timedelta(days=1), revoked_at=None,
            ))
            await s.commit()

        await _setup_app(app, Session)
        client = _client_for(app)
        try:
            resp = await client.post("/api/v2/auth/refresh", json={"refresh_token": raw_refresh})
            assert resp.status_code == 401
            assert resp.json()["error"]["code"] == "TOKEN_REVOKED"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
