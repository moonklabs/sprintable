"""story #2224 노드 계약 — GET /analytics/epic-flow-nodes 실PG 검증. 급전환(2026-07-30,
PO 판정) — 「N+1이라 안 그린다」는 안 그릴 이유가 아니라 BE 계약을 하나 더 만들 이유였다.
세 구역(지금/이어질/지나온)을 한 에픽 단위 한 번의 호출로 낸다."""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest

from tests.test_2301_story_body_mentions_realdb import (
    _REAL_DB_URL,
    _client_for,
    _make_human_member,
    _make_org,
    _make_project,
    _make_story,
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


async def test_epic_flow_nodes_three_zones_and_one_call():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)

            from app.models.pm import Goal
            epic = Goal(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="Epic A")
            s.add(epic)
            await s.commit()

            now = datetime.now(timezone.utc)

            # ①지금(now): in-progress 1건 + in-review 1건 — "검토 중"도 지금(PO 판정)
            story_ip = await _make_story(s, org.id, project.id, title="IP")
            story_ip.epic_id = epic.id
            story_ip.status = "in-progress"

            story_review = await _make_story(s, org.id, project.id, title="IN_REVIEW")
            story_review.epic_id = epic.id
            story_review.status = "in-review"

            # ②이어질(upcoming) — 우선순위 검증용 3건: 막힘 > ready-for-dev > backlog
            story_blocked = await _make_story(s, org.id, project.id, title="BLOCKED_BACKLOG")
            story_blocked.epic_id = epic.id
            story_blocked.status = "backlog"  # 막힘이 status와 무관하게 최우선이어야 함

            story_ready = await _make_story(s, org.id, project.id, title="READY")
            story_ready.epic_id = epic.id
            story_ready.status = "ready-for-dev"

            story_backlog = await _make_story(s, org.id, project.id, title="BACKLOG")
            story_backlog.epic_id = epic.id
            story_backlog.status = "backlog"

            # ③지나온(past): done 2건 — 노드로 안 나가고 수로만
            for i in range(2):
                sd = await _make_story(s, org.id, project.id, title=f"DONE_{i}")
                sd.epic_id = epic.id
                sd.status = "done"

            await s.commit()

            from app.models.gate import Gate
            s.add(Gate(
                id=uuid.uuid4(), org_id=org.id, work_item_id=story_blocked.id, work_item_type="story",
                gate_type="merge", status="pending", requires_human=True, evidence_status="insufficient",
            ))
            await s.commit()

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        call_count = {"n": 0}
        try:
            import app.repositories.analytics as analytics_repo_mod
            _orig = analytics_repo_mod.AnalyticsRepository.get_epic_flow_nodes

            async def _counting(self, project_id, epic_id, upcoming_limit=15):
                call_count["n"] += 1
                return await _orig(self, project_id, epic_id, upcoming_limit)

            analytics_repo_mod.AnalyticsRepository.get_epic_flow_nodes = _counting
            try:
                resp = await client.get(
                    "/api/v2/analytics/epic-flow-nodes",
                    params={"project_id": str(project.id), "epic_id": str(epic.id)},
                )
            finally:
                analytics_repo_mod.AnalyticsRepository.get_epic_flow_nodes = _orig

            assert resp.status_code == 200, resp.text
            body = resp.json()

            assert body["epic_id"] == str(epic.id)

            assert body["now"]["total"] == 2, "in-progress+in-review 둘 다 지금 구역"
            now_statuses = {n["status"] for n in body["now"]["items"]}
            assert now_statuses == {"in-progress", "in-review"}

            assert body["upcoming"]["total"] == 3
            assert body["upcoming"]["shown"] == 3
            upcoming_ids = [n["id"] for n in body["upcoming"]["items"]]
            assert upcoming_ids[0] == str(story_blocked.id), "막힌 것이 status와 무관하게 최우선이어야 함"
            assert upcoming_ids[1] == str(story_ready.id), "ready-for-dev가 backlog보다 앞이어야 함(PO: 이어질 것의 맨 앞)"
            assert upcoming_ids[2] == str(story_backlog.id)

            assert body["past"]["total"] == 2
            assert "items" not in body["past"], "지나온 것은 노드로 안 나간다 — 수로만"

            # story #2679 후속(초점 스트립) — blocked_count(story_blocked 1건)·last_changed_at(존재).
            assert body["blocked_count"] == 1
            assert body["last_changed_at"] is not None

            for node in body["now"]["items"] + body["upcoming"]["items"]:
                assert set(node.keys()) == {
                    "id", "story_number", "title", "status", "assignee_id", "updated_at",
                }

            assert call_count["n"] == 1, f"repo 메서드가 {call_count['n']}번 불림(N+1 의심)"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_epic_flow_nodes_batch_multiple_epics_one_call_each_query():
    """story #2679 — epic_ids로 여러 에픽을 «한 번의 호출»로 받고, story/Gate 쿼리가 각각
    1번씩(에픽 개수와 무관, N+1 없음)인지."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)

            from app.models.pm import Goal
            epic_a = Goal(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="Epic A")
            epic_b = Goal(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="Epic B")
            s.add_all([epic_a, epic_b])
            await s.commit()

            story_a_ip = await _make_story(s, org.id, project.id, title="A_IP")
            story_a_ip.epic_id = epic_a.id
            story_a_ip.status = "in-progress"

            story_a_done = await _make_story(s, org.id, project.id, title="A_DONE")
            story_a_done.epic_id = epic_a.id
            story_a_done.status = "done"

            story_b_backlog = await _make_story(s, org.id, project.id, title="B_BACKLOG")
            story_b_backlog.epic_id = epic_b.id
            story_b_backlog.status = "backlog"
            await s.commit()

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        query_count = {"n": 0}
        try:
            from sqlalchemy import event
            from app.core.database import engine as _global_engine

            def _count(*args, **kwargs):
                query_count["n"] += 1

            event.listen(_global_engine.sync_engine, "before_cursor_execute", _count)
            try:
                resp = await client.get(
                    "/api/v2/analytics/epic-flow-nodes",
                    params={
                        "project_id": str(project.id),
                        "epic_ids": f"{epic_a.id},{epic_b.id}",
                    },
                )
            finally:
                event.remove(_global_engine.sync_engine, "before_cursor_execute", _count)

            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["requested_count"] == 2
            assert body["processed_count"] == 2
            assert body["skipped_epic_ids"] == []
            assert len(body["epics"]) == 2

            by_id = {e["epic_id"]: e for e in body["epics"]}
            assert by_id[str(epic_a.id)]["now"]["total"] == 1
            assert by_id[str(epic_a.id)]["past"]["total"] == 1
            assert by_id[str(epic_b.id)]["upcoming"]["total"] == 1

            # story 쿼리 1 + gate 쿼리 1(+ project-access 확認용 소수) — 에픽 개수(2)만큼
            # 곱해지지 않는 것이 핵심(N+1이면 훨씬 커진다). 넉넉히 10 미만으로 고정 상한 확認.
            assert query_count["n"] < 10, f"쿼리 수가 큼(N+1 의심): {query_count['n']}"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_epic_flow_nodes_focus_metrics_blocked_count_and_last_changed_at():
    """story #2679 후속(2026-07-30, /flow 초점 스트립) — blocked_count는 status와 무관하게
    pending-gate 건수를 세고(get_epics_progress_lane의 lane["blocked"]와 같은 필터),
    last_changed_at은 그 에픽 스토리들의 updated_at 최댓값(「마지막 변경 이후」— 「마지막
    머지」가 아님, 그 소스가 없어 이름을 좁혀 낸 것)."""
    from datetime import datetime
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)

            from app.models.pm import Goal
            epic = Goal(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="Epic")
            s.add(epic)
            await s.commit()

            older = await _make_story(s, org.id, project.id, title="OLDER")
            older.epic_id = epic.id
            older.status = "in-progress"
            await s.commit()

            blocked_1 = await _make_story(s, org.id, project.id, title="BLOCKED_1")
            blocked_1.epic_id = epic.id
            blocked_1.status = "backlog"

            blocked_2 = await _make_story(s, org.id, project.id, title="BLOCKED_2_DONE")
            blocked_2.epic_id = epic.id
            blocked_2.status = "done"  # 막힘은 status(zone)와 무관하게 세어야 함
            await s.commit()

            # ⛔onupdate=func.now()가 커밋 시 실제 시각으로 덮어써 Python에서 과거 시각을
            # 직접 대입해도 안 먹는다(SQLAlchemy 컬럼 레벨 onupdate가 항상 이긴다) — 그래서
            # 「나중에 커밋된 것이 더 최근」이라는 자연스러운 순서로 MAX를 검증한다.
            newest = await _make_story(s, org.id, project.id, title="NEWEST")
            newest.epic_id = epic.id
            newest.status = "backlog"
            await s.commit()
            await s.refresh(newest)
            await s.refresh(older)

            from app.models.gate import Gate
            s.add_all([
                Gate(
                    id=uuid.uuid4(), org_id=org.id, work_item_id=blocked_1.id, work_item_type="story",
                    gate_type="merge", status="pending", requires_human=True, evidence_status="insufficient",
                ),
                Gate(
                    id=uuid.uuid4(), org_id=org.id, work_item_id=blocked_2.id, work_item_type="story",
                    gate_type="merge", status="pending", requires_human=True, evidence_status="insufficient",
                ),
            ])
            await s.commit()

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(
                "/api/v2/analytics/epic-flow-nodes",
                params={"project_id": str(project.id), "epic_id": str(epic.id)},
            )
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["blocked_count"] == 2, "done 상태(blocked_2)도 막힘이면 세어야 함(status 무관)"
            last_changed = datetime.fromisoformat(body["last_changed_at"])
            assert last_changed == newest.updated_at, "MAX가 가장 나중에 커밋된 것이어야 함"
            assert last_changed > older.updated_at, "더 먼저 커밋된 것보다 나중이어야 함"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_epic_flow_nodes_batch_over_cap_truncates_and_reports_skipped():
    """상한(EPIC_FLOW_NODES_BATCH_MAX) 초과 시 앞 N개만 처리되고 나머지는 skipped_epic_ids에
    실린다 — "없앤 것"이 아니라 "안 그린 것"(오늘 규율)."""
    from app.main import app
    from app.repositories.analytics import AnalyticsRepository

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            fake_ids = [str(uuid.uuid4()) for _ in range(AnalyticsRepository.EPIC_FLOW_NODES_BATCH_MAX + 5)]
            resp = await client.get(
                "/api/v2/analytics/epic-flow-nodes",
                params={"project_id": str(project.id), "epic_ids": ",".join(fake_ids)},
            )
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["requested_count"] == len(fake_ids)
            assert body["processed_count"] == AnalyticsRepository.EPIC_FLOW_NODES_BATCH_MAX
            assert len(body["skipped_epic_ids"]) == 5
            assert set(body["skipped_epic_ids"]) == set(fake_ids[AnalyticsRepository.EPIC_FLOW_NODES_BATCH_MAX:])
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_epic_flow_nodes_requires_exactly_one_of_epic_id_or_epic_ids():
    """양쪽 다 주거나 둘 다 안 주면 400 — 모호한 요청을 서버가 임의로 고르지 않는다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            neither = await client.get(
                "/api/v2/analytics/epic-flow-nodes", params={"project_id": str(project.id)},
            )
            assert neither.status_code == 400

            both = await client.get(
                "/api/v2/analytics/epic-flow-nodes",
                params={
                    "project_id": str(project.id), "epic_id": str(uuid.uuid4()),
                    "epic_ids": str(uuid.uuid4()),
                },
            )
            assert both.status_code == 400
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_epic_flow_nodes_upcoming_limit_truncates_and_reports_total():
    """upcoming_limit보다 이어질 것이 많으면 shown < total이어야 하고, 잘린 개수를 응답이
    말해야 한다("없앤 것"이 아니라 "안 그린 것", PO 규율)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_human_member(s, org.id, project.id)

            from app.models.pm import Goal
            epic = Goal(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="Epic B")
            s.add(epic)
            await s.commit()

            for i in range(5):
                st = await _make_story(s, org.id, project.id, title=f"BACKLOG_{i}")
                st.epic_id = epic.id
                st.status = "backlog"
            await s.commit()

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(
                "/api/v2/analytics/epic-flow-nodes",
                params={"project_id": str(project.id), "epic_id": str(epic.id), "upcoming_limit": 2},
            )
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["upcoming"]["total"] == 5
            assert body["upcoming"]["shown"] == 2
            assert len(body["upcoming"]["items"]) == 2
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
