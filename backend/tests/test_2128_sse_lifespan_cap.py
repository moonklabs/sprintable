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


async def _wait_for(cond, timeout: float = 5.0, step: float = 0.05) -> bool:
    """story #4834: poll an async condition instead of sleeping a fixed time (a real-PG cleanup takes as long as it takes)."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if await cond():
            return True
        await asyncio.sleep(step)
    return await cond()


class _DisconnectingRequest:
    """story #4834: a client that goes away — `is_disconnected()` turns True after `after` checks (a real disconnect, not a lifespan end)."""
    headers: dict = {}

    def __init__(self, after: int = 2) -> None:
        self._n = 0
        self._after = after

    async def is_disconnected(self) -> bool:
        self._n += 1
        return self._n > self._after


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

        # story #4834: the cleanup of a lifespan end runs in a task of its own (grace 0 here) — wait for the condition, not a fixed time
        async def _row_gone() -> bool:
            async with Session() as s:
                return not (await s.execute(select(AgentGatewaySession).where(AgentGatewaySession.agent_id == agent_id))).scalars().all()

        assert await _wait_for(_row_gone), "AgentGatewaySession row가 정리 안 됨(AC2/AC3)"
        assert gw_module._agent_sse_connection_count == count_before, "수명초과 후 카운터 정리 안 됨"
        assert not gw_module._agent_connections.get(str(agent_id)), "queue 정리 안 됨"
    finally:
        from app.core.database import Base
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()
        from app.core import shutdown as _shutdown_module
        _shutdown_module.reset_shutdown_event()


@pytest.mark.anyio
@pytest.mark.destructive_schema
@pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요")
async def test_lifespan_end_keeps_the_agent_reachable_through_the_reconnect_gap():
    """story #4834 (AC4) — 4815/4834 phone walk: every ~5 min the stream's lifespan ends and the client reconnects within seconds; the cleanup of that end
    (session row deleted · presence offline) made every send in the gap read «this agent cannot be reached» (the web drew «type this sentence in the terminal»
    for an agent that was receiving). The cleanup of a LIFESPAN end now waits `_LIFESPAN_END_GRACE_SEC`: right after the stream ended the row is still there
    (the agent still reads as live to `push_reachable_agent_ids`), and once the grace has passed it is cleaned as before. Reverting the deferral turns the first
    assertion red."""
    import app.routers.agent_gateway as gw_module
    from app.models.agent_gateway import AgentGatewaySession
    from app.services.agent_push_reach import push_reachable_agent_ids
    from sqlalchemy import select

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

        _orig_disconnect = gw_module._mark_agent_disconnected
        _spy = AsyncMock(side_effect=_orig_disconnect)
        with patch("app.core.database.async_session_factory", _factory), \
             patch.object(gw_module, "_SSE_HEARTBEAT", 0.02), \
             patch.object(gw_module, "_AGENT_SSE_LIFESPAN_SEC", 0.05), \
             patch.object(gw_module, "_AGENT_SSE_LIFESPAN_JITTER_SEC", 0.0), \
             patch.object(gw_module, "_LIFESPAN_END_GRACE_SEC", 0.6), \
             patch.object(gw_module, "_mark_agent_disconnected", _spy), \
             patch("app.services.onboarding_funnel.emit_onboarding_event", AsyncMock()):
            response = await gw_module.agent_stream(request=_FakeRequest(), auth=auth_ctx)
            saw = False
            async for chunk in response.body_iterator:
                if "lifespan_reconnect" in chunk:
                    saw = True
            assert saw
            _spy.assert_not_called()  # the offline demotion · the row delete have not run in the gap

            # the stream has ended; its cleanup is still waiting — the gap in which a send used to say «cannot be reached»
            async with Session() as s:
                rows = (await s.execute(select(AgentGatewaySession).where(AgentGatewaySession.agent_id == agent_id))).scalars().all()
                assert len(rows) == 1, "a lifespan end must not delete the session row at once (the reconnect gap)"
                assert await push_reachable_agent_ids(s, {agent_id}, webhook_covered=set()) == {agent_id}, "the agent reads as unreachable in the gap"

            async def _row_gone() -> bool:
                async with Session() as s:
                    return not (await s.execute(select(AgentGatewaySession).where(AgentGatewaySession.agent_id == agent_id))).scalars().all()

            assert await _wait_for(_row_gone), "after the grace the row is cleaned as before"  # nobody came back
            _spy.assert_awaited_once()  # the same function, once
    finally:
        from app.core.database import Base
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()
        from app.core import shutdown as _shutdown_module
        _shutdown_module.reset_shutdown_event()


