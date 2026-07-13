"""[SEC][HIGH·BE] story d764522c(산티아고 SME finding, PR #2121 검토 中 발견) — 실 PG.

`agent_routing_rules.py`(create/replace/reorder/delete)·`hitl.py`(update_policy/resolve_request)
6개 mutation 라우트가 `get_current_user`만 쓰고 `get_verified_org_id`(API-key scope check 실행점)를
거치지 않아 read-only 키가 mutation을 호출할 수 있던 갭 — `enforce_write_scope()` 배선 실증.
open_api_keys.py는 이미 `get_verified_org_id` 사용 중이라 스코프 밖(산티아고+PO 확定).

각 라우트: read-key(scope=['read'])=403·write-key(scope=['read','write'])=200 무회귀.
+ replace/reorder의 malformed body project_id UUID → 400(500 아님) 2건.

산티아고 2차 finding(2026-07-13): `_check_api_key_scope`의 Stage 1(레거시 read/write coarse
게이트)은 explicit toolset-scope 키(예 `scope=['docs']`)엔 스킵되고, Stage 2(path→toolgroup)는
이 6라우트가 어떤 toolgroup에도 안 걸려(_PATH_GROUP_PREFIXES 미매핑) "미매핑=core=허용"으로
무제한 통과시켰다 — `enforce_write_scope`가 이제 `_check_api_key_scope`에 위임하지 않고 scope
타입 불문 레거시 'write' 토큰 명시 보유만 통과시킨다. toolgroup-scope sabotage 6건 추가.
"""
from __future__ import annotations

import os
import uuid
from unittest.mock import MagicMock

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


def _auth(agent_id: uuid.UUID, org_id: uuid.UUID, project_id: uuid.UUID, *, scope: list[str]):
    """API-key AuthContext — api_key_id 마커가 있어야 _check_api_key_scope가 게이트를 적용한다.

    project_id도 claims에 실어야 함 — create_rule/delete_rule/resolve_hitl_request는 이번 스토리
    스코프 밖(Tier 0/1)이라 여전히 `_get_org_project`(project_id 동반 필수)를 쓴다."""
    from app.dependencies.auth import AuthContext
    return AuthContext(
        user_id=str(agent_id), email=None,
        claims={"app_metadata": {
            "org_id": str(org_id), "project_id": str(project_id),
            "api_key_id": str(uuid.uuid4()), "scope": scope,
        }},
        org_id=str(org_id),
    )


def _request(path: str, method: str):
    req = MagicMock()
    req.headers.get = lambda key, default=None: default
    req.method = method
    req.url.path = path
    return req


async def _seed_single_project_agent(session):
    """org + project(단일) + agent(project_access grant) — 앰비규어스 없이 단일 접근으로 resolve."""
    from app.models.member import Member
    from app.models.organization import Organization
    from app.models.project import Project
    from app.models.project_access import ProjectAccess

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()

    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()

    agent = Member(id=uuid.uuid4(), org_id=org.id, type="agent", name="Agent")
    session.add(agent)
    await session.commit()
    session.add(ProjectAccess(id=uuid.uuid4(), project_id=project.id, member_id=agent.id, permission="granted"))
    await session.commit()

    return {"org_id": org.id, "project_id": project.id, "agent_id": agent.id}


async def _seed_rule(session, org_id, project_id, agent_id):
    from app.models.agent_routing_rule import AgentRoutingRule
    rule = AgentRoutingRule(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, agent_id=agent_id,
        name="r", priority=100, match_type="event", conditions={"memo_type": []},
        action={"auto_reply_mode": "process_and_report", "forward_to_agent_id": None},
        is_enabled=True,
    )
    session.add(rule)
    await session.commit()
    return rule.id


async def _seed_hitl_request(session, org_id, project_id, agent_id):
    from app.models.hitl import HitlRequest
    req = HitlRequest(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, agent_id=agent_id,
        request_type="approval", title="t", prompt="p", requested_for=agent_id, status="pending",
    )
    session.add(req)
    await session.commit()
    return req.id


# ── agent_routing_rules::create_rule(POST) ────────────────────────────────────

