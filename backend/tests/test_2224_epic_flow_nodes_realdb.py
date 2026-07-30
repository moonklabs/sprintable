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
