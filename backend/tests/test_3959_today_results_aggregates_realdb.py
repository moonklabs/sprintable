"""story #3959(UX-v3·오늘·BE, 3954 그라운딩 doc 처방 그대로) — ``GET /api/v2/today``
「오늘 결과」 집계 3(landed_today·qa_passed_today·open_defects) 실PG 검증.
3823(test_3823_today_aggregate_route.py)의 실PG 헬퍼를 그대로 재사용(cross-import
관례, 이 저장소 기존 선례 그대로) — 이 파일은 3959 전용 픽스처만 추가한다.

핵심 검증축:
①landed_today = story_activities(status_changed→done) 오늘·org 자정 경계
②landed_today = actor_id 없는 전이는 안 세인다(근사 0 — 배제 자체가 계약, PO 確認)
③qa_passed_today = gates.status=approved·resolved_at 오늘 경계
④open_defects = 항상 {count:null, measured:false}(verdict/qa 소스 실 호출처 0)
⑤기존 5필드(needs_me 등) 무변 — 응답 스키마 확장이 기존 필드를 안 건드림
⑥조직 스코프 — 다른 org의 landed/approved는 안 셈."""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest

from tests.test_3823_today_aggregate_route import (
    _REAL_DB_URL,
    _client_for,
    _dispose_global_engine_after_test,  # noqa: F401 (autouse fixture import)
    _make_gate,
    _make_member,
    _make_org,
    _make_project,
    _make_story,
    _session_factory,
    _setup_app_human,
    anyio_backend,  # noqa: F401 (fixture import)
)

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
    pytest.mark.destructive_schema,
]


async def _make_story_activity(
    session, org_id, project_id, story_id, *, created_by, new_value="done", old_value="in-review",
    created_at=None,
):
    from app.models.pm import StoryActivity

    row = StoryActivity(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, story_id=story_id,
        activity_type="status_changed", old_value=old_value, new_value=new_value,
        created_by=created_by,
    )
    session.add(row)
    await session.flush()
    if created_at is not None:
        # server_default=func.now()라 INSERT 뒤 직접 갱신해야 과거/미래 시각을 만들 수 있다.
        row.created_at = created_at
    await session.commit()
    return row


async def test_landed_today_counts_status_changed_to_done_within_org_midnight_realdb():
    """AC1 — 오늘 done 전이만 카운트, 어제 전이·다른 org 전이는 제외."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            other_org = await _make_org(s, name="OtherOrg")
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_member(s, org.id, project.id, org_role="owner")
            story1 = await _make_story(s, org.id, project.id, title="오늘 착지1")
            story2 = await _make_story(s, org.id, project.id, title="오늘 착지2")
            story_yesterday = await _make_story(s, org.id, project.id, title="어제 착지")
            story_other_org = await _make_story(s, other_org.id, project.id, title="다른 org 착지")

            now = datetime.now(timezone.utc)
            await _make_story_activity(s, org.id, project.id, story1.id, created_by=caller_id, created_at=now)
            await _make_story_activity(s, org.id, project.id, story2.id, created_by=caller_id, created_at=now)
            # 어제(자정 경계 밖) — 제외돼야 함.
            await _make_story_activity(
                s, org.id, project.id, story_yesterday.id, created_by=caller_id,
                created_at=now - timedelta(days=1, hours=1),
            )
            # 다른 org — 제외돼야 함.
            await _make_story_activity(
                s, other_org.id, project.id, story_other_org.id, created_by=caller_id, created_at=now,
            )
            # activity_type이 status_changed가 아니거나 new_value가 done이 아니면 제외.
            await _make_story_activity(
                s, org.id, project.id, story1.id, created_by=caller_id, new_value="in-review", created_at=now,
            )

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/today")
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["landed_today"]["count"] == 2
            assert "since" in body["landed_today"]
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


async def test_landed_today_excludes_transitions_without_actor_realdb():
    """AC2 — actor_id 없는 전이는 story_activities 자체에 행이 안 남는다(emit_story_
    status_changed의 ``if actor_id:`` 계약) — 이 배제를 today 응답에서 직접 고정한다.
    이 테스트는 «행을 안 만든다»는 그 자체를 검증(만들 방법이 없다는 게 계약)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_member(s, org.id, project.id, org_role="owner")
            story = await _make_story(s, org.id, project.id, title="actor 없는 전이")
            # story.status만 직접 바꾸고 story_activities 행은 만들지 않는다 — board
            # PATCH/gate merge 경로를 거치지 않은 시스템 전이를 흉내(실제로 이런
            # 경로는 emit_story_status_changed를 안 거치면 이 행 자체가 안 남는다).
            story.status = "done"
            await s.commit()

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/today")
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["landed_today"]["count"] == 0
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


