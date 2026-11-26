"""story 5030 follow-up — the auth-failure record for a LEGACY key of an agent that belongs to two projects. Real PG.

`agent_auth_failure._classify` finds the organization of a key that has only `team_member_id` (no `member_id`; 557 of 6,652 keys on dev, 11-26) by reading `team_members` — a VIEW with one row per
project an agent has — with `scalar_one_or_none()`. For a two-project agent that raised `MultipleResultsFound`; `record_auth_failure` swallows it («never blocks the 401»), so the failure of such a key
(revoked · expired) was never written and no «auth failed» attention rose. Same cause as the 500 of `PUT /notification-preferences` (PR 5961).
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

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


async def _seed(s, *, projects: int):
    from app.models.api_key import ApiKey
    from app.models.member import Member
    from app.models.organization import Organization
    from app.models.project import Project
    from app.models.project_access import ProjectAccess

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    s.add(org)
    await s.commit()
    agent = Member(id=uuid.uuid4(), org_id=org.id, type="agent", name="A", is_active=True)
    s.add(agent)
    await s.commit()
    for i in range(projects):
        p = Project(id=uuid.uuid4(), org_id=org.id, name=f"P{i}")
        s.add(p)
        await s.commit()
        s.add(ProjectAccess(id=uuid.uuid4(), project_id=p.id, member_id=agent.id, permission="granted", role="member"))
        await s.commit()
    prefix = "sk_live_" + uuid.uuid4().hex[:8]
    # a LEGACY key: only `team_member_id`, no `member_id`
    key = ApiKey(
        id=uuid.uuid4(), team_member_id=agent.id, member_id=None, key_prefix=prefix, key_hash="x",
        revoked_at=datetime.now(timezone.utc) - timedelta(minutes=1),
    )
    s.add(key)
    await s.commit()
    return org, key, prefix


@pytest.mark.anyio
@pytest.mark.parametrize("projects", [1, 2])
async def test_a_legacy_key_of_an_agent_is_classified_whatever_its_number_of_projects(projects):
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.services.agent_auth_failure import _classify

    engine = create_async_engine(_async_url())
    try:
        Session = async_sessionmaker(engine, expire_on_commit=False)
        async with Session() as s:
            org, key, prefix = await _seed(s, projects=projects)
            reason, org_id, api_key_id, member_id = await _classify(s, prefix, datetime.now(timezone.utc))
        assert (reason, org_id, api_key_id, member_id) == ("revoked", org.id, key.id, None)
    finally:
        await engine.dispose()
