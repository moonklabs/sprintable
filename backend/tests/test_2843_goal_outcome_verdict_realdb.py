"""story #2843(PO AC 확定 2026-08-20, doc loop-closure-first-class-signal-design §2 P1) —
goal active→done 전이의 outcome 판정 계약. 어휘는 goal의 **기존 자동채점 어휘 그대로**(hit/miss —
hypothesis의 verified/falsified를 goal에 수입하는 안은 기각·같은 컬럼 두 방언 문제).

신값 둘: `unmeasured`(판정 미제공 시 자동 마킹·루프 N 잔류) / `unmeasurable`(명시 «측정 불가»
선언·사유 필수·루프 N 제외하되 별도 카운트 노출). collision 규칙: ①manual 판정(source=manual
마커)은 cron scorer가 안 덮음 ②旣 hit/miss는 done 재전이 시 판정 재요구 안 함.

근거 요구는 hypothesis #2038과 공유(`outcome_evidence.py`) — hit/miss는 actual+reason,
unmeasurable은 reason만."""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = pytest.mark.destructive_schema

_REAL_DB_SKIP = pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요")


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _session():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.core.database import Base
    import app.models  # noqa: F401
    import app.models.participation  # noqa: F401
    import app.models.workflow_line  # noqa: F401
    import app.models.event  # noqa: F401

    engine = create_async_engine(_async_url())
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_active_goal(session, *, outcome_status="n_a"):
    from app.models.pm import Goal
    from app.models.project import Project

    org, proj = uuid.uuid4(), uuid.uuid4()
    session.add(Project(id=proj, org_id=org, name="p"))
    await session.flush()
    goal = Goal(org_id=org, project_id=proj, title="g", status="active", outcome_status=outcome_status)
    session.add(goal)
    await session.commit()
    return org, goal.id


