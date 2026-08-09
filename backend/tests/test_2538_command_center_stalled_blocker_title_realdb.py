"""story #2538(2026-08-09, PO 그라운딩 정정) — story_stalled/unanswered_blocker 이상 신호에
title이 실제로 SQL 조인/셀렉트에서 나오는지 실PG로 검증한다. 기존 test_command_center.py는
mock 세션이라 SELECT 절에 title이 실제로 들어가는지·조인이 유효한지는 증명 못한다.

배경: ko.json "가설이 예상과 다르게 진행됩니다" 카피가 story_stalled(가설과 무관한 제네릭
스토리 정체 감지)에 잘못 매핑돼 있었다 — 카피 정정+dedup+개별 구별("제목+N일")은 FE 몫,
그 구별에 필요한 title을 이 스토리가 additive로 채운다."""
from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import update

from tests.test_1994_backlink_api_realdb import (
    _client_for,
    _make_org,
    _make_project,
    _session_factory,
)
from tests.test_2288_command_center_gate_type_waiting_realdb import (
    _make_member,
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


_OLD = datetime.now(UTC) - timedelta(days=10)


async def _backdate_story(session, story_id, *, status="in-progress"):
    """updated_at은 onupdate=func.now()라 ORM 경유 커밋은 값을 덮어쓴다 — Core update()로
    명시값을 강제한다."""
    from app.models.pm import Story
    await session.execute(
        update(Story).where(Story.id == story_id).values(status=status, updated_at=_OLD)
    )
    await session.commit()


async def test_story_stalled_title_matches_real_story_realdb():
    """⭐핵심 — story_stalled 항목의 title이 실제 Story.title과 일치하는지(SQL SELECT에
    Story.title이 실제로 들어갔는지) 실PG로 확認."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            _caller_id, caller_user_id = await _make_member(s, org.id, project.id)
            story = await _make_story(s, org.id, project.id, title="결제 리팩터링")
            await _backdate_story(s, story.id)

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/command-center/my-actions")
            assert resp.status_code == 200, resp.text
            items = resp.json()["attention"]["items"]
            stalled = next(i for i in items if i["type"] == "story_stalled" and i["story_id"] == str(story.id))
            assert stalled["title"] == "결제 리팩터링", (
                f"title이 실제 스토리 제목과 다르다: {stalled['title']!r}"
            )
            assert isinstance(stalled["stalled_days"], int) and stalled["stalled_days"] >= 9
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


async def test_unanswered_blocker_title_matches_blocked_story_realdb():
    """⭐핵심 — unanswered_blocker의 blocked_story_title이 실제 막힌 story의 제목과
    일치하는지(_BlockedU 조인 별칭에서 title 추출이 실제로 동작하는지) 실PG로 확認."""
    from app.main import app
    from app.models.dependency import ItemDependency

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            _caller_id, caller_user_id = await _make_member(s, org.id, project.id)
            blocker_story = await _make_story(s, org.id, project.id, title="선행 작업")
            blocked_story = await _make_story(s, org.id, project.id, title="막힌 작업")
            old_created = datetime.now(UTC) - timedelta(days=5)
            s.add(ItemDependency(
                id=uuid.uuid4(), org_id=org.id, item_type="story", dep_type="blocks",
                from_id=blocker_story.id, to_id=blocked_story.id, created_at=old_created,
            ))
            await s.commit()

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/command-center/my-actions")
            assert resp.status_code == 200, resp.text
            items = resp.json()["attention"]["items"]
            ub = next(
                i for i in items
                if i["type"] == "unanswered_blocker" and i["blocked_story_id"] == str(blocked_story.id)
            )
            assert ub["blocked_story_title"] == "막힌 작업", (
                f"blocked_story_title이 실제 막힌 스토리 제목과 다르다: {ub['blocked_story_title']!r}"
            )
        finally:
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()
