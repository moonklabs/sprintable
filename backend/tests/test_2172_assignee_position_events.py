"""story #2172(2026-07-24, 오르테가군 킥오프): #2131이 status_changed에서 닫은 "bulk과 단건이
서로 다른 이벤트 계약을 갖는" 결함이 assignee_id/position에도 있었다.

AC1: PATCH /stories/bulk이 assignee_id를 실제로 바꾸면 PATCH /{id}와 **같은** story.assignee_changed
     를 낸다 — 발행 지점은 emit_story_assignee_changed(story_assignee_events.py) 하나뿐(#2131의
     helper-공유 방식 재사용).
AC2: PATCH /{id}가 position을 실제로 바꾸면 story.position_changed를 낸다(단건 경로 한정 — FE가
     position을 bulk으로 보내는 경로 자체가 없다, kanban-board.tsx 확認).
AC3: 해당 필드가 실제로 안 바뀐 호출은 두 이벤트 모두 0건.

⚠️ 오르테가군 킥오프 명시 — low 우선순위인 이유: assignee_id는 bulk 라이브 콜러가 0(FE가 bulk로
안 보냄), position은 실측 271건 중 3건만 채워져 있어(사람이 순서를 사실상 안 씀) "계약은 깨져
있으나 지금 아무도 안 밟는" 자리. 그래도 계약 자체는 맞춰둔다(다음에 누가 이 경로를 밟을 때
또 #2131류 결함으로 재발하지 않도록).
"""
from __future__ import annotations

import asyncio
import os
import uuid
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.routers import stories as stories_mod
from app.routers.stories import BulkUpdateRequest, bulk_update_stories

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = pytest.mark.destructive_schema

_REAL_DB_SKIP = pytest.mark.skipif(
    not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"
)


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ── A. mock 단위 — bulk_update_stories가 assignee_id 변경 시 emit_story_assignee_changed를
#    #2131의 status와 동일한 판정 논리(실제 변경만·값 동일이면 스킵·실패 격리)로 호출하는지 ──
def _story(assignee_id=None, position=None, **overrides):
    now = datetime(2026, 6, 10, 12, 0, 0, tzinfo=timezone.utc)
    base = dict(
        id=uuid.uuid4(), project_id=uuid.uuid4(), org_id=uuid.uuid4(), epic_id=None,
        sprint_id=None, assignee_id=assignee_id, assignee_ids=[], attachments=[], meeting_id=None,
        title="t", status="todo", priority="medium", story_points=None, description=None,
        acceptance_criteria=None, position=position, success_hypothesis=None, metric_definition=None,
        measure_after=None, outcome_status="n_a", outcome_result=None, is_excluded=False,
        created_at=now, updated_at=now,
    )
    base.update(overrides)
    return SimpleNamespace(**base)


def _mock_db(story_by_id: dict):
    async def _execute(stmt, *a, **kw):
        m = MagicMock()
        m.scalar_one_or_none = MagicMock(return_value=next(iter(story_by_id.values())))
        return m
    db = AsyncMock()
    db.execute = AsyncMock(side_effect=_execute)
    db.flush = AsyncMock()
    db.refresh = AsyncMock()
    db.commit = AsyncMock()
    db.add = MagicMock()
    return db


def _patch_common(monkeypatch):
    monkeypatch.setattr(stories_mod, "_attach_assignee_ids", AsyncMock())
    monkeypatch.setattr(stories_mod, "_resolve_team_member_id", AsyncMock(return_value=None))
    monkeypatch.setattr(
        "app.services.project_auth.has_project_access", AsyncMock(return_value=True)
    )
    monkeypatch.setattr(
        "app.repositories.story_assignee.StoryAssigneeRepository.set_for_story", AsyncMock()
    )


