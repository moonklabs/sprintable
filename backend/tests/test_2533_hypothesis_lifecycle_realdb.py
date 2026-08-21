"""story #2533(E-FLOW-V4 S3, PO 오르테가 AC 락 2026-08-09) — 가설 생애 5축 수직 서사
BE 조립(`GET /api/v2/hypotheses/{id}/lifecycle`)을 실PG로 검증한다.

AC 락 확인 항목:
  ①목표/검증 조립 — hypothesis_epic_links/hypothesis_story_links를 이름·상태·진행도까지
    확장(N+1 회피).
  ②증명 — gate/evidence는 story 경유 간접 조회, 매칭 없으면 정직하게 None/0("아직").
  ③정반합 — self-FK(superseded_by_hypothesis_id) 양방향(superseded_by/supersedes),
    migration 0237이 백필한 확認 페어(2cbdd1a9↔724dde46)의 SQL 조건 자체를 pin.
  ④시간선 — created_at/measure_after/updated_at 3점만, 진짜 전이 이력 아님.
  ⑤빈 축(목표·검증 0건)도 에러 없이 빈 리스트.
"""
from __future__ import annotations

import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy import text

from tests.test_1994_backlink_api_realdb import (
    _client_for,
    _make_human_member,
    _make_org,
    _make_project,
    _session_factory,
    _setup_app_human,
)
from tests.gate_mock_factory import make_gate_realdb
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


async def _make_hypothesis(
    session, org_id, project_id, owner_id, statement="Hyp", status="proposed",
    superseded_by_hypothesis_id=None, hyp_id=None,
):
    from app.models.hypothesis import Hypothesis
    hyp = Hypothesis(
        id=hyp_id or uuid.uuid4(), org_id=org_id, project_id=project_id, owner_member_id=owner_id,
        statement=statement, metric_definition=_METRIC,
        measure_after=datetime(2026, 6, 1, tzinfo=UTC), status=status,
        superseded_by_hypothesis_id=superseded_by_hypothesis_id,
    )
    session.add(hyp)
    await session.commit()
    return hyp


async def _link_hypothesis_story(session, hypothesis_id, story_id):
    from app.models.hypothesis import HypothesisStoryLink
    session.add(HypothesisStoryLink(hypothesis_id=hypothesis_id, story_id=story_id, link_type="supports"))
    await session.commit()


async def _link_hypothesis_epic(session, hypothesis_id, epic_id):
    from app.models.hypothesis import HypothesisEpicLink
    session.add(HypothesisEpicLink(hypothesis_id=hypothesis_id, epic_id=epic_id, link_type="primary"))
    await session.commit()


async def _make_evidence(session, org_id, work_item_id, created_by):
    from app.models.evidence import Evidence
    ev = Evidence(
        id=uuid.uuid4(), org_id=org_id, work_item_id=work_item_id, work_item_type="story",
        type="url", ref="https://example.test/proof", created_by=created_by,
    )
    session.add(ev)
    await session.commit()
    return ev


# ─── ①②⑤ 목표/검증/증명 조립 + 빈 축 ────────────────────────────────────────────


async def test_lifecycle_assembles_goals_stories_and_evidence_realdb():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user = await _make_human_member(s, org.id, project.id)
            goal = await _make_goal(s, org.id, project.id, title="결제 안정화", status="active")
            story = await _make_story(s, org.id, project.id, title="체크아웃 리팩터")
            story.status = "in-progress"
            story.outcome_status = "pending"
            await s.commit()
            hyp = await _make_hypothesis(s, org.id, project.id, caller_id, statement="가설 A")
            await _link_hypothesis_epic(s, hyp.id, goal.id)
            await _link_hypothesis_story(s, hyp.id, story.id)
            await make_gate_realdb(s, org.id, story.id, status="pending")
            await _make_evidence(s, org.id, story.id, caller_id)
            await _make_evidence(s, org.id, story.id, caller_id)

        await _setup_app_human(app, Session, caller_user, org.id)
        async with _client_for(app) as client:
            resp = await client.get(f"/api/v2/hypotheses/{hyp.id}/lifecycle")
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["hypothesis"]["statement"] == "가설 A"
            assert len(body["goals"]) == 1
            assert body["goals"][0]["title"] == "결제 안정화"
            assert body["goals"][0]["status"] == "active"
            assert len(body["stories"]) == 1
            assert body["stories"][0]["title"] == "체크아웃 리팩터"
            assert body["stories"][0]["status"] == "in-progress"
            assert body["stories"][0]["gate_status"] == "pending"
            assert body["stories"][0]["evidence_count"] == 2
        app.dependency_overrides.clear()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_lifecycle_empty_axes_return_empty_lists_not_error_realdb():
    """⭐"없는 데이터에 화면 안 깎기" — 목표·검증 0건이어도 200+빈 리스트, 크래시 아님."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user = await _make_human_member(s, org.id, project.id)
            hyp = await _make_hypothesis(s, org.id, project.id, caller_id, statement="가설 고아")

        await _setup_app_human(app, Session, caller_user, org.id)
        async with _client_for(app) as client:
            resp = await client.get(f"/api/v2/hypotheses/{hyp.id}/lifecycle")
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["goals"] == []
            assert body["stories"] == []
            assert body["superseded_by"] is None
            assert body["supersedes"] == []
        app.dependency_overrides.clear()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_lifecycle_story_without_gate_or_evidence_is_honest_none_realdb():
    """⭐증명 미도달은 「아직」(None/0)으로 정직 — 억지로 채우지 않는다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user = await _make_human_member(s, org.id, project.id)
            story = await _make_story(s, org.id, project.id, title="증명 미도달 스토리")
            hyp = await _make_hypothesis(s, org.id, project.id, caller_id)
            await _link_hypothesis_story(s, hyp.id, story.id)

        await _setup_app_human(app, Session, caller_user, org.id)
        async with _client_for(app) as client:
            resp = await client.get(f"/api/v2/hypotheses/{hyp.id}/lifecycle")
            assert resp.status_code == 200, resp.text
            story_item = resp.json()["stories"][0]
            assert story_item["gate_status"] is None
            assert story_item["evidence_count"] == 0
        app.dependency_overrides.clear()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── ③ 정반합 양방향 ─────────────────────────────────────────────────────────────


