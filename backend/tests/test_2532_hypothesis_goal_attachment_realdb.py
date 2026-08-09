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


async def test_unattached_filter_is_sql_where_level_not_post_page_realdb():
    """⭐카디르 QA REQUEST_CHANGES(2026-08-09) 재현+회귀방지 — unattached 필터가 SQL limit
    後 Python 후필터였을 때의 두 결함을 정확히 겨눈다:
    ①페이지 경계 밖 유실 — board 분기(status+project_id)에서 attached 2건이 SQL 순서상
      먼저 오고 unattached 1건이 뒤에 있을 때, limit=1(SQL이 attached만 1건 뽑음)이면
      후필터는 0건을 반환했을 것이다(실제로 unattached가 있는데도). WHERE 레벨이면 SQL
      자체가 unattached 1건만 대상으로 삼아 정확히 1건을 반환해야 한다.
    ②X-Total-Count 거짓값 — 후필터였다면 total이 «필터 前»(3건)이었을 것. WHERE
      레벨이면 total도 필터 後 값(1건)이어야 한다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user = await _make_human_member(s, org.id, project.id)
            goal = await _make_goal(s, org.id, project.id)
            # SQL 정렬(created_at DESC)상 attached 둘이 먼저 오게 순서를 맞춘다(unattached
            # 가 가장 나중에 생성 → created_at 최댓값 → DESC 정렬에서 맨 앞). 이러면 반대로
            # unattached가 SQL 상단에 와 버려 결함이 안 드러나므로, 대신 status/필터로 board
            # 분기를 타면서 limit=1로 강제해 "SQL이 딱 1건만 실제로 스캔·반환"하는 경계를
            # 만든다 — 그 1건이 정확히 unattached여야 한다(후필터였다면 attached가 먼저 SQL
            # 결과에 담겨 0건을 냈을 자리).
            attached_1 = await _make_story(s, org.id, project.id, title="A1")
            attached_1.status = "backlog"
            attached_1.epic_id = goal.id
            attached_2 = await _make_story(s, org.id, project.id, title="A2")
            attached_2.status = "backlog"
            attached_2.epic_id = goal.id
            unattached_story = await _make_story(s, org.id, project.id, title="U1")
            unattached_story.status = "backlog"
            await s.commit()

        await _setup_app_human(app, Session, caller_user, org.id)
        async with _client_for(app) as client:
            resp = await client.get(
                f"/api/v2/stories?project_id={project.id}&status=backlog&unattached=true&limit=1"
            )
            assert resp.status_code == 200, resp.text
            items = resp.json()
            assert len(items) == 1, "SQL WHERE 레벨이면 unattached 1건이 SQL 자체에서 걸러져 정확히 1건이어야 한다"
            assert items[0]["id"] == str(unattached_story.id)
            # ⭐X-Total-Count가 필터 後 값(1)인지 — 필터 前(3)이면 거짓 신호(카디르가 잡은 결함).
            assert resp.headers.get("x-total-count") == "1", (
                f"X-Total-Count가 필터 後 값이 아니다: {resp.headers.get('x-total-count')!r}"
            )
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