async def test_qa_passed_today_counts_approved_gates_within_org_midnight_realdb():
    """AC3 — 오늘 approved된 게이트만, pending·rejected·어제 approved는 제외."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_member(s, org.id, project.id, org_role="owner")
            story1 = await _make_story(s, org.id, project.id, title="게이트1")
            story2 = await _make_story(s, org.id, project.id, title="게이트2")
            story_pending = await _make_story(s, org.id, project.id, title="게이트 대기")
            story_yesterday = await _make_story(s, org.id, project.id, title="어제 승인")

            g1 = await _make_gate(
                s, org.id, work_item_type="story", work_item_id=story1.id,
                gate_type="doc_approval", status="approved",
            )
            g2 = await _make_gate(
                s, org.id, work_item_type="story", work_item_id=story2.id,
                gate_type="external_publish", status="approved",
            )
            await _make_gate(
                s, org.id, work_item_type="story", work_item_id=story_pending.id,
                gate_type="doc_approval", status="pending",
            )
            g_yesterday = await _make_gate(
                s, org.id, work_item_type="story", work_item_id=story_yesterday.id,
                gate_type="doc_approval", status="approved",
            )

            now = datetime.now(timezone.utc)
            async with Session() as s2:
                from app.models.gate import Gate

                await s2.execute(
                    Gate.__table__.update().where(Gate.id == g1.id).values(resolved_at=now)
                )
                await s2.execute(
                    Gate.__table__.update().where(Gate.id == g2.id).values(resolved_at=now)
                )
                await s2.execute(
                    Gate.__table__.update().where(Gate.id == g_yesterday.id)
                    .values(resolved_at=now - timedelta(days=1, hours=1))
                )
                await s2.commit()

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/today")
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["qa_passed_today"]["count"] == 2
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


async def test_open_defects_always_unmeasured_realdb():
    """AC4 — verdict/qa 소스 실 호출처 0 → 항상 {count:null, measured:false}."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_member(s, org.id, project.id, org_role="owner")
            await _make_story(s, org.id, project.id, title="아무 스토리")

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/today")
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["open_defects"] == {"count": None, "measured": False}
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


async def test_today_results_query_count_fixed_regardless_of_row_volume_realdb():
    """AC(N+1 0) — landed_today·qa_passed_today는 각 1개 집계 쿼리뿐, 대상 행 수와
    무관하게 총 session.scalar() 호출 = 2(open_defects는 쿼리 0). 이 응답 체인에서
    session.scalar()를 쓰는 곳은 today_service._resolve_today_results뿐이라(grep
    확認) 이 카운터가 곧 그 함수의 쿼리 수를 직접 잰다."""
    from sqlalchemy.ext.asyncio import AsyncSession

    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_member(s, org.id, project.id, org_role="owner")
            now = datetime.now(timezone.utc)
            for i in range(12):
                story = await _make_story(s, org.id, project.id, title=f"착지{i}")
                await _make_story_activity(s, org.id, project.id, story.id, created_by=caller_id, created_at=now)
            for i in range(8):
                story = await _make_story(s, org.id, project.id, title=f"게이트{i}")
                gate = await _make_gate(
                    s, org.id, work_item_type="story", work_item_id=story.id,
                    gate_type="doc_approval", status="approved",
                )
                from app.models.gate import Gate

                await s.execute(Gate.__table__.update().where(Gate.id == gate.id).values(resolved_at=now))
            await s.commit()

        call_count = 0
        _orig_scalar = AsyncSession.scalar

        async def _counting_scalar(self, *args, **kwargs):
            nonlocal call_count
            call_count += 1
            return await _orig_scalar(self, *args, **kwargs)

        AsyncSession.scalar = _counting_scalar
        try:
            await _setup_app_human(app, Session, caller_user_id, org.id)
            client = _client_for(app)
            try:
                resp = await client.get("/api/v2/today")
                assert resp.status_code == 200, resp.text
                body = resp.json()
                assert body["landed_today"]["count"] == 12
                assert body["qa_passed_today"]["count"] == 8
                assert call_count == 2, f"session.scalar() 호출 {call_count}회 — 2회(landed+qa_passed)만 기대"
            finally:
                await client.aclose()
                app.dependency_overrides.clear()
        finally:
            AsyncSession.scalar = _orig_scalar
    finally:
        await engine.dispose()


async def test_existing_five_fields_unaffected_by_today_results_extension_realdb():
    """AC5 — needs_me/agent_progress/completed_today/published_today/usage 응답
    자체가 그대로 存在(diff 0 단언) — 3959 확장이 기존 today_service 로직에 안 닿음."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_member(s, org.id, project.id, org_role="owner")

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/today")
            assert resp.status_code == 200, resp.text
            body = resp.json()
            for key in ("needs_me", "needs_me_count", "agent_progress", "completed_today", "published_today", "usage"):
                assert key in body
            assert body["needs_me"] == []
            assert body["needs_me_count"] == 0
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()
