"""H1-FIX-2: merge 게이트 approve → 스토리 done 진행.

S7이 verdict만 기록하고 →done 진행을 안 박아, 사람이 approve해도 일이 done 도달 못 하던 dogfood
갭을 닫는다. approve→done·reject→유지·비-merge→미진행·멱등.
"""
from __future__ import annotations

import os
import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from app.services.gate_service import _advance_story_on_merge_approve

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _gate(gate_type="merge", work_item_type="story"):
    return SimpleNamespace(gate_type=gate_type, work_item_type=work_item_type, work_item_id=uuid.uuid4())


# ── 단위 ───────────────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_merge_approve_advances_story_to_done():
    story = SimpleNamespace(status="in-review")
    session = AsyncMock()
    session.get = AsyncMock(return_value=story)
    await _advance_story_on_merge_approve(session, _gate("merge"), "approved")
    assert story.status == "done"  # approve → done 진행.


@pytest.mark.anyio
async def test_reject_keeps_status():
    session = AsyncMock()
    session.get = AsyncMock()
    await _advance_story_on_merge_approve(session, _gate("merge"), "rejected")
    session.get.assert_not_awaited()  # reject → 진행 안 함(in-review 유지).


@pytest.mark.anyio
async def test_non_merge_gate_no_advance():
    session = AsyncMock()
    session.get = AsyncMock()
    await _advance_story_on_merge_approve(session, _gate("qa"), "approved")
    session.get.assert_not_awaited()  # 비-merge 게이트는 미진행.


@pytest.mark.anyio
async def test_already_done_noop():
    story = SimpleNamespace(status="done")
    session = AsyncMock()
    session.get = AsyncMock(return_value=story)
    await _advance_story_on_merge_approve(session, _gate("merge"), "approved")
    assert story.status == "done"  # 멱등 no-op.


@pytest.mark.anyio
async def test_non_story_workitem_no_advance():
    session = AsyncMock()
    session.get = AsyncMock()
    await _advance_story_on_merge_approve(session, _gate("merge", work_item_type="epic"), "approved")
    session.get.assert_not_awaited()


# ── 실DB E2E: transition_gate(approve) → 스토리 done 도달 ──────────────────────

@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
@pytest.mark.anyio
async def test_transition_approve_drives_story_done_real_db():
    from sqlalchemy import text as _text
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.core.database import Base
    import app.models  # noqa: F401
    from app.models.gate import Gate
    from app.models.participation import Participation, ParticipationRole
    from app.models.pm import Story
    from app.models.verdict import Verdict  # noqa: F401 — create_all 테이블 등록(S7 verdict 기록).
    from app.services.gate_service import transition_gate

    url = _REAL_DB_URL.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
        "postgresql://", "postgresql+asyncpg://"
    )
    engine = create_async_engine(url)
    org, project, story_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    member, role_id, resolver, gate_id = (uuid.uuid4() for _ in range(4))

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            await s.execute(_text("SET session_replication_role = replica"))
            s.add_all([
                ParticipationRole(id=role_id, org_id=org, key="implementation", label="구현", is_default=True),
                Story(id=story_id, org_id=org, project_id=project, title="S", status="in-review", story_points=3),
                Participation(id=uuid.uuid4(), org_id=org, story_id=story_id, member_id=member, role_id=role_id),
                Gate(id=gate_id, org_id=org, work_item_id=story_id, work_item_type="story",
                     gate_type="merge", status="pending"),
            ])
            await s.commit()

        async with Session() as s:
            await s.execute(_text("SET session_replication_role = replica"))
            await transition_gate(s, org, gate_id, "approved", resolver_id=resolver)
            await s.commit()

        async with Session() as s:
            status = (await s.execute(
                _text("SELECT status FROM stories WHERE id=:id"), {"id": story_id}
            )).scalar()
            # dogfood 갭 해소: 사람 approve만으로 스토리가 done에 도달(재시도/재평가 불요).
            assert status == "done", f"approve 후 스토리가 done이어야, got {status}"
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()
