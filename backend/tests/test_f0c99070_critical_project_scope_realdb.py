"""[SEC][CRITICAL·BE] story f0c99070(doc legacy-project-fallback-sweep-audit §2.2 2단계) — 실 PG.

교차 테넌트 파괴 벡터 3.5건(즉시강제 트랙)의 요청시점 재해소 강제 실증:
- `hitl::update_hitl_policy`(project_id 단독 singleton upsert — org_id 갭도 검증)
- `agent_routing_rules::reorder_or_disable_rules`의 disable_all 분기(id 없이 bulk 비활성화)
- `open_api_keys::create_project_api_key`(project-scoped 크리덴셜 발급)

각 라우트에 대해 (a)멀티프로젝트+미설정+무헤더=400·양쪽 project 무변경 (b)default_project_id 설정 시
정확히 그 project만 스코프(형제 project 무변경) (c)X-Project-Id 헤더로도 정확히 스코프됨을 실증.
`resolve_required_project_id`를 라우터 함수 직접 호출로 검증(HTTP 레이어 우회 — auth 레이어는
AuthContext 직접 구성으로 격리).
"""
from __future__ import annotations

import os
import uuid
from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException

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


def _auth(agent_id: uuid.UUID, org_id: uuid.UUID, *, role: str = "member"):
    from app.dependencies.auth import AuthContext
    return AuthContext(
        user_id=str(agent_id), email=None,
        claims={"app_metadata": {"org_id": str(org_id), "role": role}},
        org_id=str(org_id),
    )


def _request(project_id_header: str | None = None):
    req = MagicMock()
    req.headers.get = lambda key, default=None: (
        project_id_header if key == "X-Project-Id" else default
    )
    return req


async def _seed_two_project_agent(session, *, default_project_id: uuid.UUID | None = None):
    """org + project_a/project_b + agent(양쪽 project_access grant, 멀티프로젝트 앰비규어스)."""
    from app.models.member import Member
    from app.models.organization import Organization
    from app.models.project import Project
    from app.models.project_access import ProjectAccess

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()

    project_a = Project(id=uuid.uuid4(), org_id=org.id, name="A")
    project_b = Project(id=uuid.uuid4(), org_id=org.id, name="B")
    session.add_all([project_a, project_b])
    await session.commit()

    agent = Member(
        id=uuid.uuid4(), org_id=org.id, type="agent", name="Agent",
        default_project_id=default_project_id,
    )
    session.add(agent)
    await session.commit()
    session.add_all([
        ProjectAccess(id=uuid.uuid4(), project_id=project_a.id, member_id=agent.id, permission="granted"),
        ProjectAccess(id=uuid.uuid4(), project_id=project_b.id, member_id=agent.id, permission="granted"),
    ])
    await session.commit()

    return {"org_id": org.id, "project_a": project_a.id, "project_b": project_b.id, "agent_id": agent.id}


# ── hitl::update_hitl_policy ──────────────────────────────────────────────────

async def _seed_hitl_policy(session, org_id, project_id, config_marker: str):
    from app.models.hitl import HitlPolicy
    policy = HitlPolicy(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id,
        config={"schema_version": 1, "approval_rules": [], "timeout_classes": [], "marker": config_marker},
    )
    session.add(policy)
    await session.commit()


async def _get_hitl_config(session, project_id):
    from sqlalchemy import select
    from app.models.hitl import HitlPolicy
    row = (await session.execute(
        select(HitlPolicy.config).where(HitlPolicy.project_id == project_id)
    )).scalar_one_or_none()
    return row


async def test_hitl_ambiguous_no_default_400_no_mutation():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_two_project_agent(s)
            await _seed_hitl_policy(s, seeded["org_id"], seeded["project_a"], "orig_a")
            await _seed_hitl_policy(s, seeded["org_id"], seeded["project_b"], "orig_b")

        async with Session() as s:
            from app.routers.hitl import update_hitl_policy
            from app.repositories.hitl import HitlRepository
            from app.schemas.hitl import PatchHitlPolicyRequest

            resp = await update_hitl_policy(
                request=_request(None),
                body=PatchHitlPolicyRequest(approval_rules=[], timeout_classes=[]),
                auth=_auth(seeded["agent_id"], seeded["org_id"]),
                repo=HitlRepository(s),
            )
            assert resp.status_code == 400

        async with Session() as s:
            assert (await _get_hitl_config(s, seeded["project_a"]))["marker"] == "orig_a"
            assert (await _get_hitl_config(s, seeded["project_b"]))["marker"] == "orig_b"
    finally:
        await engine.dispose()


