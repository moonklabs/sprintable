"""E-SECURITY SEC HIGH baseline paydown round9 (최종) — #2050 ratchet _KNOWN_DEBT_ALLOWLIST
잔여 HIGH 1건 app.routers.members:list_members 상환. baseline HIGH 1→0(봉인 완결).

근본: 기존 가드 assert_target_in_caller_org는 cross-org IDOR만 404로 막고, 같은 org 안의
접근권 없는 project_id 주입(same-org cross-project)은 미검증이라 그 프로젝트의 휴먼+에이전트
로스터(name/role/email)가 그대로 열거됐다. project_id는 쿼리 파라미터 자체가 조회 대상이라
resource-actual has_project_access(session, user_id, project_id, org_id) 직접검증으로 봉인.
project_id가 유일 project-환원 벡터이며 EE RBAC 등 특수 훅이 없음을 그라운딩으로 확認
(round7 교훈 — diff 밖 side-effect 없음).

로스터는 휴먼+에이전트 PII 표면(name/email)이므로 네거티브 컨트롤은 상태코드(404)뿐 아니라
유출 대상 이름/이메일 문자열이 응답 바디에 verbatim 미노출까지 assert한다(동어반복 금지)."""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
]

# 유출 감시 대상 — project_b 로스터의 verbatim PII(응답 바디에 절대 나오면 안 됨). 에이전트
# 이름은 고정 상수(name 유니크 제약 없음). 휴먼 이메일은 ix_users_email 유니크 제약 때문에
# seed마다 uuid 접미로 고유화하되, seed dict로 실제 값을 반환해 그 실측 문자열로 assert한다.
_SECRET_AGENT_NAME = "TopSecretAgentB"


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


async def _seed(session):
    """org(project_a, project_b) 안에:
    - agent_a(project_a grant, name="Agent Alpha") — 회귀0 positive 확인용
    - secret_agent_b(project_b grant, name=_SECRET_AGENT_NAME) — 유출 감시 에이전트 로스터
    - secret_human_b(project_b grant, email=고유 topsecret-human-b-*) — 유출 감시 휴먼 로스터
    - caller_human(project_a에만 명시 grant·org role=member·project_b 접근권 없음) — 공격자/합법 caller
    - owner_human(org owner·grant 없이 org-wide 접근) — over-block 회귀 확인용
    team_members는 VIEW(members⋈project_access)라 에이전트는 Member + ProjectAccess(member_id)로 시드
    하면 list_members 에이전트 분기(TeamMember type=agent)에 노출된다(round2 패턴)."""
    from app.models.member import Member
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project
    from app.models.project_access import ProjectAccess
    from app.models.user import User

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()

    project_a = Project(id=uuid.uuid4(), org_id=org.id, name="Project A")
    project_b = Project(id=uuid.uuid4(), org_id=org.id, name="Project B")
    session.add_all([project_a, project_b])
    await session.commit()

    # project_a 에이전트(회귀0 positive) + project_b 시크릿 에이전트(유출 감시)
    agent_a = Member(id=uuid.uuid4(), org_id=org.id, type="agent", name="Agent Alpha")
    secret_agent_b = Member(id=uuid.uuid4(), org_id=org.id, type="agent", name=_SECRET_AGENT_NAME)
    session.add_all([agent_a, secret_agent_b])
    await session.commit()
    session.add_all([
        ProjectAccess(id=uuid.uuid4(), project_id=project_a.id, member_id=agent_a.id,
                      permission="granted", role="member"),
        ProjectAccess(id=uuid.uuid4(), project_id=project_b.id, member_id=secret_agent_b.id,
                      permission="granted", role="member"),
    ])
    await session.commit()

    # project_b 시크릿 휴먼(유출 감시) — org member + project_b grant.
    secret_human_id = uuid.uuid4()
    secret_human_email = f"topsecret-human-b-{secret_human_id.hex[:8]}@test.com"
    secret_human = User(id=secret_human_id, email=secret_human_email, hashed_password="x")
    session.add(secret_human)
    await session.commit()
    secret_human_om = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=secret_human_id, role="member")
    session.add(secret_human_om)
    await session.commit()
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project_b.id, org_member_id=secret_human_om.id,
        permission="granted", role="member",
    ))
    await session.commit()

    # caller: project_a에만 명시 grant — project_b 접근권 없음(org owner/admin도 아님).
    caller_id = uuid.uuid4()
    caller = User(id=caller_id, email=f"caller-{caller_id.hex[:8]}@test.com", hashed_password="x")
    session.add(caller)
    await session.commit()
    caller_om = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=caller_id, role="member")
    session.add(caller_om)
    await session.commit()
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project_a.id, org_member_id=caller_om.id,
        permission="granted", role="member",
    ))
    await session.commit()

    # owner: grant 없이 org-wide 접근(over-block 회귀 확인용).
    owner_id = uuid.uuid4()
    owner = User(id=owner_id, email=f"owner-{owner_id.hex[:8]}@test.com", hashed_password="x")
    session.add(owner)
    await session.commit()
    owner_om = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=owner_id, role="owner")
    session.add(owner_om)
    await session.commit()

    return {
        "org_id": org.id,
        "project_a_id": project_a.id,
        "project_b_id": project_b.id,
        "agent_a_id": agent_a.id,
        "secret_agent_b_id": secret_agent_b.id,
        "secret_human_email": secret_human_email,
        "caller_id": caller_id,
        "owner_id": owner_id,
    }


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _setup_app(app, Session, user_id, org_id):
    from app.dependencies.auth import AuthContext, get_current_user
    from app.dependencies.database import get_db

    async def _db():
        async with Session() as s:
            try:
                yield s
                await s.commit()
            except Exception:
                await s.rollback()
                raise

    async def _auth():
        return AuthContext(user_id=str(user_id), email="caller@test", claims={"app_metadata": {"org_id": str(org_id)}})

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth


