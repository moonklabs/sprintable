"""story e5225c0a(P0): prod 로그인 풀림 근본 fix — /auth/refresh 원자화 realdb 게이트.

산티아고 실측: SELECT→UPDATE 비원자 rotation이 Cloud Run 멀티 인스턴스 간 race를 유발해
/auth/refresh 239건 중 230건 401(30일 sp_rt 쿠키가 실패를 무한 재생산). 이 테스트는 동일
refresh_token으로 동시 2요청을 쏴 원자 single-use rotation(switch_account 선례와 동형)이
정확히 1건만 실제로 revoke함을 라이브 PG로 실증한다.

⛔story cd10e123(P0, e5225c0a와 별개 신 클래스) 갱신: 원자 rotation 자체는 여전히
single-use(위 불변식 유지)이나, "진 쪽에게 무엇을 응답하는지"가 바뀌었다 — 예전엔 하드
401(TOKEN_REVOKED)로 FE가 clearAuthCookies() 실행해 강제 로그아웃됐다(멀티인스턴스 in-memory
dedup 미공유 때문에 이게 진짜 race의 정상 경로로 발생). 이제는 해소 허용창(config.py
auth_refresh_chain_resolve_window_seconds, 기본 180s) 내 revoke된 토큰이면 진짜 stale/replay가
아니라 race 패자로 판정해 독립적인 새 rotation(fork)을 발급, 200으로 응답한다 — 그래서 아래
`test_concurrent_refresh_same_token_exactly_one_succeeds_realdb`는 [200,401]이 아니라
[200,200](양쪽 다 독립적으로 유효한, 그러나 서로 다른 토큰)을 기대하도록 갱신됐다.
창 밖(진짜 stale)은 여전히 401 — 아래 `_after_window` 테스트가 그 경계를 증명한다.

story #2449(2026-08-04): 옛 이름 auth_refresh_grace_seconds(기본 5s)를
auth_refresh_chain_resolve_window_seconds(기본 180s)로 단일화 — 「successor-chaining」(깊이
무제한 replaced_by 체인 walk) 설계 검토 중 그 walk가 판정 결과엔 영향이 없고(제시 토큰
자신의 revoked_at 하나만 창과 비교하면 다단계 walk와 결론이 같음) 오히려 아직 아무도 안 쓴
살아있는 successor를 straggler가 먼저 소비해 정당한 소유자를 되레 401내는 하자가 있어
「창 넓히기 + 승자 경로 replaced_by 감사기록(판정엔 미사용)」으로 수렴했다(디디 분석·PO
승인). 아래 `test_refresh_success_records_replaced_by_on_winner_realdb`가 그 감사기록만
검증한다 — 하나의 판정 로직도 안 바뀌었다는 뜻으로, 이 파일의 기존 테스트는 이름만
`_grace_window`→`_window`로 바뀌고 기대값은 그대로다.
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

# #2124: app.main import(모듈 최초 1회)이 app.core.logging_config.configure_logging()을 태워
# root.handlers.clear()를 실행한다 — 이 파일을 단독 실행(다른 파일이 먼저 app.main을 안 당겨온
# 상태)하면 그 clear가 caplog의 propagate 핸들러까지 지워 이 파일의 caplog 기반 관측성 테스트가
# 거짓양성(assert 대상이 빈 리스트인데도 다른 이유로 통과)/거짓음성을 낼 수 있다. 모듈 최상단에서
# 미리 당겨와 "이 파일 안에서" clear가 일어나는 시점을 각 테스트의 caplog fixture 설정 前으로
# 고정 — 전체 스위트에서 이미 우연히 성립하던 순서를 이 파일 단독 실행에서도 보장한다.
import app.main  # noqa: E402,F401


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
    (chain_resolve_window fork). 원자성 불변식은 "둘이 서로 다른 독립 토큰을 받는지"로 증명한다 —
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
                f"chain_resolve_window fork 실패 — 동시 2요청 결과가 [200,200]이 아님: {statuses} "
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
async def test_refresh_replay_within_chain_resolve_window_forks_new_session_realdb():
    """story cd10e123: 해소 허용창(기본 180s, story #2449 이전엔 5s) 내 순차 재사용 → 200(fork)
    — race 패자가 강제 로그아웃되지 않고 독립적인 새 세션을 받는다는 게 이 신 클래스 fix의
    핵심 계약."""
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
async def test_refresh_replay_after_chain_resolve_window_still_401_realdb():
    """회귀 0(갱신): 해소 허용창 *밖*의 진짜 stale replay는 여전히 401 — 창이 무기한 재사용을
    허용하는 게 아님을 경계값으로 증명(revoked_at을 window+1s 과거로 직접 backdate). story
    #2449: 이 assert는 auth_refresh_chain_resolve_window_seconds 값을 직접 읽어 경계를 잡으므로
    값이 바뀌면(예: 선생님이 180→다른 값 확認) 이 테스트가 그 새 값 기준으로 재현된다 — 손값
    하드코딩이면 값이 바뀌어도 조용히 안 잡히는 자리라 일부러 settings에서 읽는다."""
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
            stale_at = datetime.now(timezone.utc) - timedelta(
                seconds=settings.auth_refresh_chain_resolve_window_seconds + 1
            )
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
    """산티아고 관측성 요구(item 3): 해소 허용창 밖 실패 시 reason+상관키가 로그에 남는지 실증
    (story cd10e123 갱신: 창 안쪽은 이제 성공이라 이 테스트는 창 밖 시나리오로 검증)."""
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
            stale_at = datetime.now(timezone.utc) - timedelta(
                seconds=settings.auth_refresh_chain_resolve_window_seconds + 1
            )
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
                failure_records = [
                    r for r in caplog.records
                    if "reason=token_not_found_or_revoked_or_expired" in r.message
                ]
                assert failure_records, f"관측성 로그 누락: {[r.message for r in caplog.records]}"
                assert all("key=" in r.message for r in failure_records)
                # #2124(오르테가군 요청 2026-07-27): 하드 401 loop 실측(prod 259건, 동일 key 반복)에서
                # "누가 겪는지" 계정 상관이 0이라 못 쫓았다 — user_id가 **바로 이 실패 로그 레코드
                # 자체**에 실렸는지 실증(다른 레코드(예: 이전 성공 rotation의 INFO 로그)에 우연히
                # user_id가 있어 통과하는 거짓양성을 피하려 failure_records만 검사).
                assert all(
                    f"user_id={seeded['user_id']}" in r.message for r in failure_records
                ), f"user_id 관측성 로그 누락: {[r.message for r in failure_records]}"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_refresh_success_logs_rotation_old_new_key_realdb(caplog):
    """#2124(오르테가군 요청 2026-07-27): 성공 rotation에도 로그가 없어(침묵) old_key의 훗날
    하드 401과 new_key의 미사용 여부를 대조할 방법이 없었다 — old_key→new_key→user_id 로깅 실증."""
    import logging
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_user_with_refresh_token(s)

        await _setup_app(app, Session)
        client = _client_for(app)
        try:
            with caplog.at_level(logging.INFO, logger="app.routers.auth"):
                resp = await client.post(
                    "/api/v2/auth/refresh", json={"refresh_token": seeded["raw_refresh"]},
                )
            assert resp.status_code == 200
            assert any(
                "auth.refresh rotated old_key=" in r.message
                and "new_key=" in r.message
                and f"user_id={seeded['user_id']}" in r.message
                for r in caplog.records
            ), f"rotation 관측성 로그 누락: {[r.message for r in caplog.records]}"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_refresh_success_records_replaced_by_on_winner_realdb():
    """story #2449: 원자 rotation 승자 경로에서 old row.replaced_by가 새 row.id로 정확히
    채워지는지 실증 — 이 값이 없으면 「정상 회전 死(승계자 有) vs logout 같은 명시적
    dead-end(승계자 無)」를 구분할 감사열 자체가 비어 이 changeset의 핵심 주장(판정 로직은
    안 바꾸고 감사기록만 추가)이 근거 없는 선언이 된다."""
    from app.main import app
    from app.core.security import hash_token
    from app.models.user import RefreshToken
    from sqlalchemy import select as sa_select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_user_with_refresh_token(s)

        await _setup_app(app, Session)
        client = _client_for(app)
        try:
            resp = await client.post(
                "/api/v2/auth/refresh", json={"refresh_token": seeded["raw_refresh"]},
            )
            assert resp.status_code == 200, resp.text
            new_raw = resp.json()["data"]["refresh_token"]

            async with Session() as s:
                old_row = (await s.execute(
                    sa_select(RefreshToken).where(
                        RefreshToken.token_hash == hash_token(seeded["raw_refresh"])
                    )
                )).scalar_one()
                new_row = (await s.execute(
                    sa_select(RefreshToken).where(RefreshToken.token_hash == hash_token(new_raw))
                )).scalar_one()

            assert old_row.revoked_at is not None, "승자 rotation인데 old row가 revoke 안 됨"
            assert old_row.replaced_by == new_row.id, (
                f"replaced_by 미기록/불일치 — old.replaced_by={old_row.replaced_by} "
                f"new.id={new_row.id}"
            )
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_refresh_chain_resolve_window_fork_leaves_replaced_by_null_realdb():
    """story #2449: 해소 허용창 안 fork(loser) 경로는 replaced_by를 «절대» 안 건드린다는 걸
    실증한다 — 이게 이 changeset이 피한 하자(살아있는 successor를 straggler가 먼저 소비)의
    반대증명: fork된 새 row 자신의 replaced_by는 NULL(아직 아무도 그걸 회전 안 함), 그리고
    승자가 만든 old→new 링크는 loser 응답과 무관하게 그대로 유지된다."""
    from app.main import app
    from app.core.security import hash_token
    from app.models.user import RefreshToken
    from sqlalchemy import select as sa_select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_user_with_refresh_token(s)

        await _setup_app(app, Session)
        client = _client_for(app)
        try:
            winner = await client.post(
                "/api/v2/auth/refresh", json={"refresh_token": seeded["raw_refresh"]},
            )
            assert winner.status_code == 200, winner.text
            winner_new_raw = winner.json()["data"]["refresh_token"]

            # 원 토큰으로 재사용(창 안) — loser fork 경로를 태운다.
            loser = await client.post(
                "/api/v2/auth/refresh", json={"refresh_token": seeded["raw_refresh"]},
            )
            assert loser.status_code == 200, loser.text
            loser_new_raw = loser.json()["data"]["refresh_token"]
            assert loser_new_raw != winner_new_raw

            async with Session() as s:
                old_row = (await s.execute(
                    sa_select(RefreshToken).where(
                        RefreshToken.token_hash == hash_token(seeded["raw_refresh"])
                    )
                )).scalar_one()
                winner_row = (await s.execute(
                    sa_select(RefreshToken).where(RefreshToken.token_hash == hash_token(winner_new_raw))
                )).scalar_one()
                loser_row = (await s.execute(
                    sa_select(RefreshToken).where(RefreshToken.token_hash == hash_token(loser_new_raw))
                )).scalar_one()

            assert old_row.replaced_by == winner_row.id, "승자 링크가 loser fork로 덮어써짐"
            assert loser_row.replaced_by is None, (
                "loser fork row에 replaced_by가 채워짐 — 살아있는 노드를 건드리는 하자가 재발했을 수 있는 신호"
            )
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