@pytest.mark.anyio
@pytest.mark.destructive_schema
@pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요")
async def test_a_real_disconnect_is_cleaned_at_once_without_the_grace():
    """story #4834 — only a lifespan end waits. A client that goes away (is_disconnected) is cleaned at once, whatever the grace is: the
    session row is gone and `_mark_agent_disconnected` ran before the (long) grace could have passed."""
    import app.routers.agent_gateway as gw_module
    from app.models.agent_gateway import AgentGatewaySession
    from sqlalchemy import select

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

        _orig = gw_module._mark_agent_disconnected
        _spy = AsyncMock(side_effect=_orig)
        with patch("app.core.database.async_session_factory", _factory), \
             patch.object(gw_module, "_SSE_HEARTBEAT", 0.02), \
             patch.object(gw_module, "_AGENT_SSE_LIFESPAN_SEC", 60.0), \
             patch.object(gw_module, "_AGENT_SSE_LIFESPAN_JITTER_SEC", 0.0), \
             patch.object(gw_module, "_LIFESPAN_END_GRACE_SEC", 30.0), \
             patch.object(gw_module, "_mark_agent_disconnected", _spy), \
             patch("app.services.onboarding_funnel.emit_onboarding_event", AsyncMock()):
            response = await gw_module.agent_stream(request=_DisconnectingRequest(after=2), auth=auth_ctx)
            saw_lifespan = False
            async for chunk in response.body_iterator:
                if "lifespan_reconnect" in chunk:
                    saw_lifespan = True
            assert not saw_lifespan, "this stream must end by the client going away, not by its lifespan"
            async def _row_gone() -> bool:
                async with Session() as s:
                    return not (await s.execute(select(AgentGatewaySession).where(AgentGatewaySession.agent_id == agent_id))).scalars().all()

            assert await _wait_for(_row_gone, timeout=3.0), "a real disconnect is cleaned at once"  # far below the 30 s grace
            _spy.assert_awaited_once()
    finally:
        from app.core.database import Base
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()
        from app.core import shutdown as _shutdown_module
        _shutdown_module.reset_shutdown_event()


