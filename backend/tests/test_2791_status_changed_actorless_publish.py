"""story #2791(P0, event-workflow-unification-design-2790) — 회귀 테스트.

디디군 교차QA 실버그(2026-08-19): `preset.work.status_changed`의 `changed_by_member_id`는
payload_schema(0245)상 `{"type":"string","format":"uuid"}`로 non-nullable(`preset.work.assigned`
의 `assigned_by_member_id`와 달리 null union이 아님) — actor_id 없는 전이(시스템/자동 전이,
정확히 이 P0 자동발행 자체가 그 사례)에서 값을 `None`으로 실으면 스키마 위반 400으로
`publish_preset_event`가 예외를 던지고, 호출자(`emit_story_status_changed`)의 try/except가
그 실패를 삼켜 로그만 남긴 채 **그 전이의 발행이 영구 불발**됐다. fix = actor_id 없으면
`changed_by_member_id` 키 자체를 payload에서 생략.
"""
from __future__ import annotations

import os
import uuid
from unittest.mock import AsyncMock, patch

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _session_factory():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    engine = create_async_engine(_async_url())
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_story(session):
    from app.models.organization import Organization
    from app.models.pm import Story
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()

    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()

    story = Story(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="S", status="ready-for-dev")
    session.add(story)
    await session.commit()

    return org.id, story


@pytest.mark.anyio
async def test_status_changed_without_actor_id_still_publishes():
    """actor_id 없는 전이(시스템 자동전이)도 preset.work.status_changed 발행이 성립한다 —
    payload에 changed_by_member_id 키 자체가 없어야 함(None 값 실어 스키마위반 400 유발 금지)."""
    from app.services.story_status_events import emit_story_status_changed

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, story = await _seed_story(s)

        async with Session() as s:
            story = await s.get(type(story), story.id)
            old_status = story.status
            story.status = "in-progress"

            with patch(
                "app.routers.events.publish_preset_event", new=AsyncMock(return_value={"zero_reach_warning": False}),
            ) as publish_mock:
                await emit_story_status_changed(s, org_id, story, old_status, actor_id=None)
                await s.commit()

            publish_mock.assert_awaited_once()
            args, kwargs = publish_mock.await_args
            # 호출 시그니처: (db, org_id, definition_key, payload)
            payload = args[3] if len(args) > 3 else kwargs.get("payload")
            assert payload["work_item_type"] == "story"
            assert payload["from_status"] == old_status
            assert payload["to_status"] == "in-progress"
            assert "changed_by_member_id" not in payload, (
                "actor_id=None인데 changed_by_member_id 키가 실려있음 — "
                "non-nullable 필드에 null을 실어 스키마위반을 유발하는 회귀"
            )
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_status_changed_with_actor_id_includes_member_id():
    """대조군 — actor_id가 있으면 changed_by_member_id가 정상적으로 실린다(회귀 없음)."""
    from app.services.story_status_events import emit_story_status_changed

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, story = await _seed_story(s)

        actor_id = uuid.uuid4()
        async with Session() as s:
            story = await s.get(type(story), story.id)
            old_status = story.status
            story.status = "in-progress"

            with patch(
                "app.routers.events.publish_preset_event", new=AsyncMock(return_value={"zero_reach_warning": False}),
            ) as publish_mock:
                await emit_story_status_changed(s, org_id, story, old_status, actor_id=actor_id)
                await s.commit()

            args, kwargs = publish_mock.await_args
            payload = args[3] if len(args) > 3 else kwargs.get("payload")
            assert payload["changed_by_member_id"] == str(actor_id)
    finally:
        await engine.dispose()
