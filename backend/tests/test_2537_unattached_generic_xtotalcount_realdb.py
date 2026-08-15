"""story #2537(카디르 QA #2932 실측, 2026-08-09) — unattached-bucket이 실제로 타는 요청
형태(`project_id`+`unattached=true`, **status 없음** → 제네릭 `repo.list()` 분기)에서
X-Total-Count가 실제로 나는지 실PG로 pin한다.

⛔mock 기반 FE route.test.ts는 헤더를 인위 반환해 이 결함을 못 잡는다(미르코 FE 배선 자체는
정확했다) — 진짜 방어는 이 real-DB 테스트뿐이다. story #2532의
test_unattached_filter_is_sql_where_level_not_post_page_realdb는 `status=backlog`를 줘서
board 분기(list_board, 이미 X-Total-Count 정상)를 태우므로 이 결함을 못 잡았다 — 그게 카디르가
105건 라이브에서 잡을 때까지 CI가 초록이었던 이유."""
from __future__ import annotations

import uuid

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


async def _make_goal(session, org_id, project_id, title="Goal"):
    from app.models.pm import Goal
    goal = Goal(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title)
    session.add(goal)
    await session.commit()
    return goal


async def test_unattached_generic_branch_sets_xtotalcount_realdb():
    """⭐핵심 — status 없이 project_id+unattached=true(카디르가 105건서 재현한 정확한 그
    요청 형태)로 부르면 제네릭 repo.list() 분기를 타는데, 예전엔 X-Total-Count가 아예 안
    실렸다(응답 자체는 200 정상이라 FE 눈엔 "느리게 조용히 깨진" 결함). limit보다 적은
    unattached 3건을 심어 total=3이 정확히 나는지 확認."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            _caller_id, caller_user = await _make_human_member(s, org.id, project.id)
            goal = await _make_goal(s, org.id, project.id)

            attached = await _make_story(s, org.id, project.id, title="attached")
            attached.epic_id = goal.id
            unattached_1 = await _make_story(s, org.id, project.id, title="u1")
            unattached_2 = await _make_story(s, org.id, project.id, title="u2")
            unattached_3 = await _make_story(s, org.id, project.id, title="u3")
            await s.commit()

        await _setup_app_human(app, Session, caller_user, org.id)
        async with _client_for(app) as client:
            # ⛔status 파라미터를 안 준다 — 이게 카디르가 105건서 재현한 정확한 요청 형태다.
            resp = await client.get(
                f"/api/v2/stories?project_id={project.id}&unattached=true&limit=100"
            )
            assert resp.status_code == 200, resp.text
            items = resp.json()
            ids = {item["id"] for item in items}
            assert str(unattached_1.id) in ids
            assert str(unattached_2.id) in ids
            assert str(unattached_3.id) in ids
            assert str(attached.id) not in ids

            assert "x-total-count" in resp.headers, (
                "제네릭 repo.list() 분기가 X-Total-Count를 안 낸다 — 카디르 QA #2932 재발"
            )
            assert resp.headers["x-total-count"] == "3", (
                f"필터 後 정확한 count(3)여야 하는데 {resp.headers['x-total-count']!r}"
            )
        app.dependency_overrides.clear()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_unattached_generic_branch_xtotalcount_respects_limit_boundary_realdb():
    """⭐AC — X-Total-Count는 limit 適用 前(필터 後 전체 건수), 응답 바디는 limit 適用 後.
    limit=1보다 unattached가 많을 때 바디는 1건이지만 헤더는 실제 전체 건수(2)여야
    한다(story #2532의 board-분기 pin과 동형 원칙을 generic 분기에도 적용)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            _caller_id, caller_user = await _make_human_member(s, org.id, project.id)

            await _make_story(s, org.id, project.id, title="u1")
            await _make_story(s, org.id, project.id, title="u2")
            await s.commit()

        await _setup_app_human(app, Session, caller_user, org.id)
        async with _client_for(app) as client:
            resp = await client.get(
                f"/api/v2/stories?project_id={project.id}&unattached=true&limit=1"
            )
            assert resp.status_code == 200, resp.text
            assert len(resp.json()) == 1
            assert resp.headers["x-total-count"] == "2", (
                f"바디는 limit=1로 잘려도 헤더는 필터 後 전체(2)여야 하는데 "
                f"{resp.headers['x-total-count']!r}"
            )
        app.dependency_overrides.clear()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