@pytest.mark.anyio
@pytest.mark.destructive_schema
@pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요")
async def test_a_reconnect_inside_the_grace_keeps_its_own_session_and_only_the_old_row_goes():
    """story #4834 — the stream comes back inside the grace: when the old end's cleanup runs it finds a live session of the same agent and demotes
    nothing; only the OLD session row is deleted, the new connection's row stays."""
    import app.routers.agent_gateway as gw_module
    from app.models.agent_gateway import AgentGatewaySession
    from sqlalchemy import select

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

        with patch("app.core.database.async_session_factory", _factory), \
             patch.object(gw_module, "_SSE_HEARTBEAT", 0.02), \
             patch.object(gw_module, "_AGENT_SSE_LIFESPAN_SEC", 0.05), \
             patch.object(gw_module, "_AGENT_SSE_LIFESPAN_JITTER_SEC", 0.0), \
             patch.object(gw_module, "_LIFESPAN_END_GRACE_SEC", 4.0), \
             patch("app.services.onboarding_funnel.emit_onboarding_event", AsyncMock()):
            first = await gw_module.agent_stream(request=_FakeRequest(), auth=auth_ctx)
            async for _ in first.body_iterator:
                pass  # the first stream ends by its lifespan
            t_first_end = time.monotonic()
            async with Session() as s:
                old_ids = {r.id for r in (await s.execute(select(AgentGatewaySession).where(AgentGatewaySession.agent_id == agent_id))).scalars().all()}
            assert len(old_ids) == 1

            with patch.object(gw_module, "_AGENT_SSE_LIFESPAN_SEC", 60.0):
                second = await gw_module.agent_stream(request=_FakeRequest(), auth=auth_ctx)  # the reconnect, inside the grace
                it = second.body_iterator.__aiter__()
                await it.__anext__()  # it is up (a first frame went out)
                assert time.monotonic() - t_first_end < 3.0, "the reconnect must be up INSIDE the grace for this test to mean anything"

                async def _only_new_row() -> bool:
                    async with Session() as s:
                        ids = {r.id for r in (await s.execute(select(AgentGatewaySession).where(AgentGatewaySession.agent_id == agent_id))).scalars().all()}
                    return len(ids) == 1 and not (ids & old_ids)

                assert await _wait_for(_only_new_row, timeout=10.0), "the old row goes (after the grace) and the reconnect's own row stays"
                await it.aclose()
    finally:
        from app.core.database import Base
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()
        from app.core import shutdown as _shutdown_module
        _shutdown_module.reset_shutdown_event()


@pytest.mark.anyio
@pytest.mark.destructive_schema
@pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요")
async def test_the_shutdown_drain_cleans_up_a_waiting_lifespan_end_at_once():
    """story #4834 (codex) — a graceful shutdown cuts background tasks after 5 s (`pg_pubsub.drain_background_tasks`); a lifespan end still waiting out its grace
    must clean up NOW, not leave a session row or a stale online key behind (no zombies, #2128)."""
    import app.routers.agent_gateway as gw_module
    from app.models.agent_gateway import AgentGatewaySession
    from app.services import pg_pubsub
    from sqlalchemy import select

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

        _orig = gw_module._mark_agent_disconnected
        _spy = AsyncMock(side_effect=_orig)
        with patch("app.core.database.async_session_factory", _factory), \
             patch.object(gw_module, "_SSE_HEARTBEAT", 0.02), \
             patch.object(gw_module, "_AGENT_SSE_LIFESPAN_SEC", 0.05), \
             patch.object(gw_module, "_AGENT_SSE_LIFESPAN_JITTER_SEC", 0.0), \
             patch.object(gw_module, "_LIFESPAN_END_GRACE_SEC", 30.0), \
             patch.object(gw_module, "_mark_agent_disconnected", _spy), \
             patch("app.services.onboarding_funnel.emit_onboarding_event", AsyncMock()):
            response = await gw_module.agent_stream(request=_FakeRequest(), auth=auth_ctx)
            async for _ in response.body_iterator:
                pass  # ended by its lifespan; the cleanup waits (30 s grace)
            _spy.assert_not_called()
            # an ordinary background task (finishes by itself in 0.3 s) next to the 30 s grace: the drain must WAIT for the ordinary one and must NOT wait for the grace
            _finished: list[bool] = []

            async def _ordinary() -> None:
                await asyncio.sleep(0.3)
                _finished.append(True)

            pg_pubsub.fire_and_forget(_ordinary())
            _t0 = time.monotonic()
            await pg_pubsub.drain_background_tasks(timeout=5.0)  # the production budget: the waiting task is cut FIRST and cleans up inside it
            assert time.monotonic() - _t0 < 4.0, "the drain must not spend its 5 s budget waiting out the 30 s grace"
            assert _finished == [True], "the drain still waits for ordinary background work"
            _spy.assert_awaited_once()
            async with Session() as s:
                rows = (await s.execute(select(AgentGatewaySession).where(AgentGatewaySession.agent_id == agent_id))).scalars().all()
                assert rows == [], "a shutdown must not leave the session row of a waiting lifespan end"
    finally:
        from app.core.database import Base
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()
        from app.core import shutdown as _shutdown_module
        _shutdown_module.reset_shutdown_event()


