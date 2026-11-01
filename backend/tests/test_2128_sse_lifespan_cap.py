"""story #2128(2026-07-24, critical) — SSE wall-clock 수명 상한(v2 설계 ①본체).

realtime-dev가 이 병으로 죽어 있었다: GCLB 뒤에서 클라 disconnect가 백엔드로 전파 안 되고
(코드는 정상 — request.is_disconnected() 체크·finally discard 둘 다 있음), 연결이 Cloud Run
타임아웃(3600s)까지 자연 종료 없이 640슬롯을 점유했다(관측: 점유 중앙값 3601초). 처방 —
disconnect 감지 여부와 완전히 무관하게 발동하는 wall-clock 상한을 본체로 둔다(좀비가 스스로
늘릴 수 없는 유일한 축).

browser(events.py)는 test_c4c72eb1_sse_shutdown_aware.py의 검증된 패턴(라우트 함수 직접
호출 + body_iterator 직접 펌프, ASGI 계층 우회)을 그대로 재사용. agent(agent_gateway.py)는
DB 상태(AgentGatewaySession·presence)까지 검증해야 해 실PG로 간다.
"""
from __future__ import annotations

import asyncio
import time
import uuid
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from tests.agent_stream_auth import agent_stream_claims, seed_agent_stream_key

_REAL_DB_URL = __import__("os").getenv("PARITY_TEST_DATABASE_URL") or __import__("os").getenv("ALEMBIC_DATABASE_URL")

# story 8236bbc3 컨벤션: 이 파일의 agent 경로 realdb 테스트가 create_all/drop_all을 쓴다 —
# 파일 전체에 마커(mock 전용 테스트도 포함, 개별 함수 마커만으론 AST 가드가 통과 안 됨).
pytestmark = pytest.mark.destructive_schema


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _make_mock_session():
    session = AsyncMock()
    session.add = MagicMock()
    session.commit = AsyncMock()
    session.refresh = AsyncMock()
    session.execute = AsyncMock()
    return session


def _membership_ok(member_id: uuid.UUID) -> MagicMock:
    r = MagicMock()
    r.scalar_one_or_none.return_value = member_id
    return r


def _pending_empty() -> MagicMock:
    scalars = MagicMock()
    scalars.all.return_value = []
    r = MagicMock()
    r.scalars.return_value = scalars
    return r


class _FakeRequest:
    headers: dict = {}

    async def is_disconnected(self) -> bool:
        return False


# ── browser(events.py) — test_c4c72eb1 패턴 재사용 ──────────────────────────
@pytest.mark.anyio
async def test_browser_lifespan_cap_triggers_finite_reconnect_and_cleanup():
    """AC1/AC2 — disconnect 감지와 무관하게(위 _FakeRequest는 항상 is_disconnected()=False,
    #2128의 실제 라이브 증상 그대로 재현) wall-clock 상한만으로 유한 시간 내 종료 + 슬롯 반납."""
    import app.routers.events as ev_module

    member_id = uuid.uuid4()
    org = uuid.uuid4()

    mock_sess = _make_mock_session()
    mock_sess.execute.side_effect = [_membership_ok(member_id), _pending_empty()]

    @asynccontextmanager
    async def _factory():
        yield mock_sess

    auth_ctx = MagicMock()
    auth_ctx.user_id = str(member_id)
    # story #4565: a real agent key session carries its key's DB id (a UUID — dependencies/auth.py:271); the open-stream key
    # recheck (services/stream_access.py · not this test's subject) is held at «allowed» below
    auth_ctx.claims = {"app_metadata": {"api_key_id": str(uuid.uuid4()), "org_id": str(org)}}

    count_before = ev_module._sse_connection_count
    saw_lifespan_event = False
    elapsed = None
    try:
        with patch("app.core.database.async_session_factory", _factory), \
             patch("app.services.stream_access.key_access_revoked", AsyncMock(return_value=None)):
            # 수명상한 체크는 while 루프 top에서 heartbeat-tick 주기로만 재평가된다(매
            # asyncio.wait(timeout=heartbeat)를 다 기다려야 다음 체크로 넘어감) — 그래서
            # 하트비트도 함께 짧게 잡아야 짧은 수명상한이 실제로 빠르게 감지된다(프로덕션은
            # 30s 하트비트 주기 오차가 600s/1800s 상한 대비 무시할 수준이라 문제 없음).
            with patch.object(ev_module, "_SSE_HEARTBEAT_TIMEOUT", 0.02), \
                 patch.object(ev_module, "_SSE_LIFESPAN_SEC", 0.05), \
                 patch.object(ev_module, "_SSE_LIFESPAN_JITTER_SEC", 0.0):
                response = await ev_module.agent_event_stream(
                    request=_FakeRequest(),
                    member_id=None,
                    auth=auth_ctx,
                    org_id=org,
                    since_timestamp=None,
                    last_event_id=None,
                )
                assert ev_module._sse_connection_count == count_before + 1

                started = time.monotonic()
                async for chunk in response.body_iterator:
                    if "lifespan_reconnect" in chunk:
                        saw_lifespan_event = True
                elapsed = time.monotonic() - started

        assert saw_lifespan_event, "lifespan_reconnect 이벤트가 스트림에 안 실림 — 상한 미발동"
        assert elapsed is not None and elapsed < 5.0, (
            f"수명상한 반응이 너무 느림({elapsed}s) — disconnect 신호 없이도 유한 시간 내 종료해야"
        )
        await asyncio.sleep(0.05)
        assert ev_module._sse_connection_count == count_before, "수명초과 후 카운터 정리 안 됨(AC2)"
    finally:
        ev_module._agent_connections.pop(str(member_id), None)
        ev_module._sse_connection_count = count_before
        # generate()가 내부적으로 shutdown_event.wait()를 태스크로 태워 이 테스트의 이벤트
        # 루프에 바인딩시킨다 — 리셋 안 하면 다음 테스트(다른 루프)가 cross-loop
        # RuntimeError를 맞는다(test_c4c72eb1_sse_shutdown_aware.py와 동일 관례).
        from app.core import shutdown as _shutdown_module
        _shutdown_module.reset_shutdown_event()


