"""story #4382 — 순서 없는 LIMIT · 동률 단일 키 정렬이 요청마다 다른 결과를 내던 자리(실 PG).

AC1 attention: in-review 101건(병합 가능 1건을 맨 뒤에 넣음)에서 그 1건이 merge_ready로 나온다(예전 코드는 in-review 100건을 먼저 읽은
    뒤 파이썬에서 걸러 빠뜨렸다). 101건이 다 병합 가능하면 100건 + `truncated_kinds=["merge_ready"]`. 다섯 신호 모두 같은 시각 동률에서도
    «그 상태에 가장 오래 있던 것 먼저 · id 보조 키»로 정해진 순서다.
AC2 담당: 한 트랜잭션에 넣은 담당 둘(시각 동률 · 대표가 아닌 쪽을 먼저 넣음) — 목록 · 단건 · story_list_facts 모두 대표 담당이 맨 앞.

양성 대조(옛 코드에서 RED)는 PR 본문에 명령과 결과를 싣는다. 비파괴 — 매 테스트가 새 조직을 만든다.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요")]

T0 = datetime(2026, 9, 1, tzinfo=timezone.utc)


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

    engine = create_async_engine(_async_url())
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _org_project(s):
    from app.models.member import Member
    from app.models.organization import Organization
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="O4382", slug=f"o4382-{uuid.uuid4().hex[:8]}")
    s.add(org)
    await s.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    reviewer = Member(id=uuid.uuid4(), org_id=org.id, type="human", name="Reviewer", org_role="admin")
    s.add_all([project, reviewer])
    await s.commit()
    return org.id, project.id, reviewer.id


def _story(org_id, project_id, title, status="in-review", **kw):
    from app.models.pm import Story

    return Story(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title, status=status, **kw)


def _approval(org_id, story_id, reviewer_id):
    from app.models.evidence import Evidence

    return Evidence(
        id=uuid.uuid4(), org_id=org_id, work_item_id=story_id, work_item_type="story",
        type="gate_approval", ref="approved", created_by=reviewer_id,
    )


async def _attention(Session, org_id, project_id):
    from app.routers.glance import _compute_attention_for_project

    async with Session() as s:
        return await _compute_attention_for_project(s, org_id, project_id)


def _of(resp, kind):
    return [item for item in resp.items if item.kind == kind]


@pytest.mark.anyio
async def test_the_one_mergeable_story_among_101_in_review_is_never_dropped():
    """⭐AC1 — 병합 안 되는 in-review 100건을 먼저, 병합 가능 1건을 맨 뒤에 넣는다. 판정을 SQL에서 먼저 걸어 그 1건이 늘 나온다."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id, reviewer_id = await _org_project(s)
            s.add_all([_story(org_id, project_id, f"not-verified-{i:03d}") for i in range(100)])
            await s.commit()
            mergeable = _story(org_id, project_id, "mergeable-last")
            s.add(mergeable)
            await s.commit()
            s.add(_approval(org_id, mergeable.id, reviewer_id))
            await s.commit()

        for _ in range(2):
            resp = await _attention(Session, org_id, project_id)
            assert [item.story_id for item in _of(resp, "merge_ready")] == [mergeable.id]
            assert resp.truncated_kinds == []
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_101_mergeable_answers_100_in_a_fixed_order_and_says_it_was_truncated():
    """101건 모두 병합 가능 — 100건(진입 시각 모름 = NULL은 뒤 · 그 안에선 id 순) + truncated_kinds=["merge_ready"] · 두 번 불러도 같다."""
    from app.models.pm import StoryActivity

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id, reviewer_id = await _org_project(s)
            stories = [_story(org_id, project_id, f"m-{i:03d}") for i in range(101)]
            s.add_all(stories)
            await s.commit()
            s.add_all([_approval(org_id, st.id, reviewer_id) for st in stories])
            # 둘은 in-review 진입 시각이 있다(같은 시각 동률) — 시각이 있는 것이 먼저, 동률이면 id 순.
            timed = sorted(stories[40:42], key=lambda st: st.id)
            s.add_all([
                StoryActivity(
                    id=uuid.uuid4(), org_id=org_id, story_id=st.id, activity_type="status_changed",
                    old_value="in-progress", new_value="in-review", project_id=project_id, created_by=reviewer_id, created_at=T0,
                )
                for st in reversed(timed)
            ])
            await s.commit()

        first = await _attention(Session, org_id, project_id)
        second = await _attention(Session, org_id, project_id)
        got = [item.story_id for item in _of(first, "merge_ready")]
        untimed = sorted((st.id for st in stories if st not in timed), key=str)
        assert got == [st.id for st in timed] + untimed[:98]
        assert got == [item.story_id for item in _of(second, "merge_ready")]
        assert first.truncated_kinds == ["merge_ready"]
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_each_signal_orders_ties_by_id_and_is_stable_across_calls():
    """AC1 — gate_pending · blocked · needs_input · verify_fail · merge_ready 각각 같은 시각 셋을 id 역순으로 넣어도 (시각, id) 순."""
    from app.models.dependency import ItemDependency
    from app.models.gate import Gate
    from app.models.pm import StoryActivity
    from app.models.workflow_line import WorkflowLineStepApproval

    def by_id(rows):
        return sorted(rows, key=lambda row: str(row.id))

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id, reviewer_id = await _org_project(s)
            blocker = _story(org_id, project_id, "blocker", status="in-progress")
            gate_stories = [_story(org_id, project_id, f"g-{i}", status="in-progress") for i in range(3)]
            need_stories = [_story(org_id, project_id, f"n-{i}", status="in-progress") for i in range(3)]
            fail_stories = [_story(org_id, project_id, f"f-{i}", status="in-progress") for i in range(3)]
            blocked_stories = [_story(org_id, project_id, f"b-{i}", status="in-progress") for i in range(3)]
            merge_stories = [_story(org_id, project_id, f"m-{i}") for i in range(3)]
            s.add_all([blocker, *gate_stories, *need_stories, *fail_stories, *blocked_stories, *merge_stories])
            await s.commit()

            review_gates = [Gate(id=uuid.uuid4(), org_id=org_id, work_item_id=st.id, work_item_type="story",
                                 gate_type="review", status="approved") for st in gate_stories]
            s.add_all(review_gates)
            await s.commit()
            approvals = by_id([WorkflowLineStepApproval(
                id=uuid.uuid4(), org_id=org_id, project_id=project_id, step_run_id=uuid.uuid4(),
                approval_group_id=uuid.uuid4(), approver_member_id=uuid.uuid4(), approver_member_type="agent",
                gate_id=g.id, kind="approver", blocking=True, status="pending", created_at=T0,
            ) for g in review_gates])
            need_gates = by_id([Gate(id=uuid.uuid4(), org_id=org_id, work_item_id=st.id, work_item_type="story",
                                     gate_type="review", status="pending", requires_human=True, status_entered_at=T0)
                                for st in need_stories])
            fail_gates = [Gate(id=uuid.uuid4(), org_id=org_id, work_item_id=st.id, work_item_type="story",
                               gate_type="merge", status="approved", evidence_status="blocked",
                               evidence_status_entered_at=T0) for st in fail_stories]
            deps = by_id([ItemDependency(id=uuid.uuid4(), org_id=org_id, from_id=blocker.id, to_id=st.id,
                                         dep_type="blocks", item_type="story", created_at=T0)
                          for st in blocked_stories])
            # 물리 순서를 뒤집어 넣는다 — 정렬이 없으면 넣은 순서(역순)가 그대로 나올 공산이 크다.
            s.add_all([*reversed(approvals), *reversed(need_gates), *fail_gates, *reversed(deps)])
            s.add_all([_approval(org_id, st.id, reviewer_id) for st in merge_stories])
            s.add_all([StoryActivity(
                id=uuid.uuid4(), org_id=org_id, story_id=st.id, activity_type="status_changed",
                old_value="in-progress", new_value="in-review", project_id=project_id, created_by=reviewer_id, created_at=T0,
            ) for st in merge_stories])
            await s.commit()

        expected = {
            "gate_pending": [a.gate_id for a in approvals],
            "needs_input": [g.id for g in need_gates],
            "verify_fail": sorted((st.id for st in fail_stories), key=str),
            "blocked": [d.to_id for d in deps],
            "merge_ready": sorted((st.id for st in merge_stories), key=str),
        }
        for _ in range(2):
            resp = await _attention(Session, org_id, project_id)
            got = {
                "gate_pending": [uuid.UUID(i.ref["gate_id"]) for i in _of(resp, "gate_pending")],
                "needs_input": [uuid.UUID(i.ref["gate_id"]) for i in _of(resp, "needs_input")],
                "verify_fail": [i.story_id for i in _of(resp, "verify_fail")],
                "blocked": [i.story_id for i in _of(resp, "blocked")],
                "merge_ready": [i.story_id for i in _of(resp, "merge_ready")],
            }
            assert got == expected
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_older_entry_comes_first_before_the_id_tiebreak():
    """시각이 다르면 오래된 것이 먼저(id가 더 작아도 늦게 들어온 것은 뒤)."""
    from app.models.gate import Gate

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id, _ = await _org_project(s)
            a, b = _story(org_id, project_id, "a", status="in-progress"), _story(org_id, project_id, "b", status="in-progress")
            s.add_all([a, b])
            await s.commit()
            ids = sorted([uuid.uuid4(), uuid.uuid4()], key=str)
            s.add_all([
                Gate(id=ids[0], org_id=org_id, work_item_id=a.id, work_item_type="story", gate_type="review",
                     status="pending", requires_human=True, status_entered_at=T0 + timedelta(hours=1)),
                Gate(id=ids[1], org_id=org_id, work_item_id=b.id, work_item_type="story", gate_type="review",
                     status="pending", requires_human=True, status_entered_at=T0),
            ])
            await s.commit()
        resp = await _attention(Session, org_id, project_id)
        assert [i.story_id for i in _of(resp, "needs_input")] == [b.id, a.id]
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_representative_assignee_comes_first_everywhere_even_on_a_created_at_tie():
    """⭐AC2 — 담당 둘을 한 트랜잭션에(created_at 동률) · 대표가 아닌 쪽(id도 더 작음)을 먼저 넣는다. 저장소 목록 · 단건 · story_list_facts
    모두 [대표, 나머지]."""
    from sqlalchemy import select

    from app.models.pm import Story
    from app.models.story_assignee import StoryAssignee
    from app.repositories.story_assignee import StoryAssigneeRepository
    from app.services.story_list_facts import batch_story_list_facts

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id, _ = await _org_project(s)
            other, representative = sorted([uuid.uuid4(), uuid.uuid4()], key=str)
            story = _story(org_id, project_id, "two assignees", status="in-progress", assignee_id=representative)
            s.add(story)
            await s.commit()
            s.add(StoryAssignee(org_id=org_id, story_id=story.id, member_id=other, created_at=T0))
            s.add(StoryAssignee(org_id=org_id, story_id=story.id, member_id=representative, created_at=T0))
            await s.commit()

        for _ in range(2):
            async with Session() as s:
                repo = StoryAssigneeRepository(s, org_id)
                assert await repo.list_member_ids(story.id) == [representative, other]
                assert (await repo.map_member_ids([story.id]))[story.id] == [representative, other]
                loaded = (await s.execute(select(Story).where(Story.id == story.id))).scalar_one()
                _, facts = await batch_story_list_facts(s, org_id, [loaded])
                assert facts[story.id].assignee_ids == [representative, other]
    finally:
        await engine.dispose()
