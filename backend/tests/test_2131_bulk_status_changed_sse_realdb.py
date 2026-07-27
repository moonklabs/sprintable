"""#2131 실DB+실HTTP 통합 — PATCH /stories/bulk가 status_changed SSE를 실제로 큐에 넣는지.

fixture 아님: 실 PG(create_all) + 실 FastAPI 앱(ASGITransport)을 통해 실제 라우트를 태우고,
`_agent_connections`에 진짜 asyncio.Queue를 꽂아 서버가 실제로 push하는지 확認한다
(#2158에서 확립한 "라이브 실증, fixture-green 아님" 관례와 동형).
"""
from __future__ import annotations

import asyncio
import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = pytest.mark.destructive_schema

_REAL_DB_SKIP = pytest.mark.skipif(
    not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"
)


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

    import app.models  # noqa: F401
    from app.core.database import Base

    engine = create_async_engine(_async_url())
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed(session, *, n_stories: int = 1):
    from app.models.organization import Organization
    from app.models.pm import Story
    from app.models.project import Project
    from app.models.team import TeamMember

    org = Organization(id=uuid.uuid4(), name="Org2131", slug=f"org2131-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()

    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()

    # actor(human) — has_project_access의 team_member_branch가 type=="human"만 grant-없이
    # 통과시킨다(project_auth.py:226) — agent는 별도 Member+ProjectAccess grant가 필요해 여기선
    # 불필요한 복잡도. watcher(agent) — 다른 화면의 관찰자 역할(#2131 AC1의 "남의 화면"). watcher는
    # project_accessible_member_ids의 수신자 쿼리(team_members, type 필터 없음)만 통과하면 되므로
    # type=agent로 그대로 둬도 무방(오히려 실제 관찰 대상인 agent 클라이언트를 더 잘 대표).
    actor_id, watcher_id = uuid.uuid4(), uuid.uuid4()
    session.add_all([
        TeamMember(id=actor_id, org_id=org.id, project_id=project.id, type="human", name="actor"),
        TeamMember(id=watcher_id, org_id=org.id, project_id=project.id, type="agent", name="watcher"),
    ])
    await session.commit()

    story_ids = []
    for i in range(n_stories):
        sid = uuid.uuid4()
        session.add(Story(id=sid, org_id=org.id, project_id=project.id, title=f"S{i}", status="todo"))
        story_ids.append(sid)
    await session.commit()

    return {
        "org_id": org.id, "project_id": project.id,
        "actor_id": actor_id, "watcher_id": watcher_id, "story_ids": story_ids,
    }


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _setup_app(app, Session, actor_id, org_id):
    from app.dependencies.auth import AuthContext, get_current_user
    from app.dependencies.database import get_db

    async def _db():
        async with Session() as s:
            try:
                yield s
                await s.commit()
            except Exception:
                await s.rollback()
                raise

    async def _auth():
        return AuthContext(
            user_id=str(actor_id), email="actor@test",
            claims={"app_metadata": {"org_id": str(org_id), "api_key_id": "test-key"}},
        )

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_bulk_status_patch_pushes_sse_to_project_watcher():
    """⭐본체: 액터 ≠ 워처. 액터가 카드를 다른 컬럼으로 옮기면(bulk PATCH), 같은 프로젝트의
    다른 멤버(워처)에게 실제로 story.status_changed SSE 프레임이 도착하는지 — 이게 안 되던 것이 #2131."""
    from app.main import app
    from app.routers import events as events_mod

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["actor_id"], seeded["org_id"])

        watcher_id = str(seeded["watcher_id"])
        q: asyncio.Queue = asyncio.Queue(maxsize=50)
        events_mod._agent_connections[watcher_id].add(q)
        try:
            client = _client_for(app)
            try:
                resp = await client.patch(
                    "/api/v2/stories/bulk",
                    json={"items": [{"id": str(seeded["story_ids"][0]), "status": "in-progress"}]},
                )
                assert resp.status_code == 200, resp.text
            finally:
                await client.aclose()

            await asyncio.sleep(0.1)  # fire_and_forget/BackgroundTasks 예약분 flush

            received = []
            while not q.empty():
                received.append(q.get_nowait())

            status_changed = [e for e in received if e.get("event_type") == "story.status_changed"]
            assert len(status_changed) == 1, (
                f"워처가 status_changed를 정확히 1건 받아야 — 실제 {len(status_changed)}건. "
                f"전체 수신: {received}"
            )
            evt = status_changed[0]
            assert evt["old_status"] == "todo"
            assert evt["new_status"] == "in-progress"
            assert evt["story_id"] == str(seeded["story_ids"][0])
        finally:
            events_mod._agent_connections[watcher_id].discard(q)
            events_mod._agent_connections.pop(watcher_id, None)
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_bulk_no_status_field_does_not_push_status_changed():
    """회귀 가드: status 필드 자체를 안 보내는 bulk 호출(예: priority만)은 status_changed를 안 낸다."""
    from app.main import app
    from app.routers import events as events_mod

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["actor_id"], seeded["org_id"])

        watcher_id = str(seeded["watcher_id"])
        q: asyncio.Queue = asyncio.Queue(maxsize=50)
        events_mod._agent_connections[watcher_id].add(q)
        try:
            client = _client_for(app)
            try:
                resp = await client.patch(
                    "/api/v2/stories/bulk",
                    json={"items": [{"id": str(seeded["story_ids"][0]), "priority": "high"}]},
                )
                assert resp.status_code == 200, resp.text
            finally:
                await client.aclose()

            await asyncio.sleep(0.1)

            received = []
            while not q.empty():
                received.append(q.get_nowait())
            assert not any(e.get("event_type") == "story.status_changed" for e in received)
        finally:
            events_mod._agent_connections[watcher_id].discard(q)
            events_mod._agent_connections.pop(watcher_id, None)
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_bulk_n_item_load_measured():
    """AC3 부하 실측: N건 동시 status 변경 시 워처 1명당 push 건수 = N(선형, 배수 곱 없음).
    #2157(presence 18배)류 증폭이 이 경로엔 없음을 직접 잰다."""
    from app.main import app
    from app.routers import events as events_mod

    N = 8
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s, n_stories=N)

        await _setup_app(app, Session, seeded["actor_id"], seeded["org_id"])

        watcher_id = str(seeded["watcher_id"])
        q: asyncio.Queue = asyncio.Queue(maxsize=200)
        events_mod._agent_connections[watcher_id].add(q)
        try:
            client = _client_for(app)
            try:
                items = [{"id": str(sid), "status": "in-progress"} for sid in seeded["story_ids"]]
                resp = await client.patch("/api/v2/stories/bulk", json={"items": items})
                assert resp.status_code == 200, resp.text
            finally:
                await client.aclose()

            await asyncio.sleep(0.2)

            received = []
            while not q.empty():
                received.append(q.get_nowait())
            status_changed = [e for e in received if e.get("event_type") == "story.status_changed"]
            print(f"\n[#2131 부하 실측] {N}건 동시 status 변경 → 워처 1명 push 수신 = {len(status_changed)}건")
            assert len(status_changed) == N, f"기대 {N}건(선형), 실제 {len(status_changed)}건"
        finally:
            events_mod._agent_connections[watcher_id].discard(q)
            events_mod._agent_connections.pop(watcher_id, None)
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
