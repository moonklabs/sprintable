"""[에이전트 관리 IA·Phase 2] GET /api/v2/agents/access-matrix 실 Postgres 검증 (story da4c6b2d).

PO crux 승인조건 실측: (1) 휴먼 grant도 project_access.member_id를 미러 세팅하므로
members JOIN type='agent'로 명시 격리해야 함 — 섞이면 회귀. (2) org 스코프(타org 누출 금지).
(3) org admin/owner만 통과(403 회귀 가드).
"""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = pytest.mark.destructive_schema


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _session():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from app.core.database import Base
    import app.models  # noqa: F401

    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            url = "postgresql+asyncpg://" + url[len(prefix):]
            break
    engine = create_async_engine(url)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_org_project(session, *, admin_user_id: uuid.UUID) -> tuple[uuid.UUID, uuid.UUID]:
    """org + project + org_members(admin) 시드(ORM — 모델 default 활용) — is_org_owner_or_admin 통과용."""
    from sqlalchemy import text as _text
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project

    org_id, project_id = uuid.uuid4(), uuid.uuid4()
    await session.execute(_text("SET session_replication_role = replica"))
    session.add(Organization(id=org_id, name="x", slug=f"x-{org_id}"))
    session.add(Project(id=project_id, org_id=org_id, name="p"))
    session.add(OrgMember(id=uuid.uuid4(), org_id=org_id, user_id=admin_user_id, role="admin"))
    await session.flush()
    await session.commit()
    return org_id, project_id


async def _seed_agent_grant(session, *, org_id, project_id, name="agent"):
    from app.models.member import Member
    from app.models.project_access import ProjectAccess

    agent = Member(id=uuid.uuid4(), org_id=org_id, type="agent", name=name, is_active=True)
    session.add(agent)
    await session.flush()
    record = ProjectAccess(project_id=project_id, member_id=agent.id, org_member_id=None, permission="granted")
    session.add(record)
    await session.flush()
    await session.commit()
    return agent, record


async def _seed_human_grant(session, *, org_id, project_id):
    """휴먼 grant — project_access.py 실 동작 재현: member_id도 org_member.id로 미러 세팅."""
    from app.models.member import Member
    from app.models.project_access import ProjectAccess

    human_member = Member(id=uuid.uuid4(), org_id=org_id, type="human", name="human", is_active=True)
    session.add(human_member)
    await session.flush()
    record = ProjectAccess(
        project_id=project_id, org_member_id=human_member.id, member_id=human_member.id, permission="granted",
    )
    session.add(record)
    await session.flush()
    await session.commit()
    return human_member, record


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
@pytest.mark.anyio
async def test_access_matrix_isolates_agents_from_humans():
    """승인조건 #1: member_id IS NOT NULL만으론 휴먼이 섞임 — type='agent' 명시 격리 검증."""
    from unittest.mock import MagicMock
    from sqlalchemy import text as _text
    from app.core.database import Base
    from app.routers.agents import get_agent_access_matrix

    engine, Session = await _session()
    try:
        admin_user_id = uuid.uuid4()
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s, admin_user_id=admin_user_id)
            agent, agent_record = await _seed_agent_grant(s, org_id=org_id, project_id=project_id)
            await _seed_human_grant(s, org_id=org_id, project_id=project_id)

        async with Session() as s:
            await s.execute(_text("SET session_replication_role = replica"))
            auth = MagicMock(user_id=str(admin_user_id))
            out = await get_agent_access_matrix(session=s, auth=auth, org_id=org_id)

        assert len(out) == 1, f"휴먼 grant 섞임 — {out}"
        assert out[0]["agent_member_id"] == str(agent.id)
        assert out[0]["project_id"] == str(project_id)
        assert out[0]["record_id"] == str(agent_record.id)
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
@pytest.mark.anyio
async def test_access_matrix_scoped_to_caller_org():
    """승인조건 #2: 타org grant 누출 금지 — org_id는 get_verified_org_id로 caller org 고정."""
    from unittest.mock import MagicMock
    from sqlalchemy import text as _text
    from app.core.database import Base
    from app.routers.agents import get_agent_access_matrix

    engine, Session = await _session()
    try:
        admin_user_id = uuid.uuid4()
        async with Session() as s:
            org_a, project_a = await _seed_org_project(s, admin_user_id=admin_user_id)
            await _seed_agent_grant(s, org_id=org_a, project_id=project_a, name="agent-a")
            # 타 org — admin 은 org_a 에만 admin (org_members 별도 재확認 안 함, org_id 스코프만 검증)
            org_b, project_b = await _seed_org_project(s, admin_user_id=uuid.uuid4())
            await _seed_agent_grant(s, org_id=org_b, project_id=project_b, name="agent-b")

        async with Session() as s:
            await s.execute(_text("SET session_replication_role = replica"))
            auth = MagicMock(user_id=str(admin_user_id))
            out = await get_agent_access_matrix(session=s, auth=auth, org_id=org_a)

        assert len(out) == 1
        assert out[0]["project_id"] == str(project_a)
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
@pytest.mark.anyio
async def test_access_matrix_403_for_non_admin():
    """승인조건 #2: org admin/owner 아니면 403(member role)."""
    from unittest.mock import MagicMock
    from fastapi import HTTPException
    from sqlalchemy import text as _text
    from app.core.database import Base
    from app.routers.agents import get_agent_access_matrix

    engine, Session = await _session()
    try:
        admin_user_id = uuid.uuid4()
        member_user_id = uuid.uuid4()
        async with Session() as s:
            from app.models.project import OrgMember

            org_id, project_id = await _seed_org_project(s, admin_user_id=admin_user_id)
            await s.execute(_text("SET session_replication_role = replica"))
            s.add(OrgMember(id=uuid.uuid4(), org_id=org_id, user_id=member_user_id, role="member"))
            await s.flush()
            await s.commit()

        async with Session() as s:
            await s.execute(_text("SET session_replication_role = replica"))
            auth = MagicMock(user_id=str(member_user_id))
            with pytest.raises(HTTPException) as ei:
                await get_agent_access_matrix(session=s, auth=auth, org_id=org_id)
        assert ei.value.status_code == 403
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
@pytest.mark.anyio
async def test_access_matrix_empty_when_no_grants():
    from unittest.mock import MagicMock
    from sqlalchemy import text as _text
    from app.core.database import Base
    from app.routers.agents import get_agent_access_matrix

    engine, Session = await _session()
    try:
        admin_user_id = uuid.uuid4()
        async with Session() as s:
            org_id, _ = await _seed_org_project(s, admin_user_id=admin_user_id)

        async with Session() as s:
            await s.execute(_text("SET session_replication_role = replica"))
            auth = MagicMock(user_id=str(admin_user_id))
            out = await get_agent_access_matrix(session=s, auth=auth, org_id=org_id)
        assert out == []
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()
