"""story #2538(2026-08-09, PO 그라운딩 정정) — unanswered_blocker 이상 신호에 title이
실제로 SQL 조인/셀렉트에서 나오는지 실PG로 검증한다. 기존 test_command_center.py는 mock
세션이라 SELECT 절에 title이 실제로 들어가는지·조인이 유효한지는 증명 못한다.

⛔story #93b076c8(2250, 2026-08-27) — 이 파일은 원래 story_stalled도 함께 검증했으나 그
신호 자체가 command_center.py에서 완전히 걷어내졌다(#8934ba7f AC1 실측으로 부정확 확定 —
Story.updated_at은 같은 값 재대입에도 bump. `/glance/attention` kind="stalled"가 대체).
그 테스트(test_story_stalled_title_matches_real_story_realdb)는 삭제 — unanswered_blocker
커버리지만 남는다."""
from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest

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
