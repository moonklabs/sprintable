"""E-DG S27: project_auth.resolve_project_relay_owner — sprint dispatch relay-owner SSOT.

우선순위(deterministic 단일 픽): ①project_access granted owner ②org_members owner ③org_members admin
④tie-break created_at ASC. 반환=canonical member id(team_members.id | org_members.id)·없으면 None.
member-SSOT(ad-hoc TeamMember.role 금지·agent-PO 도 relay)·가짜 fallback 금지.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from app.services.project_auth import resolve_project_relay_owner

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(raw SQL UNION/COALESCE)")


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _session():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from app.core.database import Base
    import app.models  # noqa: F401
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql://"):
        if url.startswith(prefix):
            url = "postgresql+asyncpg://" + url[len(prefix):]
            break
    engine = create_async_engine(url)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_project(s, org):
    from app.models.project import Project
    pid = uuid.uuid4()
    s.add(Project(id=pid, org_id=org, name="p"))
    await s.flush()
    return pid


def _t(base, mins):
    return base + timedelta(minutes=mins)


@pytest.mark.anyio
async def test_priority1_project_access_owner_wins():
    """project_access granted owner(member_id) > org owner. canonical=member_id 반환."""
    from app.models.project import OrgMember
    from app.models.project_access import ProjectAccess
    engine, Session = await _session()
    base = datetime(2026, 1, 1, tzinfo=timezone.utc)
    async with Session() as s:
        org = uuid.uuid4()
        pid = await _seed_project(s, org)
        pa_member = uuid.uuid4()
        org_owner = uuid.uuid4()
        # pa_member 가 org 에서 resolve 가능해야 ①가 유효(resolve_member_identity oracle).
        s.add(OrgMember(id=pa_member, org_id=org, user_id=uuid.uuid4(), role="member", created_at=base))
        s.add(OrgMember(id=org_owner, org_id=org, user_id=uuid.uuid4(), role="owner", created_at=base))
        s.add(ProjectAccess(id=uuid.uuid4(), project_id=pid, permission="granted", role="owner",
                            member_id=pa_member, created_at=base))
        await s.commit()
        got = await resolve_project_relay_owner(s, pid, org)
        assert got == pa_member  # ①가 ②를 이김
    await engine.dispose()


@pytest.mark.anyio
async def test_priority1_org_member_id_fallback_when_no_member_id():
    """pa.member_id 없고 org_member_id 있으면 org_member_id 반환(grant-only 휴먼)."""
    from app.models.project import OrgMember
    from app.models.project_access import ProjectAccess
    engine, Session = await _session()
    base = datetime(2026, 1, 1, tzinfo=timezone.utc)
    async with Session() as s:
        org = uuid.uuid4()
        pid = await _seed_project(s, org)
        om_id = uuid.uuid4()
        # project_access.org_member_id FK → org_members 선 시드(grant-only 휴먼·role=member).
        s.add(OrgMember(id=om_id, org_id=org, user_id=uuid.uuid4(), role="member", created_at=base))
        await s.flush()
        s.add(ProjectAccess(id=uuid.uuid4(), project_id=pid, permission="granted", role="owner",
                            org_member_id=om_id, created_at=base))
        await s.commit()
        assert await resolve_project_relay_owner(s, pid, org) == om_id
    await engine.dispose()


@pytest.mark.anyio
async def test_priority2_org_owner_when_no_project_access():
    from app.models.project import OrgMember
    engine, Session = await _session()
    base = datetime(2026, 1, 1, tzinfo=timezone.utc)
    async with Session() as s:
        org = uuid.uuid4()
        pid = await _seed_project(s, org)
        owner, admin = uuid.uuid4(), uuid.uuid4()
        s.add(OrgMember(id=admin, org_id=org, user_id=uuid.uuid4(), role="admin", created_at=base))
        s.add(OrgMember(id=owner, org_id=org, user_id=uuid.uuid4(), role="owner", created_at=_t(base, 5)))
        await s.commit()
        assert await resolve_project_relay_owner(s, pid, org) == owner  # ②owner > ③admin
    await engine.dispose()


@pytest.mark.anyio
async def test_priority3_org_admin_when_no_owner():
    from app.models.project import OrgMember
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        pid = await _seed_project(s, org)
        admin = uuid.uuid4()
        s.add(OrgMember(id=admin, org_id=org, user_id=uuid.uuid4(), role="admin",
                        created_at=datetime(2026, 1, 1, tzinfo=timezone.utc)))
        s.add(OrgMember(id=uuid.uuid4(), org_id=org, user_id=uuid.uuid4(), role="member",
                        created_at=datetime(2026, 1, 1, tzinfo=timezone.utc)))  # member=무자격
        await s.commit()
        assert await resolve_project_relay_owner(s, pid, org) == admin
    await engine.dispose()


@pytest.mark.anyio
async def test_none_when_no_owner_or_admin():
    """가짜 fallback 금지 — owner/admin 없으면 None(no_assignee 가시화)."""
    from app.models.project import OrgMember
    engine, Session = await _session()
    async with Session() as s:
        org = uuid.uuid4()
        pid = await _seed_project(s, org)
        s.add(OrgMember(id=uuid.uuid4(), org_id=org, user_id=uuid.uuid4(), role="member",
                        created_at=datetime(2026, 1, 1, tzinfo=timezone.utc)))
        await s.commit()
        assert await resolve_project_relay_owner(s, pid, org) is None
    await engine.dispose()


@pytest.mark.anyio
async def test_tiebreak_earliest_created_at():
    """동순위(pa owner 2명) → created_at ASC 결정적 단일 픽."""
    from app.models.project import OrgMember
    from app.models.project_access import ProjectAccess
    engine, Session = await _session()
    base = datetime(2026, 1, 1, tzinfo=timezone.utc)
    async with Session() as s:
        org = uuid.uuid4()
        pid = await _seed_project(s, org)
        early, late = uuid.uuid4(), uuid.uuid4()
        # 둘 다 resolve 가능해야 tie-break 가 의미(아니면 unresolvable skip).
        s.add(OrgMember(id=early, org_id=org, user_id=uuid.uuid4(), role="member", created_at=base))
        s.add(OrgMember(id=late, org_id=org, user_id=uuid.uuid4(), role="member", created_at=base))
        s.add(ProjectAccess(id=uuid.uuid4(), project_id=pid, permission="granted", role="owner",
                            member_id=late, created_at=_t(base, 10)))
        s.add(ProjectAccess(id=uuid.uuid4(), project_id=pid, permission="granted", role="owner",
                            member_id=early, created_at=base))
        await s.commit()
        assert await resolve_project_relay_owner(s, pid, org) == early
    await engine.dispose()


@pytest.mark.anyio
async def test_orphan_pa_owner_falls_through_to_org_floor():
    """⚠️S27 QA 블로커: stale/orphan project_access owner(org resolve 불가)는 skip 하고 org owner
    floor 로 fallthrough — 데이터 드리프트가 floor 가드를 무력화 못 함."""
    from app.models.project import OrgMember
    from app.models.project_access import ProjectAccess
    engine, Session = await _session()
    base = datetime(2026, 1, 1, tzinfo=timezone.utc)
    async with Session() as s:
        org = uuid.uuid4()
        pid = await _seed_project(s, org)
        orphan = uuid.uuid4()   # project_access owner 지만 org 에 member 행 없음(stale/cross-org)
        org_owner = uuid.uuid4()
        s.add(OrgMember(id=org_owner, org_id=org, user_id=uuid.uuid4(), role="owner", created_at=base))
        s.add(ProjectAccess(id=uuid.uuid4(), project_id=pid, permission="granted", role="owner",
                            member_id=orphan, created_at=base))
        await s.commit()
        got = await resolve_project_relay_owner(s, pid, org)
        assert got == org_owner  # orphan ① skip → ② org owner 로 fallthrough
    await engine.dispose()


@pytest.mark.anyio
async def test_crossorg_pa_owner_falls_through_to_org_floor():
    """⚠️S27 QA(산티아고): cross-org project_access owner(다른 org 멤버)는 this-org resolve 실패 →
    skip → org owner floor 승계. resolve_member_identity 가 org_id 스코프라 cross-org id 는 None."""
    from app.models.project import OrgMember
    from app.models.project_access import ProjectAccess
    engine, Session = await _session()
    base = datetime(2026, 1, 1, tzinfo=timezone.utc)
    async with Session() as s:
        org, other_org = uuid.uuid4(), uuid.uuid4()
        pid = await _seed_project(s, org)
        cross = uuid.uuid4()    # 다른 org 의 멤버 — this-org 에선 resolve 불가
        org_owner = uuid.uuid4()
        s.add(OrgMember(id=cross, org_id=other_org, user_id=uuid.uuid4(), role="owner", created_at=base))
        s.add(OrgMember(id=org_owner, org_id=org, user_id=uuid.uuid4(), role="owner", created_at=base))
        s.add(ProjectAccess(id=uuid.uuid4(), project_id=pid, permission="granted", role="owner",
                            member_id=cross, created_at=base))
        await s.commit()
        assert await resolve_project_relay_owner(s, pid, org) == org_owner  # cross ① skip → ② floor
    await engine.dispose()


@pytest.mark.anyio
async def test_org_scoped_other_org_ignored():
    """다른 org 의 owner 는 무시(org 가드)."""
    from app.models.project import OrgMember
    engine, Session = await _session()
    async with Session() as s:
        org, other = uuid.uuid4(), uuid.uuid4()
        pid = await _seed_project(s, org)
        s.add(OrgMember(id=uuid.uuid4(), org_id=other, user_id=uuid.uuid4(), role="owner",
                        created_at=datetime(2026, 1, 1, tzinfo=timezone.utc)))
        await s.commit()
        assert await resolve_project_relay_owner(s, pid, org) is None
    await engine.dispose()