@pytest.mark.anyio
async def test_bulk_assignee_change_calls_emit_story_assignee_changed(monkeypatch):
    story = _story(assignee_id=None)
    db = _mock_db({story.id: story})
    repo = MagicMock()
    repo.org_id = story.org_id

    _patch_common(monkeypatch)
    spy = AsyncMock()
    monkeypatch.setattr(stories_mod, "emit_story_assignee_changed", spy)

    new_assignee = uuid.uuid4()
    payload = BulkUpdateRequest(items=[{"id": str(story.id), "assignee_id": str(new_assignee)}])
    await bulk_update_stories(
        payload, MagicMock(), db, repo, auth=MagicMock(user_id=str(uuid.uuid4())),
    )

    spy.assert_awaited_once()
    args, kwargs = spy.call_args
    assert args[1] == repo.org_id
    assert args[2] is story
    assert args[3] is None  # old_assignee_id
    assert "background_tasks" in kwargs


@pytest.mark.anyio
async def test_bulk_no_assignee_field_does_not_call_emit(monkeypatch):
    """AC3 — priority만 바뀌는 item은 assignee emit 호출 자체가 없어야."""
    story = _story(assignee_id=None, priority="low")
    db = _mock_db({story.id: story})
    repo = MagicMock()
    repo.org_id = story.org_id

    _patch_common(monkeypatch)
    spy = AsyncMock()
    monkeypatch.setattr(stories_mod, "emit_story_assignee_changed", spy)

    payload = BulkUpdateRequest(items=[{"id": str(story.id), "priority": "high"}])
    await bulk_update_stories(
        payload, MagicMock(), db, repo, auth=MagicMock(user_id=str(uuid.uuid4())),
    )

    spy.assert_not_awaited()


@pytest.mark.anyio
async def test_bulk_assignee_unchanged_value_does_not_call_emit(monkeypatch):
    """AC3 — 같은 값으로 PATCH(assignee_id 그대로)는 old_assignee_by_id에 안 잡히므로 emit도 안 함."""
    same_id = uuid.uuid4()
    story = _story(assignee_id=same_id)
    db = _mock_db({story.id: story})
    repo = MagicMock()
    repo.org_id = story.org_id

    _patch_common(monkeypatch)
    spy = AsyncMock()
    monkeypatch.setattr(stories_mod, "emit_story_assignee_changed", spy)

    payload = BulkUpdateRequest(items=[{"id": str(story.id), "assignee_id": str(same_id)}])
    await bulk_update_stories(
        payload, MagicMock(), db, repo, auth=MagicMock(user_id=str(uuid.uuid4())),
    )

    spy.assert_not_awaited()


@pytest.mark.anyio
async def test_bulk_assignee_unassign_to_none_is_not_representable(monkeypatch):
    """기존 bulk 한계(#2172 스코프 밖) 문서화 — BulkUpdateItem.model_dump(exclude_none=True)는
    assignee_id=None(명시적 미배정)을 항상 드롭한다. 이 테스트는 그 한계를 고정해 다음 사람이
    "왜 bulk 미배정이 안 먹지"로 새로 헤매지 않게 한다 — 고치는 게 아니라 기록."""
    same_id = uuid.uuid4()
    story = _story(assignee_id=same_id)
    db = _mock_db({story.id: story})
    repo = MagicMock()
    repo.org_id = story.org_id

    _patch_common(monkeypatch)
    spy = AsyncMock()
    monkeypatch.setattr(stories_mod, "emit_story_assignee_changed", spy)

    payload = BulkUpdateRequest(items=[{"id": str(story.id), "assignee_id": None}])
    await bulk_update_stories(
        payload, MagicMock(), db, repo, auth=MagicMock(user_id=str(uuid.uuid4())),
    )

    spy.assert_not_awaited()  # exclude_none이 assignee_id 키 자체를 지워 변경으로 안 잡힘


@pytest.mark.anyio
async def test_bulk_assignee_emit_failure_isolated_per_item(monkeypatch):
    story = _story(assignee_id=None)
    db = _mock_db({story.id: story})
    repo = MagicMock()
    repo.org_id = story.org_id

    _patch_common(monkeypatch)
    monkeypatch.setattr(
        stories_mod, "emit_story_assignee_changed", AsyncMock(side_effect=RuntimeError("boom"))
    )

    payload = BulkUpdateRequest(items=[{"id": str(story.id), "assignee_id": str(uuid.uuid4())}])
    result = await bulk_update_stories(
        payload, MagicMock(), db, repo, auth=MagicMock(user_id=str(uuid.uuid4())),
    )

    assert len(result) == 1