@pytest.mark.anyio
@pytest.mark.destructive_schema
@pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요")
async def test_grace_zero_is_the_old_inline_cleanup_with_no_task_of_its_own():
    """story #4834 — `_LIFESPAN_END_GRACE_SEC <= 0` (the whole test suite's default, tests/conftest.py) = the cleanup of a lifespan end runs inside the stream's own end,
    exactly as before: the moment the stream's iteration has finished the cleanup has been awaited and the row is gone, and no background task is left that a closing
    test loop could cut (CI shard 3/6: «Event loop is closed» on the next test)."""
    import app.routers.agent_gateway as gw_module
    from app.models.agent_gateway import AgentGatewaySession
    from app.services import pg_pubsub
    from sqlalchemy import select

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

        _orig = gw_module._mark_agent_disconnected
        _spy = AsyncMock(side_effect=_orig)
        tasks_before = len([t for t in pg_pubsub._background_tasks if t.get_loop() is asyncio.get_running_loop()])
        with patch("app.core.database.async_session_factory", _factory), \
             patch.object(gw_module, "_SSE_HEARTBEAT", 0.02), \
             patch.object(gw_module, "_AGENT_SSE_LIFESPAN_SEC", 0.05), \
             patch.object(gw_module, "_AGENT_SSE_LIFESPAN_JITTER_SEC", 0.0), \
             patch.object(gw_module, "_LIFESPAN_END_GRACE_SEC", 0.0), \
             patch.object(gw_module, "_mark_agent_disconnected", _spy), \
             patch("app.services.onboarding_funnel.emit_onboarding_event", AsyncMock()):
            response = await gw_module.agent_stream(request=_FakeRequest(), auth=auth_ctx)
            async for _ in response.body_iterator:
                pass
            _spy.assert_awaited_once()  # at once — inside the stream's own end, not in a task started later
            tasks_after = len([t for t in pg_pubsub._background_tasks if t.get_loop() is asyncio.get_running_loop() and not t.done()])
            assert tasks_after <= tasks_before, "grace 0 must not leave a background task behind"
            async with Session() as s:
                rows = (await s.execute(select(AgentGatewaySession).where(AgentGatewaySession.agent_id == agent_id))).scalars().all()
                assert rows == [], "grace 0: the row is gone when the stream's iteration has finished"
    finally:
        from app.core.database import Base
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()
        from app.core import shutdown as _shutdown_module
        _shutdown_module.reset_shutdown_event()


