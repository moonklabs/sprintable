"""41a6e294: gate-driven done이 정상 status-change side-effects를 발화.

merge approve→done이 status만 직접 set하던 갭을 닫고, 정상 board 경로와 동일 helper
(emit_story_status_changed)로 events(story.status_changed)·StoryActivity를 발화하는지
실DB로 검증.

⚠️story #2132(2026-07-23) 정정 — 이 파일이 검증하던 `publish_event("story.status_changed")`는
삭제됐다(org-level fanout, `_subscribers` 영구 죽은 레지스트리·구독자 0). 실 배달은
`project_accessible_member_ids`로 프로젝트 인가 필터를 거친 뒤 `_push_to_agent` 개별 push뿐이라
(story_status_events.py 참고), 이 테스트도 그 실 경로로 재조준한다.
"""
from __future__ import annotations

import os
import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

# story 8236bbc3: create_all/drop_all로 자체 스키마 직접 관리 — 공유 alembic-migrated DB
# 오염 방지 위해 격리 DB 전용(conftest.py 가드가 마커 누락을 자동 검출).
pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)"),
    pytest.mark.destructive_schema,
]


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
        push_spy = MagicMock()
        with patch("app.services.project_auth.project_accessible_member_ids",
                   AsyncMock(return_value={resolver})), \
             patch("app.routers.events._push_to_agent", push_spy):
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
        # ② _push_to_agent("story.status_changed") 발화 = 실 SSE 배달 경로(story #2132 이후).
        assert push_spy.called
        evt_types = [c.args[1].get("event_type") for c in push_spy.call_args_list if len(c.args) >= 2]
        assert "story.status_changed" in evt_types
        # ③ StoryActivity status_changed 행(in-review→done) — 정상 경로와 parity.
        assert any(a.activity_type == "status_changed" and a.old_value == "in-review"
                   and a.new_value == "done" for a in act)
    finally:
        async with engine.begin() as c:
            await c.run_sync(Base.metadata.drop_all)
        await engine.dispose()
