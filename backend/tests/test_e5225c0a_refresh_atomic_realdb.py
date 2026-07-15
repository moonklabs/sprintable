"""story e5225c0a(P0): prod 로그인 풀림 근본 fix — /auth/refresh 원자화 realdb 게이트.

산티아고 실측: SELECT→UPDATE 비원자 rotation이 Cloud Run 멀티 인스턴스 간 race를 유발해
/auth/refresh 239건 중 230건 401(30일 sp_rt 쿠키가 실패를 무한 재생산). 이 테스트는 동일
refresh_token으로 동시 2요청을 쏴 정확히 1건만 성공(switch_account 선례와 동형 single-use
원자 rotation)함을 라이브 PG로 실증한다.
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
    """까심 race 재현: 동일 refresh_token으로 동시 2요청 → 정확히 1건 200, 1건 401(TOKEN_REVOKED)."""
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
            assert statuses == [200, 401], (
                f"원자성 실패 — 동시 2요청 결과가 [200,401]이 아님: {statuses} "
                f"(둘 다 200이면 double-spend race 재발)"
            )
            failed = next(r for r in results if r.status_code == 401)
            assert failed.json()["error"]["code"] == "TOKEN_REVOKED"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_refresh_already_revoked_token_401_realdb():
    """회귀 0: 이미 사용된(revoked) 토큰 재사용 → 401(단발성 rotation 유지 확인)."""
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
            assert second.status_code == 401
            assert second.json()["error"]["code"] == "TOKEN_REVOKED"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_refresh_failure_logs_reason_and_correlation_key_realdb(caplog):
    """산티아고 관측성 요구(item 3): 실패 시 reason+상관키가 로그에 남는지 실증."""
    import logging
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_user_with_refresh_token(s)

        await _setup_app(app, Session)
        client = _client_for(app)
        try:
            first = await client.post("/api/v2/auth/refresh", json={"refresh_token": seeded["raw_refresh"]})
            assert first.status_code == 200

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