async def test_create_rule_read_key_403():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_single_project_agent(s)
        async with Session() as s:
            from app.routers.agent_routing_rules import create_rule
            from app.repositories.agent_routing_rule import AgentRoutingRuleRepository
            from app.schemas.agent_routing_rule import CreateRoutingRuleRequest

            resp = await create_rule(
                request=_request("/api/v2/agent-routing-rules", "POST"),
                body=CreateRoutingRuleRequest(agent_id=seeded["agent_id"], name="r"),
                auth=_auth(seeded["agent_id"], seeded["org_id"], seeded["project_id"], scope=["read"]),
                repo=AgentRoutingRuleRepository(s),
            )
            assert resp.status_code == 403
    finally:
        await engine.dispose()


async def test_create_rule_write_key_201_no_regression():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_single_project_agent(s)
        async with Session() as s:
            from app.routers.agent_routing_rules import create_rule
            from app.repositories.agent_routing_rule import AgentRoutingRuleRepository
            from app.schemas.agent_routing_rule import CreateRoutingRuleRequest

            resp = await create_rule(
                request=_request("/api/v2/agent-routing-rules", "POST"),
                body=CreateRoutingRuleRequest(agent_id=seeded["agent_id"], name="r"),
                auth=_auth(seeded["agent_id"], seeded["org_id"], seeded["project_id"], scope=["read", "write"]),
                repo=AgentRoutingRuleRepository(s),
            )
            assert resp.status_code == 201
    finally:
        await engine.dispose()


# ── agent_routing_rules::replace_or_update_rules(PUT bulk-replace) ────────────

async def test_replace_rules_read_key_403():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_single_project_agent(s)
            await _seed_rule(s, seeded["org_id"], seeded["project_id"], seeded["agent_id"])
        async with Session() as s:
            from app.routers.agent_routing_rules import replace_or_update_rules
            from app.repositories.agent_routing_rule import AgentRoutingRuleRepository

            resp = await replace_or_update_rules(
                request=_request("/api/v2/agent-routing-rules", "PUT"),
                body={"items": [{"agent_id": str(seeded["agent_id"]), "name": "new"}], "project_id": str(seeded["project_id"])},
                auth=_auth(seeded["agent_id"], seeded["org_id"], seeded["project_id"], scope=["read"]),
                repo=AgentRoutingRuleRepository(s),
            )
            assert resp.status_code == 403
    finally:
        await engine.dispose()


async def test_replace_rules_write_key_200_no_regression():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_single_project_agent(s)
            await _seed_rule(s, seeded["org_id"], seeded["project_id"], seeded["agent_id"])
        async with Session() as s:
            from app.routers.agent_routing_rules import replace_or_update_rules
            from app.repositories.agent_routing_rule import AgentRoutingRuleRepository

            resp = await replace_or_update_rules(
                request=_request("/api/v2/agent-routing-rules", "PUT"),
                body={"items": [{"agent_id": str(seeded["agent_id"]), "name": "new"}], "project_id": str(seeded["project_id"])},
                auth=_auth(seeded["agent_id"], seeded["org_id"], seeded["project_id"], scope=["read", "write"]),
                repo=AgentRoutingRuleRepository(s),
            )
            assert resp.status_code == 200
    finally:
        await engine.dispose()


async def test_replace_rules_malformed_project_id_400_not_500():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_single_project_agent(s)
        async with Session() as s:
            from app.routers.agent_routing_rules import replace_or_update_rules
            from app.repositories.agent_routing_rule import AgentRoutingRuleRepository

            resp = await replace_or_update_rules(
                request=_request("/api/v2/agent-routing-rules", "PUT"),
                body={"items": [{"agent_id": str(seeded["agent_id"]), "name": "new"}], "project_id": "not-a-uuid"},
                auth=_auth(seeded["agent_id"], seeded["org_id"], seeded["project_id"], scope=["read", "write"]),
                repo=AgentRoutingRuleRepository(s),
            )
            assert resp.status_code == 400
    finally:
        await engine.dispose()


# ── agent_routing_rules::reorder_or_disable_rules(PATCH) ──────────────────────

