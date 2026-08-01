"""story #2322 — PR #1(story 헬퍼) — `_assert_story_project_access`(stories.py)를 쓰는
5개 호출부(그때까지 403전용 테스트가 없던 곳: get_story·update_story·update_story_status·
list_comments·list_activities) 각각에 «무권한→404» 계약을 새로 못박는다.

⛔RED-먼저 규율(PO 판정, 2026-07-29): 옛 403을 테스트로 고정하지 않는다 — 이 파일은
헬퍼가 아직 403을 내는 시점에 작성됐고, 코드를 고치기 前에 반드시 RED(404 기대인데 실제
403이 와서 실패)를 눈으로 본 뒤에만 헬퍼를 바꾼다(같은 세션 커밋 메시지에 그 순서를 남긴다).

⭐양성대조: 접근권 있는 caller는 여전히 200 + 실제 데이터를 받는다(기존 test_stories.py::
test_get_story_200 등이 이미 그 축을 덮고 있어 여기서 재짓지 않는다 — 발명 금지).

다른 5개 호출부(backlinks·workflow-line-status·fallback-notify·withdraw·request-verification)
는 이미 403전용 테스트가 있어 — 이 파일이 아니라 그 기존 테스트 파일들을 직접 403→404로
수정한다(동일 커밋).
"""
from __future__ import annotations

import os
import uuid

import pytest

from tests.test_2266_story_backlinks_realdb import (
    _client_for,
    _make_human_member,
    _make_org,
    _make_project,
    _make_story,
    _session_factory,
    _setup_app_human,
)

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

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


async def _seed_cross_project(session):
    """org 하나에 project 둘 — caller는 other_project 소속(=target story의 project에 접근권 없음),
    같은 org 라서 org 경계는 이미 통과(그건 #2261이 이미 확認한 축, 이 PR과 무관)."""
    org = await _make_org(session)
    project = await _make_project(session, org.id, "Target Project")
    other_project = await _make_project(session, org.id, "Other Project")
    _, user_id = await _make_human_member(session, org.id, other_project.id)
    story = await _make_story(session, org.id, project.id, title="Target Story")
    return org, story, user_id


@pytest.mark.anyio
async def test_get_story_no_project_access_is_404_not_403():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, story, user_id = await _seed_cross_project(s)

        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/stories/{story.id}")
            assert resp.status_code == 404, (
                f"story #2322: 같은 org·다른 project 무권한은 404여야 한다(존재 비노출 통일) — "
                f"{resp.status_code}: {resp.text}"
            )
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_update_story_no_project_access_is_404_not_403():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, story, user_id = await _seed_cross_project(s)

        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.patch(f"/api/v2/stories/{story.id}", json={"title": "hacked"})
            assert resp.status_code == 404, (
                f"story #2322: PATCH 무권한도 404여야 한다 — {resp.status_code}: {resp.text}"
            )
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_update_story_status_no_project_access_is_404_not_403():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, story, user_id = await _seed_cross_project(s)

        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.patch(f"/api/v2/stories/{story.id}/status", json={"status": "in-progress"})
            assert resp.status_code == 404, (
                f"story #2322: PATCH /status 무권한도 404여야 한다 — {resp.status_code}: {resp.text}"
            )
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_list_comments_no_project_access_is_404_not_403():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, story, user_id = await _seed_cross_project(s)

        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/stories/{story.id}/comments")
            assert resp.status_code == 404, (
                f"story #2322: GET /comments 무권한도 404여야 한다 — {resp.status_code}: {resp.text}"
            )
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_list_activities_no_project_access_is_404_not_403():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, story, user_id = await _seed_cross_project(s)

        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/stories/{story.id}/activities")
            assert resp.status_code == 404, (
                f"story #2322: GET /activities 무권한도 404여야 한다 — {resp.status_code}: {resp.text}"
            )
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_get_story_still_404_for_genuinely_nonexistent_id():
    """양성대조의 다른 절반 — 「전부 404로 만들어 조용해진 것」과 구분(AC4). 존재 자체가
    없는 id도 여전히 404(이건 원래도 404였다 — 회귀 아님)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id, "P")
            _, user_id = await _make_human_member(s, org.id, project.id)

        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/stories/{uuid.uuid4()}")
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