@pytest.mark.anyio
async def test_browser_lifespan_cap_does_not_fire_under_normal_duration():
    """AC4 — 상한이 넉넉히 크면(정상 상황) 하트비트/이벤트 경로가 그대로 동작(회귀 0).
    짧은 관찰 구간 안에서 lifespan_reconnect가 섞이지 않는지만 확認(무한 대기 방지 위해
    heartbeat 타임아웃도 짧게 잡고 몇 틱만 관찰)."""
    import app.routers.events as ev_module

    member_id = uuid.uuid4()
    org = uuid.uuid4()

    mock_sess = _make_mock_session()
    mock_sess.execute.side_effect = [_membership_ok(member_id), _pending_empty()]

    @asynccontextmanager
    async def _factory():
        yield mock_sess

    auth_ctx = MagicMock()
    auth_ctx.user_id = str(member_id)
    # story #4565: a real agent key session carries its key's DB id (a UUID — dependencies/auth.py:271); the open-stream key
    # recheck (services/stream_access.py · not this test's subject) is held at «allowed» below
    auth_ctx.claims = {"app_metadata": {"api_key_id": str(uuid.uuid4()), "org_id": str(org)}}

    count_before = ev_module._sse_connection_count
    chunks: list[str] = []
    try:
        with patch("app.core.database.async_session_factory", _factory), \
             patch("app.services.stream_access.key_access_revoked", AsyncMock(return_value=None)):
            with patch.object(ev_module, "_SSE_HEARTBEAT_TIMEOUT", 0.05), \
                 patch.object(ev_module, "_SSE_LIFESPAN_SEC", 600.0), \
                 patch.object(ev_module, "_SSE_LIFESPAN_JITTER_SEC", 0.0):
                response = await ev_module.agent_event_stream(
                    request=_FakeRequest(),
                    member_id=None,
                    auth=auth_ctx,
                    org_id=org,
                    since_timestamp=None,
                    last_event_id=None,
                )
                agen = response.body_iterator
                for _ in range(4):  # 초기 heartbeat + 하트비트 tick 몇 번
                    chunks.append(await agen.__anext__())
                await agen.aclose()
        assert not any("lifespan_reconnect" in c for c in chunks), (
            "600s 상한인데 짧은 관찰 구간에 발동 — 회귀"
        )
        assert any("heartbeat" in c for c in chunks)
    finally:
        ev_module._agent_connections.pop(str(member_id), None)
        ev_module._sse_connection_count = count_before
        from app.core import shutdown as _shutdown_module
        _shutdown_module.reset_shutdown_event()


