"""story #2845(loop-closure P2) — list_measure_due_queue 실PG 검증.

detect_unclosed_loops()와 같은 3축 union을 읽기전용으로 재사용한다는 것을 실측한다 —
발행 부작용 0(notified_at 미기록·Event 미생성)·command_center.py의 limit=20 요약과 달리
전량 페이지네이션·claim(=기존 owner_member_id/assignee_id) 유무로 필터.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select

from app.services.loop_measure_due import list_measure_due_queue
from tests.test_1994_backlink_api_realdb import _make_org, _make_project, _session_factory
from tests.test_2288_command_center_gate_type_waiting_realdb import _make_member
from tests.test_2301_story_body_mentions_realdb import _REAL_DB_URL
from tests.test_2829_loop_measure_due_realdb import _make_goal, _make_hypothesis

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
]

_PAST = datetime(2020, 1, 1, tzinfo=timezone.utc)


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


@pytest.mark.anyio
async def test_queue_paginates_beyond_command_center_20_cap():
    """command_center.py attention_item은 타입당 limit=20 요약뿐 — 이 큐는 limit/offset으로
    전량 순회 가능해야 한다(claim 큐 자체가 목적, 대시보드 nudge가 아님)."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            owner_id, _ = await _make_member(s, org.id, project.id)
            hyps = [
                await _make_hypothesis(
                    s, org.id, project.id, owner_id,
                    measure_after=_PAST + timedelta(days=i),
                )
                for i in range(3)
            ]

            page1 = await list_measure_due_queue(s, org.id, project_id=project.id, limit=2, offset=0)
            page2 = await list_measure_due_queue(s, org.id, project_id=project.id, limit=2, offset=2)

            assert page1["total"] == 3
            assert len(page1["items"]) == 2
            assert len(page2["items"]) == 1
            all_ids = {it["work_item_id"] for it in page1["items"] + page2["items"]}
            assert all_ids == {str(h.id) for h in hyps}
            # 오래된(measure_after 이른) 순 — page1이 가장 오래된 둘을 먼저 담아야 한다.
            assert page1["items"][0]["work_item_id"] == str(hyps[0].id)
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_unclaimed_only_excludes_owned_items():
    """§AC — 고아(owner 없음) 큐 필터. owner 있는 항목은 unclaimed_only=True에서 빠진다.

    hypotheses.owner_member_id는 DB NOT NULL(model 71행) — 실측 결과 «고아»는 goal
    (assignee_id nullable)만 실재할 수 있다(#2845 dev DB 분포 실측이 잡은 85건도 전부
    goal 축). 그래서 이 테스트는 goal로만 고아를 구성한다 — hypothesis로 시도하면
    NotNullViolationError로 즉시 반증되는 것을 이미 확認."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            owner_id, _ = await _make_member(s, org.id, project.id)
            owned = await _make_goal(s, org.id, project.id, owner_id, status="active")
            orphan = await _make_goal(s, org.id, project.id, None, status="active")

            all_items = await list_measure_due_queue(s, org.id, project_id=project.id)
            unclaimed = await list_measure_due_queue(s, org.id, project_id=project.id, unclaimed_only=True)

            all_ids = {it["work_item_id"] for it in all_items["items"]}
            unclaimed_ids = {it["work_item_id"] for it in unclaimed["items"]}
            assert {str(owned.id), str(orphan.id)} <= all_ids
            assert str(orphan.id) in unclaimed_ids
            assert str(owned.id) not in unclaimed_ids
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_queue_read_has_zero_side_effects():
    """읽기전용 확認 — detect_unclosed_loops와 달리 notified_at 미기록·Event 미발행."""
    from app.models.event import Event
    from app.models.hypothesis import Hypothesis

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            owner_id, _ = await _make_member(s, org.id, project.id)
            hyp = await _make_hypothesis(s, org.id, project.id, owner_id)

            await list_measure_due_queue(s, org.id, project_id=project.id)

            refreshed = (
                await s.execute(select(Hypothesis).where(Hypothesis.id == hyp.id))
            ).scalar_one()
            assert refreshed.loop_measure_due_notified_at is None

            events = (
                await s.execute(select(Event).where(Event.org_id == org.id))
            ).scalars().all()
            assert events == []
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_queue_unifies_hypothesis_and_goal_categories_across_shared_project():
    """3축(가설 도과·goal 도과·outcome 없는 done goal) 전부 한 페이지네이션 목록에 섞여
    나와야 한다 — work_item_type으로 구분 가능."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            owner_id, _ = await _make_member(s, org.id, project.id)
            hyp = await _make_hypothesis(s, org.id, project.id, owner_id)
            overdue_goal = await _make_goal(s, org.id, project.id, owner_id, status="active")
            done_goal = await _make_goal(
                s, org.id, project.id, owner_id, status="done", measure_after=None, outcome_status="n_a",
            )

            result = await list_measure_due_queue(s, org.id, project_id=project.id)

            by_id = {it["work_item_id"]: it for it in result["items"]}
            assert by_id[str(hyp.id)]["work_item_type"] == "hypothesis"
            assert by_id[str(overdue_goal.id)]["work_item_type"] == "epic"
            assert by_id[str(overdue_goal.id)]["reason"] == "measure_after_overdue"
            assert by_id[str(done_goal.id)]["work_item_type"] == "epic"
            assert by_id[str(done_goal.id)]["reason"] == "done_without_outcome"
    finally:
        await engine.dispose()
