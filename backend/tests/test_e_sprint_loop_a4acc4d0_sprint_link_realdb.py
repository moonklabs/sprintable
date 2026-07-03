"""E-SPRINT-LOOP a4acc4d0: HypothesisSprintLink 재배정 — realdb 원자성 실증(까심 RC②).

select→delete→insert 3단계(구 구현)는 동시 재링크 시 둘 다 no-row를 관측한 뒤 각자
insert해 uq_hypothesis_sprint_links_hypothesis 위반(500)이 날 수 있는 TOCTOU 레이스였다.
`INSERT ... ON CONFLICT (hypothesis_id) DO UPDATE`(HypothesisRepository.set_sprint_link)로
교체한 뒤, **실제 동시 두 세션이 같은 hypothesis를 서로 다른 sprint로 동시 재배정**해도
예외 없이 정확히 1행만 남는지 실 Postgres로 검증한다(mock 세션으로는 DB 레벨 락/원자성을
관측할 수 없어 이 파일이 필요 — codex 지적).
"""
from __future__ import annotations

import asyncio
import os
import uuid
from datetime import datetime, timezone

import pytest
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)

pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")

ORG = uuid.UUID("da000000-0000-0000-0000-000000000001")
PROJ = uuid.UUID("da000000-0000-0000-0000-0000000000c1")
OWNER = uuid.UUID("da000000-0000-0000-0000-0000000000b1")
HYP = uuid.UUID("da000000-0000-0000-0000-0000000000d1")
SPRINT_A = uuid.UUID("da000000-0000-0000-0000-0000000000e1")
SPRINT_B = uuid.UUID("da000000-0000-0000-0000-0000000000e2")


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _seed(s):
    for sql in [
        f"DELETE FROM hypothesis_sprint_links WHERE hypothesis_id='{HYP}'",
        f"DELETE FROM hypotheses WHERE id='{HYP}'",
        f"DELETE FROM sprints WHERE id IN ('{SPRINT_A}','{SPRINT_B}')",
        f"DELETE FROM projects WHERE id='{PROJ}'",
        f"DELETE FROM organizations WHERE id='{ORG}'",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','DA','da-org','free')",
        f"INSERT INTO projects (id,org_id,name,violation_level) VALUES "
        f"('{PROJ}','{ORG}','P','none')",
        f"INSERT INTO sprints (id,org_id,project_id,title,status,duration) VALUES "
        f"('{SPRINT_A}','{ORG}','{PROJ}','sprint-a','planning',14)",
        f"INSERT INTO sprints (id,org_id,project_id,title,status,duration) VALUES "
        f"('{SPRINT_B}','{ORG}','{PROJ}','sprint-b','planning',14)",
    ]:
        await s.execute(text(sql))
    # metric_definition JSON 리터럴의 콜론(`"target":1`)이 text()의 `:bindparam` 파서와
    # 충돌해(asyncpg text() 함정) 별도 bound parameter로 분리(feedback_asyncpg_text_traps 동형).
    await s.execute(
        text(
            "INSERT INTO hypotheses (id,org_id,project_id,owner_member_id,statement,"
            "metric_definition,measure_after,status,human_accounting,gate_contract) VALUES "
            "(:id,:org_id,:project_id,:owner_id,:statement,"
            "CAST(:metric AS jsonb),:measure_after,'proposed','{}','{}')"
        ),
        {
            "id": HYP, "org_id": ORG, "project_id": PROJ, "owner_id": OWNER,
            "statement": "stmt",
            "metric": '{"metric":"x","source":"manual","target":1,"direction":"up"}',
            "measure_after": datetime(2026, 8, 1, tzinfo=timezone.utc),
        },
    )
    await s.commit()


async def _engine():
    eng = create_async_engine(_ASYNC)
    return eng, async_sessionmaker(eng, expire_on_commit=False)


@pytest.mark.anyio
async def test_sequential_reassign_replaces_no_violation():
    """A→B 순차 재배정 — 정확히 1행, 최신 sprint_id만 남음(구현 §2 카디널리티 실증)."""
    from app.models.hypothesis import HypothesisSprintLink
    from app.repositories.hypothesis import HypothesisRepository

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)

        async with Session() as s:
            repo = HypothesisRepository(s, ORG)
            await repo.set_sprint_link(HYP, SPRINT_A, "declared")
            await repo.set_sprint_link(HYP, SPRINT_B, "declared")  # 재배정
            await s.commit()

        async with Session() as s:
            rows = (await s.execute(
                select(HypothesisSprintLink).where(HypothesisSprintLink.hypothesis_id == HYP)
            )).scalars().all()
            assert len(rows) == 1
            assert rows[0].sprint_id == SPRINT_B
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_concurrent_reassign_atomic_no_unique_violation():
    """두 세션이 동시에 같은 hypothesis를 다른 sprint로 재배정 — 예외 없이 정확히 1행
    (구 select→delete→insert였다면 둘 다 no-row 관측→unique_violation 위험이 있던 지점)."""
    from app.models.hypothesis import HypothesisSprintLink
    from app.repositories.hypothesis import HypothesisRepository

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
            repo = HypothesisRepository(s, ORG)
            await repo.set_sprint_link(HYP, SPRINT_A, "declared")  # 최초 링크
            await s.commit()

        async def _reassign(sprint_id):
            async with Session() as s:
                repo = HypothesisRepository(s, ORG)
                await repo.set_sprint_link(HYP, sprint_id, "declared")
                await s.commit()

        # 동시 재배정 — 둘 다 예외 없이 완료돼야(ON CONFLICT 원자성).
        results = await asyncio.gather(
            _reassign(SPRINT_A), _reassign(SPRINT_B), return_exceptions=True
        )
        exceptions = [r for r in results if isinstance(r, Exception)]
        assert exceptions == [], f"동시 재배정이 예외를 냄(원자성 깨짐): {exceptions}"

        async with Session() as s:
            rows = (await s.execute(
                select(HypothesisSprintLink).where(HypothesisSprintLink.hypothesis_id == HYP)
            )).scalars().all()
            assert len(rows) == 1  # 어느 한쪽이 이기든 정확히 1행만 생존
            assert rows[0].sprint_id in (SPRINT_A, SPRINT_B)
    finally:
        await eng.dispose()
