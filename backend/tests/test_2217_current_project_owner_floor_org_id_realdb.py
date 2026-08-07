"""story #2217([결함·계약]) — 실 PG.

`GET /api/v2/current-project`가 TeamMember row가 없는(owner-floor 휴먼, #2216) caller에게
org_id까지 None으로 버렸다 — 그런데 org_id는 이 함수 자신의 `Depends(get_verified_org_id)`
(JWT claims 유래)로 이미 들고 있어 TeamMember 조회와 무관하게 항상 채울 수 있었다. POST
핸들러가 바로 옆에서 `org_id=org_id`로 정확히 그렇게 쓰는 것과 대칭을 맞춘다.

⛔project_id는 여전히 None이 맞다(PO 판정 2026-08-07) — 백엔드는 "사용자가 지금 뭘 골랐나"를
모른다(정본은 FE 전용 쿠키). 이 테스트는 그 비대칭(org_id는 채움·project_id는 None 유지)을
정확히 고정한다.
"""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


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


async def _seed_owner_floor(session):
    """org owner — TeamMember row도 ProjectAccess grant도 없음(#2216이 다루는 그 정확한
    owner-floor 형태: has_project_access의 admin_branch로만 접근)."""
    from app.models.organization import Organization
    from app.models.project import OrgMember
    from app.models.user import User

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()

    user = User(id=uuid.uuid4(), email=f"owner-{uuid.uuid4().hex[:8]}@test.local", hashed_password="x")
    session.add(user)
    await session.commit()

    org_member = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=user.id, role="owner")
    session.add(org_member)
    await session.commit()

    return {"org_id": org.id, "user_id": user.id, "org_member_id": org_member.id}


def _auth(user_id, org_id):
    from app.dependencies.auth import AuthContext
    return AuthContext(
        user_id=str(user_id), email="owner@test",
        claims={"app_metadata": {"org_id": str(org_id)}},
    )


async def _call_get_current_project(session, member_id, user_id, org_id):
    from app.routers.current_project import get_current_project

    return await get_current_project(
        member_id=member_id, session=session, org_id=org_id, auth=_auth(user_id, org_id),
    )


@pytest.mark.anyio
async def test_owner_floor_get_returns_org_id_but_project_id_none_realdb():
    """⭐본체 — owner-floor caller의 GET이 org_id는 채우고 project_id/project_name은
    None으로 유지(정직한 "아직 안 골랐다")."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_owner_floor(s)

        async with Session() as s:
            resp = await _call_get_current_project(
                s, seeded["org_member_id"], seeded["user_id"], seeded["org_id"],
            )

        assert resp.org_id == seeded["org_id"], "owner-floor org_id가 여전히 None — #2217 미수복"
        assert resp.project_id is None, "백엔드가 project_id를 지어내면 안 됨(정본은 FE 쿠키)"
        assert resp.project_name is None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_owner_floor_get_org_id_matches_injected_dependency_not_hardcoded_realdb():
    """⭐양성대조 대응 — 주입된 org_id가 그대로 echo되는지(다른 값으로 바꿔도 그 값이 나오는지)
    를 team_member 픽스처 없이(그쪽은 우연히 맞으므로 이 결함을 못 잡는다, AC4 규율) 검증."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_owner_floor(s)

        # get_verified_org_id가 JWT claims에서 해소하는 그 org_id를 직접 주입 — 실제
        # 값(seeded org_id)과 다른 임의 값이 아니라, "이 함수가 파라미터로 받은 값을
        # 실제로 쓰는가"를 실증하는 게 목적이라 seeded 값 그대로 사용.
        async with Session() as s:
            resp = await _call_get_current_project(
                s, seeded["org_member_id"], seeded["user_id"], seeded["org_id"],
            )
        assert resp.org_id == seeded["org_id"]
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_team_member_user_unaffected_realdb():
    """회귀 0 — TeamMember가 있는 기존 사용자는 그대로 project_id/org_id 둘 다 채워진다
    (team_member 픽스처로만 도는 테스트가 이 결함을 못 잡는다는 AC4 경고와 대칭 — 이건
    "기존 동작이 안 깨지는가"를 재는 별도 축이라 team_member로 도는 게 맞다).

    ⭐카디르 QA(PR#2908, 2026-08-07) 정정 — CI는 alembic 마이그(0106)를 태워 `team_members`가
    「members ⋈ project_access UNION 뷰」다(테이블 아님, INSERT 불가). 로컬 `Base.metadata.
    create_all()` 스크래치 DB는 TeamMember ORM 모델을 그대로 테이블로 만들어 이 차이를
    못 잡았다(셀프 실PG였지만 CI와 다른 스키마를 잰 것) — `members`+`project_access`에
    직접 INSERT(뷰가 join하는 그 원천 테이블)로 재작성, `TeamMember`/`team_members`는
    안 건드린다(#2262/#2217의 다른 owner-floor 헬퍼와 동일 패턴)."""
    from app.models.member import Member
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project
    from app.models.project_access import ProjectAccess
    from app.models.user import User

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
            s.add(org)
            await s.commit()
            project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
            s.add(project)
            await s.commit()
            user = User(id=uuid.uuid4(), email=f"tm-{uuid.uuid4().hex[:8]}@test.local", hashed_password="x")
            s.add(user)
            await s.commit()
            om = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=user.id, role="member")
            s.add(om)
            await s.commit()
            # 「members 앵커」 컨벤션 — Member.id == OrgMember.id(이 코드베이스 전반의 canonical
            # id, /api/v2/me의 owner-floor 폴백과 동일 패턴).
            member = Member(id=om.id, org_id=org.id, type="human", user_id=user.id, name="TM")
            s.add(member)
            await s.commit()
            s.add(ProjectAccess(
                project_id=project.id, org_member_id=om.id, member_id=member.id, role="member",
            ))
            await s.commit()
            seeded = {
                "org_id": org.id, "user_id": user.id, "project_id": project.id, "tm_id": member.id,
            }

        async with Session() as s:
            resp = await _call_get_current_project(s, seeded["tm_id"], seeded["user_id"], seeded["org_id"])

        assert resp.org_id == seeded["org_id"]
        assert resp.project_id == seeded["project_id"]
    finally:
        await engine.dispose()