# ── agent(agent_gateway.py) — 실PG로 세션row/presence까지 검증(AC2/AC3) ─────
async def _realdb_session():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from app.core.database import Base
    import app.models  # noqa: F401

    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql://"):
        if url.startswith(prefix):
            url = "postgresql+asyncpg://" + url[len(prefix):]
            break
    engine = create_async_engine(url)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_org_project_agent(session):
    from app.models.organization import Organization
    from app.models.project import Project
    from app.models.team import TeamMember

    org = Organization(id=uuid.uuid4(), name="Org2128", slug=f"org2128-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    agent = TeamMember(
        id=uuid.uuid4(), org_id=org.id, project_id=project.id, type="agent", name="agent",
        is_active=True,
    )
    session.add(agent)
    await session.commit()
    return org.id, project.id, agent.id


@pytest.mark.anyio
@pytest.mark.destructive_schema
@pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요")
async def test_agent_lifespan_cap_reclaims_slot_and_presence():
    """AC2/AC3 — 에이전트 경로: 수명상한 발동 시 연결 카운트·AgentGatewaySession row·presence
    offline까지 실제로 회수되는지(기존 finally: 무수정 — 정상/이상/수명초과 전부 같은 경로)."""
    import app.routers.agent_gateway as gw_module
    from app.models.agent_gateway import AgentGatewaySession
    from sqlalchemy import select

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, agent_id = await _seed_org_project_agent(s)
            key_id = await seed_agent_stream_key(s, agent_id)  # the stream rechecks its key each tick (story #4434)

        auth_ctx = MagicMock()
        auth_ctx.user_id = str(agent_id)
        auth_ctx.claims = agent_stream_claims(key_id)

        @asynccontextmanager
        async def _factory():
            async with Session() as s:
                yield s

        count_before = gw_module._agent_sse_connection_count
        saw_lifespan_event = False
        elapsed = None
        with patch("app.core.database.async_session_factory", _factory), \
             patch.object(gw_module, "_SSE_HEARTBEAT", 0.02), \
             patch.object(gw_module, "_AGENT_SSE_LIFESPAN_SEC", 0.05), \
             patch.object(gw_module, "_AGENT_SSE_LIFESPAN_JITTER_SEC", 0.0), \
             patch.object(gw_module, "_LIFESPAN_END_GRACE_SEC", 0.0), \
             patch("app.services.onboarding_funnel.emit_onboarding_event", AsyncMock()):
            response = await gw_module.agent_stream(request=_FakeRequest(), auth=auth_ctx)
            assert gw_module._agent_sse_connection_count == count_before + 1

            started = time.monotonic()
            async for chunk in response.body_iterator:
                if "lifespan_reconnect" in chunk:
                    saw_lifespan_event = True
            elapsed = time.monotonic() - started

        assert saw_lifespan_event, "lifespan_reconnect 이벤트가 스트림에 안 실림"
        assert elapsed is not None and elapsed < 5.0

        await asyncio.sleep(0.05)
        assert gw_module._agent_sse_connection_count == count_before, "수명초과 후 카운터 정리 안 됨"
        assert not gw_module._agent_connections.get(str(agent_id)), "queue 정리 안 됨"

        async with Session() as s:
            remaining = (await s.execute(
                select(AgentGatewaySession).where(AgentGatewaySession.agent_id == agent_id)
            )).scalars().all()
            assert remaining == [], "AgentGatewaySession row가 정리 안 됨(AC2/AC3)"
    finally:
        from app.core.database import Base
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()
        from app.core import shutdown as _shutdown_module
        _shutdown_module.reset_shutdown_event()


# ── story #4834 (AC4): a lifespan end stamps its row to expire; it does not delete it ──────────────────────────────────────────────────────────────
class _DisconnectingRequest:
    headers: dict = {}

    async def is_disconnected(self) -> bool:
        return True


