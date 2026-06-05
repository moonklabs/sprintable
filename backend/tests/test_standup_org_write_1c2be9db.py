"""E-STANDUP 1c2be9db: org-level write API — project_id 생략 + author 접근 프로젝트 auto-link.

- 스키마: project_id Optional.
- 핸들러: org-level write(project_id 없음) → 링크 = accessible_project_ids_in_org full overwrite
  (canonical helper 재사용·CP2-A). legacy(project_id 명시) → resync 미호출·additive(CP2-B).
- real-DB: 2프로젝트 접근 유저 1 save → entry 1 + 링크 2(CP2-C).
"""
from __future__ import annotations

import os
import uuid
from datetime import date as _date
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient


@pytest.fixture
def anyio_backend():
    return "asyncio"


def test_schema_project_id_optional():
    from app.schemas.standup import StandupSelfUpdate, StandupUpsert

    # project_id 생략해도 검증 통과(org-level)
    u = StandupUpsert(author_id=uuid.uuid4(), date=_date(2026, 6, 5))
    assert u.project_id is None
    s = StandupSelfUpdate(date=_date(2026, 6, 5))
    assert s.project_id is None


async def _client(uid: uuid.UUID, org_id: uuid.UUID):
    from app.main import app
    from app.dependencies.auth import get_current_user, get_verified_org_id
    from app.dependencies.database import get_db

    ctx = MagicMock()
    ctx.user_id = str(uid)
    ctx.claims = {"app_metadata": {"org_id": str(org_id)}}

    async def _db():
        yield AsyncMock()

    async def _auth():
        return ctx

    async def _org():
        return org_id

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth
    app.dependency_overrides[get_verified_org_id] = _org
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test"), app


def _entry(org_id, project_id=None):
    e = MagicMock()
    e.id = uuid.uuid4(); e.org_id = org_id; e.project_id = project_id
    e.sprint_id = None; e.author_id = uuid.uuid4(); e.date = _date(2026, 6, 5)
    e.done = "d"; e.plan = "p"; e.blockers = None; e.plan_story_ids = []
    e.created_at = e.updated_at = __import__("datetime").datetime(2026, 6, 5)
    return e


@pytest.mark.anyio
async def test_org_level_post_resyncs_to_accessible_projects():
    """project_id 없는 POST → resync_project_links(accessible) 호출(full overwrite·CP2-A)."""
    uid, org = uuid.uuid4(), uuid.uuid4()
    p1, p2 = uuid.uuid4(), uuid.uuid4()
    client, app = await _client(uid, org)
    resync = AsyncMock()
    try:
        with patch("app.routers.standups.canonicalize_member_id", new=AsyncMock(return_value=uuid.uuid4())), \
             patch("app.routers.standups.accessible_project_ids_in_org", new=AsyncMock(return_value=[p1, p2])), \
             patch("app.repositories.standup.StandupEntryRepository.upsert", new=AsyncMock(return_value=_entry(org))), \
             patch("app.repositories.standup.StandupEntryRepository.resync_project_links", new=resync):
            async with client as c:
                resp = await c.post("/api/v2/standups", json={
                    "author_id": str(uuid.uuid4()), "date": "2026-06-05", "plan": "p",
                })
        assert resp.status_code == 201
        # resync 가 accessible [p1,p2] 로 호출
        resync.assert_awaited_once()
        assert list(resync.await_args.args[1]) == [p1, p2]
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_legacy_post_with_project_id_no_resync():
    """project_id 명시 POST(legacy) → resync 미호출(additive only·DELETE 없음·CP2-B)."""
    uid, org = uuid.uuid4(), uuid.uuid4()
    client, app = await _client(uid, org)
    resync = AsyncMock()
    accessible = AsyncMock(return_value=[])
    try:
        with patch("app.routers.standups.canonicalize_member_id", new=AsyncMock(return_value=uuid.uuid4())), \
             patch("app.routers.standups.accessible_project_ids_in_org", new=accessible), \
             patch("app.repositories.standup.StandupEntryRepository.upsert", new=AsyncMock(return_value=_entry(org, uuid.uuid4()))), \
             patch("app.repositories.standup.StandupEntryRepository.resync_project_links", new=resync):
            async with client as c:
                resp = await c.post("/api/v2/standups", json={
                    "author_id": str(uuid.uuid4()), "date": "2026-06-05",
                    "project_id": str(uuid.uuid4()), "plan": "p",
                })
        assert resp.status_code == 201
        resync.assert_not_awaited()       # org-level 분기 미진입 → DELETE 없음
        accessible.assert_not_awaited()
    finally:
        app.dependency_overrides.clear()


# ── real-DB: 2프로젝트 1 save → entry 1 + 링크 2 (CP2-C) ───────────────────────

_RAW = os.environ.get("PARITY_TEST_DATABASE_URL") or os.environ.get("ALEMBIC_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)


@pytest.mark.anyio
@pytest.mark.skipif(not _ASYNC, reason="real-DB URL 미설정 — skip")
async def test_resync_links_full_overwrite_realdb():
    """resync_project_links: DELETE 후 INSERT — 링크를 target 으로 full overwrite·멱등."""
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from app.repositories.standup import StandupEntryRepository

    org = uuid.uuid4(); author = uuid.uuid4()
    p1, p2, p3 = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    eid = uuid.uuid4()
    eng = create_async_engine(_ASYNC)
    sm = async_sessionmaker(eng, expire_on_commit=False)
    try:
        async with sm() as s:
            for pid in (p1, p2, p3):
                await s.execute(text("INSERT INTO projects (id,org_id,name,created_at) VALUES (:i,:o,'P',now())"),
                                {"i": pid, "o": org})
            await s.execute(text(
                "INSERT INTO standup_entries (id,org_id,author_id,date,plan_story_ids,created_at,updated_at)"
                " VALUES (:i,:o,:a,:d,ARRAY[]::uuid[],now(),now())"),
                {"i": eid, "o": org, "a": author, "d": _date(2026, 6, 5)})
            await s.commit()

            repo = StandupEntryRepository(s, org)
            # 1) [p1,p2] 로 set
            await repo.resync_project_links(eid, [p1, p2]); await s.commit()
            got = set((await s.execute(text(
                "SELECT project_id FROM standup_entry_projects WHERE entry_id=:e"), {"e": eid})).scalars().all())
            assert got == {p1, p2}
            # 2) [p2,p3] 로 re-sync(full overwrite — p1 삭제·p3 추가)
            await repo.resync_project_links(eid, [p2, p3]); await s.commit()
            got2 = set((await s.execute(text(
                "SELECT project_id FROM standup_entry_projects WHERE entry_id=:e"), {"e": eid})).scalars().all())
            assert got2 == {p2, p3}
            # 3) 멱등 — 같은 set 재실행 무변화
            await repo.resync_project_links(eid, [p2, p3]); await s.commit()
            got3 = set((await s.execute(text(
                "SELECT project_id FROM standup_entry_projects WHERE entry_id=:e"), {"e": eid})).scalars().all())
            assert got3 == {p2, p3}
        async with sm() as s:
            await s.execute(text("DELETE FROM standup_entry_projects WHERE org_id=:o"), {"o": org})
            await s.execute(text("DELETE FROM standup_entries WHERE org_id=:o"), {"o": org})
            await s.execute(text("DELETE FROM projects WHERE org_id=:o"), {"o": org})
            await s.commit()
    finally:
        await eng.dispose()
