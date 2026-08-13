"""story #2602: 「에이전트 로컬 프로세스 정상·하트비트 송신 중인데 웹 UI 오프라인 노출 +
채팅 무응답」 진단에서 dev 라이브로 재현된 실패군을 고정한다.

재현(2026-08-13, 은두카쿠·backend-dev 직접 curl): per-key SSE 슬롯(free=3)을 채운 뒤 client를
kill -9(정상 종료 시퀀스 없이 종료 — 크래시 모사)하면, sse_lease.py 문서가 약속하는 90초
TTL 자가회수가 지나도(115초 시점에도) 재접속이 계속 429였다. 원인 — refresh(30초 틱)가
`request.is_disconnected()`로 게이트된 같은 루프 안에서 돌기 때문에, 클라가 죽었는데 서버가
그걸 못 알아챈 orphan은 refresh도 안 멈춘다(매 틱마다 스스로 lease를 갱신) — 그래서 이
실패군의 진짜 상한은 `sse_lease._TTL_SEC`(90초)가 아니라 disconnect 감지와 무관하게 발동하는
`agent_gateway._AGENT_SSE_LIFESPAN_SEC`(+jitter, 기본 ~300~330초) 능동 종료뿐이다(#2128 본체).

이 파일은 그 경로 — "TTL이 아니라 lifespan cap이 실제 회수 축" — 를 real PG(AgentGatewaySession
등 generate() 내부 write 전부와 patch 없이) + fakeredis(sse_lease 실경로) 조합으로 처음 고정한다.
기존 test_2128_sse_lifespan_cap.py는 lifespan cap이 카운터/세션row/큐를 정리하는 것만 검증했고
sse_lease(Redis 공유 lease)는 건드리지 않았다 — 기존 test_2582_*.py는 반대로 sse_lease의 TTL
자연만료(score를 과거로 조작)만 검증했고 lifespan-cap이 강제 종료하는 경로는 없었다. 이 갭을 닫는다.
"""
from __future__ import annotations

import asyncio
import time
import uuid
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

_REAL_DB_URL = __import__("os").getenv("PARITY_TEST_DATABASE_URL") or __import__("os").getenv("ALEMBIC_DATABASE_URL")

pytestmark = pytest.mark.destructive_schema


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
def _flag_on_fakeredis():
    aioredis = pytest.importorskip("fakeredis.aioredis")
    pytest.importorskip("lupa")
    from app.services import sse_lease

    server = aioredis.FakeServer()
    client = aioredis.FakeRedis(server=server, decode_responses=True)
    with patch.object(sse_lease.settings, "sse_lease_redis_enabled", True), \
         patch.object(sse_lease.settings, "redis_url", "redis://fake"), \
         patch("app.services.redis_shared.get_client", return_value=client):
        yield client


class _NeverDisconnects:
    """story #2128 패턴 재사용 — is_disconnected()가 영원히 False. kill -9 후에도 ASGI 계층이
    클라 사망을 못 알아채는 실측 상황(#2183·까심 AC6)의 결정론적 재현."""
    headers: dict = {}

    async def is_disconnected(self) -> bool:
        return False


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

    org = Organization(id=uuid.uuid4(), name="Org2602", slug=f"org2602-{uuid.uuid4().hex[:8]}")
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
async def test_undetected_orphan_reclaims_sse_lease_via_lifespan_cap_not_ttl(monkeypatch, _flag_on_fakeredis):
    """핵심 회귀가드 — disconnect가 영영 감지 안 되는(kill -9 모사) 연결도, TTL(90s) 자연만료를
    기다릴 필요 없이 lifespan cap(disconnect 감지와 무관하게 발동)이 끝나면 sse_lease per-key
    lease가 실제로 release()되고, 그 즉시 같은 키의 새 연결이 성공한다."""
    import app.routers.agent_gateway as gw_module
    from app.services import sse_lease

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, agent_id = await _seed_org_project_agent(s)
        agent_id_str = str(agent_id)
        scope = f"perkey:{agent_id_str}"

        auth_ctx = MagicMock()
        auth_ctx.user_id = agent_id_str
        auth_ctx.claims = {"app_metadata": {"api_key_id": "test-key"}}

        @asynccontextmanager
        async def _factory():
            async with Session() as s:
                yield s

        with patch("app.core.database.async_session_factory", _factory), \
             patch.object(gw_module, "_SSE_HEARTBEAT", 0.02), \
             patch.object(gw_module, "_AGENT_SSE_LIFESPAN_SEC", 0.05), \
             patch.object(gw_module, "_AGENT_SSE_LIFESPAN_JITTER_SEC", 0.0), \
             patch("app.services.onboarding_funnel.emit_onboarding_event", AsyncMock()):

            # 1) orphan 연결 하나를 생성 — is_disconnected()가 절대 False를 안 벗어나므로
            #    (kill -9 후 서버가 클라 사망을 못 알아챈 상태와 동형) 오직 lifespan cap만이
            #    이 연결을 끝낼 수 있다.
            response = await gw_module.agent_stream(request=_NeverDisconnects(), auth=auth_ctx)

            # 이 연결이 실제로 sse_lease를 잡았는지 먼저 확認(선행조건 — 안 잡았으면 이하 검증 무의미).
            held_before = await sse_lease.count(scope)
            assert held_before == 1, f"연결이 sse_lease를 획득 못함(held={held_before}) — 테스트 전제 붕괴"

            started = time.monotonic()
            saw_lifespan_event = False
            async for chunk in response.body_iterator:
                if "lifespan_reconnect" in chunk:
                    saw_lifespan_event = True
            elapsed = time.monotonic() - started

        assert saw_lifespan_event, "disconnect 미감지 상태에서도 lifespan cap이 발동해야(#2128 본체)"
        assert elapsed < 5.0, f"lifespan cap 반응이 너무 느림({elapsed}s)"

        # 2) 회수 확認 — TTL(90s) 자연만료를 기다린 게 아니라(테스트는 <5s 안에 끝났다),
        #    lifespan cap이 finally를 타고 sse_lease.release()를 실제로 호출한 것.
        await asyncio.sleep(0.05)
        held_after = await sse_lease.count(scope)
        assert held_after == 0, (
            f"lifespan cap 종료 후에도 sse_lease가 안 풀림(held={held_after}) — "
            "disconnect 미감지 orphan이 영구 슬롯을 물고 있는 #2602 재현 그 자체"
        )

        # 3) 실사용자 체감 축 — 슬롯이 진짜 비었으므로 같은 키의 새 연결이 즉시 성공(429 아님).
        with patch("app.core.database.async_session_factory", _factory), \
             patch("app.services.onboarding_funnel.emit_onboarding_event", AsyncMock()):
            second = await gw_module.agent_stream(request=_NeverDisconnects(), auth=auth_ctx)
            assert second is not None
            await second.body_iterator.aclose()
    finally:
        gw_module._agent_connections.pop(agent_id_str, None)
        from app.core.database import Base
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()
        from app.core import shutdown as _shutdown_module
        _shutdown_module.reset_shutdown_event()
