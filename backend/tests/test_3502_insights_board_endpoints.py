"""story #3502(Phase2·마케팅운영, 페드루 PO 確定 2026-09-05) 조각② — 성과 보드 HTTP
라우터(GET insights-board · POST follow-ups). story #3604(CI·소형, 페드루 PO 確定
2026-09-07)로 test_3502_insights_board.py에서 분리했다 — 원인 실측(--durations):
`from app.main import app`(FastAPI 앱 전체 import) 1회 비용이 로컬 무경합 기준
~3.4s로, 이 6개 HTTP 테스트가 있던 자리(원 파일 20개 중)가 4.08s(그 중 1건)로 튀어
등재 39s 대비 경합 시 80s까지 늘던 원인이었다 — 나머지 14개(list_insights_board를
서비스 함수로 직접 부르는, app.main 무관) 테스트는 각 0.3~0.4s로 안정적이었다.
분할 후 실측: 이 파일 6개=4.50s(app.main 1회분 포함, 무경합)·원 파일 14개=6.78s —
둘 다 20s 목표 아래(경합 배율 2배를 감안해도 여유). 테스트 수·assertion 불변,
세팅 헬퍼는 test_3471_org_content_rules_lint.py 재사용(동형 관례 유지)."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from tests.test_3471_org_content_rules_lint import (
    _client_for,
    _seed_agent,
    _seed_human,
    _seed_org,
    _seed_story,
    _session_factory,
    _setup_org_scoped_app,
)

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


async def _seed_site_post(
    session, *, org_id, work_item_id, lang="ko", slug, title, published_at, unpublished_at=None,
):
    from app.models.site_post import SitePost

    post = SitePost(
        id=uuid.uuid4(), org_id=org_id, lang=lang, slug=slug, title=title, summary="요약",
        tags=[], body_md="본문", published_at=published_at, source_story_id=work_item_id,
        gate_id=uuid.uuid4(), unpublished_at=unpublished_at,
    )
    session.add(post)
    await session.commit()
    return post


@pytest.mark.anyio
async def test_get_insights_board_endpoint_agent_200_with_rows():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            await _seed_site_post(
                s, org_id=org_id, work_item_id=story_id, slug="post-http", title="HTTP",
                published_at=datetime.now(timezone.utc) - timedelta(days=1),
            )

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_id}/insights-board")
        assert r.status_code == 200, r.text
        body = r.json()
        assert len(body["rows"]) == 1
        assert body["rows"][0]["title"] == "HTTP"
        assert body["has_more"] is False
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_get_insights_board_endpoint_invalid_window_422():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_id}/insights-board?window=14d")
        assert r.status_code == 422, r.text
        assert r.json()["error"]["code"] == "INSIGHTS_BOARD_INVALID_WINDOW"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_create_follow_up_creates_story_with_number_and_evidence():
    from app.main import app
    from app.models.evidence import Evidence
    from app.models.pm import Story
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, role="member")
            story_id = await _seed_story(s, org_id, project_id, title="원문")
            sp = await _seed_site_post(
                s, org_id=org_id, work_item_id=story_id, slug="post-fu", title="FU",
                published_at=datetime.now(timezone.utc) - timedelta(days=2),
            )

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/organizations/{org_id}/publications/{sp.id}/follow-ups",
                json={"kind": "republish", "note": "다시 내보내자"},
            )
        assert r.status_code == 201, r.text
        new_story_id = uuid.UUID(r.json()["story_id"])

        async with Session() as s:
            new_story = (await s.execute(select(Story).where(Story.id == new_story_id))).scalar_one()
            assert new_story.project_id == project_id
            assert new_story.story_number is not None, "allocate_story_number()가 채번해야 한다"
            assert "원문" in new_story.title

            evidence = (await s.execute(
                select(Evidence).where(Evidence.work_item_id == new_story_id)
            )).scalar_one()
            assert evidence.payload["kind"] == "follow_up_created"
            assert evidence.payload["follow_up_kind"] == "republish"
            assert evidence.payload["publication_id"] == str(sp.id)
            assert evidence.payload["recorded_by"] == "platform"
            assert evidence.created_by is None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_create_follow_up_agent_forbidden():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            sp = await _seed_site_post(
                s, org_id=org_id, work_item_id=story_id, slug="post-fu-agent", title="FUA",
                published_at=datetime.now(timezone.utc) - timedelta(days=2),
            )

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/organizations/{org_id}/publications/{sp.id}/follow-ups",
                json={"kind": "edit"},
            )
        assert r.status_code == 403, r.text
        assert r.json()["error"]["code"] == "FOLLOW_UP_CREATE_HUMAN_ONLY"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_create_follow_up_other_org_publication_404():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_a, project_a = await _seed_org(s)
            story_a = await _seed_story(s, org_a, project_a)
            sp_a = await _seed_site_post(
                s, org_id=org_a, work_item_id=story_a, slug="post-org-a", title="A",
                published_at=datetime.now(timezone.utc) - timedelta(days=1),
            )
            org_b, project_b = await _seed_org(s)
            human_b = await _seed_human(s, org_b, role="member")

        _setup_org_scoped_app(app, Session, org_b, user_id=human_b)
        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/organizations/{org_b}/publications/{sp_a.id}/follow-ups",
                json={"kind": "stop"},
            )
        assert r.status_code == 404, r.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_create_follow_up_invalid_kind_422():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, role="member")
            story_id = await _seed_story(s, org_id, project_id)
            sp = await _seed_site_post(
                s, org_id=org_id, work_item_id=story_id, slug="post-fu-badkind", title="Bad",
                published_at=datetime.now(timezone.utc) - timedelta(days=1),
            )

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/organizations/{org_id}/publications/{sp.id}/follow-ups",
                json={"kind": "delete_everything"},
            )
        assert r.status_code == 422, r.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
