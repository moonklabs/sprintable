"""E-DG S16: dogfood default story line seed 테스트.

핵심: published definition+version 시드·기본 shadow·lint 통과·idempotent(재실행 0·config_hash).
"""
from __future__ import annotations

import os
import uuid

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


def test_default_config_passes_lint_and_is_shadow():
    from app.services.workflow_line_seed import DEFAULT_STORY_LINE_CONFIG
    from app.services.workflow_line_config import lint_config
    assert lint_config(DEFAULT_STORY_LINE_CONFIG) == []  # ④ valid config
    assert DEFAULT_STORY_LINE_CONFIG["rollout_mode"] == "shadow"  # ③ 기본 shadow
    # AC①: 3 transitions(dev relay·QA observe·merge-gate)
    steps = {(s["from_status"], s["to_status"]): s for s in DEFAULT_STORY_LINE_CONFIG["steps"]}
    assert steps[("backlog", "ready-for-dev")]["step_type"] == "agent-handoff"
    assert steps[("in-review", "done")]["step_type"] == "merge-gate"


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_seed_creates_published_definition_and_version():
    from app.services.workflow_line_seed import seed_default_story_line
    from app.models.workflow_line import WorkflowLineDefinition, WorkflowLineDefinitionVersion
    from sqlalchemy import select
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        r = await seed_default_story_line(s, org)
        assert r["status"] == "seeded" and r["rollout_mode"] == "shadow"
        defn = (await s.execute(select(WorkflowLineDefinition).where(
            WorkflowLineDefinition.org_id == org))).scalar_one()
        assert defn.is_active and defn.source == "system_default" and defn.entity_type == "story"
        ver = (await s.execute(select(WorkflowLineDefinitionVersion).where(
            WorkflowLineDefinitionVersion.org_id == org))).scalar_one()
        assert ver.status == "published" and ver.config_hash == r["config_hash"]
        assert ver.config["rollout_mode"] == "shadow"
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_seed_idempotent():
    from app.services.workflow_line_seed import seed_default_story_line
    from app.models.workflow_line import WorkflowLineDefinition
    from sqlalchemy import select, func
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        r1 = await seed_default_story_line(s, org)
        r2 = await seed_default_story_line(s, org)  # 재실행
        assert r1["status"] == "seeded" and r2["status"] == "already_seeded"
        n = (await s.execute(select(func.count()).select_from(WorkflowLineDefinition).where(
            WorkflowLineDefinition.org_id == org))).scalar()
        assert n == 1  # 중복 0
    await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_seed_rejects_invalid_config():
    from app.services.workflow_line_seed import seed_default_story_line
    engine, Session = await _session()
    async with Session() as s:
        # merge-gate 인데 approver 없음 → lint no_approver → seed 거부
        bad = {"rollout_mode": "shadow", "steps": [
            {"from_status": "in-review", "to_status": "done", "step_type": "merge-gate"}]}
        r = await seed_default_story_line(s, uuid.uuid4(), config=bad)
        assert r["status"] == "lint_failed" and r["errors"]
    await engine.dispose()
