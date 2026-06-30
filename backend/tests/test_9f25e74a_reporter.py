"""9f25e74a: stories.reporter_id(=creator) + created_by 노출 + 서버필터 + 백필(no-guess).

핵심: StoryResponse created_by(=reporter_id alias)·list_board reporter_id 필터·0128 백필(story_activities
실값만·no-guess NULL).
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone
from unittest.mock import MagicMock

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ── StoryResponse created_by 매핑(unit) ──────────────────────────────────────
def test_story_response_exposes_created_by_from_reporter_id():
    from app.schemas.story import StoryResponse
    rid = uuid.uuid4()
    now = datetime.now(timezone.utc)
    obj = MagicMock(
        id=uuid.uuid4(), project_id=uuid.uuid4(), org_id=uuid.uuid4(),
        epic_id=None, sprint_id=None, assignee_id=None, assignee_ids=[],
        attachments=[], meeting_id=None, reporter_id=rid,
        title="t", status="backlog", priority="medium", story_points=None,
        description=None, acceptance_criteria=None, position=None,
        is_excluded=False, success_hypothesis=None, measure_after=None,
        outcome_status="n_a", outcome_result=None, metric_definition=None,
        created_at=now, updated_at=now,
    )
    resp = StoryResponse.model_validate(obj)
    assert resp.created_by == rid  # ⭐reporter_id → created_by
    # NULL(백필 미스) 케이스
    obj.reporter_id = None
    assert StoryResponse.model_validate(obj).created_by is None


async def _session():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from app.core.database import Base
    import app.models  # noqa: F401
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            url = "postgresql+asyncpg://" + url[len(prefix):]
            break
    engine = create_async_engine(url)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _story(s, org, proj, *, status="done", reporter=None):
    from app.models.pm import Story
    st = Story(org_id=org, project_id=proj, title="t", status=status, reporter_id=reporter)
    s.add(st)
    await s.flush()
    return st


# ── list_board reporter 필터(repo·real PG) ───────────────────────────────────
@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_list_board_reporter_filter():
    from app.repositories.story import StoryRepository
    from app.models.project import Project
    engine, Session = await _session()
    async with Session() as s:
        org, proj, me = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        s.add(Project(id=proj, org_id=org, name="p"))
        await s.flush()
        await _story(s, org, proj, reporter=me)        # 내가 등록
        await _story(s, org, proj, reporter=uuid.uuid4())  # 타인
        await _story(s, org, proj, reporter=None)      # 미상(백필 미스)
        await s.commit()
        repo = StoryRepository(s, org)
        rows, total = await repo.list_board(project_id=proj, status="done", reporter_id=me)
        assert total == 1 and all(r.reporter_id == me for r in rows)  # '내가 등록한'만
        rows_all, total_all = await repo.list_board(project_id=proj, status="done")
        assert total_all == 3  # 필터 없으면 전부
    await engine.dispose()


# ── 0128 백필 no-guess(real PG) ──────────────────────────────────────────────
@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_0128_backfill_from_activity_no_guess():
    import sqlalchemy as sa
    from app.models.project import Project
    from app.models.pm import StoryActivity
    engine, Session = await _session()
    async with Session() as s:
        org, proj, creator = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        s.add(Project(id=proj, org_id=org, name="p"))
        await s.flush()
        st_with = await _story(s, org, proj, status="backlog", reporter=None)
        st_without = await _story(s, org, proj, status="backlog", reporter=None)
        # st_with 에만 story_created activity(실 생성자)
        s.add(StoryActivity(org_id=org, story_id=st_with.id, project_id=proj,
                            activity_type="story_created", created_by=creator,
                            created_at=datetime.now(timezone.utc)))
        await s.commit()
        # 0128 백필 SQL 실행
        await s.execute(sa.text(
            "UPDATE stories s SET reporter_id = sub.actor FROM ("
            " SELECT DISTINCT ON (story_id) story_id, created_by AS actor FROM story_activities"
            " WHERE activity_type='story_created' ORDER BY story_id, created_at ASC) sub"
            " WHERE sub.story_id = s.id AND s.reporter_id IS NULL"))
        await s.commit()
        # raw SQL scalar 직조회(identity-map 캐시·ORM lazy-load 우회·expire_on_commit=False)
        r1 = (await s.execute(sa.text("SELECT reporter_id FROM stories WHERE id=:i"),
                              {"i": st_with.id})).scalar()
        r2 = (await s.execute(sa.text("SELECT reporter_id FROM stories WHERE id=:i"),
                              {"i": st_without.id})).scalar()
        assert r1 == creator   # activity 실값 백필
        assert r2 is None      # ⭐no-guess: activity 없으면 NULL 유지
    await engine.dispose()