async def test_disable_all_read_key_403():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_single_project_agent(s)
        async with Session() as s:
            from app.routers.agent_routing_rules import reorder_or_disable_rules
            from app.repositories.agent_routing_rule import AgentRoutingRuleRepository

            resp = await reorder_or_disable_rules(
                request=_request("/api/v2/agent-routing-rules", "PATCH"),
                body={"disable_all": True},
                auth=_auth(seeded["agent_id"], seeded["org_id"], seeded["project_id"], scope=["read"]),
                repo=AgentRoutingRuleRepository(s),
            )
            assert resp.status_code == 403
    finally:
        await engine.dispose()


async def test_reorder_items_write_key_200_no_regression():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_single_project_agent(s)
            rule_id = await _seed_rule(s, seeded["org_id"], seeded["project_id"], seeded["agent_id"])
        async with Session() as s:
            from app.routers.agent_routing_rules import reorder_or_disable_rules
            from app.repositories.agent_routing_rule import AgentRoutingRuleRepository

            resp = await reorder_or_disable_rules(
                request=_request("/api/v2/agent-routing-rules", "PATCH"),
                body={"items": [{"id": str(rule_id), "priority": 5}], "project_id": str(seeded["project_id"])},
                auth=_auth(seeded["agent_id"], seeded["org_id"], seeded["project_id"], scope=["read", "write"]),
                repo=AgentRoutingRuleRepository(s),
            )
            assert resp.status_code == 200
    finally:
        await engine.dispose()


async def test_reorder_items_malformed_project_id_400_not_500():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_single_project_agent(s)
            rule_id = await _seed_rule(s, seeded["org_id"], seeded["project_id"], seeded["agent_id"])
        async with Session() as s:
            from app.routers.agent_routing_rules import reorder_or_disable_rules
            from app.repositories.agent_routing_rule import AgentRoutingRuleRepository

            resp = await reorder_or_disable_rules(
                request=_request("/api/v2/agent-routing-rules", "PATCH"),
                body={"items": [{"id": str(rule_id), "priority": 5}], "project_id": "not-a-uuid"},
                auth=_auth(seeded["agent_id"], seeded["org_id"], seeded["project_id"], scope=["read", "write"]),
                repo=AgentRoutingRuleRepository(s),
            )
            assert resp.status_code == 400
    finally:
        await engine.dispose()


# ── agent_routing_rules::delete_rule(DELETE) ──────────────────────────────────

async def test_delete_rule_read_key_403():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_single_project_agent(s)
            rule_id = await _seed_rule(s, seeded["org_id"], seeded["project_id"], seeded["agent_id"])
        async with Session() as s:
            from app.routers.agent_routing_rules import delete_rule
            from app.repositories.agent_routing_rule import AgentRoutingRuleRepository

            resp = await delete_rule(
                request=_request("/api/v2/agent-routing-rules", "DELETE"),
                id=rule_id,
                auth=_auth(seeded["agent_id"], seeded["org_id"], seeded["project_id"], scope=["read"]),
                repo=AgentRoutingRuleRepository(s),
            )
            assert resp.status_code == 403
    finally:
        await engine.dispose()


async def test_delete_rule_write_key_200_no_regression():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_single_project_agent(s)
            rule_id = await _seed_rule(s, seeded["org_id"], seeded["project_id"], seeded["agent_id"])
        async with Session() as s:
            from app.routers.agent_routing_rules import delete_rule
            from app.repositories.agent_routing_rule import AgentRoutingRuleRepository

            resp = await delete_rule(
                request=_request("/api/v2/agent-routing-rules", "DELETE"),
                id=rule_id,
                auth=_auth(seeded["agent_id"], seeded["org_id"], seeded["project_id"], scope=["read", "write"]),
                repo=AgentRoutingRuleRepository(s),
            )
            assert resp.status_code == 200
    finally:
        await engine.dispose()


# ── hitl::update_hitl_policy(PATCH /policy) ───────────────────────────────────

async def test_update_hitl_policy_read_key_403():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_single_project_agent(s)
        async with Session() as s:
            from app.routers.hitl import update_hitl_policy
            from app.repositories.hitl import HitlRepository
            from app.schemas.hitl import PatchHitlPolicyRequest

            resp = await update_hitl_policy(
                request=_request("/api/v2/hitl/policy", "PATCH"),
                body=PatchHitlPolicyRequest(approval_rules=[], timeout_classes=[]),
                auth=_auth(seeded["agent_id"], seeded["org_id"], seeded["project_id"], scope=["read"]),
                repo=HitlRepository(s),
            )
            assert resp.status_code == 403
    finally:
        await engine.dispose()


