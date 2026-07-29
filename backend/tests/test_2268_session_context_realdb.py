"""story #2268(E-CONNECT, C-10) — GET /api/v2/session-context 실PG 검증.

AC1: my_stories/my_tasks(dashboard_core 재사용) + judgments_by_work_item(judgment_core
재사용) + recent_activity_by_work_item(activity_logs, PO 축전환 2026-07-29)이 한 호출로 온다.
AC4: `since` 생략 시 recent_activity_by_work_item은 None(빈 dict가 아니다).
AC5: 캡에 잘린 것은 비율이 아니라 사실(omitted_count)로 — judgments든 activity든 동형.

#2263/#2277과 동일 실PG 패턴(_client_for/_setup_app_human/_make_human_member 재사용,
delta 없이도 되는 이유는 이 테스트들이 매번 새 org/story를 만들어 절대값 assertion이
안전하기 때문 — 공유 테이블 delta 필요 없는 케이스)."""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest

from tests.test_1994_backlink_api_realdb import (
    _client_for,
    _make_human_member,
    _make_org,
    _make_project,
    _session_factory,
    _setup_app_human,
)

pytestmark = [pytest.mark.anyio]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


async def _make_story(session, org_id, project_id, *, assignee_id, title="Story", status="in-progress"):
    from app.models.pm import Story
    story = Story(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title, status=status,
        assignee_id=assignee_id,
    )
    session.add(story)
    await session.flush()
    return story