def test_bulk_and_single_share_the_one_assignee_emit_helper():
    """소스 검사(AC1) — PATCH /{id}·PATCH /bulk 둘 다 emit_story_assignee_changed를 정확히
    1회씩만 호출. 새 파생 함수를 만들거나 발행 로직을 인라인으로 복제하지 않았는지 회귀 고정
    (오늘 확立된 "발행 지점을 두 벌로 만들지 말 것" 관례, #2131과 동형)."""
    import inspect

    bulk_source = inspect.getsource(stories_mod.bulk_update_stories)
    assert bulk_source.count("await emit_story_assignee_changed(") == 1

    single_source = inspect.getsource(stories_mod.update_story)
    assert single_source.count("await emit_story_assignee_changed(") == 1
    # 예전 인라인 블록의 흔적(story_assigned Event 직접 생성)이 update_story 안에 남아있으면
    # 발행 지점이 갈라진 것 — 완전히 helper로 이관됐는지 고정.
    assert "sa_event = Event(" not in single_source


def test_position_changed_event_type_and_judgment_documented():
    """소스 검사(AC2) — position 변경 시 story.position_changed를 낸다는 계약 + 오르테가군이
    요청한 "판정 근거·무너지는 조건" 선언이 소스에 남아있는지 고정(오늘 팀 관례로 채택된
    "선언은 comment가 아니라 pinning test로" 그대로 적용)."""
    import inspect

    single_source = inspect.getsource(stories_mod.update_story)
    assert '"event_type": "story.position_changed"' in single_source
    assert "판정이 무너지는 조건" in single_source


