"""story #2360(오르테가 판정 2026-07-31, 스레드 7256d5cc) — 목표(에픽) 간 「낳음」 연결을
목표 쌍 단위로 집계하는 `GET /api/v2/analytics/goal-edges`.

착수 前 조사(디디)에서 답한 넷을 그대로 AC로 박은 것 + 구현 중 발견한 다섯째(같은 스토리
쌍이 entity_references·reference_semantic_candidates 양쪽에 걸려도 1로 세야 한다)를
이 파일이 실측으로 고정한다.
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


async def _make_created_from(session, org_id, source_id, target_id):
    from app.services.reference_core import insert_reference
    await insert_reference(
        session, org_id=org_id, source_type="story", source_field="self", source_id=source_id,
        target_type="story", target_id=target_id, form="mention", created_by=None,
        relation="created_from",
    )
    await session.commit()


async def _make_declared_candidate(session, org_id, source_id, target_id, relation_kind, source_field="body"):
    from app.models.reference_semantic_candidate import ReferenceSemanticCandidate
    session.add(ReferenceSemanticCandidate(
        id=uuid.uuid4(), org_id=org_id, source_type="story", source_field=source_field,
        source_id=source_id, target_type="story", target_id=target_id, form="mention",
        relation_kind=relation_kind, matched_keyword=None, snippet="s", status="declared",
        declared_by=None, declared_at=None,
    ))
    await session.commit()


async def _call(client, project_id):
    return await client.get("/api/v2/analytics/goal-edges", params={"project_id": str(project_id)})


def _find_edge(rows, from_id, to_id):
    return next((r for r in rows if r["from_goal_id"] == str(from_id) and r["to_goal_id"] == str(to_id)), None)


# ─── ①②③: 두 소스 합산·A→A 제외·epic NULL 제외 ─────────────────────────────

async def test_goal_edges_combines_both_sources_excludes_self_loop_and_no_epic():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            _, user_id = await _make_human_member(s, org.id, project.id)
            goal_a = await _make_goal(s, org.id, project.id, "A")
            goal_b = await _make_goal(s, org.id, project.id, "B")

            # A -> B: created_from 한 건(kind 없음)
            s1 = await _make_story(s, org.id, project.id, epic_id=goal_a.id, title="A1")
            s2 = await _make_story(s, org.id, project.id, epic_id=goal_b.id, title="B1")
            await _make_created_from(s, org.id, s1.id, s2.id)

            # A -> B: declared 한 건 더(다른 스토리 쌍, kind='spawned') — count가 2로 늘어야 함
            s3 = await _make_story(s, org.id, project.id, epic_id=goal_a.id, title="A2")
            s4 = await _make_story(s, org.id, project.id, epic_id=goal_b.id, title="B2")
            await _make_declared_candidate(s, org.id, s3.id, s4.id, "spawned")

            # A -> A(자기 목표 안) — 제외돼야 함
            s5 = await _make_story(s, org.id, project.id, epic_id=goal_a.id, title="A3")
            s6 = await _make_story(s, org.id, project.id, epic_id=goal_a.id, title="A4")
            await _make_created_from(s, org.id, s5.id, s6.id)

            # epic 없는 스토리가 낀 연결 — 제외돼야 함
            s7 = await _make_story(s, org.id, project.id, epic_id=None, title="NOEPIC")
            await _make_created_from(s, org.id, s7.id, s2.id)

        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            resp = await _call(client, project.id)
            assert resp.status_code == 200, resp.text
            rows = resp.json()

            edge_ab = _find_edge(rows, goal_a.id, goal_b.id)
            assert edge_ab is not None, "A->B 연결이 아예 안 나왔다"
            assert edge_ab["count"] == 2, "두 소스(created_from+declared)가 합산 안 됐다"

            assert _find_edge(rows, goal_a.id, goal_a.id) is None, "A->A 자기 목표 안이 안 빠졌다"
            # epic 없는 스토리(s7)가 낀 연결은 goal_id 자체가 없어 어느 쪽에도 안 잡혀야 한다.
            assert all(r["from_goal_id"] != str(goal_a.id) or r["to_goal_id"] != str(goal_b.id)
                       or r["count"] == 2 for r in rows)
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


# ─── ⑤(구현 중 발견): 같은 스토리 쌍이 두 표 모두에 걸려도 1로 센다 ──────────

async def test_goal_edges_same_story_pair_in_both_sources_counts_once():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            _, user_id = await _make_human_member(s, org.id, project.id)
            goal_a = await _make_goal(s, org.id, project.id, "A")
            goal_b = await _make_goal(s, org.id, project.id, "B")

            src = await _make_story(s, org.id, project.id, epic_id=goal_a.id, title="SRC")
            tgt = await _make_story(s, org.id, project.id, epic_id=goal_b.id, title="TGT")
            # 같은 (src, tgt) 쌍이 created_from으로도, declared로도 동시에 걸린다.
            await _make_created_from(s, org.id, src.id, tgt.id)
            await _make_declared_candidate(s, org.id, src.id, tgt.id, "spawned", source_field="description")

        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            resp = await _call(client, project.id)
            assert resp.status_code == 200, resp.text
            edge = _find_edge(resp.json(), goal_a.id, goal_b.id)
            assert edge is not None
            assert edge["count"] == 1, "같은 스토리 쌍이 두 표에 걸려 있다고 2로 중복 집계했다"
            # 한 쌍 안에서 kind가 섞였다(created_from=없음 vs declared=spawned) — None이어야 함.
            assert edge["kind"] is None
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


# ─── kind 규칙 — 단일/혼합/없음 세 갈래 ──────────────────────────────────────

async def test_goal_edges_kind_single_value_when_uniform():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            _, user_id = await _make_human_member(s, org.id, project.id)
            goal_a = await _make_goal(s, org.id, project.id, "A")
            goal_b = await _make_goal(s, org.id, project.id, "B")

            s1 = await _make_story(s, org.id, project.id, epic_id=goal_a.id, title="A1")
            t1 = await _make_story(s, org.id, project.id, epic_id=goal_b.id, title="B1")
            await _make_declared_candidate(s, org.id, s1.id, t1.id, "spawned")
            s2 = await _make_story(s, org.id, project.id, epic_id=goal_a.id, title="A2")
            t2 = await _make_story(s, org.id, project.id, epic_id=goal_b.id, title="B2")
            await _make_declared_candidate(s, org.id, s2.id, t2.id, "spawned")

        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            resp = await _call(client, project.id)
            edge = _find_edge(resp.json(), goal_a.id, goal_b.id)
            assert edge["count"] == 2
            assert edge["kind"] == "spawned"
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


async def test_goal_edges_kind_null_when_mixed():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            _, user_id = await _make_human_member(s, org.id, project.id)
            goal_a = await _make_goal(s, org.id, project.id, "A")
            goal_b = await _make_goal(s, org.id, project.id, "B")

            s1 = await _make_story(s, org.id, project.id, epic_id=goal_a.id, title="A1")
            t1 = await _make_story(s, org.id, project.id, epic_id=goal_b.id, title="B1")
            await _make_declared_candidate(s, org.id, s1.id, t1.id, "spawned")
            s2 = await _make_story(s, org.id, project.id, epic_id=goal_a.id, title="A2")
            t2 = await _make_story(s, org.id, project.id, epic_id=goal_b.id, title="B2")
            await _make_declared_candidate(s, org.id, s2.id, t2.id, "followed")

        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            resp = await _call(client, project.id)
            edge = _find_edge(resp.json(), goal_a.id, goal_b.id)
            assert edge["count"] == 2
            assert edge["kind"] is None, "섞인 종류인데 kind가 null이 아니다"
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


async def test_goal_edges_kind_null_when_created_from_only():
    """entity_references(created_from)는 kind 축이 없다 — None으로 집계된다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            _, user_id = await _make_human_member(s, org.id, project.id)
            goal_a = await _make_goal(s, org.id, project.id, "A")
            goal_b = await _make_goal(s, org.id, project.id, "B")
            s1 = await _make_story(s, org.id, project.id, epic_id=goal_a.id, title="A1")
            t1 = await _make_story(s, org.id, project.id, epic_id=goal_b.id, title="B1")
            await _make_created_from(s, org.id, s1.id, t1.id)

        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            resp = await _call(client, project.id)
            edge = _find_edge(resp.json(), goal_a.id, goal_b.id)
            assert edge["count"] == 1
            assert edge["kind"] is None
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


