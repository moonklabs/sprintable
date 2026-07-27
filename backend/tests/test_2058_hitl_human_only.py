"""story #2058[보안·critical]: HITL 승인 경로 human-only 불변식.

배경: `gates.py::transition_gate_endpoint`는 `resolved.type != "human"`이면 403으로 막는데,
`hitl.py::resolve_hitl_request`(HitlRequest 승인/거부 — 같은 승인 병목의 다른 절반)엔 그 불변식이
없었다. legacy write-scope를 가진 agent 키라면 **자기 것이 아닌 남의 gate_approval 요청**도
승인/거부할 수 있었다(GATE_SELF_APPROVAL은 self 조합만 막는다).

AC1: resolve_hitl_request에 gates.py와 동형인 human-only 강제.
AC2: 회귀 — agent(write scope)는 거부, human은 통과. 특히 **타인의 요청을 승인하는 조합**(자기승인
   방어로는 안 잡히는 조합)을 명시적으로 재현.
AC5②: is_org_owner_or_admin/is_org_owner 헬퍼 자체에 "agent가 org_members에 있으면 거부" 불변식을
   명시(NOT EXISTS members.type='agent') — 6개 암묵-의존 콜사이트(void/hold/unhold/reassign/
   override/workflow_line_config approve·reject)는 개별 수정하지 않고 이 헬퍼가 지키면 전부 지켜짐.
   에이전트 신원이 org_members에 (가정상) 올라간 상황을 직접 시뮬레이션해 헬퍼가 여전히 거부하는지
   실증한다.
"""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

# story 8236bbc3 가드 대응 — 아래 _session_factory()가 Base.metadata.create_all을 호출하므로
# destructive_schema 마커 필수(누락 시 collection에서 pytest.UsageError로 즉시 표면화된다).
pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
    pytest.mark.destructive_schema,
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

    import app.models  # noqa: F401 — 전 모델 메타데이터 로드
    from app.core.database import Base

    # ⚠️fix(발견 2026-07-20, #2043 AC3 작업 중): 이 함수가 create_all을 호출하지 않고 있었다 —
    # 자매 realdb 파일(test_2027/test_2054/test_2058_apikey 등)과 달리 스키마를 자체적으로
    # 짓지 않는 결함. conftest.py의 destructive_schema autouse 픽스처가 대상 스키마를 DROP까지
    # 하므로(9108cb4f), 사전에 별도로 alembic upgrade head를 돌려둔 DB를 우연히 가리킬 때만
    # 통과하고 순수 신규 DB에서는 "relation organizations does not exist"로 실패하는 잠복
    # 결함이었다(#2058 병합 후 처음 신규 DB로 재현하다 발견).
    engine = create_async_engine(_async_url())
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


def _request(path: str, method: str):
    from unittest.mock import MagicMock
    req = MagicMock()
    req.headers.get = lambda key, default=None: default
    req.method = method
    req.url.path = path
    return req


def _agent_auth(agent_id: uuid.UUID, org_id: uuid.UUID, project_id: uuid.UUID, *, scope: list[str]):
    from app.dependencies.auth import AuthContext
    return AuthContext(
        user_id=str(agent_id), email=None,
        claims={"app_metadata": {
            "org_id": str(org_id), "project_id": str(project_id),
            "api_key_id": str(uuid.uuid4()), "scope": scope,
        }},
        org_id=str(org_id),
    )


def _human_auth(user_id: uuid.UUID, org_id: uuid.UUID, project_id: uuid.UUID):
    from app.dependencies.auth import AuthContext
    return AuthContext(
        user_id=str(user_id), email="h@test.com",
        claims={"app_metadata": {"org_id": str(org_id), "project_id": str(project_id)}},
        org_id=str(org_id),
    )


async def _seed_org_project(session):
    from app.models.organization import Organization
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    return org.id, project.id


