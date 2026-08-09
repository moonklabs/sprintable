"""story #2532(E-FLOW-V4 S2, PO 오르테가 AC 락 2026-08-08) — 「가설 OR 목표」 매달림
BE 재료를 실PG로 검증한다.

AC 락 확인 항목:
  ①has_hypothesis_or_goal — epic_id 존재 OR hypothesis_story_links 존재 시에만 True(positive
    단방향, False 없음). 양성대조 4케이스(목표만·가설만·둘 다·둘 없음).
  ②unattached=true — 기존 list 엔드포인트에 얹은 필터, 미매달림만 반환.
  ③attachment-suggestions — open goal/hypothesis만 후보(closed/archived 제외), ambiguous
    시 둘 다 채움, overlap 0 후보는 안 냄.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

import pytest

from tests.test_1994_backlink_api_realdb import (
    _client_for,
    _make_human_member,
    _make_org,
    _make_project,
    _session_factory,
    _setup_app_human,
)
from tests.test_2301_story_body_mentions_realdb import _REAL_DB_URL, _make_story

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


_METRIC = {"metric": "signups", "source": "db", "target": 100, "direction": "increase"}


async def _make_goal(session, org_id, project_id, title="Goal", status="active"):
    from app.models.pm import Goal
    goal = Goal(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title, status=status)
    session.add(goal)
    await session.commit()
    return goal


async def _make_hypothesis(session, org_id, project_id, owner_id, statement="Hyp", status="proposed"):
    from app.models.hypothesis import Hypothesis
    hyp = Hypothesis(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, owner_member_id=owner_id,
        statement=statement, metric_definition=_METRIC,
        measure_after=datetime(2026, 6, 1, tzinfo=timezone.utc), status=status,
    )
    session.add(hyp)
    await session.commit()
    return hyp


async def _link_hypothesis_story(session, hypothesis_id, story_id):
    from app.models.hypothesis import HypothesisStoryLink
    session.add(HypothesisStoryLink(hypothesis_id=hypothesis_id, story_id=story_id, link_type="supports"))
    await session.commit()


# ─── ① has_hypothesis_or_goal — 양성대조 4케이스 ─────────────────────────────────


async def test_goal_only_sets_true_realdb():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user = await _make_human_member(s, org.id, project.id)
            goal = await _make_goal(s, org.id, project.id)
            story = await _make_story(s, org.id, project.id, title="Goal-only")
            story.epic_id = goal.id
            await s.commit()

        await _setup_app_human(app, Session, caller_user, org.id)
        async with _client_for(app) as client:
            resp = await client.get(f"/api/v2/stories/{story.id}")
            assert resp.status_code == 200, resp.text
            assert resp.json()["has_hypothesis_or_goal"] is True
        app.dependency_overrides.clear()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_hypothesis_only_sets_true_realdb():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user = await _make_human_member(s, org.id, project.id)
            story = await _make_story(s, org.id, project.id, title="Hyp-only")
            hyp = await _make_hypothesis(s, org.id, project.id, caller_id)
            await _link_hypothesis_story(s, hyp.id, story.id)

        await _setup_app_human(app, Session, caller_user, org.id)
        async with _client_for(app) as client:
            resp = await client.get(f"/api/v2/stories/{story.id}")
            assert resp.status_code == 200, resp.text
            assert resp.json()["has_hypothesis_or_goal"] is True
        app.dependency_overrides.clear()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_both_goal_and_hypothesis_sets_true_realdb():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user = await _make_human_member(s, org.id, project.id)
            goal = await _make_goal(s, org.id, project.id)
            story = await _make_story(s, org.id, project.id, title="Both")
            story.epic_id = goal.id
            await s.commit()
            hyp = await _make_hypothesis(s, org.id, project.id, caller_id)
            await _link_hypothesis_story(s, hyp.id, story.id)

        await _setup_app_human(app, Session, caller_user, org.id)
        async with _client_for(app) as client:
            resp = await client.get(f"/api/v2/stories/{story.id}")
            assert resp.status_code == 200, resp.text
            assert resp.json()["has_hypothesis_or_goal"] is True
        app.dependency_overrides.clear()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_neither_leaves_none_not_false_realdb():
    """⭐positive 단방향 규율 — 미매달림은 False가 아니라 None(필드 자체가 미설정)이어야
    한다(has_evidence와 동형 규율, PO 명시)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user = await _make_human_member(s, org.id, project.id)
            story = await _make_story(s, org.id, project.id, title="Neither")

        await _setup_app_human(app, Session, caller_user, org.id)
        async with _client_for(app) as client:
            resp = await client.get(f"/api/v2/stories/{story.id}")
            assert resp.status_code == 200, resp.text
            assert resp.json()["has_hypothesis_or_goal"] is None
        app.dependency_overrides.clear()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── ② unattached=true 필터 ─────────────────────────────────────────────────────


