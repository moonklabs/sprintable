"""story #2366(오르테가 판정 2026-07-31, 스레드 7256d5cc) — 「연결 0건」 화면이 297건의
확認 대기 후보를 못 말하던 갭의 BE 지원 경로: `GET /analytics/goal-edges/pending-count`.

디디 실측(2026-07-31 07:19Z, dev DB 직접) — `goal-edges`는 `status='declared'`만 세는데
org 전체에 declared 행이 0건이라, 297건의 cross-epic `estimated` 후보 쌍이 화면에 안
잡혔다. 이 엔드포인트는 그 297을 «화면이 지금 그리는 목표 집합 안에서만» 세도록 낸다.

⛔가장 중요한 핀(AC4) — `goal-edges`가 세는 축(status='declared')을 이 엔드포인트가
건드리지 않는다는 것을 실제로 대조한다: declared 상태 후보는 이 카운트에 «안 잡힌다».
"""
from __future__ import annotations

import uuid

import pytest

from tests.test_2267_story_origin_realdb import (
    _REAL_DB_URL,
    _client_for,
    _make_human_member,
    _make_org,
    _make_project,
    _session_factory,
    _setup_app_human,
)

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


async def _make_goal(session, org_id, project_id, title="Goal"):
    from app.models.pm import Goal
    goal = Goal(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title)
    session.add(goal)
    await session.commit()
    return goal


async def _make_story(session, org_id, project_id, epic_id=None, title="S"):
    from app.models.pm import Story
    story = Story(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title,
        status="backlog", priority="medium", epic_id=epic_id,
    )
    session.add(story)
    await session.commit()
    return story


async def _make_candidate(
    session, org_id, source_id, target_id, *, status, source_field="body",
):
    from app.models.reference_semantic_candidate import ReferenceSemanticCandidate
    session.add(ReferenceSemanticCandidate(
        id=uuid.uuid4(), org_id=org_id, source_type="story", source_field=source_field,
        source_id=source_id, target_type="story", target_id=target_id, form="mention",
        relation_kind=None, matched_keyword=None, snippet="s", status=status,
        declared_by=None, declared_at=None,
    ))
    await session.commit()


async def _call(client, project_id, epic_ids):
    return await client.get(
        "/api/v2/analytics/goal-edges/pending-count",
        params={"project_id": str(project_id), "epic_ids": ",".join(str(e) for e in epic_ids)},
    )


# ─── AC 핵심: cross-epic estimated 쌍이 주어진 epic 집합 안에서 세어진다 ─────


async def test_counts_cross_epic_estimated_pairs_within_given_epic_set():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            _, user_id = await _make_human_member(s, org.id, project.id)
            goal_a = await _make_goal(s, org.id, project.id, "A")
            goal_b = await _make_goal(s, org.id, project.id, "B")
            story_a = await _make_story(s, org.id, project.id, epic_id=goal_a.id)
            story_b = await _make_story(s, org.id, project.id, epic_id=goal_b.id)
            await _make_candidate(s, org.id, story_a.id, story_b.id, status="estimated")

        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            resp = await _call(client, project.id, [goal_a.id, goal_b.id])
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["count"] == 1
            assert body["requested_count"] == 2
            assert body["processed_count"] == 2
            assert body["skipped_epic_ids"] == []
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── AC4 핵심 핀: declared 상태는 이 카운트에 «안 잡힌다» — goal-edges 축과 분리 ──


async def test_declared_status_is_not_counted_here_goal_edges_axis_untouched():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            _, user_id = await _make_human_member(s, org.id, project.id)
            goal_a = await _make_goal(s, org.id, project.id, "A")
            goal_b = await _make_goal(s, org.id, project.id, "B")
            story_a = await _make_story(s, org.id, project.id, epic_id=goal_a.id)
            story_b = await _make_story(s, org.id, project.id, epic_id=goal_b.id)
            # declared 상태 — goal-edges가 세는 것이지 이 엔드포인트가 세는 게 아니다.
            await _make_candidate(s, org.id, story_a.id, story_b.id, status="declared")

        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            resp = await _call(client, project.id, [goal_a.id, goal_b.id])
            assert resp.status_code == 200, resp.text
            assert resp.json()["count"] == 0, "declared 상태가 pending count에 새어 들어갔다"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── 같은 목표 안(A→A)은 제외 ────────────────────────────────────────────────


