"""story #4299 ② — 목록(`StoryRepository.list`) · glance attention이 `stories`를 프로젝트로 거를 때 0415 인덱스
(`ix_stories_project_created_live`: project_id, created_at DESC, id DESC · WHERE deleted_at IS NULL)를 **쓸 수 있는가**.

dev EXPLAIN(PO 2026-09-28): 목록 · count · attention 프로젝트 거르기가 `Seq Scan on stories`(8,009행)였다.
코드가 실제로 낸 문장을 그대로(파라미터째) 잡아 `enable_seqscan=off`로 EXPLAIN — 그래도 stories 순차 훑기가 남으면 인덱스를 **쓸 수
없는** 것(부분 조건 · 칼럼이 조회와 어긋남 — 0384가 겪은 조용한 무효). 작은 시드에선 플래너가 전체 훑기를 고를 수 있어 «쓸 수 있는가»만 본다.
"""
from __future__ import annotations

import os
import uuid

import pytest
from sqlalchemy import event, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace("postgresql://", "postgresql+asyncpg://")
pytestmark = [pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip"), pytest.mark.anyio]

_INDEX = "ix_stories_project_created_live"


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _seed(s) -> tuple[uuid.UUID, uuid.UUID, uuid.UUID]:
    org, proj, other = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    await s.execute(text(f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{org}','O','o-{org.hex[:12]}','free')"))
    for p in (proj, other):
        await s.execute(text(f"INSERT INTO projects (id,org_id,name,slug,violation_level) VALUES ('{p}','{org}','P','p-{p.hex[:12]}','warn')"))
    statuses = ["backlog", "ready-for-dev", "in-progress", "in-review", "done"]
    for i in range(40):
        await s.execute(text(
            "INSERT INTO stories (id,org_id,project_id,title,status,priority) "
            f"VALUES (gen_random_uuid(),'{org}','{proj if i % 2 else other}','S{i}','{statuses[i % 5]}','medium')"
        ))
    await s.commit()
    return org, proj, other


async def _cleanup(s, org: uuid.UUID) -> None:
    await s.execute(text(f"DELETE FROM stories WHERE org_id = '{org}'"))
    await s.execute(text(f"DELETE FROM projects WHERE org_id = '{org}'"))
    await s.execute(text(f"DELETE FROM organizations WHERE id = '{org}'"))
    await s.commit()


async def _captured_story_scans(run) -> list[tuple[str, tuple]]:
    """run(session)이 낸 문장 중 stories를 프로젝트로 거르는 것만(문장 · 파라미터)."""
    eng = create_async_engine(_ASYNC)
    Session = async_sessionmaker(eng, expire_on_commit=False)
    caught: list[tuple[str, tuple]] = []
    capturing = [False]

    @event.listens_for(eng.sync_engine, "before_cursor_execute")
    def _catch(conn, cursor, statement, parameters, context, executemany):
        if not capturing[0]:
            return
        low = " ".join(statement.split()).lower()
        if "from stories" in low and "stories.project_id =" in low:
            caught.append((statement, tuple(parameters) if isinstance(parameters, (list, tuple)) else ()))

    try:
        async with Session() as s:
            org, proj, _other = await _seed(s)
        try:
            capturing[0] = True
            async with Session() as s:
                await run(s, org, proj)
            capturing[0] = False
            plans = []
            async with eng.connect() as conn:
                await conn.exec_driver_sql("SET enable_seqscan = off")
                for statement, params in caught:
                    rows = (await conn.exec_driver_sql("EXPLAIN " + statement, params)).all()
                    plans.append((statement, "\n".join(r[0] for r in rows)))
            return plans
        finally:
            async with Session() as s:
                await _cleanup(s, org)
    finally:
        await eng.dispose()


def _assert_uses_index(plans):
    assert plans, "잡힌 문장이 없다 — 가드가 헛돈다(조회 모양이 바뀌었으면 필터를 맞출 것)"
    for statement, plan in plans:
        assert "Seq Scan on stories" not in plan, f"stories 순차 훑기가 남았다 — 0415 인덱스를 못 쓴다:\n{statement}\n{plan}"
        assert _INDEX in plan, f"0415 인덱스를 안 탄다:\n{statement}\n{plan}"


@pytest.mark.parametrize("unattached", [False, True], ids=["board-list", "unattached-bucket"])
async def test_story_list_can_use_the_project_index(unattached):
    from app.repositories.story import StoryRepository

    async def run(s, org, proj):
        await StoryRepository(s, org).list(limit=51 if not unattached else 100, project_id=proj, unattached=unattached)

    _assert_uses_index(await _captured_story_scans(run))


async def test_glance_attention_project_filters_can_use_the_project_index():
    from app.routers.glance import _compute_attention_for_project

    async def run(s, org, proj):
        await _compute_attention_for_project(s, org, proj)

    plans = await _captured_story_scans(run)
    # attention의 `FROM stories … project_id = …`(in-review · stalled 모집단 등)만 — 게이트 · 의존성에서 stories를 JOIN하는 문장은 별개.
    _assert_uses_index([(st, pl) for st, pl in plans if " ".join(st.split()).lower().split(" from ", 1)[1].startswith("stories")])