@pytest.mark.anyio
@pytest.mark.destructive_schema
@pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요")
async def test_the_suites_end_of_test_hooks_reap_a_waiting_lifespan_end_inside_the_test_loop():
    """story #4834 (PO: CI shard 3/6 «Event loop is closed» on the next test) — a task that waits on purpose must not outlive its test's event loop: the conftest's
    end-of-test hooks (`_dispose_global_engine` for the non-destructive async tests, `drain_global_background_work` for the destructive ones) cut it first, in the
    test's own loop, so its «clean up now» path runs there. Reverting the call in either hook turns this red."""
    import app.routers.agent_gateway as gw_module
    from app.models.agent_gateway import AgentGatewaySession
    from app.services import pg_pubsub
    from sqlalchemy import select
    from tests import conftest as suite

    for hook_name in ("_dispose_global_engine", "drain_global_background_work"):
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

            _orig = gw_module._mark_agent_disconnected
            _spy = AsyncMock(side_effect=_orig)
            with patch("app.core.database.async_session_factory", _factory), \
                 patch.object(gw_module, "_SSE_HEARTBEAT", 0.02), \
                 patch.object(gw_module, "_AGENT_SSE_LIFESPAN_SEC", 0.05), \
                 patch.object(gw_module, "_AGENT_SSE_LIFESPAN_JITTER_SEC", 0.0), \
                 patch.object(gw_module, "_LIFESPAN_END_GRACE_SEC", 30.0), \
                 patch.object(gw_module, "_mark_agent_disconnected", _spy), \
                 patch("app.services.onboarding_funnel.emit_onboarding_event", AsyncMock()):
                response = await gw_module.agent_stream(request=_FakeRequest(), auth=auth_ctx)
                async for _ in response.body_iterator:
                    pass  # ended by its lifespan; the cleanup waits (30 s grace)
                loop = asyncio.get_running_loop()
                assert [t for t in pg_pubsub._cancel_first_tasks if not t.done() and t.get_loop() is loop], "the grace task is waiting"
                await getattr(suite, hook_name)()  # the end of the test
                assert not [t for t in pg_pubsub._cancel_first_tasks if not t.done() and t.get_loop() is loop], f"{hook_name}: no waiting task may be left"
                _spy.assert_awaited_once()
                async with Session() as s:
                    rows = (await s.execute(select(AgentGatewaySession).where(AgentGatewaySession.agent_id == agent_id))).scalars().all()
                    assert rows == [], f"{hook_name}: its cleanup ran (the row is gone)"
        finally:
            from app.core.database import Base
            async with engine.begin() as conn:
                await conn.run_sync(Base.metadata.drop_all)
            await engine.dispose()
            from app.core import shutdown as _shutdown_module
            _shutdown_module.reset_shutdown_event()


def test_the_grace_from_the_environment_is_parsed_defensively():
    """story #4834 (codex) — a typo must not fail the import of the whole router, `nan` must not switch the grace off silently, `inf` must not wait for ever."""
    from app.routers.agent_gateway import _lifespan_end_grace_from_env as parse

    assert parse(None) == 20.0 and parse("") == 20.0 and parse("  ") == 20.0
    assert parse("0") == 0.0 and parse("7.5") == 7.5 and parse("20") == 20.0
    for bad in ("abc", "nan", "inf", "-inf", "-3", "1e999"):
        assert parse(bad) == 20.0, bad


@pytest.mark.anyio
@pytest.mark.destructive_schema
@pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요")
async def test_the_drain_catches_a_grace_task_that_a_stream_end_registers_while_it_runs():
    """story #4834 (codex) — a stream's end is itself an ordinary background task that registers the grace task AFTER the drain's first look. The drain looks again
    after it has waited for the ordinary tasks, so that task is cut (and cleans up) inside the budget and does not survive into the engine's disposal."""
    import app.routers.agent_gateway as gw_module
    from app.models.agent_gateway import AgentGatewaySession
    from app.services import pg_pubsub
    from sqlalchemy import select

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

        _orig = gw_module._mark_agent_disconnected
        _spy = AsyncMock(side_effect=_orig)
        from app.services import sse_lease as _lease
        _real_release = _lease.release

        async def _slow_release(*a, **k):
            await asyncio.sleep(0.4)  # the stream's end is still running when the drain starts
            return await _real_release(*a, **k)

        with patch("app.core.database.async_session_factory", _factory), \
             patch.object(gw_module, "_SSE_HEARTBEAT", 0.02), \
             patch.object(gw_module, "_AGENT_SSE_LIFESPAN_SEC", 0.05), \
             patch.object(gw_module, "_AGENT_SSE_LIFESPAN_JITTER_SEC", 0.0), \
             patch.object(gw_module, "_LIFESPAN_END_GRACE_SEC", 30.0), \
             patch.object(gw_module, "_mark_agent_disconnected", _spy), \
             patch.object(_lease, "release", _slow_release), \
             patch("app.services.onboarding_funnel.emit_onboarding_event", AsyncMock()):
            response = await gw_module.agent_stream(request=_FakeRequest(), auth=auth_ctx)

            async def _consume() -> None:
                async for _ in response.body_iterator:
                    pass

            consumer = asyncio.ensure_future(_consume())
            await asyncio.sleep(0.25)  # the lifespan (0.05 s) has ended the stream; its end task is inside the slow release, the grace task is not registered yet
            loop = asyncio.get_running_loop()
            assert not [t for t in pg_pubsub._cancel_first_tasks if not t.done() and t.get_loop() is loop]
            _t0 = time.monotonic()
            await pg_pubsub.drain_background_tasks(timeout=5.0)
            assert time.monotonic() - _t0 < 4.0
            await consumer
            assert not [t for t in pg_pubsub._cancel_first_tasks if not t.done() and t.get_loop() is loop], "no waiting task survives the drain"
            _spy.assert_awaited_once()
            async with Session() as s:
                rows = (await s.execute(select(AgentGatewaySession).where(AgentGatewaySession.agent_id == agent_id))).scalars().all()
                assert rows == [], "the row of the late-registered grace task is cleaned inside the drain"
    finally:
        from app.core.database import Base
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()
        from app.core import shutdown as _shutdown_module
        _shutdown_module.reset_shutdown_event()