async def test_lifecycle_supersession_bidirectional_realdb():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user = await _make_human_member(s, org.id, project.id)
            successor = await _make_hypothesis(
                s, org.id, project.id, caller_id, statement="신뢰 신호 가설", status="proposed",
            )
            predecessor = await _make_hypothesis(
                s, org.id, project.id, caller_id, statement="체크아웃 2단계 가설", status="falsified",
                superseded_by_hypothesis_id=successor.id,
            )

        await _setup_app_human(app, Session, caller_user, org.id)
        async with _client_for(app) as client:
            pred_resp = await client.get(f"/api/v2/hypotheses/{predecessor.id}/lifecycle")
            assert pred_resp.status_code == 200, pred_resp.text
            pred_body = pred_resp.json()
            assert pred_body["superseded_by"]["id"] == str(successor.id)
            assert pred_body["superseded_by"]["statement"] == "신뢰 신호 가설"
            assert pred_body["supersedes"] == []

            succ_resp = await client.get(f"/api/v2/hypotheses/{successor.id}/lifecycle")
            assert succ_resp.status_code == 200, succ_resp.text
            succ_body = succ_resp.json()
            assert succ_body["superseded_by"] is None
            assert len(succ_body["supersedes"]) == 1
            assert succ_body["supersedes"][0]["id"] == str(predecessor.id)
        app.dependency_overrides.clear()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── ④ 시간선 ────────────────────────────────────────────────────────────────────


async def test_lifecycle_timeline_is_three_points_only_realdb():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user = await _make_human_member(s, org.id, project.id)
            hyp = await _make_hypothesis(s, org.id, project.id, caller_id)

        await _setup_app_human(app, Session, caller_user, org.id)
        async with _client_for(app) as client:
            resp = await client.get(f"/api/v2/hypotheses/{hyp.id}/lifecycle")
            assert resp.status_code == 200, resp.text
            timeline = resp.json()["timeline"]
            assert set(timeline.keys()) == {"created_at", "measure_after", "updated_at"}, (
                "시간선은 3점만이어야 한다 — 진짜 전이 이력을 지어내면 안 된다"
            )
        app.dependency_overrides.clear()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── migration 0237 백필 SQL 조건 자체를 pin ────────────────────────────────────


async def test_migration_0237_backfill_condition_links_confirmed_pair_realdb():
    """⭐migration 0237의 백필 SQL(조건부 UPDATE)이 실제로 그 페어를 잇는지 실PG로 pin —
    이 테스트가 없으면 "그 UUID들이 실존할 때 정말 링크되는가"가 코드 리뷰로만 남는다.
    fresh 테스트 DB엔 그 실제 hypothesis row가 없으므로(alembic upgrade 시점엔 no-op),
    같은 UUID로 두 행을 직접 심고 마이그레이션과 동일한 조건부 SQL을 재실행해 검증한다."""
    import importlib.util
    import pathlib

    from app.core.database import async_session_factory

    migration_path = (
        pathlib.Path(__file__).resolve().parent.parent
        / "alembic" / "versions" / "0237_hypothesis_superseded_by.py"
    )
    spec = importlib.util.spec_from_file_location("migration_0237", migration_path)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)

    async with async_session_factory() as session:
        org = await _make_org(session)
        project = await _make_project(session, org.id)
        caller_id, _ = await _make_human_member(session, org.id, project.id)

        # 마이그레이션이 참조하는 그 정확한 UUID로 두 행을 심는다(SSOT — 하드코딩 중복 없이
        # 마이그레이션 모듈 상수를 그대로 재사용, PK를 처음부터 그 값으로 생성).
        await _make_hypothesis(
            session, org.id, project.id, caller_id, statement="체크아웃 2단계 가설(재현)",
            status="falsified", hyp_id=uuid.UUID(migration._FALSIFIED_ID),
        )
        await _make_hypothesis(
            session, org.id, project.id, caller_id, statement="신뢰 신호 가설(재현)",
            status="proposed", hyp_id=uuid.UUID(migration._SUCCESSOR_ID),
        )

        # 마이그레이션의 upgrade() 안 백필 SQL과 동일 문장을 그대로 재실행.
        await session.execute(text(
            f"""
            UPDATE hypotheses SET superseded_by_hypothesis_id = '{migration._SUCCESSOR_ID}'
            WHERE id = '{migration._FALSIFIED_ID}'
              AND EXISTS (SELECT 1 FROM hypotheses WHERE id = '{migration._SUCCESSOR_ID}')
            """
        ))
        await session.commit()

        result = await session.execute(text(
            f"SELECT superseded_by_hypothesis_id FROM hypotheses WHERE id = '{migration._FALSIFIED_ID}'"
        ))
        linked = result.scalar_one()
        assert str(linked) == migration._SUCCESSOR_ID