@asynccontextmanager
async def _agent_env(*, redis_presence_on: bool = False):
    """A real database and one seeded agent with a stream key. Redis presence is OFF (the configuration dev and prod run) unless `redis_presence_on`: then the flag and a URL
    are set and the online-key calls are stand-ins (a lifespan end must then be cleaned at once, as before). Yields what a test needs."""
    from contextlib import ExitStack

    from app.core.config import settings
    from app.services import presence_online

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, agent_id = await _seed_org_project_agent(s)
            key_id = await seed_agent_stream_key(s, agent_id)
        auth_ctx = MagicMock()
        auth_ctx.user_id = str(agent_id)
        auth_ctx.claims = agent_stream_claims(key_id)

        @asynccontextmanager
        async def _factory():
            async with Session() as s:
                yield s

        online_calls: dict[str, AsyncMock] = {}
        with ExitStack() as stack:
            stack.enter_context(patch("app.core.database.async_session_factory", _factory))
            stack.enter_context(patch("app.services.onboarding_funnel.emit_onboarding_event", AsyncMock()))
            if redis_presence_on:
                stack.enter_context(patch.object(settings, "presence_online_redis_enabled", True))
                stack.enter_context(patch.object(settings, "redis_url", "redis://fake"))
                for name, ret in (("mark_online", None), ("clear_online", None), ("is_online", True)):
                    online_calls[name] = AsyncMock(return_value=ret)
                    stack.enter_context(patch.object(presence_online, name, online_calls[name]))
            yield Session, agent_id, auth_ctx, online_calls
    finally:
        from app.core.database import Base
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()
        from app.core import shutdown as _shutdown_module
        _shutdown_module.reset_shutdown_event()


async def _stream_to_its_end(auth_ctx, *, grace: float, lifespan: float = 0.05, request=None) -> None:
    import app.routers.agent_gateway as gw_module

    with patch.object(gw_module, "_SSE_HEARTBEAT", 0.02), \
         patch.object(gw_module, "_AGENT_SSE_LIFESPAN_SEC", lifespan), \
         patch.object(gw_module, "_AGENT_SSE_LIFESPAN_JITTER_SEC", 0.0), \
         patch.object(gw_module, "_LIFESPAN_END_GRACE_SEC", grace):
        response = await gw_module.agent_stream(request=request or _FakeRequest(), auth=auth_ctx)
        async for _ in response.body_iterator:
            pass


async def _readers(Session, agent_id) -> dict[str, bool]:
    """What each reader of the session row says about the agent right now."""
    from app.services.agent_push_reach import push_reachable_agent_ids
    from app.services.agent_verify import _has_fresh_session

    async with Session() as db:
        reach = agent_id in await push_reachable_agent_ids(db, {agent_id}, webhook_covered=set())
        verified = await _has_fresh_session(db, agent_id)
    return {"agent_push_reach": reach, "agent_verify": verified}


async def _session_rows(Session, agent_id) -> list:
    from app.models.agent_gateway import AgentGatewaySession
    from sqlalchemy import select

    async with Session() as s:
        return list((await s.execute(select(AgentGatewaySession).where(AgentGatewaySession.agent_id == agent_id))).scalars().all())


async def _drain(it) -> None:
    async for _ in it:
        pass


@pytest.mark.anyio
@pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요")
async def test_a_lifespan_end_keeps_the_agent_live_for_every_reader_through_the_reconnect_gap():
    """story #4834 — the stream ends by its lifespan and the client has not come back yet: the row is still there (stamped, not deleted) and each reader of it — the
    send's reach check (`agent_push_reach`, which makes `agent_wake`) and the connection test (`agent_verify`) — still reads the agent as live."""
    async with _agent_env() as (Session, agent_id, auth_ctx, _):
        await _stream_to_its_end(auth_ctx, grace=3.0)
        assert len(await _session_rows(Session, agent_id)) == 1, "the row is stamped, not deleted"
        for reader, live in (await _readers(Session, agent_id)).items():
            assert live, f"{reader} reads the agent as gone in the gap"


@pytest.mark.anyio
@pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요")
@pytest.mark.parametrize("reader", ["agent_push_reach", "agent_verify"])
async def test_every_reader_reads_the_agent_as_gone_once_the_expiry_has_run_out(reader):
    """story #4834 (PO condition, #2128's «no false online»): the stamped row is not a live session for ever — when its expiry (1.5 s here, 20 s in production) has run
    out, each reader says the agent is gone. A reader that kept reading the row as live would turn red here."""
    async with _agent_env() as (Session, agent_id, auth_ctx, _):
        await _stream_to_its_end(auth_ctx, grace=1.5)
        assert (await _readers(Session, agent_id))[reader], f"{reader} already reads it as gone inside the expiry"
        await asyncio.sleep(1.8)
        assert not (await _readers(Session, agent_id))[reader], f"{reader} still reads the agent as live after the expiry"


