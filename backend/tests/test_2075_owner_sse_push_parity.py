"""story #2075(2026-07-21) — org owner/admin이 명시 project_access 없이도 SSE push 수신자
집합에 포함되는지 실측(까심 아르야 코드 발견 + 댄 어윈 촬영 재현 + 선생님 실사용 케이스로 확定).

`project_accessible_member_ids`(SSE push 수신자 해소)가 `has_project_access`(보드 조회 인가)와
다른 판정을 내리던 자기모순을 닫는다 — owner는 볼 수 있는데 실시간 갱신은 안 오던 상태.
직접 함수 호출로 검증(gate approve 등 전체 파이프라인을 안 타서 story #2059/#2067 재검증에서
겪은 이중 이벤트 얽힘과 무관 — 순수 SQL 함수 단위 테스트)."""
from __future__ import annotations

import os
import uuid

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


async def _session_factory():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    engine = create_async_engine(_async_url())
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed(session):
    """org + project_a/project_b + owner(project_access 없음, org_members.role=owner) +
    member_a(project_a에 명시 project_access) + 다른 org의 owner_other(누설 대조군)."""
    from app.models.member import Member
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project
    from app.models.project_access import ProjectAccess
    from app.models.user import User

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    other_org = Organization(id=uuid.uuid4(), name="OtherOrg", slug=f"other-{uuid.uuid4().hex[:8]}")
    session.add_all([org, other_org])
    await session.commit()

    project_a = Project(id=uuid.uuid4(), org_id=org.id, name="A")
    session.add(project_a)
    await session.commit()

    owner_user = User(id=uuid.uuid4(), email=f"owner-{uuid.uuid4().hex[:8]}@test.local", hashed_password="x")
    other_owner_user = User(id=uuid.uuid4(), email=f"other-{uuid.uuid4().hex[:8]}@test.local", hashed_password="x")
    session.add_all([owner_user, other_owner_user])
    await session.commit()

    # owner는 members 행 자체가 없어도 된다(grant-only 휴먼) — org_members만으로 신원 해소되는
    # 케이스를 그대로 재현(story #2075가 닫으려는 정확히 그 시나리오).
    owner_org_member = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=owner_user.id, role="owner")
    other_owner_org_member = OrgMember(
        id=uuid.uuid4(), org_id=other_org.id, user_id=other_owner_user.id, role="owner",
    )
    session.add_all([owner_org_member, other_owner_org_member])
    await session.commit()

    member_a = Member(id=uuid.uuid4(), org_id=org.id, type="human", name="Member A")
    session.add(member_a)
    await session.commit()
    session.add(ProjectAccess(id=uuid.uuid4(), project_id=project_a.id, member_id=member_a.id, permission="granted"))
    await session.commit()

    return {
        "org_id": org.id, "project_a": project_a.id,
        "owner_org_member_id": owner_org_member.id,
        "other_owner_org_member_id": other_owner_org_member.id,
        "member_a": member_a.id,
    }


@pytest.mark.anyio
async def test_owner_without_explicit_project_access_is_included():
    """story #2075 핵심 — project_access 행이 아예 없는 org owner도 수신자 집합에 포함된다."""
    from app.services.project_auth import project_accessible_member_ids

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        async with Session() as s:
            result = await project_accessible_member_ids(s, seeded["org_id"], seeded["project_a"])
        assert seeded["owner_org_member_id"] in result, "org owner가 push 수신자 집합에서 빠짐(#2075 회귀)"
        assert seeded["member_a"] in result, "명시 project_access 멤버는 계속 포함돼야 함(무회귀)"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_other_org_owner_not_leaked_hard_gate():
    """하드 게이트 — 다른 org의 owner는 여전히 절대 포함되지 않는다(cross-org 누설 0)."""
    from app.services.project_auth import project_accessible_member_ids

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        async with Session() as s:
            result = await project_accessible_member_ids(s, seeded["org_id"], seeded["project_a"])
        assert seeded["other_owner_org_member_id"] not in result, "다른 org owner에게 누설됨(#2075 회귀)"
    finally:
        await engine.dispose()
