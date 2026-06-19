"""E-DG S6: gate transition hook → generic line resolution 테스트.

핵심: find_active_step_run_for_gate(gate→step_run)·apply_workflow_line_resolution(approve+
apply_transition→to_status+emit / no-apply·stale·reject→미적용 / row lock·idempotent) ·
emit_story_status_changed = H1 동일 경로.
"""
from __future__ import annotations

import os
import uuid
from unittest.mock import AsyncMock, patch

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _session():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from app.core.database import Base
    import app.models  # noqa: F401
    import app.models.workflow_line  # noqa: F401
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            url = "postgresql+asyncpg://" + url[len(prefix):]
            break
    engine = create_async_engine(url)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed(s, org, *, apply_transition=True, story_status="in-review",
                from_status="in-review", to_status="done", gate_id=None, run_status="waiting_gate"):
    from app.models.project import Project
    from app.models.pm import Story
    from app.models.workflow_line import (
        WorkflowLineDefinition, WorkflowLineDefinitionVersion, WorkflowLineStepRun,
    )
    proj = uuid.uuid4()
    s.add(Project(id=proj, org_id=org, name="p")); await s.flush()
    defn = WorkflowLineDefinition(org_id=org, project_id=None, entity_type="story",
                                  name="L", is_active=True, version=1)
    s.add(defn); await s.flush()
    s.add(WorkflowLineDefinitionVersion(
        line_definition_id=defn.id, org_id=org, project_id=None, entity_type="story", version=1,
        status="published", config_hash="h", created_by_member_id=uuid.uuid4(),
        config={"rollout_mode": "enforcing", "steps": [{
            "from_status": from_status, "to_status": to_status, "step_type": "merge-gate",
            "on_approve": {"apply_transition": apply_transition}}]}))
    story = Story(org_id=org, project_id=proj, title="t", status=story_status, priority="high")
    s.add(story); await s.flush()
    sr = WorkflowLineStepRun(
        org_id=org, project_id=proj, line_definition_id=defn.id, entity_type="story",
        entity_id=story.id, from_status=from_status, to_status=to_status, status=run_status,
        mode="gate_pending", gate_id=gate_id or uuid.uuid4(), h1_gate_id=gate_id,
        correlation_id=uuid.uuid4(), transition_id=uuid.uuid4().hex)
    s.add(sr); await s.flush()
    return defn, story, sr


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_find_active_step_run_for_gate():
    from app.services.workflow_line_resolution import find_active_step_run_for_gate
    engine, Session = await _session()
    async with Session() as s:
        org, gid = uuid.uuid4(), uuid.uuid4()
        _, _, sr = await _seed(s, org, gate_id=gid)
        assert await find_active_step_run_for_gate(s, org, gid) == sr.id
        assert await find_active_step_run_for_gate(s, org, uuid.uuid4()) is None  # 다른 gate
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_apply_approve_with_apply_transition_advances_story():
    from app.services.workflow_line_resolution import apply_workflow_line_resolution
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        _, story, sr = await _seed(s, org, apply_transition=True)
        with patch("app.services.story_status_events.emit_story_status_changed",
                   new=AsyncMock()) as emit:
            await apply_workflow_line_resolution(s, sr.id, "approved", resolver_id=uuid.uuid4())
        await s.refresh(story); await s.refresh(sr)
        assert story.status == "done" and sr.status == "applied"
        assert emit.await_count == 1  # H1 동일 side-effect 경로
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_apply_approve_without_apply_transition_no_status_change():
    from app.services.workflow_line_resolution import apply_workflow_line_resolution
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        _, story, sr = await _seed(s, org, apply_transition=False)
        with patch("app.services.story_status_events.emit_story_status_changed",
                   new=AsyncMock()) as emit:
            await apply_workflow_line_resolution(s, sr.id, "approved")
        await s.refresh(story); await s.refresh(sr)
        assert story.status == "in-review" and sr.status == "approved"
        assert emit.await_count == 0  # apply_transition=false → status 변경 안 함(AC⑤)
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_apply_stale_from_status_skipped():
    from app.services.workflow_line_resolution import apply_workflow_line_resolution
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        # story 가 이미 다른 status(done)로 이동 → from_status(in-review) stale → 미적용(P1-1).
        _, story, sr = await _seed(s, org, apply_transition=True, story_status="done")
        with patch("app.services.story_status_events.emit_story_status_changed", new=AsyncMock()) as emit:
            await apply_workflow_line_resolution(s, sr.id, "approved")
        await s.refresh(sr)
        # to_status==done == story.status → 이미 목표(멱등 applied)·emit 0. stale 케이스 별도 검증:
        assert sr.status == "applied" and emit.await_count == 0
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_apply_stale_when_moved_elsewhere():
    from app.services.workflow_line_resolution import apply_workflow_line_resolution
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        # from=in-review, to=done 인데 story 가 backlog 로 이동 → stale → skipped.
        _, story, sr = await _seed(s, org, apply_transition=True, story_status="backlog")
        with patch("app.services.story_status_events.emit_story_status_changed", new=AsyncMock()) as emit:
            await apply_workflow_line_resolution(s, sr.id, "approved")
        await s.refresh(story); await s.refresh(sr)
        assert story.status == "backlog" and sr.status == "skipped" and emit.await_count == 0
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_apply_reject_keeps_in_review():
    from app.services.workflow_line_resolution import apply_workflow_line_resolution
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        _, story, sr = await _seed(s, org, apply_transition=True)
        with patch("app.services.story_status_events.emit_story_status_changed", new=AsyncMock()) as emit:
            await apply_workflow_line_resolution(s, sr.id, "rejected")
        await s.refresh(story); await s.refresh(sr)
        assert story.status == "in-review" and sr.status == "rejected"  # Phase1 reject=in-review 유지
        assert emit.await_count == 0
    await engine.dispose()