@pytest.mark.anyio
@pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요")
async def test_the_expiry_never_outlasts_half_the_freshness_window():
    """story #4834 (codex round 12) — the stamp shortens the freshness window (`SSE_HEARTBEAT_TIMEOUT` can lower it): an expiry longer than that window would be read as
    gone before it is up. It is cut to half the window; with a 3 s window and a 20 s expiry asked for, the agent reads live at first and gone after 1.5 s + a margin."""
    import app.routers.agent_gateway as gw_module

    async with _agent_env() as (Session, agent_id, auth_ctx, _):
        with patch.object(gw_module, "_SESSION_FRESH_TTL", 3.0):
            await _stream_to_its_end(auth_ctx, grace=20.0)
            assert all((await _readers(Session, agent_id)).values()), "live inside the (cut) expiry"
            rows = await _session_rows(Session, agent_id)
            from datetime import datetime, timezone

            seen_ago = (datetime.now(timezone.utc) - rows[0].last_seen_at).total_seconds()
            assert 1.0 < seen_ago < 2.5, f"the stamp was cut to half of 3 s: last_seen_at is {seen_ago:.1f} s old (it would be ~0 s if not cut: the whole window is then left)"
            await asyncio.sleep(1.9)
            assert not any((await _readers(Session, agent_id)).values()), "gone once the cut expiry has run out"


@pytest.mark.anyio
@pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요")
async def test_the_screens_presence_is_demoted_at_the_lifespan_end_as_for_a_disconnect():
    """story #4834 (PO condition) — the online/offline the screen shows is stored on the agent's profile (`last_seen_at` · `agent_status`): a lifespan end still demotes it
    at once when no other session is live (the short blink until the client is back is accepted), so it never reads online after the expiry. The stamped row of this very
    session is not «another live session»."""
    async with _agent_env() as (Session, agent_id, auth_ctx, _):
        with patch("app.services.agent_anchor_sync.sync_agent_profile_presence", new=AsyncMock()) as sync:
            await _stream_to_its_end(auth_ctx, grace=3.0)
        last = sync.await_args_list[-1]
        assert last.kwargs.get("last_seen_at") is None and last.kwargs.get("agent_status") == "offline", last


@pytest.mark.anyio
@pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요")
async def test_a_reconnect_inside_the_expiry_has_its_own_row_and_the_stamped_one_is_swept_at_the_next_end():
    """story #4834 — the client comes back inside the expiry: the new stream holds its own live row, so the agent reads live also after the old stamp has run out; when that
    connection ends for real, the cleanup sweeps the expired stamp too (no row is left behind)."""
    import app.routers.agent_gateway as gw_module

    async with _agent_env() as (Session, agent_id, auth_ctx, _):
        await _stream_to_its_end(auth_ctx, grace=1.0)
        with patch.object(gw_module, "_SSE_HEARTBEAT", 0.02), \
             patch.object(gw_module, "_AGENT_SSE_LIFESPAN_SEC", 30.0), \
             patch.object(gw_module, "_AGENT_SSE_LIFESPAN_JITTER_SEC", 0.0):
            response = await gw_module.agent_stream(request=_FakeRequest(), auth=auth_ctx)
            consumer = asyncio.ensure_future(_drain(response.body_iterator.__aiter__()))
            try:
                await asyncio.sleep(1.5)  # the old stamp (1.0 s) has run out
                assert len(await _session_rows(Session, agent_id)) == 2, "the new stream has its own row beside the stamped one"
                for reader, live in (await _readers(Session, agent_id)).items():
                    assert live, f"{reader}: the reconnected agent reads as gone"
            finally:
                consumer.cancel()
                await asyncio.gather(consumer, return_exceptions=True)
        await asyncio.sleep(0.2)  # the connection ended (cancelled) → the cleanup of that end swept the expired stamp as well
        assert await _session_rows(Session, agent_id) == [], "no row left behind"


@pytest.mark.anyio
@pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요")
async def test_a_real_disconnect_is_cleaned_at_once_whatever_the_expiry_is():
    """story #4834 — only a lifespan end is stamped. A client that went away (`is_disconnected`) is cleaned at once as before: the row is gone and no reader reads the agent
    as live, however long the expiry is."""
    async with _agent_env() as (Session, agent_id, auth_ctx, _):
        await _stream_to_its_end(auth_ctx, grace=30.0, lifespan=30.0, request=_DisconnectingRequest())
        assert await _session_rows(Session, agent_id) == [], "the row of a real disconnect is deleted at once"
        for reader, live in (await _readers(Session, agent_id)).items():
            assert not live, f"{reader} reads a disconnected agent as live"


