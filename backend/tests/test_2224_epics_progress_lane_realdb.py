"""story #2224(S2-1, 갈래 화면) 좌측 레인 — GET /analytics/epics-progress-lane 실PG 검증.
미르코가 지금 `/flow`를 짓고 있어 급히 공급된 계약(2026-07-30) — 한 번의 호출로 project
전체 에픽의 진행/대기/막힘/멈춤을 낸다."""
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


async def test_epics_progress_lane_buckets_correctly_and_one_call():
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

            # ①in_progress: status만 in-progress, 최근 변경
            story_ip = await _make_story(s, org.id, project.id, title="IP")
            story_ip.epic_id = epic.id
            story_ip.status = "in-progress"

            # ②waiting: self_reported=True, human_verified 없음(evidence 1건, gate_approval 아님)
            story_wait = await _make_story(s, org.id, project.id, title="WAIT")
            story_wait.epic_id = epic.id
            story_wait.status = "in-review"

            # ③blocked: pending gate 매임
            story_blocked = await _make_story(s, org.id, project.id, title="BLOCKED")
            story_blocked.epic_id = epic.id
            story_blocked.status = "in-progress"  # blocked가 in_progress보다 우선순위 높아야 함

            # ④stalled: status=backlog, updated_at 169시간 전
            story_stalled = await _make_story(s, org.id, project.id, title="STALLED")
            story_stalled.epic_id = epic.id
            story_stalled.status = "backlog"

            # ⑤uncounted: done (네 칸 어디에도 안 잡힘 → other)
            story_done = await _make_story(s, org.id, project.id, title="DONE")
            story_done.epic_id = epic.id
            story_done.status = "done"

            # ⑥음성대조: pending gate가 있어도 requires_human/evidence_status 조건을 안
            # 채우면 「막힘」이 아니다(민 32건 정의와 좁혀 맞춘 것 — 그냥 "pending 매임"만
            # 이었으면 이 story도 blocked로 잘못 잡혔을 것).
            story_not_blocked = await _make_story(s, org.id, project.id, title="PENDING_BUT_NOT_BLOCKED")
            story_not_blocked.epic_id = epic.id
            story_not_blocked.status = "in-progress"

            # ⑦epic 없음 — story #2224 PO 판정(2026-07-30, dev 445건 실측 후): 레인은 여전히
            # 안 만들되 이 수는 응답에 실린다(화면이 "나머지 N건은 레인 밖" 말할 수 있게).
            story_no_epic = await _make_story(s, org.id, project.id, title="NO_EPIC")
            story_no_epic.status = "backlog"

            await s.commit()

            from app.models.evidence import Evidence
            s.add(Evidence(
                id=uuid.uuid4(), org_id=org.id, work_item_id=story_wait.id, work_item_type="story",
                type="url", ref="https://example.com/evidence", created_by=caller_id, created_at=now,
            ))
            from app.models.gate import Gate
            s.add(Gate(
                id=uuid.uuid4(), org_id=org.id, work_item_id=story_blocked.id, work_item_type="story",
                gate_type="merge", status="pending", requires_human=True, evidence_status="insufficient",
            ))
            s.add(Gate(
                id=uuid.uuid4(), org_id=org.id, work_item_id=story_not_blocked.id, work_item_type="story",
                gate_type="merge", status="pending", requires_human=False, evidence_status=None,
            ))
            await s.commit()

            # updated_at은 서버 default라 직접 UPDATE로 과거로 되돌린다(실물 "멈춤" 재현).
            from sqlalchemy import text
            await s.execute(
                text("UPDATE stories SET updated_at = :t WHERE id = :id"),
                {"t": now - timedelta(hours=169), "id": story_stalled.id},
            )
            await s.commit()

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        call_count = {"n": 0}
        try:
            import app.repositories.analytics as analytics_repo_mod
            _orig = analytics_repo_mod.AnalyticsRepository.get_epics_progress_lane

            async def _counting(self, project_id):
                call_count["n"] += 1
                return await _orig(self, project_id)

            analytics_repo_mod.AnalyticsRepository.get_epics_progress_lane = _counting
            try:
                resp = await client.get(
                    "/api/v2/analytics/epics-progress-lane", params={"project_id": str(project.id)}
                )
            finally:
                analytics_repo_mod.AnalyticsRepository.get_epics_progress_lane = _orig

            assert resp.status_code == 200, resp.text
            body = resp.json()
            lane = body["epics"][str(epic.id)]
            assert lane == {
                "in_progress": 2, "waiting": 1, "blocked": 1, "stalled": 1, "other": 1,
            }, lane
            # story_not_blocked는 pending gate가 있어도 requires_human/evidence_status 조건이
            # 없어 blocked에 안 잡히고, status=in-progress라 in_progress로 떨어져야 한다.
            assert sum(lane.values()) == 6, "네 칸(진행/대기/막힘/멈춤) + other == total_stories 항상 성립해야 함"
            assert body["stall_threshold_hours"] == 168
            # story #3126 — stall(168h, story-level 단기 주의)과 dormancy(720h=30일, goal-level
            # 장기 활동 분류)는 「같은 질문 두 값」이 아니다(페드루 판정 2026-08-27) — 값이
            # 다른 게 정직하다.
            assert body["dormancy_threshold_hours"] == 720
            assert body["stories_without_epic"] == 1, "epic 없는 story(story_no_epic) 1건이 응답에 실려야 함"
            assert call_count["n"] == 1, f"repo 메서드가 {call_count['n']}번 불림(N+1 의심)"

            # 급추가(2026-07-30, 선생님 지적): past/now/upcoming(시간축) — epic-flow-nodes와
            # 같은 정의(past=done, now=in-progress+in-review, upcoming=나머지).
            zone = body["zones"][str(epic.id)]
            assert zone["title"] == "Epic A"
            assert zone["total"] == 6
            assert zone["done"] == 1
            assert zone["pct"] == 17  # round(1/6*100)
            assert zone["past_cnt"] == 1  # story_done
            assert zone["now_cnt"] == 4  # story_ip·story_wait(in-review)·story_blocked·story_not_blocked
            assert zone["upcoming_cnt"] == 1  # story_stalled(backlog)
            assert zone["past_cnt"] + zone["now_cnt"] + zone["upcoming_cnt"] == zone["total"]
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
