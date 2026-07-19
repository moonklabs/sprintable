"""Real-DB release check for the Advisor namespace reservation preflight."""
from __future__ import annotations

import os
import uuid

import pytest
from sqlalchemy import text

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")
pytestmark = [pytest.mark.skipif(not _REAL_DB_URL, reason="requires isolated migrated PostgreSQL")]


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _async_url():
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if _REAL_DB_URL.startswith(prefix):
            return "postgresql+asyncpg://" + _REAL_DB_URL[len(prefix):]
    return _REAL_DB_URL


async def _session_factory():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    engine = create_async_engine(_async_url())
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _collision_count(session, org_id):
    """Must remain semantically identical to scripts/check_advisor_p0_provenance.py."""
    return (await session.execute(text("""
        SELECT (SELECT count(*) FROM evidence WHERE org_id = :oid AND source LIKE 'advisor.%') +
               (SELECT count(*) FROM gate WHERE org_id = :oid AND neutral_facts IS NOT NULL
                 AND EXISTS (SELECT 1 FROM jsonb_object_keys(neutral_facts) k
                             WHERE k = 'advisor_origin' OR k LIKE 'advisor_%' OR k LIKE 'executor_advisor_%'))
    """), {"oid": org_id})).scalar_one()


@pytest.mark.anyio
async def test_provenance_preflight_passes_clean_org_and_fails_closed_on_both_reserved_collision_classes():
    from app.models.evidence import Evidence
    from app.models.gate import Gate
    from app.models.organization import Organization
    from app.models.pm import Story
    from app.models.project import Project

    engine, Session = await _session_factory()
    try:
        async with Session() as session:
            org = Organization(id=uuid.uuid4(), name="Advisor preflight", slug=f"advisor-preflight-{uuid.uuid4().hex[:12]}")
            session.add(org)
            await session.commit()
            assert await _collision_count(session, org.id) == 0

            project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
            session.add(project)
            await session.commit()
            story = Story(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="S", status="in-progress")
            session.add(story)
            await session.commit()
            session.add_all([
                Evidence(id=uuid.uuid4(), org_id=org.id, work_item_id=story.id, work_item_type="story",
                         type="report", ref="legacy", source="advisor.legacy_collision", note="{}", created_by=uuid.uuid4()),
                Gate(id=uuid.uuid4(), org_id=org.id, work_item_id=story.id, work_item_type="story",
                     gate_type="merge", status="pending", neutral_facts={"executor_advisor_legacy": True}),
            ])
            await session.commit()
            assert await _collision_count(session, org.id) == 2
    finally:
        await engine.dispose()