@pytest.mark.anyio
@pytest.mark.destructive_schema
@pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요")
async def test_a_second_cancel_cannot_cut_the_cleanup_half_way():
    """story #4834 (codex) — the grace task is cancelled by the drain, and maybe again (the end of its budget): once its cleanup has begun it runs to its end (its own
    shielded task) while the task itself still ends cancelled. A slow cleanup is cut a second time in the middle — it still finishes and the row is gone."""
    import app.routers.agent_gateway as gw_module
    from app.models.agent_gateway import AgentGatewaySession
    from app.services import pg_pubsub
    from sqlalchemy import select

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

        _orig = gw_module._mark_agent_disconnected
        finished: list[bool] = []

        async def _slow(*a, **k):
            await asyncio.sleep(0.5)  # a slow database
            await _orig(*a, **k)
            finished.append(True)

        with patch("app.core.database.async_session_factory", _factory), \
             patch.object(gw_module, "_SSE_HEARTBEAT", 0.02), \
             patch.object(gw_module, "_AGENT_SSE_LIFESPAN_SEC", 0.05), \
             patch.object(gw_module, "_AGENT_SSE_LIFESPAN_JITTER_SEC", 0.0), \
             patch.object(gw_module, "_LIFESPAN_END_GRACE_SEC", 30.0), \
             patch.object(gw_module, "_mark_agent_disconnected", _slow), \
             patch("app.services.onboarding_funnel.emit_onboarding_event", AsyncMock()):
            response = await gw_module.agent_stream(request=_FakeRequest(), auth=auth_ctx)
            async for _ in response.body_iterator:
                pass
            loop = asyncio.get_running_loop()
            waiting = [t for t in pg_pubsub._cancel_first_tasks if not t.done() and t.get_loop() is loop]
            assert len(waiting) == 1
            task = waiting[0]
            task.cancel()  # the drain: the wait is cut, the cleanup begins (slow)
            await asyncio.sleep(0.15)
            task.cancel()  # the budget's end: cancelled again in the middle of the cleanup
            await asyncio.wait([task], timeout=5.0)
            assert task.cancelled(), "the task itself ends cancelled"
            assert finished == [True], "the cleanup was not cut half-way by the second cancel"
            async with Session() as s:
                rows = (await s.execute(select(AgentGatewaySession).where(AgentGatewaySession.agent_id == agent_id))).scalars().all()
                assert rows == [], "the row is gone: the cleanup ran to its end"
    finally:
        from app.core.database import Base
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()
        from app.core import shutdown as _shutdown_module
        _shutdown_module.reset_shutdown_event()


