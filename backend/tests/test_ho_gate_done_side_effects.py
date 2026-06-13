"""41a6e294: gate-driven done이 정상 status-change side-effects를 발화.

merge approve→done이 status만 직접 set하던 갭을 닫고, 정상 board 경로와 동일 helper
(emit_story_status_changed)로 events(story.status_changed→L1 진입점)·StoryActivity를 발화하는지
실DB로 검증. publish_event는 eventbus→L1 activity_events 캡처의 진입점이다.
"""
from __future__ import annotations

import os
import uuid
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = pytest.mark.skipif(
    not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)"
)


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.anyio
async def test_gate_driven_done_emits_status_changed_side_effects():
    from sqlalchemy import text as _text
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.core.database import Base
    import app.models  # noqa: F401
    from app.models.participation import ParticipationRole  # noqa: F401 — org_gate_override FK 해소.
    from app.models.member import Member
    from app.models.pm import Story, StoryActivity
    from app.services.gate_service import _advance_story_on_merge_approve

    url = _REAL_DB_URL.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
        "postgresql://", "postgresql+asyncpg://"
    )
    engine = create_async_engine(url)
    org, project, story_id, resolver = (uuid.uuid4() for _ in range(4))

    async with engine.begin() as c:
        await c.run_sync(Base.metadata.create_all)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            await s.execute(_text("SET session_replication_role = replica"))
            s.add_all([
                Member(id=resolver, org_id=org, type="human", user_id=uuid.uuid4(), name="h"),
                Story(id=story_id, org_id=org, project_id=project, title="S", status="in-review",
                      story_points=3),
            ])
            await s.commit()

        gate = SimpleNamespace(
            gate_type="merge", work_item_type="story", work_item_id=story_id,
            org_id=org, resolver_id=resolver,
        )
        spy = MagicMock()
        with patch("app.routers.events.publish_event", spy):
            async with Session() as s:
                await s.execute(_text("SET session_replication_role = replica"))
                await _advance_story_on_merge_approve(s, gate, "approved")
                await s.commit()

        # ① 상태 진행.
        async with Session() as s:
            status = (await s.execute(
                _text("SELECT status FROM stories WHERE id=:i"), {"i": story_id}
            )).scalar()
            act = (await s.execute(
                _text("SELECT old_value, new_value, activity_type FROM story_activities "
                      "WHERE story_id=:i"), {"i": story_id}
            )).all()
        assert status == "done"
        # ② publish_event("story.status_changed") 발화 = L1 activity_events 캡처 진입점.
        assert spy.called
        evt_types = [c.args[1] for c in spy.call_args_list if len(c.args) >= 2]
        assert "story.status_changed" in evt_types
        # ③ StoryActivity status_changed 행(in-review→done) — 정상 경로와 parity.
        assert any(a.activity_type == "status_changed" and a.old_value == "in-review"
                   and a.new_value == "done" for a in act)
    finally:
        async with engine.begin() as c:
            await c.run_sync(Base.metadata.drop_all)
        await engine.dispose()
