"""story #4405 — GA4 채점 cron: 값 읽기 → 트랜잭션 끝 → GA4(트랜잭션 없이) → 대상마다 짧은 트랜잭션 기록 + 한 판 상한.

실 PG여야 하는 이유: autoflush가 쌓던 UPDATE 행 잠금과 다른 세션의 대기는 mock으로 재현되지 않는다.

- GA4 호출 도중 다른 세션이 앞서 채점된 · 채점 중인 story를 UPDATE해도 막히지 않는다(예전: 앞 대상의 UPDATE 잠금이 끝 커밋까지 쌓임).
- GA4 호출 도중 사람이 판정(pending 밖)하면 cron이 덮지 않는다.
- 상한: GA4 호출 수 · 시간을 넘은 대상은 pending 그대로 deferred.
"""
from __future__ import annotations

import asyncio
import os
import threading
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.destructive_schema,
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
]

_GA4_MD = {"source": "ga4", "property_id": "p", "ga4_metric": "m", "target": 1, "direction": "up", "metric": "m"}
_HIT = {"outcome_status": "hit", "outcome_result": {"actual": 2, "target": 1}}


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _session_factory():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    import app.models  # noqa: F401 — 전 모델 메타데이터 로드
    from app.core.database import Base

    engine = create_async_engine(_async_url())
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_ga4_stories(Session, n):
    from app.models.pm import Story
    from app.models.project import Project

    org, proj = uuid.uuid4(), uuid.uuid4()
    async with Session() as s:
        s.add(Project(id=proj, org_id=org, name="p"))
        await s.flush()
        stories = [
            Story(
                org_id=org, project_id=proj, title=f"s{i}", outcome_status="pending",
                measure_after=datetime.now(timezone.utc) - timedelta(days=1), metric_definition=dict(_GA4_MD),
            )
            for i in range(n)
        ]
        s.add_all(stories)
        await s.commit()
        return [st.id for st in stories]


async def _story(Session, story_id):
    from sqlalchemy import select

    from app.models.pm import Story

    async with Session() as s:
        return (await s.execute(select(Story).where(Story.id == story_id))).scalar_one()


class _BlockingGa4:
    """n번째 GA4 호출에서 멈춰 선다 — 테스트가 «GA4 도중»에 끼어든다."""

    def __init__(self, block_on_call):
        self.calls = 0
        self.block_on_call = block_on_call
        self.started = threading.Event()
        self.release = threading.Event()
        self._lock = threading.Lock()

    def __call__(self, md, org_timezone=None):
        with self._lock:
            self.calls += 1
            n = self.calls
        if n == self.block_on_call:
            self.started.set()
            assert self.release.wait(20), "테스트가 GA4를 풀어 주지 않음"
        return dict(_HIT)

    async def wait_started(self):
        assert await asyncio.to_thread(self.started.wait, 20), "GA4 호출이 시작되지 않음"


async def _run_cron(Session):
    from app.routers import cron as cron_mod

    async with Session() as s:
        with patch.object(cron_mod, "verify_cron", MagicMock()):
            resp = await cron_mod.score_ga4_outcomes(MagicMock(), s)
    import json

    return json.loads(resp.body)["data"]


@pytest.mark.anyio
async def test_story_rows_are_not_locked_while_ga4_is_called():
    """둘째 GA4 호출 도중 다른 세션이 두 story를 UPDATE — lock_timeout 2초 안에 끝난다(예전: 앞서 채점된 story의 UPDATE 잠금이 커밋까지 쌓여 RED)."""
    from sqlalchemy import text

    engine, Session = await _session_factory()
    try:
        ids = await _seed_ga4_stories(Session, 2)
        fake = _BlockingGa4(block_on_call=2)
        with patch("app.services.outcome_scorer.score_ga4_outcome", side_effect=fake):
            task = asyncio.create_task(_run_cron(Session))
            await fake.wait_started()
            try:
                async with Session() as other:
                    await other.execute(text("SET LOCAL lock_timeout = '2s'"))
                    for story_id in ids:
                        await other.execute(text("UPDATE stories SET title = 'edited' WHERE id = :id"), {"id": story_id})
                    await other.commit()
            finally:
                fake.release.set()
                data = await task
        assert len(data["scored"]) == 2
        for story_id in ids:
            story = await _story(Session, story_id)
            assert (story.title, story.outcome_status) == ("edited", "hit")
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_human_verdict_during_ga4_call_is_not_overwritten():
    """GA4 호출 도중 사람이 판정(pending → miss) — cron은 pending일 때만 기록하므로 덮지 않는다."""
    from sqlalchemy import text

    engine, Session = await _session_factory()
    try:
        [story_id] = await _seed_ga4_stories(Session, 1)
        fake = _BlockingGa4(block_on_call=1)
        with patch("app.services.outcome_scorer.score_ga4_outcome", side_effect=fake):
            task = asyncio.create_task(_run_cron(Session))
            await fake.wait_started()
            try:
                async with Session() as human:
                    await human.execute(text("SET LOCAL lock_timeout = '2s'"))
                    await human.execute(
                        text("UPDATE stories SET outcome_status = 'miss' WHERE id = :id"), {"id": story_id},
                    )
                    await human.commit()
            finally:
                fake.release.set()
                data = await task
        assert data["scored"] == []
        assert (await _story(Session, story_id)).outcome_status == "miss"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_ga4_call_cap_defers_the_rest_to_the_next_run():
    """한 판 GA4 호출 상한 2 · 대상 3 → 둘 채점 · 하나 deferred(pending 그대로). 다음 판이 나머지를 채점."""
    from app.routers import cron as cron_mod

    engine, Session = await _session_factory()
    try:
        ids = await _seed_ga4_stories(Session, 3)
        fake = _BlockingGa4(block_on_call=0)
        with patch("app.services.outcome_scorer.score_ga4_outcome", side_effect=fake), \
             patch.object(cron_mod, "_GA4_SCORE_MAX_CALLS", 2):
            first = await _run_cron(Session)
            second = await _run_cron(Session)
        assert (len(first["scored"]), len(first["deferred"])) == (2, 1)
        assert fake.calls == 3  # 다음 판은 남은 하나만
        assert (len(second["scored"]), second["deferred"]) == (1, [])
        for story_id in ids:
            assert (await _story(Session, story_id)).outcome_status == "hit"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_time_budget_spent_defers_every_ga4_target():
    """시간 상한이 이미 다 쓰였으면 GA4를 부르지 않고 전부 deferred — 행은 pending 그대로."""
    from app.routers import cron as cron_mod

    engine, Session = await _session_factory()
    try:
        ids = await _seed_ga4_stories(Session, 2)
        fake = _BlockingGa4(block_on_call=0)
        with patch("app.services.outcome_scorer.score_ga4_outcome", side_effect=fake), \
             patch.object(cron_mod, "_GA4_SCORE_TIME_BUDGET_S", 0.0):
            data = await _run_cron(Session)
        assert fake.calls == 0
        assert (data["scored"], len(data["deferred"])) == ([], 2)
        for story_id in ids:
            assert (await _story(Session, story_id)).outcome_status == "pending"
    finally:
        await engine.dispose()
