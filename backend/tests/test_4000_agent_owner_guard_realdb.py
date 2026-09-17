"""story #4000(보안 감사) — 에이전트 설정을 바꾸는 라우트 4개(agent_personas·agent_
deployments·agent_routing_rules·agent_sessions)가 org/project 스코프만 보고 대상 agent의
소유권(생성자 or org admin)을 안 보던 구멍을 `assert_agent_owner`로 막는다.

## AC2 — 실패 테스트 먼저(구멍 실측)
각 경로마다 "org의 일반 멤버(비소유자·비admin)가 남의 agent 설정을 바꾸려는" 요청을
보내고, 수정 前 브랜치에서는 200/201(구멍)이었고 수정 後에는 403임을 확認한다. 이 파일은
"수정 後" 상태만 담는다(수정 前 RED는 뮤테이션 self-check로 검증 — PR 본문에 절차 기록:
router의 assert_agent_owner 호출 라인을 임시 주석 처리 후 재실행 → attacker 케이스가
200/201로 뒤집히는지 확認 → 원복).

## AC4 — 회귀 0
같은 요청을 owner 또는 org-admin이 보내면 그대로 성공한다(경로마다 최소 1건).

`PARITY_TEST_DATABASE_URL`/`ALEMBIC_DATABASE_URL` 미설정 시 skip. destructive_schema
아님(create_all 기반 공유 스키마를 건드리지 않는 순수 CRUD, test_2266/test_3687과 동일
관례) — 생성한 행은 org_id 단위로 격리돼 다른 realdb 테스트와 충돌하지 않는다.

구조 노트: scenario 시딩은 pytest async fixture가 아니라 테스트 함수 본문 안에서 직접
await하는 plain 헬퍼로 둔다 — 이 레포는 asyncio_mode=auto(pytest-asyncio) + pytest-anyio가
동시 등록돼 있어, async generator fixture(@pytest.fixture async def ...)는 pytest-asyncio가
자체 이벤트루프로 구동하는 반면 @pytest.mark.anyio 테스트 본문은 anyio 루프에서 도는
불일치가 실측으로 확인됨("attached to a different loop" — asyncpg 커넥션이 fixture의
루프에서 열리고 테스트의 루프에서 재사용됨). test_139d2405/test_2266도 동일 이유로
fixture 대신 inline seeding을 쓰는 관례라 그대로 따른다.
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


# ─── Seeding helpers ────────────────────────────────────────────────────────


async def _make_org(session, name="Org4000"):
    from app.models.organization import Organization
    org = Organization(id=uuid.uuid4(), name=name, slug=f"org4000-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    return org


async def _make_project(session, org_id, name="P4000"):
    from app.models.project import Project
    project = Project(id=uuid.uuid4(), org_id=org_id, name=name)
    session.add(project)
    await session.commit()
    return project


async def _make_human(session, org_id, project_id, role="member"):
    """휴먼 멤버 하나(User+OrgMember+Member+ProjectAccess) — test_2266의 _make_human_member와
    동형(role 파라미터만 추가, org-admin 회귀 케이스에 재사용)."""
    from app.models.member import Member
    from app.models.project import OrgMember
    from app.models.project_access import ProjectAccess
    from app.models.user import User

    user = User(id=uuid.uuid4(), email=f"u-{uuid.uuid4().hex[:8]}@test.local", hashed_password="x")
    session.add(user)
    await session.flush()
    om = OrgMember(id=uuid.uuid4(), org_id=org_id, user_id=user.id, role=role)
    session.add(om)
    await session.flush()
    m = Member(id=om.id, org_id=org_id, type="human", user_id=user.id, name=f"Human-{role}")
    session.add(m)
    await session.flush()
    session.add(ProjectAccess(project_id=project_id, org_member_id=om.id, member_id=m.id, role=role))
    await session.commit()
    return m.id, user.id


async def _make_agent_owned_by(session, org_id, project_id, owner_member_id, name="Agent"):
    """story #4000 — team_members.created_by는 members.owner_member_id가 가리키는 human의
    user_id로 투영된다(migration 0110 VIEW 정의, `owner.user_id AS created_by`) — assert_agent_owner
    가 검사하는 값이 정확히 이것이라 owner_member_id를 명시해야 "누가 만들었나"가 성립한다."""
    from app.models.member import Member
    from app.models.project_access import ProjectAccess

    agent = Member(id=uuid.uuid4(), org_id=org_id, type="agent", name=name, owner_member_id=owner_member_id)
    session.add(agent)
    await session.flush()
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project_id, member_id=agent.id, permission="granted", role="member",
    ))
    await session.commit()
    return agent.id


def _client_for(app):
    from httpx import ASGITransport, AsyncClient
    # raise_app_exceptions=False — persona seed 성공 경로가 별도·기존 버그(missing DB
    # function, 위 test_persona_seed_attacker_403_admin_200 주석 참고)로 500을 내는데,
    # 기본값(True)이면 httpx가 그걸 파이썬 예외로 재던져 resp.status_code로 관찰이 안 된다.
    return AsyncClient(
        transport=ASGITransport(app=app, raise_app_exceptions=False), base_url="http://test",
    )


async def _setup_app_human(app, Session, user_id, org_id, project_id):
    from app.dependencies.auth import AuthContext, get_current_user
    from tests.conftest import override_db_and_read

    async def _db():
        async with Session() as s:
            try:
                yield s
                await s.commit()
            except Exception:
                await s.rollback()
                raise

    async def _auth():
        return AuthContext(
            user_id=str(user_id), email="human@test",
            claims={"app_metadata": {"org_id": str(org_id), "project_id": str(project_id)}},
        )

    # story #2451(§6 Phase3 root-fix) — get_db만 걸고 get_read_db를 빠뜨리면 그 경로가
    # 오버라이드 안 된 실 DB에 붙어 이 테스트의 세션과 다른 이벤트루프/커넥션으로 갈려
    # "attached to a different loop" 크래시가 난다(agent_deployments.py 등 이 카드의
    # 라우터들이 get_read_db를 쓰는 경로가 있어 실측으로 걸림) — 공용 헬퍼로 항상 같이.
    override_db_and_read(app, _db)
    app.dependency_overrides[get_current_user] = _auth


async def _build_scenario():
    """org + project + owner-human(agent 소유자) + attacker-human(같은 org·project 멤버,
    비소유자·비admin) + admin-human(org admin) + owner가 만든 agent 1개. 4개 라우터 테스트가
    공유하는 표준 시나리오 — plain async 헬퍼(테스트 본문에서 직접 await, fixture 아님)."""
    engine, Session = await _session_factory()
    async with Session() as s:
        org = await _make_org(s)
        project = await _make_project(s, org.id)
        owner_member_id, owner_user_id = await _make_human(s, org.id, project.id, role="member")
        attacker_member_id, attacker_user_id = await _make_human(s, org.id, project.id, role="member")
        admin_member_id, admin_user_id = await _make_human(s, org.id, project.id, role="admin")
        agent_id = await _make_agent_owned_by(s, org.id, project.id, owner_member_id)
    return {
        "engine": engine, "Session": Session,
        "org_id": org.id, "project_id": project.id,
        "owner_user_id": owner_user_id, "attacker_user_id": attacker_user_id, "admin_user_id": admin_user_id,
        "agent_id": agent_id,
    }


async def _client_as(scenario, user_id):
    from app.main import app
    await _setup_app_human(app, scenario["Session"], user_id, scenario["org_id"], scenario["project_id"])
    return _client_for(app)


def _clear_overrides():
    from app.main import app
    app.dependency_overrides.clear()


# ============================================================================
# agent_personas.py — create/seed/update/delete
# ============================================================================


@pytest.mark.anyio
async def test_persona_create_attacker_403_owner_201():
    scenario = await _build_scenario()
    try:
        client = await _client_as(scenario, scenario["attacker_user_id"])
        try:
            resp = await client.post("/api/v2/agent-personas", json={
                "agent_id": str(scenario["agent_id"]), "name": "Hijacked", "system_prompt": "evil",
            })
            assert resp.status_code == 403, resp.text
        finally:
            await client.aclose()
            _clear_overrides()

        client = await _client_as(scenario, scenario["owner_user_id"])
        try:
            resp = await client.post("/api/v2/agent-personas", json={
                "agent_id": str(scenario["agent_id"]), "name": "Legit", "system_prompt": "ok",
            })
            assert resp.status_code == 201, resp.text
        finally:
            await client.aclose()
            _clear_overrides()
    finally:
        await scenario["engine"].dispose()


@pytest.mark.anyio
async def test_persona_seed_attacker_403_admin_200():
    scenario = await _build_scenario()
    try:
        client = await _client_as(scenario, scenario["attacker_user_id"])
        try:
            resp = await client.post(f"/api/v2/agent-personas/seed?agent_id={scenario['agent_id']}")
            assert resp.status_code == 403, resp.text
        finally:
            await client.aclose()
            _clear_overrides()

        client = await _client_as(scenario, scenario["admin_user_id"])
        try:
            resp = await client.post(f"/api/v2/agent-personas/seed?agent_id={scenario['agent_id']}")
            # story #4000 그라운딩 중 발견(별도·기존 버그, 이 스토리 범위 밖) — repo.seed_builtin()이
            # 호출하는 Postgres 함수 seed_builtin_personas(uuid,uuid,uuid)가 어느 migration에도
            # 존재하지 않아 admin이 실제로 호출해도 500(UndefinedFunctionError)이 난다(실측
            # 확인). 이 카드가 책임지는 건 "소유권 게이트를 통과하는가"뿐 — 통과 후 500은
            # 별도 버그이므로 admin에게 403이 아님(=게이트 통과)만 단언하고, 함수 결손은
            # PO에게 별도 스토리로 플래그한다.
            assert resp.status_code != 403, resp.text
        finally:
            await client.aclose()
            _clear_overrides()
    finally:
        await scenario["engine"].dispose()


async def _build_persona_scenario():
    scenario = await _build_scenario()
    async with scenario["Session"]() as s:
        from app.repositories.agent_persona import AgentPersonaRepository
        repo = AgentPersonaRepository(s)
        persona = await repo.create(
            org_id=scenario["org_id"], project_id=scenario["project_id"], agent_id=scenario["agent_id"],
            actor_id=uuid.uuid4(), name="Seed persona", system_prompt="hi",
        )
        # repo.create()는 flush만 하고 commit하지 않는다 — 세션 close(=rollback)로 사라지지
        # 않도록 명시 commit(실측으로 발견: 없으면 아래 owner/attacker 요청이 새 세션에서
        # 이 persona를 못 찾아 403 대신 404가 난다).
        await s.commit()
    scenario["persona_id"] = persona.id
    return scenario


@pytest.mark.anyio
async def test_persona_update_attacker_403_owner_200():
    scenario = await _build_persona_scenario()
    try:
        client = await _client_as(scenario, scenario["attacker_user_id"])
        try:
            resp = await client.patch(
                f"/api/v2/agent-personas/{scenario['persona_id']}",
                json={"system_prompt": "attacker rewritten prompt"},
            )
            assert resp.status_code == 403, resp.text
        finally:
            await client.aclose()
            _clear_overrides()

        client = await _client_as(scenario, scenario["owner_user_id"])
        try:
            resp = await client.patch(
                f"/api/v2/agent-personas/{scenario['persona_id']}",
                json={"system_prompt": "owner rewritten prompt"},
            )
            assert resp.status_code == 200, resp.text
        finally:
            await client.aclose()
            _clear_overrides()
    finally:
        await scenario["engine"].dispose()


@pytest.mark.anyio
async def test_persona_delete_attacker_403_owner_200():
    scenario = await _build_persona_scenario()
    try:
        client = await _client_as(scenario, scenario["attacker_user_id"])
        try:
            resp = await client.delete(f"/api/v2/agent-personas/{scenario['persona_id']}")
            assert resp.status_code == 403, resp.text
        finally:
            await client.aclose()
            _clear_overrides()

        client = await _client_as(scenario, scenario["owner_user_id"])
        try:
            resp = await client.delete(f"/api/v2/agent-personas/{scenario['persona_id']}")
            assert resp.status_code == 200, resp.text
        finally:
            await client.aclose()
            _clear_overrides()
    finally:
        await scenario["engine"].dispose()


# ============================================================================
# agent_deployments.py — create/preflight/patch/delete/verification
# ============================================================================


@pytest.mark.anyio
async def test_deployment_create_attacker_403_owner_202():
    scenario = await _build_scenario()
    try:
        client = await _client_as(scenario, scenario["attacker_user_id"])
        try:
            resp = await client.post("/api/v2/agent-deployments", json={
                "agent_id": str(scenario["agent_id"]), "name": "Hijack deploy",
            })
            assert resp.status_code == 403, resp.text
        finally:
            await client.aclose()
            _clear_overrides()

        client = await _client_as(scenario, scenario["owner_user_id"])
        try:
            resp = await client.post("/api/v2/agent-deployments", json={
                "agent_id": str(scenario["agent_id"]), "name": "Legit deploy",
            })
            assert resp.status_code == 202, resp.text
        finally:
            await client.aclose()
            _clear_overrides()
    finally:
        await scenario["engine"].dispose()


@pytest.mark.anyio
async def test_deployment_preflight_attacker_403():
    scenario = await _build_scenario()
    try:
        client = await _client_as(scenario, scenario["attacker_user_id"])
        try:
            resp = await client.post("/api/v2/agent-deployments/preflight", json={
                "agent_id": str(scenario["agent_id"]), "name": "Preview",
            })
            assert resp.status_code == 403, resp.text
        finally:
            await client.aclose()
            _clear_overrides()
    finally:
        await scenario["engine"].dispose()


async def _build_deployment_scenario():
    scenario = await _build_scenario()
    async with scenario["Session"]() as s:
        from app.services.deployment_lifecycle import DeploymentLifecycleService
        svc = DeploymentLifecycleService(s)
        result = await svc.create_deployment(
            org_id=scenario["org_id"], project_id=scenario["project_id"], agent_id=scenario["agent_id"],
            actor_id=uuid.uuid4(), name="Seed deploy", runtime=None, model=None, version=None,
            persona_id=None, config=None, overwrite_routing_rules=None,
        )
        # flush만 하고 commit 안 하는 서비스 계층 관례 — 위 persona 시나리오와 동일 이유로 명시 commit.
        await s.commit()
    scenario["deployment_id"] = result.deployment.id
    return scenario


@pytest.mark.anyio
async def test_deployment_patch_attacker_403_owner_200():
    scenario = await _build_deployment_scenario()
    try:
        client = await _client_as(scenario, scenario["attacker_user_id"])
        try:
            resp = await client.patch(
                f"/api/v2/agent-deployments/{scenario['deployment_id']}",
                json={"status": "SUSPENDED"},
            )
            assert resp.status_code == 403, resp.text
        finally:
            await client.aclose()
            _clear_overrides()

        client = await _client_as(scenario, scenario["owner_user_id"])
        try:
            resp = await client.patch(
                f"/api/v2/agent-deployments/{scenario['deployment_id']}",
                json={"status": "SUSPENDED"},
            )
            assert resp.status_code == 200, resp.text
        finally:
            await client.aclose()
            _clear_overrides()
    finally:
        await scenario["engine"].dispose()


@pytest.mark.anyio
async def test_deployment_verification_attacker_403_admin_200():
    scenario = await _build_deployment_scenario()
    try:
        client = await _client_as(scenario, scenario["attacker_user_id"])
        try:
            resp = await client.post(f"/api/v2/agent-deployments/{scenario['deployment_id']}/verification")
            assert resp.status_code == 403, resp.text
        finally:
            await client.aclose()
            _clear_overrides()

        client = await _client_as(scenario, scenario["admin_user_id"])
        try:
            resp = await client.post(f"/api/v2/agent-deployments/{scenario['deployment_id']}/verification")
            assert resp.status_code == 200, resp.text
        finally:
            await client.aclose()
            _clear_overrides()
    finally:
        await scenario["engine"].dispose()


@pytest.mark.anyio
async def test_deployment_delete_attacker_403_owner_200():
    scenario = await _build_deployment_scenario()
    try:
        client = await _client_as(scenario, scenario["attacker_user_id"])
        try:
            resp = await client.delete(f"/api/v2/agent-deployments/{scenario['deployment_id']}")
            assert resp.status_code == 403, resp.text
        finally:
            await client.aclose()
            _clear_overrides()

        client = await _client_as(scenario, scenario["owner_user_id"])
        try:
            resp = await client.delete(f"/api/v2/agent-deployments/{scenario['deployment_id']}")
            assert resp.status_code == 200, resp.text
        finally:
            await client.aclose()
            _clear_overrides()
    finally:
        await scenario["engine"].dispose()


# ============================================================================
# agent_routing_rules.py — create/PUT(items·single)/PATCH(disable_all·reorder)/delete
# ============================================================================


@pytest.mark.anyio
async def test_routing_rule_create_attacker_403_owner_201():
    scenario = await _build_scenario()
    try:
        client = await _client_as(scenario, scenario["attacker_user_id"])
        try:
            resp = await client.post(
                "/api/v2/agent-routing-rules",
                json={"agent_id": str(scenario["agent_id"]), "name": "Hijack rule"},
                headers={"X-Project-Id": str(scenario["project_id"])},
            )
            assert resp.status_code == 403, resp.text
        finally:
            await client.aclose()
            _clear_overrides()

        client = await _client_as(scenario, scenario["owner_user_id"])
        try:
            resp = await client.post(
                "/api/v2/agent-routing-rules",
                json={"agent_id": str(scenario["agent_id"]), "name": "Legit rule"},
                headers={"X-Project-Id": str(scenario["project_id"])},
            )
            assert resp.status_code == 201, resp.text
        finally:
            await client.aclose()
            _clear_overrides()
    finally:
        await scenario["engine"].dispose()


async def _build_routing_rule_scenario():
    scenario = await _build_scenario()
    async with scenario["Session"]() as s:
        from app.repositories.agent_routing_rule import AgentRoutingRuleRepository
        repo = AgentRoutingRuleRepository(s)
        rule = await repo.create(
            org_id=scenario["org_id"], project_id=scenario["project_id"], actor_id=uuid.uuid4(),
            agent_id=scenario["agent_id"], name="Seed rule", priority=100, match_type="event",
            conditions=None, action=None, target_runtime="openclaw", target_model=None,
            is_enabled=True, persona_id=None, deployment_id=None,
        )
        # flush만 하고 commit 안 하는 관례 — 위 persona 시나리오와 동일 이유로 명시 commit.
        await s.commit()
    scenario["rule_id"] = rule.id
    return scenario


@pytest.mark.anyio
async def test_routing_rule_put_single_update_attacker_403_owner_200():
    scenario = await _build_routing_rule_scenario()
    try:
        client = await _client_as(scenario, scenario["attacker_user_id"])
        try:
            resp = await client.put(
                "/api/v2/agent-routing-rules",
                json={"id": str(scenario["rule_id"]), "name": "Hijacked rename"},
                headers={"X-Project-Id": str(scenario["project_id"])},
            )
            assert resp.status_code == 403, resp.text
        finally:
            await client.aclose()
            _clear_overrides()

        client = await _client_as(scenario, scenario["owner_user_id"])
        try:
            resp = await client.put(
                "/api/v2/agent-routing-rules",
                json={"id": str(scenario["rule_id"]), "name": "Owner rename"},
                headers={"X-Project-Id": str(scenario["project_id"])},
            )
            assert resp.status_code == 200, resp.text
        finally:
            await client.aclose()
            _clear_overrides()
    finally:
        await scenario["engine"].dispose()


@pytest.mark.anyio
async def test_routing_rule_put_items_replace_attacker_403():
    """벌크 교체 — 기존 규칙(owner의 agent)이 있는 project에 attacker가 items로 전체
    교체를 시도하면, 새 items가 attacker 소유 agent를 가리켜도 기존 규칙의 agent(owner
    소유)가 섞여 있어 전체 거부돼야 한다(부분 성공 없음)."""
    scenario = await _build_routing_rule_scenario()
    try:
        client = await _client_as(scenario, scenario["attacker_user_id"])
        try:
            resp = await client.put(
                "/api/v2/agent-routing-rules",
                json={
                    "project_id": str(scenario["project_id"]),
                    "items": [{"agent_id": str(scenario["agent_id"]), "name": "Wiped and replaced"}],
                },
            )
            assert resp.status_code == 403, resp.text
        finally:
            await client.aclose()
            _clear_overrides()
    finally:
        await scenario["engine"].dispose()


@pytest.mark.anyio
async def test_routing_rule_patch_reorder_attacker_403_owner_200():
    scenario = await _build_routing_rule_scenario()
    try:
        client = await _client_as(scenario, scenario["attacker_user_id"])
        try:
            resp = await client.patch(
                "/api/v2/agent-routing-rules",
                json={
                    "project_id": str(scenario["project_id"]),
                    "items": [{"id": str(scenario["rule_id"]), "priority": 1}],
                },
            )
            assert resp.status_code == 403, resp.text
        finally:
            await client.aclose()
            _clear_overrides()

        client = await _client_as(scenario, scenario["owner_user_id"])
        try:
            resp = await client.patch(
                "/api/v2/agent-routing-rules",
                json={
                    "project_id": str(scenario["project_id"]),
                    "items": [{"id": str(scenario["rule_id"]), "priority": 1}],
                },
            )
            assert resp.status_code == 200, resp.text
        finally:
            await client.aclose()
            _clear_overrides()
    finally:
        await scenario["engine"].dispose()


@pytest.mark.anyio
async def test_routing_rule_patch_disable_all_attacker_403_admin_200():
    scenario = await _build_routing_rule_scenario()
    try:
        client = await _client_as(scenario, scenario["attacker_user_id"])
        try:
            resp = await client.patch(
                "/api/v2/agent-routing-rules",
                json={"disable_all": True},
                headers={"X-Project-Id": str(scenario["project_id"])},
            )
            assert resp.status_code == 403, resp.text
        finally:
            await client.aclose()
            _clear_overrides()

        client = await _client_as(scenario, scenario["admin_user_id"])
        try:
            resp = await client.patch(
                "/api/v2/agent-routing-rules",
                json={"disable_all": True},
                headers={"X-Project-Id": str(scenario["project_id"])},
            )
            assert resp.status_code == 200, resp.text
        finally:
            await client.aclose()
            _clear_overrides()
    finally:
        await scenario["engine"].dispose()


@pytest.mark.anyio
async def test_routing_rule_delete_attacker_403_owner_200():
    scenario = await _build_routing_rule_scenario()
    try:
        client = await _client_as(scenario, scenario["attacker_user_id"])
        try:
            resp = await client.delete(f"/api/v2/agent-routing-rules?id={scenario['rule_id']}")
            assert resp.status_code == 403, resp.text
        finally:
            await client.aclose()
            _clear_overrides()

        client = await _client_as(scenario, scenario["owner_user_id"])
        try:
            resp = await client.delete(f"/api/v2/agent-routing-rules?id={scenario['rule_id']}")
            assert resp.status_code == 200, resp.text
        finally:
            await client.aclose()
            _clear_overrides()
    finally:
        await scenario["engine"].dispose()


# ============================================================================
# agent_sessions.py — transition
# ============================================================================


async def _build_session_scenario():
    scenario = await _build_scenario()
    async with scenario["Session"]() as s:
        from app.models.agent_session import AgentSession
        sess = AgentSession(
            id=uuid.uuid4(), org_id=scenario["org_id"], project_id=scenario["project_id"],
            agent_id=scenario["agent_id"], session_key=f"key-{uuid.uuid4().hex[:8]}", status="active",
        )
        s.add(sess)
        await s.commit()
    scenario["session_id"] = sess.id
    return scenario


@pytest.mark.anyio
async def test_session_transition_attacker_403_owner_200():
    scenario = await _build_session_scenario()
    try:
        client = await _client_as(scenario, scenario["attacker_user_id"])
        try:
            resp = await client.patch(
                f"/api/v2/agent-sessions/{scenario['session_id']}",
                json={"status": "suspended", "reason": "attacker forced pause"},
            )
            assert resp.status_code == 403, resp.text
        finally:
            await client.aclose()
            _clear_overrides()

        client = await _client_as(scenario, scenario["owner_user_id"])
        try:
            resp = await client.patch(
                f"/api/v2/agent-sessions/{scenario['session_id']}",
                json={"status": "suspended", "reason": "owner pause"},
            )
            assert resp.status_code == 200, resp.text
        finally:
            await client.aclose()
            _clear_overrides()
    finally:
        await scenario["engine"].dispose()