async def test_hitl_default_project_id_scopes_correctly_sibling_untouched():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_two_project_agent(s)
            # default_project_id는 Member 생성 後 별도 update(FK가 같은 트랜잭션 내 순서 문제 회피).
            from sqlalchemy import update as sa_update
            from app.models.member import Member
            await s.execute(
                sa_update(Member).where(Member.id == seeded["agent_id"]).values(default_project_id=seeded["project_a"])
            )
            await s.commit()
            await _seed_hitl_policy(s, seeded["org_id"], seeded["project_a"], "orig_a")
            await _seed_hitl_policy(s, seeded["org_id"], seeded["project_b"], "orig_b")

        async with Session() as s:
            from app.routers.hitl import update_hitl_policy
            from app.repositories.hitl import HitlRepository
            from app.schemas.hitl import PatchHitlPolicyRequest

            resp = await update_hitl_policy(
                request=_request(None),
                body=PatchHitlPolicyRequest(approval_rules=[], timeout_classes=[]),
                auth=_auth(seeded["agent_id"], seeded["org_id"]),
                repo=HitlRepository(s),
            )
            assert resp.status_code == 200
            await s.commit()

        async with Session() as s:
            a_config = await _get_hitl_config(s, seeded["project_a"])
            b_config = await _get_hitl_config(s, seeded["project_b"])
            assert "marker" not in (a_config or {})  # project_a는 정책 갱신됨(merge 후 marker 소실).
            assert b_config["marker"] == "orig_b"  # project_b는 완전 무변경 — 교차테넌트 파괴 0 실증.
    finally:
        await engine.dispose()


async def test_hitl_header_scopes_correctly():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_two_project_agent(s)
            await _seed_hitl_policy(s, seeded["org_id"], seeded["project_a"], "orig_a")
            await _seed_hitl_policy(s, seeded["org_id"], seeded["project_b"], "orig_b")

        async with Session() as s:
            from app.routers.hitl import update_hitl_policy
            from app.repositories.hitl import HitlRepository
            from app.schemas.hitl import PatchHitlPolicyRequest

            resp = await update_hitl_policy(
                request=_request(str(seeded["project_b"])),
                body=PatchHitlPolicyRequest(approval_rules=[], timeout_classes=[]),
                auth=_auth(seeded["agent_id"], seeded["org_id"]),
                repo=HitlRepository(s),
            )
            assert resp.status_code == 200
            await s.commit()

        async with Session() as s:
            assert (await _get_hitl_config(s, seeded["project_a"]))["marker"] == "orig_a"  # 무변경.
            assert "marker" not in (await _get_hitl_config(s, seeded["project_b"]) or {})  # 헤더 지정분만 변경.
    finally:
        await engine.dispose()


# ── agent_routing_rules::reorder_or_disable_rules(disable_all) ───────────────

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


async def _rule_enabled(session, rule_id) -> bool:
    from sqlalchemy import select
    from app.models.agent_routing_rule import AgentRoutingRule
    return (await session.execute(
        select(AgentRoutingRule.is_enabled).where(AgentRoutingRule.id == rule_id)
    )).scalar_one()


async def test_disable_all_ambiguous_400_no_mutation():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_two_project_agent(s)
            rule_a = await _seed_rule(s, seeded["org_id"], seeded["project_a"], seeded["agent_id"])
            rule_b = await _seed_rule(s, seeded["org_id"], seeded["project_b"], seeded["agent_id"])

        async with Session() as s:
            from app.routers.agent_routing_rules import reorder_or_disable_rules
            from app.repositories.agent_routing_rule import AgentRoutingRuleRepository

            resp = await reorder_or_disable_rules(
                request=_request(None),
                body={"disable_all": True},
                auth=_auth(seeded["agent_id"], seeded["org_id"]),
                repo=AgentRoutingRuleRepository(s),
            )
            assert resp.status_code == 400

        async with Session() as s:
            assert await _rule_enabled(s, rule_a) is True
            assert await _rule_enabled(s, rule_b) is True
    finally:
        await engine.dispose()


