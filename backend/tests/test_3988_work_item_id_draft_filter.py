"""story #3988(E-UX-OVERHAUL·「일감」 흡수 2/N·BE+FE) — `GET .../channel-posts/drafts`·
`GET .../site-posts/drafts` 목록 엔드포인트에 `work_item_id` additive 필터. 일감 상세
「발행물」 탭이 그 work_item_id에 이어진 초안만 보이게 하는 것이 목적 — 새 엔드포인트
0, 기존 파라미터·정렬·권한 무변경. 세팅 헬퍼는 test_3374_channel_posts.py/
test_3384_site_post_list_status.py를 그대로 재사용(중복 재발명 0)."""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.destructive_schema,
    pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요"),
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


@pytest.mark.anyio
async def test_channel_post_drafts_filter_by_work_item_id_hits_and_misses():
    from tests.test_3374_channel_posts import (
        _client_for, _draft_body, _seed_agent, _seed_connection, _seed_default_role,
        _seed_org, _seed_story, _session_factory, _setup_org_scoped_app,
    )
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            story_a = await _seed_story(s, org_id, project_id, title="일 A")
            story_b = await _seed_story(s, org_id, project_id, title="일 B")
            connection_id = await _seed_connection(s, org_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            for story_id in (story_a, story_b):
                r = await client.post(
                    f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                    json=_draft_body(work_item_id=story_id, connection_id=connection_id),
                )
                assert r.status_code == 201, r.text

            # 적중 — story_a로 필터하면 그 초안 1건만.
            r_hit = await client.get(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                params={"work_item_id": str(story_a)},
            )
            assert r_hit.status_code == 200, r_hit.text
            hit_items = r_hit.json()
            assert len(hit_items) == 1
            assert hit_items[0]["work_item_id"] == str(story_a)
            assert r_hit.headers["X-Total-Count"] == "1"

            # 미적중 — 초안이 하나도 안 이어진 임의 work_item_id면 빈 목록.
            r_miss = await client.get(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                params={"work_item_id": str(uuid.uuid4())},
            )
            assert r_miss.status_code == 200, r_miss.text
            assert r_miss.json() == []
            assert r_miss.headers["X-Total-Count"] == "0"

            # 기존 호출(필터 무지정) — 회귀 0, 둘 다 보인다.
            r_all = await client.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts")
            assert r_all.status_code == 200, r_all.text
            assert len(r_all.json()) == 2
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_channel_post_drafts_filter_excludes_other_org():
    """다른 org의 같은 work_item_id 값(우연히 같은 UUID일 수는 없지만, org_id 스코프
    자체가 필터보다 먼저 걸리는지 — 교차 조직 노출 방지 확認)."""
    from tests.test_3374_channel_posts import (
        _client_for, _draft_body, _seed_agent, _seed_connection, _seed_default_role,
        _seed_org, _seed_story, _session_factory, _setup_org_scoped_app,
    )
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)

            other_org_id, other_project_id = await _seed_org(s)
            await _seed_default_role(s, other_org_id)
            other_agent_id = await _seed_agent(s, other_org_id, other_project_id)
            other_connection_id = await _seed_connection(s, other_org_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                json=_draft_body(work_item_id=story_id, connection_id=connection_id),
            )
            assert r.status_code == 201, r.text
        app.dependency_overrides.clear()

        _setup_org_scoped_app(app, Session, other_org_id, user_id=other_agent_id, agent=True)
        async with _client_for(app) as client:
            # 다른 org 소속 요청자가 첫 번째 org의 work_item_id로 필터해도(org_id
            # 스코프가 항상 먼저 걸린다) 새지 않는다 — 애초에 접근 자체가 org_id 스코프.
            r_cross = await client.get(
                f"/api/v2/organizations/{other_org_id}/channel-posts/drafts",
                params={"work_item_id": str(story_id)},
            )
            assert r_cross.status_code == 200, r_cross.text
            assert r_cross.json() == []
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_site_post_drafts_filter_by_work_item_id_hits_and_misses():
    from tests.test_3384_site_post_list_status import (
        _client_for, _draft_body, _seed_agent, _seed_org, _seed_story, _session_factory,
        _setup_org_scoped_app,
    )
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            story_a = await _seed_story(s, org_id, project_id, title="일 A")
            story_b = await _seed_story(s, org_id, project_id, title="일 B")

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id)
        async with _client_for(app) as client:
            for story_id in (story_a, story_b):
                r = await client.post(
                    f"/api/v2/organizations/{org_id}/site-posts/drafts",
                    json=_draft_body(work_item_id=story_id),
                )
                assert r.status_code == 201, r.text

            r_hit = await client.get(
                f"/api/v2/organizations/{org_id}/site-posts/drafts",
                params={"work_item_id": str(story_a)},
            )
            assert r_hit.status_code == 200, r_hit.text
            hit_items = r_hit.json()
            assert len(hit_items) == 1
            assert hit_items[0]["work_item_id"] == str(story_a)
            assert r_hit.headers["X-Total-Count"] == "1"

            r_miss = await client.get(
                f"/api/v2/organizations/{org_id}/site-posts/drafts",
                params={"work_item_id": str(uuid.uuid4())},
            )
            assert r_miss.status_code == 200, r_miss.text
            assert r_miss.json() == []

            r_all = await client.get(f"/api/v2/organizations/{org_id}/site-posts/drafts")
            assert r_all.status_code == 200, r_all.text
            assert len(r_all.json()) == 2
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_site_post_drafts_filter_excludes_other_org():
    """CHANGES-2(페드루 PO 판정 2026-09-17 03:49Z) — AC1 「다른 org 미노출」이 채널
    쪽만 테스트돼 있던 갭. site_posts도 org_id 스코프가 work_item_id 필터보다 먼저
    걸리는지(교차 org 노출 0) 채널과 동형으로 확認."""
    from tests.test_3384_site_post_list_status import (
        _client_for, _draft_body, _seed_agent, _seed_org, _seed_story, _session_factory,
        _setup_org_scoped_app,
    )
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)

            other_org_id, other_project_id = await _seed_org(s)
            other_agent_id = await _seed_agent(s, other_org_id, other_project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id)
        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts",
                json=_draft_body(work_item_id=story_id),
            )
            assert r.status_code == 201, r.text
        app.dependency_overrides.clear()

        _setup_org_scoped_app(app, Session, other_org_id, user_id=other_agent_id)
        async with _client_for(app) as client:
            r_cross = await client.get(
                f"/api/v2/organizations/{other_org_id}/site-posts/drafts",
                params={"work_item_id": str(story_id)},
            )
            assert r_cross.status_code == 200, r_cross.text
            assert r_cross.json() == []
    finally:
        await engine.dispose()