@pytest.mark.anyio
@pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요")
async def test_expiry_zero_is_the_old_cleanup_at_the_lifespan_end():
    """story #4834 — `AGENT_SSE_LIFESPAN_END_GRACE_SEC=0` switches the stamp off: a lifespan end deletes its row at once, as before this change."""
    async with _agent_env() as (Session, agent_id, auth_ctx, _):
        await _stream_to_its_end(auth_ctx, grace=0.0)
        assert await _session_rows(Session, agent_id) == []


@pytest.mark.anyio
@pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요")
async def test_with_redis_presence_on_a_lifespan_end_is_cleaned_at_once_as_before():
    """story #4834 (PO decision) — Redis presence on (default off; no deployment runs it): its readers judge by the online key, which the stamp does not touch, so a lifespan end
    keeps the old behaviour there: the row is deleted and the key cleared at once."""
    async with _agent_env(redis_presence_on=True) as (Session, agent_id, auth_ctx, online):
        await _stream_to_its_end(auth_ctx, grace=30.0)
        assert await _session_rows(Session, agent_id) == [], "no stamp with Redis presence on"
        online["clear_online"].assert_awaited()


@pytest.mark.anyio
@pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요")
async def test_a_stamped_row_is_not_a_live_sibling_when_the_next_connection_really_ends():
    """story #4834 (codex round 10) — the client reconnected inside the expiry and that connection went away at once (before the first stamp ran out): its cleanup must not
    count the earlier session's stamped row as «another live session», or the agent is never demoted (the connect wrote it online) and reads online after the expiry."""
    async with _agent_env() as (Session, agent_id, auth_ctx, _):
        with patch("app.services.agent_anchor_sync.sync_agent_profile_presence", new=AsyncMock()) as sync:
            await _stream_to_its_end(auth_ctx, grace=30.0)  # the stamp (up to 60 s) is still running below
            await _stream_to_its_end(auth_ctx, grace=30.0, lifespan=30.0, request=_DisconnectingRequest())  # the next connection goes away for real
        last = sync.await_args_list[-1]
        assert last.kwargs.get("last_seen_at") is None and last.kwargs.get("agent_status") == "offline", f"not demoted — {last}"


@pytest.mark.anyio
@pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요")
async def test_two_streams_that_end_together_both_skip_the_demotion_but_the_expiry_still_decides_the_end():
    """story #4834 (PO condition on the known race) — two streams of one agent that end at the same moment can each see the other as a live sibling before either has
    stamped, so neither demotes (the same race develop has for two simultaneous disconnects). What must hold whatever the interleaving: the readers do not read the
    agent as live for ever — after the expiry both stamped rows are gone from every reader's view."""
    import app.routers.agent_gateway as gw_module
    from datetime import datetime, timedelta, timezone

    from app.models.agent_gateway import AgentGatewaySession

    async with _agent_env() as (Session, agent_id, auth_ctx, _):
        ids = [uuid.uuid4(), uuid.uuid4()]
        async with Session() as s:
            now = datetime.now(timezone.utc)
            for sid in ids:
                s.add(AgentGatewaySession(id=sid, agent_id=agent_id, connected_at=now - timedelta(seconds=100), last_seen_at=now))
            await s.commit()
        with patch("app.services.agent_anchor_sync.sync_agent_profile_presence", new=AsyncMock()):
            await asyncio.gather(*(gw_module._mark_agent_disconnected(agent_id, sid, None, expire_in=2.0) for sid in ids))
        assert all((await _readers(Session, agent_id)).values()), "inside the expiry the agent still reads live"
        await asyncio.sleep(2.3)
        assert not any((await _readers(Session, agent_id)).values()), "after the expiry no reader reads the agent as live, whichever of the two demoted"