@pytest.mark.anyio
async def test_session_context_bundles_my_work_and_judgments():
    """AC1 핵심 — 한 호출에서 my_stories와 그 스토리에 붙은 judgment가 같이 온다."""
    from app.main import app
    from app.services.judgment_core import create_judgment

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id, "P")
            member_id, user_id = await _make_human_member(s, org.id, project.id)
            story = await _make_story(s, org.id, project.id, assignee_id=member_id, title="My Story")
            await s.commit()

            await create_judgment(
                s, org_id=org.id, scope="items", work_item_ids=[story.id], kind="judgment",
                target_id=None, method=None, statement="초기 판단", created_by=member_id,
            )
            await s.commit()

        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(
                "/api/v2/session-context", params={"member_id": str(member_id)},
            )
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert any(st["id"] == str(story.id) for st in body["my_stories"])
            judgments = body["judgments_by_work_item"][str(story.id)]
            assert len(judgments["active"]) == 1
            assert judgments["active"][0]["statement"] == "초기 판단"
            assert judgments["corrections"] == []
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_session_context_retraction_visible_inline_not_separate_only():
    """⭐PO 요구① — 철회를 「따로 목록」으로만 두지 않는다. active 원소 자체의 correction_ids로
    철회된 사실이 그 자리에서 보여야 한다(#2308/#2611 재사용, 이 엔드포인트가 그 필드를
    안 지우고 그대로 통과시키는지 확認)."""
    from app.main import app
    from app.services.judgment_core import create_judgment

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id, "P")
            member_id, user_id = await _make_human_member(s, org.id, project.id)
            story = await _make_story(s, org.id, project.id, assignee_id=member_id)
            await s.commit()

            original = await create_judgment(
                s, org_id=org.id, scope="items", work_item_ids=[story.id], kind="judgment",
                target_id=None, method=None, statement="원 판단(틀림)", created_by=member_id,
            )
            await s.commit()
            await create_judgment(
                s, org_id=org.id, scope="items", work_item_ids=[story.id], kind="retraction",
                target_id=original.id, method=None, statement="철회함", created_by=member_id,
            )
            await s.commit()

        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(
                "/api/v2/session-context", params={"member_id": str(member_id)},
            )
            assert resp.status_code == 200, resp.text
            judgments = resp.json()["judgments_by_work_item"][str(story.id)]
            active_original = next(j for j in judgments["active"] if j["id"] == str(original.id))
            assert active_original["correction_ids"] == [str(next(
                c["id"] for c in judgments["corrections"]
            ))], "active 목록의 원 판단 자체가 자신을 철회한 correction id를 물고 있어야 한다"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_session_context_since_omitted_gives_null_not_empty_list():
    """⛔AC4 — since를 안 주면 recent_activity_by_work_item은 None이어야 한다({}가 아니다).
    None="안 물어봤다", {}는 "물어봤는데 없었다" — 다른 사실이라 섞으면 거짓."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id, "P")
            member_id, user_id = await _make_human_member(s, org.id, project.id)
            await _make_story(s, org.id, project.id, assignee_id=member_id)
            await s.commit()

        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(
                "/api/v2/session-context", params={"member_id": str(member_id)},
            )
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["recent_activity_by_work_item"] is None
            assert body["recent_activity_since"] is None
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_session_context_since_provided_returns_activity_scoped_to_my_work():
    """AC1③ — since를 주면 내 work_item에 붙은 activity_logs만(다른 work_item의 활동은
    안 새는지도 대조) 반환한다."""
    from app.main import app
    from app.models.activity_log import ActivityLog

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id, "P")
            member_id, user_id = await _make_human_member(s, org.id, project.id)
            my_story = await _make_story(s, org.id, project.id, assignee_id=member_id, title="Mine")
            other_story = await _make_story(
                s, org.id, project.id, assignee_id=uuid.uuid4(), title="NotMine",
            )
            await s.commit()

            now = datetime.now(timezone.utc)
            s.add(ActivityLog(
                id=uuid.uuid4(), org_id=org.id, project_id=project.id, actor_id=member_id,
                actor_type="human", action="status_changed", entity_type="story",
                entity_id=my_story.id, context={"from": "backlog", "to": "in-progress"},
                created_at=now,
            ))
            s.add(ActivityLog(
                id=uuid.uuid4(), org_id=org.id, project_id=project.id, actor_id=member_id,
                actor_type="human", action="status_changed", entity_type="story",
                entity_id=other_story.id, context={}, created_at=now,
            ))
            await s.commit()

        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            since = (now - timedelta(hours=1)).isoformat()
            resp = await client.get(
                "/api/v2/session-context",
                params={"member_id": str(member_id), "since": since},
            )
            assert resp.status_code == 200, resp.text
            body = resp.json()
            activity = body["recent_activity_by_work_item"]
            assert str(my_story.id) in activity
            assert len(activity[str(my_story.id)]["items"]) == 1
            assert activity[str(my_story.id)]["items"][0]["action"] == "status_changed"
            assert str(other_story.id) not in activity, "내 것 아닌 스토리의 활동이 새면 안 된다"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_session_context_activity_cap_reports_omitted_as_fact():
    """⛔PO 판정② — 캡에 잘린 것은 비율이 아니라 사실로. activity_limit=1로 좁혀 2건 중
    1건만 실리면 omitted_count=1이 정확히 나와야 한다(잘렸다는 사실 자체가 사라지면 안 됨)."""
    from app.main import app
    from app.models.activity_log import ActivityLog

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id, "P")
            member_id, user_id = await _make_human_member(s, org.id, project.id)
            story = await _make_story(s, org.id, project.id, assignee_id=member_id)
            await s.commit()

            now = datetime.now(timezone.utc)
            for i in range(2):
                s.add(ActivityLog(
                    id=uuid.uuid4(), org_id=org.id, project_id=project.id, actor_id=member_id,
                    actor_type="human", action=f"event_{i}", entity_type="story",
                    entity_id=story.id, context={}, created_at=now - timedelta(minutes=i),
                ))
            await s.commit()

        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            since = (now - timedelta(hours=1)).isoformat()
            resp = await client.get(
                "/api/v2/session-context",
                params={"member_id": str(member_id), "since": since, "activity_limit": 1},
            )
            assert resp.status_code == 200, resp.text
            item = resp.json()["recent_activity_by_work_item"][str(story.id)]
            assert len(item["items"]) == 1
            assert item["omitted_count"] == 1
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_session_context_404_when_member_not_in_caller_org():
    """dashboard.py와 동일 cross-org 차단(dashboard_core.get_my_work 재사용이 이 게이트도
    같이 물려받는지 확認)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_a = await _make_org(s)
            org_b = await _make_org(s)
            project_a = await _make_project(s, org_a.id, "A")
            project_b = await _make_project(s, org_b.id, "B")
            _, caller_user_id = await _make_human_member(s, org_a.id, project_a.id)
            other_member_id, _ = await _make_human_member(s, org_b.id, project_b.id)
            await s.commit()

        await _setup_app_human(app, Session, caller_user_id, org_a.id)
        client = _client_for(app)
        try:
            resp = await client.get(
                "/api/v2/session-context", params={"member_id": str(other_member_id)},
            )
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