@pytest.mark.anyio
async def test_project_a_human_can_list_own_project_roster():
    """회귀 0: project_a grant 보유 휴먼은 project_a 로스터(agent 포함)를 정상 조회(200).
    그리고 project_b 시크릿 로스터(이름/이메일)는 절대 섞여 나오지 않는다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/members?project_id={seeded['project_a_id']}")
            assert resp.status_code == 200, resp.text
            ids = {item["id"] for item in resp.json()}
            assert str(seeded["agent_a_id"]) in ids, "project_a 에이전트가 정상 로스터에 있어야 한다(회귀0)"
            # 크로스-프로젝트 유출 없음(positive 응답에도 project_b PII 미혼입).
            assert _SECRET_AGENT_NAME not in resp.text
            assert seeded["secret_human_email"] not in resp.text
            assert str(seeded["secret_agent_b_id"]) not in ids
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_no_grant_human_cannot_list_other_project_roster():
    """봉인 실증(비-동어반복): project_a에만 grant된 휴먼이 project_b 로스터를 project_id
    override로 조회 시도 → 404. 상태코드뿐 아니라 시크릿 에이전트 이름/시크릿 휴먼 이메일이
    응답 바디에 verbatim 미노출까지 assert(기존엔 has_project_access 부재로 200+full leak)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/members?project_id={seeded['project_b_id']}")
            assert resp.status_code == 404, resp.text
            # PII verbatim 미노출 — 로스터 이름/이메일이 바디 어디에도 없어야 함.
            assert _SECRET_AGENT_NAME not in resp.text, "에이전트 이름 유출"
            assert seeded["secret_human_email"] not in resp.text, "휴먼 이메일 유출"
            assert str(seeded["secret_agent_b_id"]) not in resp.text, "에이전트 member id 유출"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_org_owner_can_list_any_project_roster_unchanged():
    """회귀 0(over-block 방지): org owner는 grant 없이도 org-wide 접근이라 project_b 로스터를
    정상 조회(200)해야 한다 — has_project_access가 owner/admin 분기를 보존하는지 실증."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["owner_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/members?project_id={seeded['project_b_id']}")
            assert resp.status_code == 200, resp.text
            # owner는 정당 접근 — project_b 시크릿 에이전트가 로스터에 실제로 보인다.
            ids = {item["id"] for item in resp.json()}
            assert str(seeded["secret_agent_b_id"]) in ids
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_nonexistent_project_id_returns_404_not_leak():
    """엣지: 존재하지 않는 project_id도 404(존재여부 자체를 흘리지 않음)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/members?project_id={uuid.uuid4()}")
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