@pytest.mark.anyio
@pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요")
async def test_a_long_lived_real_connection_still_counts_as_a_live_sibling():
    """story #4834 (PO) — the other side of the sibling line: a real connection that is 3650 s old (near the 3600 s cap, still ticking) is a live sibling, so the cleanup of
    another connection of the same agent does not demote it. A line drawn too low would stop counting it and the agent would read offline while it is connected."""
    from datetime import datetime, timedelta, timezone

    from app.models.agent_gateway import AgentGatewaySession

    async with _agent_env() as (Session, agent_id, auth_ctx, _):
        async with Session() as s:
            now = datetime.now(timezone.utc)
            s.add(AgentGatewaySession(id=uuid.uuid4(), agent_id=agent_id, connected_at=now - timedelta(seconds=3650), last_seen_at=now))
            await s.commit()
        with patch("app.services.agent_anchor_sync.sync_agent_profile_presence", new=AsyncMock()) as sync:
            await _stream_to_its_end(auth_ctx, grace=30.0, lifespan=30.0, request=_DisconnectingRequest())  # another connection of the agent goes away for real
        demotions = [c for c in sync.await_args_list if c.kwargs.get("last_seen_at") is None and c.kwargs.get("agent_status") == "offline"]
        assert not demotions, "the agent was demoted while a live connection (3650 s old) was still there"


def test_the_sibling_window_is_derived_from_the_lifetime_cap_and_sits_above_a_real_connection():
    """story #4834 (PO) — the line between «a live connection» and «a stamped (expiring) row» is not a number of its own: it is the lifetime cap minus the longest stamp, so it
    moves with the cap; and it must stay above what a real connection can reach (Cloud Run / GCLB hard cap 3600 s), or a live long connection would stop counting as a
    sibling. A stamp of the longest expiry starts exactly at the line (so it is on the stamped side)."""
    import inspect

    import app.routers.agent_gateway as gw_module

    assert gw_module._SIBLING_LIFETIME_SEC == gw_module._MAX_SSE_LIFETIME_SEC - gw_module._STAMP_MAX_SEC
    # (the value alone cannot tell a derived line from a number that happens to be the same today — the formula is pinned in the source, as this file does for its other contracts)
    assert "_SIBLING_LIFETIME_SEC: float = _MAX_SSE_LIFETIME_SEC - _STAMP_MAX_SEC" in inspect.getsource(gw_module)
    assert gw_module._SIBLING_LIFETIME_SEC > 3600.0, "a connection at its hard cap must still be a live sibling"


def test_the_expiry_from_the_environment_is_parsed_defensively():
    from app.routers.agent_gateway import _lifespan_end_grace_from_env as parse

    assert parse(None) == 20.0 and parse("") == 20.0 and parse("  ") == 20.0
    assert parse("0") == 0.0 and parse("7.5") == 7.5
    assert parse("500") == 60.0, "a longer expiry is cut to the most a stamp may have (its connected_at must stay older than any live connection)"
    for bad in ("abc", "nan", "inf", "-inf", "-1"):
        assert parse(bad) == 20.0, bad


# ── 소스 고정 — pinning 테스트(오늘 팀 관례) ────────────────────────────────
def test_browser_breaking_condition_declared():
    import inspect
    import app.routers.events as ev_module

    source = inspect.getsource(ev_module)
    assert "90s를 넘겨야 하는 정당한 경로" in source and "무너지는 조건" in source


def test_agent_breaking_condition_declared():
    import inspect
    import app.routers.agent_gateway as gw_module

    source = inspect.getsource(gw_module)
    assert "한 자릿수 이상 늘어나" in source
    assert "무너지는 조건" in source


def test_lifespan_cap_uses_same_finally_no_special_casing():
    """오르테가군 지시 — "completed로 위장 금지·CAS로 전이"의 SSE 적용: 수명초과 종료가
    기존 finally: 블록과 별도의 정리 경로를 만들지 않았는지 소스 고정(정상·이상·수명초과가
    모두 같은 finally 하나를 탄다)."""
    import inspect
    import app.routers.events as ev_module
    import app.routers.agent_gateway as gw_module

    ev_source = inspect.getsource(ev_module.agent_event_stream)
    gw_source = inspect.getsource(gw_module.agent_stream)
    # lifespan_reconnect 분기가 return만 하고(그 안에서 카운터 조작을 직접 하지 않음),
    # 정리는 바깥 finally:가 담당 — 새 finally 블록을 안 만들었는지 개수로 확認.
    assert ev_source.count("_sse_connection_count -= 1") == 1
    assert gw_source.count("_agent_sse_connection_count -= 1") == 1