async def _seed_agent(session, org_id, project_id):
    from app.models.member import Member
    from app.models.project_access import ProjectAccess

    agent = Member(id=uuid.uuid4(), org_id=org_id, type="agent", name="Agent")
    session.add(agent)
    await session.commit()
    session.add(ProjectAccess(id=uuid.uuid4(), project_id=project_id, member_id=agent.id, permission="granted"))
    await session.commit()
    return agent.id


async def _seed_human(session, org_id, project_id, *, role="member"):
    from app.models.project import OrgMember
    from app.models.project_access import ProjectAccess
    from app.models.user import User

    user = User(id=uuid.uuid4(), email=f"u-{uuid.uuid4().hex[:8]}@test.com", hashed_password="x")
    session.add(user)
    await session.commit()
    om = OrgMember(id=uuid.uuid4(), org_id=org_id, user_id=user.id, role=role)
    session.add(om)
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project_id, org_member_id=om.id, permission="granted", role="member",
    ))
    await session.commit()
    return user.id, om.id


async def _seed_hitl_request(session, org_id, project_id, requester_agent_id, *, requested_for=None):
    from app.models.hitl import HitlRequest
    req = HitlRequest(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, agent_id=requester_agent_id,
        request_type="gate_approval", title="t", prompt="p",
        requested_for=requested_for or requester_agent_id, status="pending",
    )
    session.add(req)
    await session.commit()
    return req.id


# ── AC1/AC2: human-only 게이트 — 특히 "타인의 요청 승인"(self-approval 방어로는 안 잡히는 조합) ──


@pytest.mark.anyio
async def test_agent_cannot_approve_another_agents_request():
    """이게 #2058의 headline 재현 — 자기 것이 아닌 요청도 agent가 승인 가능했던 결함.

    ⚠️`resolve_member`(auth.user_id → identity)의 agent 분기는 레거시 경로에서 `team_members`
    **VIEW**를 조회한다(migrated DB 전용 — `Base.metadata.create_all`은 뷰를 못 짓는다,
    reference_realdb_seed_gotchas 선례). 이 테스트가 검증하는 대상은 `resolve_hitl_request`의
    `resolved.type != "human"` 강제 그 자체이지 identity 해소 내부 배관이 아니므로, 이 한 지점만
    mock으로 agent 신원을 직접 주입한다(다른 테스트들처럼 정공법 DB 시드가 안 되는 유일한 이유가
    VIEW 의존이라 예외적으로)."""
    from unittest.mock import AsyncMock, patch

    from app.repositories.hitl import HitlRepository
    from app.routers.hitl import resolve_hitl_request
    from app.schemas.hitl import ResolveHitlRequestBody
    from app.services.member_resolver import ResolvedMember

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            requester_agent_id = await _seed_agent(s, org_id, project_id)
            approver_agent_id = await _seed_agent(s, org_id, project_id)  # 타 에이전트(다른 identity)
            req_id = await _seed_hitl_request(s, org_id, project_id, requester_agent_id)

        async with Session() as s:
            approver_resolved = ResolvedMember(
                id=approver_agent_id, user_id=None, name="Approver Agent", type="agent",
                role="member", org_id=org_id, project_id=project_id,
            )
            with patch(
                "app.routers.hitl.resolve_member", AsyncMock(return_value=approver_resolved),
            ):
                resp = await resolve_hitl_request(
                    request_id=req_id,
                    body=ResolveHitlRequestBody(status="approved"),
                    request=_request("/api/v2/hitl/requests/x", "PATCH"),
                    auth=_agent_auth(approver_agent_id, org_id, project_id, scope=["read", "write"]),
                    repo=HitlRepository(s),
                )
            assert resp.status_code == 403, resp.body
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_human_can_approve_agents_request():
    from app.repositories.hitl import HitlRepository
    from app.routers.hitl import resolve_hitl_request
    from app.schemas.hitl import ResolveHitlRequestBody

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            requester_agent_id = await _seed_agent(s, org_id, project_id)
            user_id, _ = await _seed_human(s, org_id, project_id)
            req_id = await _seed_hitl_request(s, org_id, project_id, requester_agent_id)

        async with Session() as s:
            resp = await resolve_hitl_request(
                request_id=req_id,
                body=ResolveHitlRequestBody(status="approved"),
                request=_request("/api/v2/hitl/requests/x", "PATCH"),
                auth=_human_auth(user_id, org_id, project_id),
                repo=HitlRepository(s),
            )
            assert resp.status_code == 200, resp.body
    finally:
        await engine.dispose()