# ── B. 실PG+실HTTP — #2131이 확立한 _agent_connections 실 큐 관찰 패턴 재사용(mock 아닌
#    실제 서버 push 관찰) ──────────────────────────────────────────────────────────────
async def _session_factory():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    import app.models  # noqa: F401
    from app.core.database import Base

    def _async_url() -> str:
        url = _REAL_DB_URL
        for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
            if url.startswith(prefix):
                return "postgresql+asyncpg://" + url[len(prefix):]
        return url

    engine = create_async_engine(_async_url())
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed(session):
    from app.models.organization import Organization
    from app.models.pm import Story
    from app.models.project import Project
    from app.models.team import TeamMember

    org = Organization(id=uuid.uuid4(), name="Org2172", slug=f"org2172-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()

    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()

    # actor(human, grant 불요·has_project_access team_member_branch) — #2131 패턴 재사용.
    # watcher(agent) — "남의 화면" 관찰 대상. new_assignee(human) — 재배정 대상 실존 멤버(
    # dispatch_notification이 실 member 대상으로 정상 동작하게).
    actor_id, watcher_id, assignee_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    session.add_all([
        TeamMember(id=actor_id, org_id=org.id, project_id=project.id, type="human", name="actor"),
        TeamMember(id=watcher_id, org_id=org.id, project_id=project.id, type="agent", name="watcher"),
        TeamMember(id=assignee_id, org_id=org.id, project_id=project.id, type="human", name="assignee"),
    ])
    await session.commit()

    story = Story(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="S", status="todo")
    session.add(story)
    await session.commit()

    return {
        "org_id": org.id, "project_id": project.id, "actor_id": actor_id,
        "watcher_id": watcher_id, "assignee_id": assignee_id, "story_id": story.id,
    }


def _client_for(app):
    from httpx import ASGITransport, AsyncClient
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
async def test_realdb_bulk_assignee_change_pushes_same_event_as_single():
    """⭐본체 AC1 — PATCH /stories/bulk이 assignee_id를 바꾸면 PATCH /{id}와 동일한
    story.assignee_changed가 실제로 프로젝트 워처에게 도착한다."""
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
                    json={"items": [{
                        "id": str(seeded["story_id"]), "assignee_id": str(seeded["assignee_id"]),
                    }]},
                )
                assert resp.status_code == 200, resp.text
            finally:
                await client.aclose()

            await asyncio.sleep(0.1)

            received = []
            while not q.empty():
                received.append(q.get_nowait())

            assignee_changed = [e for e in received if e.get("event_type") == "story.assignee_changed"]
            assert len(assignee_changed) == 1, (
                f"워처가 assignee_changed를 정확히 1건 받아야(bulk 경로) — 실제 "
                f"{len(assignee_changed)}건. 전체 수신: {received}"
            )
            evt = assignee_changed[0]
            assert evt["assignee_id"] == str(seeded["assignee_id"])
            assert evt["old_assignee_id"] is None
            assert evt["story_id"] == str(seeded["story_id"])
        finally:
            events_mod._agent_connections[watcher_id].discard(q)
            events_mod._agent_connections.pop(watcher_id, None)
    finally:
        app.dependency_overrides.clear()
        from app.core.database import engine as _global_engine
        await _global_engine.dispose()
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_realdb_bulk_no_assignee_field_pushes_zero():
    """AC3 — assignee_id 필드 자체를 안 보내는 bulk 호출(priority만)은 assignee_changed 0건."""
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
                    json={"items": [{"id": str(seeded["story_id"]), "priority": "high"}]},
                )
                assert resp.status_code == 200, resp.text
            finally:
                await client.aclose()

            await asyncio.sleep(0.1)

            received = []
            while not q.empty():
                received.append(q.get_nowait())
            assert not any(e.get("event_type") == "story.assignee_changed" for e in received)
        finally:
            events_mod._agent_connections[watcher_id].discard(q)
            events_mod._agent_connections.pop(watcher_id, None)
    finally:
        app.dependency_overrides.clear()
        from app.core.database import engine as _global_engine
        await _global_engine.dispose()
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_realdb_single_position_change_pushes_position_changed():
    """⭐본체 AC2 — PATCH /{id}가 position을 바꾸면 story.position_changed가 프로젝트 워처에게
    실제로 도착한다(FE dnd 같은 컬럼 내 재정렬 경로 — kanban-board.tsx 확認)."""
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
                    f"/api/v2/stories/{seeded['story_id']}", json={"position": 2000},
                )
                assert resp.status_code == 200, resp.text
            finally:
                await client.aclose()

            await asyncio.sleep(0.1)

            received = []
            while not q.empty():
                received.append(q.get_nowait())

            position_changed = [e for e in received if e.get("event_type") == "story.position_changed"]
            assert len(position_changed) == 1, (
                f"워처가 position_changed를 정확히 1건 받아야 — 실제 {len(position_changed)}건. "
                f"전체 수신: {received}"
            )
            evt = position_changed[0]
            assert evt["position"] == 2000
            assert evt["old_position"] is None
            assert evt["story_id"] == str(seeded["story_id"])
        finally:
            events_mod._agent_connections[watcher_id].discard(q)
            events_mod._agent_connections.pop(watcher_id, None)
    finally:
        app.dependency_overrides.clear()
        from app.core.database import engine as _global_engine
        await _global_engine.dispose()
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_realdb_single_position_unchanged_pushes_zero():
    """AC3 — position 필드 자체를 안 보내는 단건 PATCH(title만)는 position_changed 0건."""
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
                    f"/api/v2/stories/{seeded['story_id']}", json={"title": "renamed"},
                )
                assert resp.status_code == 200, resp.text
            finally:
                await client.aclose()

            await asyncio.sleep(0.1)

            received = []
            while not q.empty():
                received.append(q.get_nowait())
            assert not any(e.get("event_type") == "story.position_changed" for e in received)
        finally:
            events_mod._agent_connections[watcher_id].discard(q)
            events_mod._agent_connections.pop(watcher_id, None)
    finally:
        app.dependency_overrides.clear()
        from app.core.database import engine as _global_engine
        await _global_engine.dispose()
        await engine.dispose()
