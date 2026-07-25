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
    auth_ctx.claims = {"app_metadata": {"api_key_id": "test-key", "org_id": str(org)}}

    count_before = ev_module._sse_connection_count
    saw_lifespan_event = False
    elapsed = None
    try:
        with patch("app.core.database.async_session_factory", _factory):
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
    auth_ctx.claims = {"app_metadata": {"api_key_id": "test-key", "org_id": str(org)}}

    count_before = ev_module._sse_connection_count
    chunks: list[str] = []
    try:
        with patch("app.core.database.async_session_factory", _factory):
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

        auth_ctx = MagicMock()
        auth_ctx.user_id = str(agent_id)
        auth_ctx.claims = {"app_metadata": {"api_key_id": "test-key"}}

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
    assert "idle-but-legit한 agent 세션이 실제로 관측되면" in source
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