async def test_unattached_filter_returns_only_unlinked_stories_realdb():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user = await _make_human_member(s, org.id, project.id)
            goal = await _make_goal(s, org.id, project.id)
            attached = await _make_story(s, org.id, project.id, title="Attached")
            attached.epic_id = goal.id
            await s.commit()
            unattached = await _make_story(s, org.id, project.id, title="Unattached")

        await _setup_app_human(app, Session, caller_user, org.id)
        async with _client_for(app) as client:
            resp = await client.get(f"/api/v2/stories?project_id={project.id}&unattached=true")
            assert resp.status_code == 200, resp.text
            ids = [item["id"] for item in resp.json()]
            assert str(unattached.id) in ids
            assert str(attached.id) not in ids

            # 양성대조: unattached 미지정이면 둘 다 나온다(회귀 0 — 필터가 기본 동작을 안 바꿈).
            resp_all = await client.get(f"/api/v2/stories?project_id={project.id}")
            all_ids = [item["id"] for item in resp_all.json()]
            assert str(unattached.id) in all_ids
            assert str(attached.id) in all_ids
        app.dependency_overrides.clear()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── ③ attachment-suggestions ───────────────────────────────────────────────────


async def test_attachment_suggestions_goal_type_with_open_candidate_realdb():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user = await _make_human_member(s, org.id, project.id)
            await _make_goal(s, org.id, project.id, title="결제 시스템 안정화")
            story = await _make_story(s, org.id, project.id, title="결제 시스템 버그 fix")

        await _setup_app_human(app, Session, caller_user, org.id)
        async with _client_for(app) as client:
            resp = await client.get(f"/api/v2/stories/{story.id}/attachment-suggestions")
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["suggested_type"] == "goal"
            assert len(body["goal_candidates"]) == 1
        app.dependency_overrides.clear()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_attachment_suggestions_excludes_closed_and_archived_realdb():
    """⭐PO 락 확認 항목 — open(draft/active)만 후보, done/archived는 제외(doc §7-1
    "더미 미표시"와 정합)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user = await _make_human_member(s, org.id, project.id)
            await _make_goal(s, org.id, project.id, title="결제 시스템 개편", status="done")
            await _make_goal(s, org.id, project.id, title="결제 시스템 아카이브", status="archived")
            story = await _make_story(s, org.id, project.id, title="결제 시스템 버그 fix")

        await _setup_app_human(app, Session, caller_user, org.id)
        async with _client_for(app) as client:
            resp = await client.get(f"/api/v2/stories/{story.id}/attachment-suggestions")
            assert resp.status_code == 200, resp.text
            assert resp.json()["goal_candidates"] == []
        app.dependency_overrides.clear()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_attachment_suggestions_ambiguous_fills_both_lists_realdb():
    """⭐AC 양성대조 — 어느 키워드도 안 걸린 애매한 작업엔 goal_candidates·
    hypothesis_candidates 둘 다 채워져야 한다(제목 overlap이 있는 후보가 각각 있을 때)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user = await _make_human_member(s, org.id, project.id)
            await _make_goal(s, org.id, project.id, title="프로필 페이지 목표")
            await _make_hypothesis(s, org.id, project.id, caller_id, statement="프로필 페이지 개선 가설")
            story = await _make_story(s, org.id, project.id, title="프로필 페이지 개편")

        await _setup_app_human(app, Session, caller_user, org.id)
        async with _client_for(app) as client:
            resp = await client.get(f"/api/v2/stories/{story.id}/attachment-suggestions")
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["suggested_type"] == "ambiguous"
            assert len(body["goal_candidates"]) == 1
            assert len(body["hypothesis_candidates"]) == 1
        app.dependency_overrides.clear()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_attachment_suggestions_empty_when_no_overlap_realdb():
    """⭐빈 제안 금지 원칙의 반대 증명 — overlap이 진짜 0이면 억지 후보 없이 정직하게
    빈 리스트."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user = await _make_human_member(s, org.id, project.id)
            await _make_goal(s, org.id, project.id, title="완전히 무관한 제목")
            story = await _make_story(s, org.id, project.id, title="결제 시스템 버그 fix")

        await _setup_app_human(app, Session, caller_user, org.id)
        async with _client_for(app) as client:
            resp = await client.get(f"/api/v2/stories/{story.id}/attachment-suggestions")
            assert resp.status_code == 200, resp.text
            assert resp.json()["goal_candidates"] == []
        app.dependency_overrides.clear()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
