"""story #2847(AC1) — story 착수(in-progress 진입) 시 implementation participation 자동 등록.

claim_story/assignee 경로는 이미 3414b6d7의 ensure_implementation_participation으로 보장됐지만,
PATCH /stories/{id}/status만 거치는 챗-킥오프 흐름(claim/assign 생략)은 여태 빠져 있었다 —
merge gate의 "no implementation participation" 침묵 no-op 근본원인(#2843/#3262 실사고, 디디
진단·페드루 확定). 이 파일은 그 새 call site를 실PG로 검증한다(기존 helper 자체 동작은
test_claim_participation.py가 이미 커버 — 발명 0, 새 chokepoint 배선만 확인).

test_2266_story_backlinks_realdb.py의 harness(session_factory/client_for/human member/
setup_app_human)를 그대로 재사용.
"""
from __future__ import annotations

import os
import uuid

import pytest
from sqlalchemy import select

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


async def _seed_default_role(session, org_id):
    from app.models.participation import ParticipationRole

    role = ParticipationRole(
        id=uuid.uuid4(), org_id=org_id, key="implementation", label="구현", is_default=True,
    )
    session.add(role)
    await session.commit()
    return role


async def _participation_rows(session, org_id, story_id):
    from app.models.participation import Participation

    return (
        await session.execute(
            select(Participation).where(
                Participation.org_id == org_id, Participation.story_id == story_id,
            )
        )
    ).scalars().all()


@pytest.mark.anyio
async def test_status_to_in_progress_auto_registers_caller_as_implementation_participant():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            member_id, user_id = await _make_human_member(s, org.id, project.id)
            await _seed_default_role(s, org.id)
            story = await _make_story(s, org.id, project.id)
            story_id = story.id

        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.patch(
                f"/api/v2/stories/{story_id}/status", json={"status": "in-progress"},
            )
            assert resp.status_code == 200, resp.text
        finally:
            await client.aclose()
            app.dependency_overrides.clear()

        async with Session() as s:
            rows = await _participation_rows(s, org.id, story_id)
            assert len(rows) == 1
            assert rows[0].member_id == member_id
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_status_to_in_progress_idempotent_no_duplicate_participation():
    """양성대조 — 두 번 in-progress 전이(예: in-progress→todo→in-progress)해도 participation은
    1건(ensure_implementation_participation의 멱등성이 이 call site에서도 성립)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            member_id, user_id = await _make_human_member(s, org.id, project.id)
            await _seed_default_role(s, org.id)
            story = await _make_story(s, org.id, project.id)
            story_id = story.id

        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            for target in ("in-progress", "ready-for-dev", "in-progress"):
                resp = await client.patch(
                    f"/api/v2/stories/{story_id}/status", json={"status": target},
                )
                assert resp.status_code == 200, resp.text
        finally:
            await client.aclose()
            app.dependency_overrides.clear()

        async with Session() as s:
            rows = await _participation_rows(s, org.id, story_id)
            assert len(rows) == 1
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_status_transition_not_touching_in_progress_does_not_register_participation():
    """음성대조 — in-progress를 거치지 않는 전이(backlog→ready-for-dev)는 participation을 만들지 않는다
    (착수 시점이 아니면 "누가 구현했는지" 서버가 함부로 단정하지 않는다)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            _member_id, user_id = await _make_human_member(s, org.id, project.id)
            await _seed_default_role(s, org.id)
            story = await _make_story(s, org.id, project.id)
            story_id = story.id

        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.patch(
                f"/api/v2/stories/{story_id}/status", json={"status": "ready-for-dev"},
            )
            assert resp.status_code == 200, resp.text
        finally:
            await client.aclose()
            app.dependency_overrides.clear()

        async with Session() as s:
            rows = await _participation_rows(s, org.id, story_id)
            assert len(rows) == 0
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