async def test_same_epic_pair_excluded():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            _, user_id = await _make_human_member(s, org.id, project.id)
            goal_a = await _make_goal(s, org.id, project.id, "A")
            story_1 = await _make_story(s, org.id, project.id, epic_id=goal_a.id)
            story_2 = await _make_story(s, org.id, project.id, epic_id=goal_a.id)
            await _make_candidate(s, org.id, story_1.id, story_2.id, status="estimated")

        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            resp = await _call(client, project.id, [goal_a.id])
            assert resp.status_code == 200, resp.text
            assert resp.json()["count"] == 0
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── epic_id가 NULL이면 제외 ─────────────────────────────────────────────────


async def test_epic_id_null_excluded():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            _, user_id = await _make_human_member(s, org.id, project.id)
            goal_a = await _make_goal(s, org.id, project.id, "A")
            story_a = await _make_story(s, org.id, project.id, epic_id=goal_a.id)
            story_no_epic = await _make_story(s, org.id, project.id, epic_id=None)
            await _make_candidate(s, org.id, story_a.id, story_no_epic.id, status="estimated")

        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            resp = await _call(client, project.id, [goal_a.id])
            assert resp.status_code == 200, resp.text
            assert resp.json()["count"] == 0
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── epic_ids 집합 밖의 쌍은 안 잡힌다(프로젝트 전체가 아니라 «화면의 레인»만) ──


async def test_pair_outside_requested_epic_set_not_counted():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            _, user_id = await _make_human_member(s, org.id, project.id)
            goal_a = await _make_goal(s, org.id, project.id, "A")
            goal_b = await _make_goal(s, org.id, project.id, "B")
            goal_c = await _make_goal(s, org.id, project.id, "C — 화면에 없음")
            story_a = await _make_story(s, org.id, project.id, epic_id=goal_a.id)
            story_c = await _make_story(s, org.id, project.id, epic_id=goal_c.id)
            # goal_c는 요청 집합 밖 — 이 쌍은 화면(goal_a·goal_b)에 안 그려진다.
            await _make_candidate(s, org.id, story_a.id, story_c.id, status="estimated")

        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            resp = await _call(client, project.id, [goal_a.id, goal_b.id])
            assert resp.status_code == 200, resp.text
            assert resp.json()["count"] == 0, "화면에 없는 목표(goal_c) 쪽 쌍이 새어 들어왔다"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── 같은 스토리 쌍이 두 field(body/acceptance_criteria)에 걸려도 1로 dedup ──


async def test_same_story_pair_across_two_source_fields_dedups_to_one():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            _, user_id = await _make_human_member(s, org.id, project.id)
            goal_a = await _make_goal(s, org.id, project.id, "A")
            goal_b = await _make_goal(s, org.id, project.id, "B")
            story_a = await _make_story(s, org.id, project.id, epic_id=goal_a.id)
            story_b = await _make_story(s, org.id, project.id, epic_id=goal_b.id)
            await _make_candidate(
                s, org.id, story_a.id, story_b.id, status="estimated", source_field="body",
            )
            await _make_candidate(
                s, org.id, story_a.id, story_b.id, status="estimated",
                source_field="acceptance_criteria",
            )

        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            resp = await _call(client, project.id, [goal_a.id, goal_b.id])
            assert resp.status_code == 200, resp.text
            assert resp.json()["count"] == 1
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── cap 경로 실측(오르테가 지적, 2026-07-31) — 8건 표본 어디도 30건을 안 넘겨
# skipped_epic_ids를 채우는 두 줄이 「한 번도 실행되지 않는」 채로 초록이었다. 여기서
# 실제로 EPIC_FLOW_NODES_BATCH_MAX(30)을 넘겨 그 경로를 밟는다. ─────────────