def _human():
    from app.services.member_resolver import ResolvedMember
    return ResolvedMember(id=uuid.uuid4(), user_id=uuid.uuid4(), name="h", type="human", role="member", org_id=uuid.uuid4())


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_done_without_verdict_auto_marks_unmeasured_and_succeeds_realdb():
    """AC1·AC5 — 판정 미제공은 전이를 막지 않는다(200 성립) + outcome_status=unmeasured 자동."""
    from app.services.goal import transition_goal
    from app.models.pm import Goal
    from sqlalchemy import select

    engine, Session = await _session()
    try:
        async with Session() as s:
            org, goal_id = await _seed_active_goal(s)
            caller = _human()
            goal = await transition_goal(s, org, caller, goal_id, "done")
            await s.commit()

            assert goal.status == "done"
            assert goal.outcome_status == "unmeasured"

            refetched = (await s.execute(select(Goal).where(Goal.id == goal_id))).scalar_one()
            assert refetched.outcome_status == "unmeasured"
    finally:
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_done_with_hit_no_evidence_rejected_realdb():
    from app.services.goal import transition_goal, GoalTransitionError

    engine, Session = await _session()
    try:
        async with Session() as s:
            org, goal_id = await _seed_active_goal(s)
            caller = _human()
            with pytest.raises(GoalTransitionError) as ei:
                await transition_goal(s, org, caller, goal_id, "done", outcome_status="hit")
            assert ei.value.code == "OUTCOME_RESULT_REQUIRED"
    finally:
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_done_with_hit_and_evidence_succeeds_and_injects_source_manual_realdb():
    from app.services.goal import transition_goal

    engine, Session = await _session()
    try:
        async with Session() as s:
            org, goal_id = await _seed_active_goal(s)
            caller = _human()
            goal = await transition_goal(
                s, org, caller, goal_id, "done",
                outcome_status="hit", outcome_result={"actual": 42, "reason": "목표 달성"},
            )
            await s.commit()

            assert goal.outcome_status == "hit"
            assert goal.outcome_result["actual"] == 42
            assert goal.outcome_result["source"] == "manual"
            assert goal.outcome_result["closed_by"] == "human"
            assert goal.outcome_result["closed_by_member_id"] == str(caller.id)
    finally:
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_done_with_miss_and_evidence_succeeds_realdb():
    from app.services.goal import transition_goal

    engine, Session = await _session()
    try:
        async with Session() as s:
            org, goal_id = await _seed_active_goal(s)
            caller = _human()
            goal = await transition_goal(
                s, org, caller, goal_id, "done",
                outcome_status="miss", outcome_result={"actual": 3, "reason": "목표 미달"},
            )
            assert goal.outcome_status == "miss"
    finally:
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_done_with_unmeasurable_no_reason_rejected_realdb():
    from app.services.goal import transition_goal, GoalTransitionError

    engine, Session = await _session()
    try:
        async with Session() as s:
            org, goal_id = await _seed_active_goal(s)
            caller = _human()
            with pytest.raises(GoalTransitionError) as ei:
                await transition_goal(s, org, caller, goal_id, "done", outcome_status="unmeasurable")
            assert ei.value.code == "OUTCOME_REASON_REQUIRED"
    finally:
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_done_with_unmeasurable_and_reason_succeeds_no_actual_required_realdb():
    """unmeasurable은 actual 없이도(측정 불가가 본질) reason만으로 성립."""
    from app.services.goal import transition_goal

    engine, Session = await _session()
    try:
        async with Session() as s:
            org, goal_id = await _seed_active_goal(s)
            caller = _human()
            goal = await transition_goal(
                s, org, caller, goal_id, "done",
                outcome_status="unmeasurable", outcome_result={"reason": "메트릭 소스 폐지"},
            )
            assert goal.outcome_status == "unmeasurable"
            assert goal.outcome_result["source"] == "manual"
    finally:
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_invalid_outcome_status_rejected_realdb():
    from app.services.goal import transition_goal, GoalTransitionError

    engine, Session = await _session()
    try:
        async with Session() as s:
            org, goal_id = await _seed_active_goal(s)
            caller = _human()
            with pytest.raises(GoalTransitionError) as ei:
                await transition_goal(s, org, caller, goal_id, "done", outcome_status="verified")
            assert ei.value.code == "INVALID_OUTCOME_STATUS"
    finally:
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_already_judged_goal_skips_verdict_requirement_realdb():
    """collision②: 旣 hit/miss(cron 자동채점 등으로 active 상태에서 이미 판정된 goal)는 done
    전이 시 판정 재요구 없이 성립·기존 값 보존."""
    from app.services.goal import transition_goal

    engine, Session = await _session()
    try:
        async with Session() as s:
            org, goal_id = await _seed_active_goal(s, outcome_status="hit")
            caller = _human()
            goal = await transition_goal(s, org, caller, goal_id, "done")  # outcome_status 미제공
            assert goal.status == "done"
            assert goal.outcome_status == "hit"  # unmeasured로 안 덮임
    finally:
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_cron_scorer_skips_manual_verdict_realdb():
    """collision①: source=manual 마커가 있는 goal은 cron 자동채점 루프가 실제로 건드리지
    않는다 — cron.py의 명시 스킵 가드(방어심층, 정상 경로에선 outcome_status가 항상 pending
    밖이라 WHERE가 이미 걸러내지만 그 «정상 경로 전제»가 깨지는 경합 상황을 직접 재현해
    코드 자체를 실행 검증). 코드가 도달하는 자리를 실제로 태우기 위해 outcome_status를
    직접 "pending"으로(정상 write 경로로는 절대 안 생기는 상태) seed한다."""
    from unittest.mock import AsyncMock, MagicMock, patch
    from datetime import datetime, timedelta, timezone

    from sqlalchemy import select

    from app.models.pm import Goal
    from app.models.project import Project
    from app.routers import cron as cron_mod

    engine, Session = await _session()
    try:
        async with Session() as s:
            org, proj = uuid.uuid4(), uuid.uuid4()
            s.add(Project(id=proj, org_id=org, name="p"))
            await s.flush()
            # 정상 write 경로로는 절대 안 생기는 조합(pending + source=manual) — 스킵 가드
            # 코드가 실제로 이 자리에 도달했을 때 올바르게 작동하는지를 직접 태운다.
            goal = Goal(
                org_id=org, project_id=proj, title="g", status="active",
                outcome_status="pending",
                outcome_result={"actual": 1, "reason": "manual verdict", "source": "manual"},
                measure_after=datetime.now(timezone.utc) - timedelta(days=1),
                metric_definition={"source": "ga4", "property_id": "x", "ga4_metric": "y"},
            )
            s.add(goal)
            await s.commit()
            goal_id = goal.id

        async with Session() as s:
            with patch.object(cron_mod, "verify_cron", MagicMock()), \
                 patch("app.services.outcome_scorer.score_ga4_outcome") as mock_score:
                await cron_mod.score_ga4_outcomes(MagicMock(), s)
            # 스킵 가드가 continue했다면 score_ga4_outcome은 이 goal에 대해 절대 호출 안 됐어야.
            mock_score.assert_not_called()

        async with Session() as s:
            refetched = (await s.execute(select(Goal).where(Goal.id == goal_id))).scalar_one()
            assert refetched.outcome_status == "pending"  # 안 덮임(스킵 가드 작동 확認)
            assert refetched.outcome_result["source"] == "manual"
    finally:
        await engine.dispose()