# ─── AC6 — 쿼리 개수가 스토리 수와 무관하게 고정(2) ─────────────────────────

async def test_goal_edges_query_count_is_fixed_regardless_of_story_count():
    from app.core.database import async_session_factory

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            goal_a = await _make_goal(s, org.id, project.id, "A")
            goal_b = await _make_goal(s, org.id, project.id, "B")
            # 목표 쌍 하나에 스토리 쌍 5개를 심는다 — 쿼리 수는 이 개수와 무관해야 한다.
            for i in range(5):
                src = await _make_story(s, org.id, project.id, epic_id=goal_a.id, title=f"A{i}")
                tgt = await _make_story(s, org.id, project.id, epic_id=goal_b.id, title=f"B{i}")
                if i % 2 == 0:
                    await _make_created_from(s, org.id, src.id, tgt.id)
                else:
                    await _make_declared_candidate(s, org.id, src.id, tgt.id, "spawned")

        from app.repositories.analytics import AnalyticsRepository

        async with Session() as s:
            repo = AnalyticsRepository(s, org.id)
            call_count = {"n": 0}
            _orig_execute = s.execute

            async def _counting_execute(*args, **kwargs):
                call_count["n"] += 1
                return await _orig_execute(*args, **kwargs)

            s.execute = _counting_execute
            try:
                rows = await repo.get_goal_edges(project.id)
            finally:
                s.execute = _orig_execute

            assert call_count["n"] == 2, f"쿼리 개수가 고정 2가 아니다(스토리 5쌍인데 {call_count['n']}회)"
            edge = _find_edge(
                [{"from_goal_id": str(r["from_goal_id"]), "to_goal_id": str(r["to_goal_id"]),
                  "count": r["count"], "kind": r["kind"]} for r in rows],
                goal_a.id, goal_b.id,
            )
            assert edge["count"] == 5
    finally:
        await engine.dispose()


# ─── 권한·빈 프로젝트 ────────────────────────────────────────────────────────

async def test_goal_edges_cross_project_is_404():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project_a = await _make_project(s, org.id, name="A")
            project_b = await _make_project(s, org.id, name="B")
            _, user_id = await _make_human_member(s, org.id, project_b.id)  # caller는 B만 접근권

        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            resp = await _call(client, project_a.id)
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


async def test_goal_edges_empty_project_returns_empty_array_not_error():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            _, user_id = await _make_human_member(s, org.id, project.id)

        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            resp = await _call(client, project.id)
            assert resp.status_code == 200, resp.text
            assert resp.json() == []
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()