async def test_cap_applies_when_epic_ids_exceeds_max_but_real_pair_stays_within_processed():
    """실제 쌍의 두 epic이 상한 30 «안»에 들면 — 나머지가 fake로 채워져도 정상 집계되고,
    skipped_epic_ids가 정확히 넘친 만큼만(가짜 것들) 채워진다."""
    from app.repositories.analytics import AnalyticsRepository
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            _, user_id = await _make_human_member(s, org.id, project.id)
            goal_a = await _make_goal(s, org.id, project.id, "A")
            goal_b = await _make_goal(s, org.id, project.id, "B")
            story_a = await _make_story(s, org.id, project.id, epic_id=goal_a.id)
            story_b = await _make_story(s, org.id, project.id, epic_id=goal_b.id)
            await _make_candidate(s, org.id, story_a.id, story_b.id, status="estimated")

        max_batch = AnalyticsRepository.EPIC_FLOW_NODES_BATCH_MAX
        fillers = [uuid.uuid4() for _ in range(max_batch - 2)]
        overflow = [uuid.uuid4() for _ in range(5)]
        # goal_a·goal_b를 앞쪽(처리되는 30개 안)에 두고, 뒤에 33개째부터 넘치게 채운다.
        epic_ids = [goal_a.id, goal_b.id, *fillers, *overflow]
        assert len(epic_ids) == max_batch + 5

        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            resp = await _call(client, project.id, epic_ids)
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["requested_count"] == max_batch + 5
            assert body["processed_count"] == max_batch
            assert set(body["skipped_epic_ids"]) == {str(e) for e in overflow}
            # 실제 쌍의 두 epic이 processed 안에 있으므로 여전히 잡힌다.
            assert body["count"] == 1
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_pair_silently_excluded_when_its_epics_fall_in_skipped_range():
    """⭐이것이 오르테가군이 짚은 위험이다 — 실제 쌍의 두 epic이 «넘친 쪽»(skipped)에
    있으면 count에 안 잡힌다. skipped_epic_ids가 비어 있지 않으면 그 count는 «부분»이라는
    것을 FE가 그 필드로만 판정할 수 있어야 한다(응답에 재료가 있는지가 이 테스트의 요지)."""
    from app.repositories.analytics import AnalyticsRepository
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            _, user_id = await _make_human_member(s, org.id, project.id)
            goal_a = await _make_goal(s, org.id, project.id, "A")
            goal_b = await _make_goal(s, org.id, project.id, "B")
            story_a = await _make_story(s, org.id, project.id, epic_id=goal_a.id)
            story_b = await _make_story(s, org.id, project.id, epic_id=goal_b.id)
            await _make_candidate(s, org.id, story_a.id, story_b.id, status="estimated")

        max_batch = AnalyticsRepository.EPIC_FLOW_NODES_BATCH_MAX
        fillers = [uuid.uuid4() for _ in range(max_batch)]
        # goal_a·goal_b를 상한 밖(31·32번째)에 둔다 — processed에서 빠진다.
        epic_ids = [*fillers, goal_a.id, goal_b.id]
        assert len(epic_ids) == max_batch + 2

        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            resp = await _call(client, project.id, epic_ids)
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["processed_count"] == max_batch
            assert set(body["skipped_epic_ids"]) == {str(goal_a.id), str(goal_b.id)}
            # ⭐실제로 존재하는 대기 쌍인데도 count=0 — skipped_epic_ids를 안 보면
            # FE가 이 0을 「대기 없음」으로 오독한다(오르테가 지적 그대로).
            assert body["count"] == 0
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── cross-project 404(기존 analytics 라우트와 동일 게이트) ─────────────────


async def test_cross_project_access_denied_404():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project_a = await _make_project(s, org.id, name="A")
            project_b = await _make_project(s, org.id, name="B")
            _, user_id = await _make_human_member(s, org.id, project_a.id)
            goal = await _make_goal(s, org.id, project_b.id, "B-goal")

        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            resp = await _call(client, project_b.id, [goal.id])
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── 빈 프로젝트 — 0/0 (오류 아님) ───────────────────────────────────────────


async def test_empty_project_returns_zero_not_error():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            _, user_id = await _make_human_member(s, org.id, project.id)
            goal_a = await _make_goal(s, org.id, project.id, "A")

        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            resp = await _call(client, project.id, [goal_a.id])
            assert resp.status_code == 200, resp.text
            assert resp.json()["count"] == 0
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