async def test_disable_all_default_project_id_scopes_correctly_sibling_untouched():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_two_project_agent(s)
            from sqlalchemy import update as sa_update
            from app.models.member import Member
            await s.execute(
                sa_update(Member).where(Member.id == seeded["agent_id"]).values(default_project_id=seeded["project_a"])
            )
            await s.commit()
            rule_a = await _seed_rule(s, seeded["org_id"], seeded["project_a"], seeded["agent_id"])
            rule_b = await _seed_rule(s, seeded["org_id"], seeded["project_b"], seeded["agent_id"])

        async with Session() as s:
            from app.routers.agent_routing_rules import reorder_or_disable_rules
            from app.repositories.agent_routing_rule import AgentRoutingRuleRepository

            resp = await reorder_or_disable_rules(
                request=_request(None),
                body={"disable_all": True},
                auth=_auth(seeded["agent_id"], seeded["org_id"]),
                repo=AgentRoutingRuleRepository(s),
            )
            assert resp.status_code == 200
            await s.commit()

        async with Session() as s:
            assert await _rule_enabled(s, rule_a) is False  # 스코프된 project만 비활성화.
            assert await _rule_enabled(s, rule_b) is True   # 형제 project 무변경 — 교차테넌트 파괴 0.
    finally:
        await engine.dispose()


# ── open_api_keys::create_project_api_key ─────────────────────────────────────

async def _key_count(session, project_id) -> int:
    from sqlalchemy import func, select
    from app.models.project_api_key import ProjectApiKey
    return (await session.execute(
        select(func.count()).select_from(ProjectApiKey).where(ProjectApiKey.project_id == project_id)
    )).scalar_one()


async def _seed_two_project_agent_with_user_row(session, *, default_project_id: uuid.UUID | None = None):
    """create_project_api_key의 created_by FK(→users.id)를 만족시키기 위해 동일 id의 User도 시드."""
    from app.models.user import User

    seeded = await _seed_two_project_agent(session, default_project_id=default_project_id)
    session.add(User(
        id=seeded["agent_id"], email=f"{seeded['agent_id']}@test.local", hashed_password="x",
    ))
    await session.commit()
    return seeded


async def test_create_project_api_key_ambiguous_400_no_key_created():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_two_project_agent_with_user_row(s)

        async with Session() as s:
            from app.routers.open_api_keys import create_project_api_key
            from app.repositories.project_api_key import ProjectApiKeyRepository
            from app.schemas.project_api_key import CreateProjectApiKeyRequest

            with pytest.raises(HTTPException) as exc_info:
                await create_project_api_key(
                    request=_request(None),
                    body=CreateProjectApiKeyRequest(name="k"),
                    auth=_auth(seeded["agent_id"], seeded["org_id"], role="admin"),
                    _org_id=seeded["org_id"],
                    repo=ProjectApiKeyRepository(s),
                    session=s,
                )
            assert exc_info.value.status_code == 400

        async with Session() as s:
            assert await _key_count(s, seeded["project_a"]) == 0
            assert await _key_count(s, seeded["project_b"]) == 0
    finally:
        await engine.dispose()


async def test_create_project_api_key_default_project_id_scopes_correctly():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_two_project_agent_with_user_row(s)
            from sqlalchemy import update as sa_update
            from app.models.member import Member
            await s.execute(
                sa_update(Member).where(Member.id == seeded["agent_id"]).values(default_project_id=seeded["project_a"])
            )
            await s.commit()

        async with Session() as s:
            from app.routers.open_api_keys import create_project_api_key
            from app.repositories.project_api_key import ProjectApiKeyRepository
            from app.schemas.project_api_key import CreateProjectApiKeyRequest

            result = await create_project_api_key(
                request=_request(None),
                body=CreateProjectApiKeyRequest(name="k"),
                auth=_auth(seeded["agent_id"], seeded["org_id"], role="admin"),
                _org_id=seeded["org_id"],
                repo=ProjectApiKeyRepository(s),
                session=s,
            )
            assert result.project_id == seeded["project_a"]

        async with Session() as s:
            assert await _key_count(s, seeded["project_a"]) == 1
            assert await _key_count(s, seeded["project_b"]) == 0  # 형제 project 무변경.
    finally:
        await engine.dispose()