@pytest.mark.anyio
@pytest.mark.destructive_schema
@pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요")
async def test_a_stuck_cleanup_cannot_hold_the_shutdown_drain_hostage():
    """story #4834 (codex) — the grace cleanup runs shielded, so it cannot be cut; the drain must not wait for it without a limit (a stuck database would keep the
    engine from being disposed). With a cleanup that takes 8 s, a drain with a 0.5 s budget returns within a few seconds (the budget + its bounded wait for the cancelled)."""
    import app.routers.agent_gateway as gw_module
    from app.services import pg_pubsub

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

        async def _stuck(*a, **k):
            await asyncio.sleep(8.0)

        with patch("app.core.database.async_session_factory", _factory), \
             patch.object(gw_module, "_SSE_HEARTBEAT", 0.02), \
             patch.object(gw_module, "_AGENT_SSE_LIFESPAN_SEC", 0.05), \
             patch.object(gw_module, "_AGENT_SSE_LIFESPAN_JITTER_SEC", 0.0), \
             patch.object(gw_module, "_LIFESPAN_END_GRACE_SEC", 30.0), \
             patch.object(gw_module, "_mark_agent_disconnected", _stuck), \
             patch("app.services.onboarding_funnel.emit_onboarding_event", AsyncMock()):
            response = await gw_module.agent_stream(request=_FakeRequest(), auth=auth_ctx)
            async for _ in response.body_iterator:
                pass
            t0 = time.monotonic()
            await pg_pubsub.drain_background_tasks(timeout=0.5)
            elapsed = time.monotonic() - t0
            assert elapsed < 5.0, f"a stuck cleanup held the drain for {elapsed:.1f}s"
    finally:
        from app.core.database import Base
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()
        from app.core import shutdown as _shutdown_module
        _shutdown_module.reset_shutdown_event()


@pytest.mark.anyio
@pytest.mark.destructive_schema
@pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요")
async def test_a_cancel_that_comes_early_still_cleans_up_the_connection():
    """story #4834 (codex) — `_lifespan_ended` is set up before the first await, so a cancel that arrives while the stream is still starting (after its session row is
    committed) does not make `_end_connection` fail with a NameError and skip the cleanup (a leaked row)."""
    import app.routers.agent_gateway as gw_module
    from app.models.agent_gateway import AgentGatewaySession
    from sqlalchemy import select

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

        _orig = gw_module._mark_agent_disconnected
        _spy = AsyncMock(side_effect=_orig)
        with patch("app.core.database.async_session_factory", _factory), \
             patch.object(gw_module, "_SSE_HEARTBEAT", 0.02), \
             patch.object(gw_module, "_AGENT_SSE_LIFESPAN_SEC", 60.0), \
             patch.object(gw_module, "_LIFESPAN_END_GRACE_SEC", 0.0), \
             patch.object(gw_module, "_mark_agent_disconnected", _spy), \
             patch("app.services.presence_online.mark_online", AsyncMock(side_effect=asyncio.CancelledError)), \
             patch("app.services.onboarding_funnel.emit_onboarding_event", AsyncMock()):
            response = await gw_module.agent_stream(request=_FakeRequest(), auth=auth_ctx)
            async for _ in response.body_iterator:
                pass  # the cancel at the start ends the stream at once

            async def _row_gone() -> bool:
                async with Session() as s:
                    return not (await s.execute(select(AgentGatewaySession).where(AgentGatewaySession.agent_id == agent_id))).scalars().all()

            assert await _wait_for(_row_gone, timeout=5.0), "the connection's row must not leak when the stream is cancelled while it starts"
            _spy.assert_awaited_once()
    finally:
        from app.core.database import Base
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()
        from app.core import shutdown as _shutdown_module
        _shutdown_module.reset_shutdown_event()


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