async def test_update_hitl_policy_write_key_200_no_regression():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_single_project_agent(s)
        async with Session() as s:
            from app.routers.hitl import update_hitl_policy
            from app.repositories.hitl import HitlRepository
            from app.schemas.hitl import PatchHitlPolicyRequest

            resp = await update_hitl_policy(
                request=_request("/api/v2/hitl/policy", "PATCH"),
                body=PatchHitlPolicyRequest(approval_rules=[], timeout_classes=[]),
                auth=_auth(seeded["agent_id"], seeded["org_id"], seeded["project_id"], scope=["read", "write"]),
                repo=HitlRepository(s),
            )
            assert resp.status_code == 200
    finally:
        await engine.dispose()


# ── hitl::resolve_hitl_request(PATCH /requests/{id}) ──────────────────────────

async def test_resolve_hitl_request_read_key_403():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_single_project_agent(s)
            req_id = await _seed_hitl_request(s, seeded["org_id"], seeded["project_id"], seeded["agent_id"])
        async with Session() as s:
            from app.routers.hitl import resolve_hitl_request
            from app.repositories.hitl import HitlRepository
            from app.schemas.hitl import ResolveHitlRequestBody

            resp = await resolve_hitl_request(
                request_id=req_id,
                body=ResolveHitlRequestBody(status="approved"),
                request=_request("/api/v2/hitl/requests/x", "PATCH"),
                auth=_auth(seeded["agent_id"], seeded["org_id"], seeded["project_id"], scope=["read"]),
                repo=HitlRepository(s),
            )
            assert resp.status_code == 403
    finally:
        await engine.dispose()


async def test_resolve_hitl_request_write_key_200_no_regression():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_single_project_agent(s)
            req_id = await _seed_hitl_request(s, seeded["org_id"], seeded["project_id"], seeded["agent_id"])
        async with Session() as s:
            from app.routers.hitl import resolve_hitl_request
            from app.repositories.hitl import HitlRepository
            from app.schemas.hitl import ResolveHitlRequestBody

            resp = await resolve_hitl_request(
                request_id=req_id,
                body=ResolveHitlRequestBody(status="approved"),
                request=_request("/api/v2/hitl/requests/x", "PATCH"),
                auth=_auth(seeded["agent_id"], seeded["org_id"], seeded["project_id"], scope=["read", "write"]),
                repo=HitlRepository(s),
            )
            assert resp.status_code == 200
    finally:
        await engine.dispose()


# ── 산티아고 2차 finding: toolgroup-scope(scope=['docs']) sabotage — 6라우트 전부 403 ─────

async def test_create_rule_toolgroup_scope_403_no_bypass():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_single_project_agent(s)
        async with Session() as s:
            from app.routers.agent_routing_rules import create_rule
            from app.repositories.agent_routing_rule import AgentRoutingRuleRepository
            from app.schemas.agent_routing_rule import CreateRoutingRuleRequest

            resp = await create_rule(
                request=_request("/api/v2/agent-routing-rules", "POST"),
                body=CreateRoutingRuleRequest(agent_id=seeded["agent_id"], name="r"),
                auth=_auth(seeded["agent_id"], seeded["org_id"], seeded["project_id"], scope=["docs"]),
                repo=AgentRoutingRuleRepository(s),
            )
            assert resp.status_code == 403
    finally:
        await engine.dispose()


async def test_replace_rules_toolgroup_scope_403_no_bypass():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_single_project_agent(s)
            await _seed_rule(s, seeded["org_id"], seeded["project_id"], seeded["agent_id"])
        async with Session() as s:
            from app.routers.agent_routing_rules import replace_or_update_rules
            from app.repositories.agent_routing_rule import AgentRoutingRuleRepository

            resp = await replace_or_update_rules(
                request=_request("/api/v2/agent-routing-rules", "PUT"),
                body={"items": [{"agent_id": str(seeded["agent_id"]), "name": "new"}], "project_id": str(seeded["project_id"])},
                auth=_auth(seeded["agent_id"], seeded["org_id"], seeded["project_id"], scope=["docs"]),
                repo=AgentRoutingRuleRepository(s),
            )
            assert resp.status_code == 403
    finally:
        await engine.dispose()