# ── AC5②: is_org_owner_or_admin/is_org_owner 헬퍼 자체의 명시 불변식 ──────────────


@pytest.mark.anyio
async def test_is_org_owner_or_admin_rejects_agent_even_if_somehow_in_org_members():
    """org_members에 agent 소유 user_id가 owner/admin role로 (가정상) 올라간 상황을 직접
    시뮬레이션 — 헬퍼가 여전히 False를 내야 한다(#2058 AC5② — 개별 6곳 대신 이 헬퍼가 봉인)."""
    from app.models.member import Member
    from app.models.organization import Organization
    from app.models.project import OrgMember
    from app.models.user import User
    from app.services.project_auth import is_org_owner, is_org_owner_or_admin

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
            s.add(org)
            await s.commit()
            # agent를 만들되, 같은 user_id로 org_members에도(가정상 침투) owner row를 만든다 —
            # 정상 경로로는 절대 안 생기는 조합을 직접 구성해 헬퍼의 명시 불변식만 단독 실증.
            fake_user_id = uuid.uuid4()
            user = User(id=fake_user_id, email=f"agent-user-{uuid.uuid4().hex[:8]}@test.com", hashed_password="x")
            s.add(user)
            await s.commit()
            agent = Member(id=uuid.uuid4(), org_id=org.id, type="agent", user_id=fake_user_id, name="Agent")
            s.add(agent)
            om = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=fake_user_id, role="owner")
            s.add(om)
            await s.commit()

            assert await is_org_owner_or_admin(s, fake_user_id, org.id) is False
            assert await is_org_owner(s, fake_user_id, org.id) is False
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_is_org_owner_or_admin_human_owner_unaffected_no_regression():
    """정상 human owner/admin은 이 NOT EXISTS 가드로 회귀 없음(members 행이 아예 없는 human도 통과 —
    members-sync 갭 선례 고려해 members row 존재를 요구하지 않는다)."""
    from app.models.organization import Organization
    from app.models.project import OrgMember
    from app.models.user import User
    from app.services.project_auth import is_org_owner, is_org_owner_or_admin

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
            s.add(org)
            await s.commit()
            user = User(id=uuid.uuid4(), email=f"owner-{uuid.uuid4().hex[:8]}@test.com", hashed_password="x")
            s.add(user)
            await s.commit()
            om = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=user.id, role="owner")
            s.add(om)
            await s.commit()

            # members 테이블에 이 human의 row가 전혀 없다(멤버싱크 갭 시뮬레이션) — 그래도 통과해야 함.
            assert await is_org_owner_or_admin(s, user.id, org.id) is True
            assert await is_org_owner(s, user.id, org.id) is True
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_is_org_owner_or_admin_human_member_role_still_false_no_regression():
    from app.models.organization import Organization
    from app.models.project import OrgMember
    from app.models.user import User
    from app.services.project_auth import is_org_owner_or_admin

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
            s.add(org)
            await s.commit()
            user = User(id=uuid.uuid4(), email=f"member-{uuid.uuid4().hex[:8]}@test.com", hashed_password="x")
            s.add(user)
            await s.commit()
            om = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=user.id, role="member")
            s.add(om)
            await s.commit()

            assert await is_org_owner_or_admin(s, user.id, org.id) is False
    finally:
        await engine.dispose()
