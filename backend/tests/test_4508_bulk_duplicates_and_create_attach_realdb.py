"""story #4508 (Qadir 4912 second line · Didi AC0 · PO 15:01Z) — two leftovers of 4497.

- PATCH /stories/bulk with the same story twice: which of its values would win was decided silently, and its assignee / status
  change was announced twice → refused, 422 naming the id, nothing written.
- POST /stories with an assignee commits early (to announce it); a failing enrichment after that answered 500 for a story
  already saved — a caller retrying would make it twice → logged and skipped, the saved story answers 201. With no assignee
  nothing is committed yet, and a failure still rolls the creation back.
"""
from __future__ import annotations

import os
import uuid

import pytest

from tests.test_4497_assignee_event_on_create_realdb import _assigned_events, _create, _patch, _seed

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.destructive_schema,  # the seeds write team_members (a table in the destructive schema, a view when migrated)
    pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요"),
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


async def _stories(Session, project_id):
    from sqlalchemy import select

    from app.models.pm import Story

    async with Session() as s:
        return (await s.execute(select(Story).where(Story.project_id == project_id))).scalars().all()


async def test_bulk_naming_the_same_story_twice_is_refused_and_writes_nothing():
    engine, Session, org_id, project_id, owner_id, _other, agent_id = await _seed()
    try:
        r = await _create(Session, org_id, project_id, owner_id)
        sid = r.json().get("data", r.json())["id"]
        r = await _patch(Session, org_id, owner_id, "/api/v2/stories/bulk", {"items": [
            {"id": sid, "assignee_id": str(agent_id), "status": "ready-for-dev"},
            {"id": sid, "status": "in-progress"},
        ]})
        assert r.status_code == 422, r.text
        assert "DUPLICATE_STORY_IDS" in r.text and sid in r.text
        [story] = await _stories(Session, project_id)
        assert story.assignee_id is None and story.status not in ("ready-for-dev", "in-progress")
        assert await _assigned_events(Session, uuid.UUID(sid)) == []
        # control: the same story once goes through
        r = await _patch(Session, org_id, owner_id, "/api/v2/stories/bulk", {"items": [{"id": sid, "assignee_id": str(agent_id)}]})
        assert r.status_code == 200, r.text
    finally:
        await engine.dispose()


async def _create_or_500(Session, org_id, project_id, owner_id, **extra) -> int:
    """The status the caller gets — a server exception the test client re-raises counts as the 500 it would answer."""
    try:
        return (await _create(Session, org_id, project_id, owner_id, **extra)).status_code
    except Exception:
        return 500


async def test_a_story_made_with_an_assignee_answers_201_when_an_enrichment_fails_after_it_is_saved(monkeypatch):
    import app.routers.stories as stories_mod

    async def broken(*_a, **_k):
        raise RuntimeError("enrichment down")

    monkeypatch.setattr(stories_mod, "_attach_trust_stage", broken)
    engine, Session, org_id, project_id, owner_id, _other, agent_id = await _seed()
    try:
        assert await _create_or_500(Session, org_id, project_id, owner_id, assignee_id=str(agent_id)) == 201
        assert len(await _stories(Session, project_id)) == 1  # saved once — nothing for a retry to duplicate
    finally:
        await engine.dispose()


async def test_with_no_assignee_a_failing_enrichment_still_rolls_the_creation_back(monkeypatch):
    """No early commit on this path: the failure answers 500 and nothing is saved (a retry is safe) — as before."""
    import app.routers.stories as stories_mod

    async def broken(*_a, **_k):
        raise RuntimeError("enrichment down")

    monkeypatch.setattr(stories_mod, "_attach_trust_stage", broken)
    engine, Session, org_id, project_id, owner_id, _other, _agent = await _seed()
    try:
        assert await _create_or_500(Session, org_id, project_id, owner_id) == 500
        assert await _stories(Session, project_id) == []
    finally:
        await engine.dispose()