async def test_disable_all_toolgroup_scope_403_no_bypass():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_single_project_agent(s)
        async with Session() as s:
            from app.routers.agent_routing_rules import reorder_or_disable_rules
            from app.repositories.agent_routing_rule import AgentRoutingRuleRepository

            resp = await reorder_or_disable_rules(
                request=_request("/api/v2/agent-routing-rules", "PATCH"),
                body={"disable_all": True},
                auth=_auth(seeded["agent_id"], seeded["org_id"], seeded["project_id"], scope=["docs"]),
                repo=AgentRoutingRuleRepository(s),
            )
            assert resp.status_code == 403
    finally:
        await engine.dispose()


async def test_delete_rule_toolgroup_scope_403_no_bypass():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_single_project_agent(s)
            rule_id = await _seed_rule(s, seeded["org_id"], seeded["project_id"], seeded["agent_id"])
        async with Session() as s:
            from app.routers.agent_routing_rules import delete_rule
            from app.repositories.agent_routing_rule import AgentRoutingRuleRepository

            resp = await delete_rule(
                request=_request("/api/v2/agent-routing-rules", "DELETE"),
                id=rule_id,
                auth=_auth(seeded["agent_id"], seeded["org_id"], seeded["project_id"], scope=["docs"]),
                repo=AgentRoutingRuleRepository(s),
            )
            assert resp.status_code == 403
    finally:
        await engine.dispose()


async def test_update_hitl_policy_toolgroup_scope_403_no_bypass():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_single_project_agent(s)
        async with Session() as s:
            from app.routers.hitl import update_hitl_policy
            from app.repositories.hitl import HitlRepository
            from app.schemas.hitl import PatchHitlPolicyRequest

            resp = await update_hitl_policy(
                request=_request("/api/v2/hitl/policy", "PATCH"),
                body=PatchHitlPolicyRequest(approval_rules=[], timeout_classes=[]),
                auth=_auth(seeded["agent_id"], seeded["org_id"], seeded["project_id"], scope=["docs"]),
                repo=HitlRepository(s),
            )
            assert resp.status_code == 403
    finally:
        await engine.dispose()


async def test_resolve_hitl_request_toolgroup_scope_403_no_bypass():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_single_project_agent(s)
            req_id = await _seed_hitl_request(s, seeded["org_id"], seeded["project_id"], seeded["agent_id"])
        async with Session() as s:
            from app.routers.hitl import resolve_hitl_request
            from app.repositories.hitl import HitlRepository
            from app.schemas.hitl import ResolveHitlRequestBody

            resp = await resolve_hitl_request(
                request_id=req_id,
                body=ResolveHitlRequestBody(status="approved"),
                request=_request("/api/v2/hitl/requests/x", "PATCH"),
                auth=_auth(seeded["agent_id"], seeded["org_id"], seeded["project_id"], scope=["docs"]),
                repo=HitlRepository(s),
            )
            assert resp.status_code == 403
    finally:
        await engine.dispose()


# ── malformed-vs-unspecified project_id(falsy 값 오인 방지) ───────────────────

async def test_replace_rules_empty_string_project_id_400_not_treated_as_unspecified():
    """`project_id: ""`(falsy지만 명시 제공)는 미지정이 아닌 malformed로 400 처리돼야 함."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_single_project_agent(s)
        async with Session() as s:
            from app.routers.agent_routing_rules import replace_or_update_rules
            from app.repositories.agent_routing_rule import AgentRoutingRuleRepository

            resp = await replace_or_update_rules(
                request=_request("/api/v2/agent-routing-rules", "PUT"),
                body={"items": [{"agent_id": str(seeded["agent_id"]), "name": "new"}], "project_id": ""},
                auth=_auth(seeded["agent_id"], seeded["org_id"], seeded["project_id"], scope=["read", "write"]),
                repo=AgentRoutingRuleRepository(s),
            )
            assert resp.status_code == 400
    finally:
        await engine.dispose()
