"""story #2889(S2h①③, 페드루 확定 2026-08-21) — gate/pull_request/member를 reference_registry의
TARGET_ONLY_TYPES로 등록 + gate/pull_request의 backlinks READ 엔드포인트 신설, 실PG 검증.

WRITE(entity_references target_type=gate/pull_request/member 저장)는 이미 배선된
`insert_chat_mentions`를 target_types 파라미터만 넓혀 재사용한다(재구현 0 — conversations.py의
send_message가 이미 이렇게 호출). 이 스토리의 신규 로직은 ③(존재판정 resolver 3종:
_resolve_gates/_resolve_pull_requests/_resolve_members) + ①(BACKLINKS_ALLOWED_TARGET_TYPES
확장 + GET /{id}/backlinks 엔드포인트 2개, gate·pull_request 대상, member는 backlinks 대상
아님 — 원 계약이 존재판정+멘션감지까지만).

커버:
  AC-③: 존재판정 resolver 3종(gate/pull_request/member) 실PG 왕복 — insert_chat_mentions가
        각 타입 토큰을 entity_references에 저장하는지(=resolver가 "존재함"을 올바로 판정).
  AC-①-gate: GET /api/v2/gates/{id}/backlinks — mention→backlinks 왕복, 404(비존재/타project).
  AC-①-pr: GET /api/v2/integrations/github/links/{id}/backlinks — 동형.
  AC-parity: 레지스트리 집합 고정(TARGET_ONLY_TYPES/TARGET_ONLY_RESOLVERS/
        BACKLINKS_ALLOWED_TARGET_TYPES) — 조용한 드리프트 방지 핀(#2889 확定 계약 그대로).
"""
from __future__ import annotations

import os
import uuid
from datetime import UTC, datetime

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


# ─── seeding ────────────────────────────────────────────────────────────────

async def _seed_org_project(session, name_suffix=""):
    from app.models.organization import Organization
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name=f"Org2889{name_suffix}", slug=f"org2889-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    return org.id, project.id


async def _seed_agent(session, org_id, project_id):
    from app.models.member import AgentProjectProfile, Member
    from app.models.project_access import ProjectAccess

    member_id = uuid.uuid4()
    session.add(Member(id=member_id, org_id=org_id, type="agent", name="agent"))
    await session.commit()
    session.add(AgentProjectProfile(id=uuid.uuid4(), member_id=member_id, project_id=project_id))
    await session.commit()
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project_id, member_id=member_id, permission="granted",
    ))
    await session.commit()
    return member_id


async def _seed_story(session, org_id, project_id, title="스토리"):
    from app.models.pm import Story

    story = Story(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title,
        status="backlog", priority="medium",
    )
    session.add(story)
    await session.commit()
    return story


async def _seed_gate(session, org_id, story_id, gate_type="qa"):
    from app.models.gate import Gate

    gate = Gate(
        id=uuid.uuid4(), org_id=org_id, work_item_id=story_id, work_item_type="story",
        gate_type=gate_type, status="pending",
    )
    session.add(gate)
    await session.commit()
    return gate


async def _seed_pr_link(session, org_id, story_id, pr_number=1):
    from app.models.pull_request_story_link import PullRequestStoryLink

    link = PullRequestStoryLink(
        id=uuid.uuid4(), org_id=org_id, story_id=story_id, repo_full_name="moonklabs/sprintable",
        pr_number=pr_number, link_source="explicit", confidence="high",
    )
    session.add(link)
    await session.commit()
    return link


async def _seed_conversation(session, org_id, project_id, member_ids, created_by):
    from app.models.conversation import Conversation, ConversationParticipant

    conv = Conversation(
        id=uuid.uuid4(), project_id=project_id, org_id=org_id, type="group",
        title="T", created_by=created_by,
    )
    session.add(conv)
    await session.flush()
    for mid in member_ids:
        session.add(ConversationParticipant(conversation_id=conv.id, member_id=mid))
    await session.commit()
    return conv.id


async def _seed_message(session, conversation_id, sender_id, content="본문"):
    from app.models.conversation import ConversationMessage
    msg = ConversationMessage(
        id=uuid.uuid4(), conversation_id=conversation_id, sender_id=sender_id, content=content,
        created_at=datetime.now(UTC),
    )
    session.add(msg)
    await session.commit()
    return msg


def _agent_auth(agent_id, org_id, project_id):
    from app.dependencies.auth import AuthContext
    return AuthContext(
        user_id=str(agent_id), email=None,
        claims={"app_metadata": {
            "org_id": str(org_id), "project_id": str(project_id), "api_key_id": str(uuid.uuid4()),
        }},
    )


async def _setup_app(app, Session, agent_id, org_id, project_id):
    from app.dependencies.auth import get_current_user
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
        return _agent_auth(agent_id, org_id, project_id)

    override_db_and_read(app, _db)
    app.dependency_overrides[get_current_user] = _auth


def _client_for(app):
    from httpx import ASGITransport, AsyncClient
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def _target_only_token(entity_type: str, entity_id, title: str) -> str:
    """gate/pull_request/member는 TARGET_ONLY(완전지원 아님)라 `reference_token.
    build_reference_token()`이 `is_registered_entity_type`(=ENTITY_RESOLVERS 멤버십)로 걸러
    None을 준다(그 함수의 명시 계약, AC5) — 여기선 `_CHAT_TOKEN_RE`가 실제로 매치하는
    `[title](entity:type:id)` 원문을 직접 짓는다(파서 문법만 재사용, 신규 문법 0)."""
    return f"[{title}](entity:{entity_type}:{entity_id})"


async def _insert_mention(session, *, org_id, message_id, content, created_by):
    """conversations.py::send_message와 동일 배선 — target_types를 명시로 넓힌다(라우터가
    이미 이렇게 함, WIP diff 참고)."""
    from app.services.mention_parser import insert_chat_mentions
    from app.services.reference_registry import ENTITY_RESOLVERS

    return await insert_chat_mentions(
        session, org_id=org_id, message_id=message_id, content=content, created_by=created_by,
        target_types=frozenset(ENTITY_RESOLVERS) | {"gate", "pull_request", "member"},
    )


# ─── AC-③: 존재판정 resolver 실PG 왕복 ──────────────────────────────────────

@pytest.mark.anyio
async def test_gate_mention_is_resolved_and_stored():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s, "G")
            agent_id = await _seed_agent(s, org_id, project_id)
            story = await _seed_story(s, org_id, project_id)
            gate = await _seed_gate(s, org_id, story.id)
            conv_id = await _seed_conversation(s, org_id, project_id, [agent_id], created_by=agent_id)

            token = _target_only_token("gate", gate.id, "게이트")
            msg = await _seed_message(s, conv_id, agent_id, content=f"확認 필요: {token}")
            result = await _insert_mention(s, org_id=org_id, message_id=msg.id, content=msg.content, created_by=agent_id)
            await s.commit()
            assert result.stored == 1, "_resolve_gates가 실존 gate를 못 찾으면 여기서 0으로 잡힌다"

            from sqlalchemy import select
            from app.models.reference import Reference
            row = (await s.execute(
                select(Reference).where(Reference.target_type == "gate", Reference.target_id == gate.id)
            )).scalar_one()
            assert row.source_id == msg.id
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_gate_mention_of_nonexistent_gate_is_not_stored():
    """존재판정 resolver가 실존하지 않는 id는 걸러야 한다(허위 참조 저장 방지)."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s, "GX")
            agent_id = await _seed_agent(s, org_id, project_id)
            conv_id = await _seed_conversation(s, org_id, project_id, [agent_id], created_by=agent_id)

            ghost_id = uuid.uuid4()
            token = _target_only_token("gate", ghost_id, "유령게이트")
            msg = await _seed_message(s, conv_id, agent_id, content=f"확認: {token}")
            result = await _insert_mention(s, org_id=org_id, message_id=msg.id, content=msg.content, created_by=agent_id)
            await s.commit()
            assert result.stored == 0
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_pull_request_mention_is_resolved_and_stored():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s, "PR")
            agent_id = await _seed_agent(s, org_id, project_id)
            story = await _seed_story(s, org_id, project_id)
            link = await _seed_pr_link(s, org_id, story.id)
            conv_id = await _seed_conversation(s, org_id, project_id, [agent_id], created_by=agent_id)

            token = _target_only_token("pull_request", link.id, "PR#1")
            msg = await _seed_message(s, conv_id, agent_id, content=f"리뷰: {token}")
            result = await _insert_mention(s, org_id=org_id, message_id=msg.id, content=msg.content, created_by=agent_id)
            await s.commit()
            assert result.stored == 1
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_pull_request_mention_excludes_soft_deleted_link():
    """_resolve_pull_requests가 deleted_at 필터를 지키는지 — story #2889 diff의 명시 요구."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s, "PRD")
            agent_id = await _seed_agent(s, org_id, project_id)
            story = await _seed_story(s, org_id, project_id)
            link = await _seed_pr_link(s, org_id, story.id)
            link.deleted_at = datetime.now(UTC)
            await s.commit()
            conv_id = await _seed_conversation(s, org_id, project_id, [agent_id], created_by=agent_id)

            token = _target_only_token("pull_request", link.id, "PR#1")
            msg = await _seed_message(s, conv_id, agent_id, content=f"리뷰: {token}")
            result = await _insert_mention(s, org_id=org_id, message_id=msg.id, content=msg.content, created_by=agent_id)
            await s.commit()
            assert result.stored == 0
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_member_mention_is_resolved_and_stored():
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s, "M")
            agent_id = await _seed_agent(s, org_id, project_id)
            other_id = await _seed_agent(s, org_id, project_id)
            conv_id = await _seed_conversation(s, org_id, project_id, [agent_id, other_id], created_by=agent_id)

            token = _target_only_token("member", other_id, "동료")
            msg = await _seed_message(s, conv_id, agent_id, content=f"담당: {token}")
            result = await _insert_mention(s, org_id=org_id, message_id=msg.id, content=msg.content, created_by=agent_id)
            await s.commit()
            assert result.stored == 1
    finally:
        await engine.dispose()


# ─── AC-①-gate: GET /api/v2/gates/{id}/backlinks ────────────────────────────

@pytest.mark.anyio
async def test_gate_backlinks_returns_mentioning_message():
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s, "GB")
            agent_id = await _seed_agent(s, org_id, project_id)
            story = await _seed_story(s, org_id, project_id)
            gate = await _seed_gate(s, org_id, story.id)
            conv_id = await _seed_conversation(s, org_id, project_id, [agent_id], created_by=agent_id)

            token = _target_only_token("gate", gate.id, "게이트")
            msg = await _seed_message(s, conv_id, agent_id, content=f"확認: {token}")
            result = await _insert_mention(s, org_id=org_id, message_id=msg.id, content=msg.content, created_by=agent_id)
            await s.commit()
            assert result.stored == 1
            msg_id, gate_id = msg.id, gate.id

        await _setup_app(app, Session, agent_id, org_id, project_id)
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/gates/{gate_id}/backlinks")
            assert resp.status_code == 200, resp.text
            source_ids = {item["source_id"] for item in resp.json()["data"]}
            assert str(msg_id) in source_ids
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_gate_backlinks_nonexistent_gate_returns_404():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s, "GB404")
            agent_id = await _seed_agent(s, org_id, project_id)

        await _setup_app(app, Session, agent_id, org_id, project_id)
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/gates/{uuid.uuid4()}/backlinks")
            assert resp.status_code == 404
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_gate_backlinks_cross_project_returns_404():
    """SEC-S8류 선례 — 같은 org·다른 project의 gate는 존재 비노출 404(resolve_work_item_project_id
    → require_project_access 경유, get_gate_endpoint와 동형 상속)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_a = await _seed_org_project(s, "GBX")
            from app.models.project import Project
            project_b = Project(id=uuid.uuid4(), org_id=org_id, name="ProjectB")
            s.add(project_b)
            await s.commit()

            agent_in_a = await _seed_agent(s, org_id, project_a)
            story_in_b = await _seed_story(s, org_id, project_b.id)
            gate_in_b = await _seed_gate(s, org_id, story_in_b.id)

        await _setup_app(app, Session, agent_in_a, org_id, project_a)
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/gates/{gate_in_b.id}/backlinks")
            assert resp.status_code == 404
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


# ─── AC-①-pr: GET /api/v2/integrations/github/links/{id}/backlinks ─────────

@pytest.mark.anyio
async def test_pr_link_backlinks_returns_mentioning_message():
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s, "PRB")
            agent_id = await _seed_agent(s, org_id, project_id)
            story = await _seed_story(s, org_id, project_id)
            link = await _seed_pr_link(s, org_id, story.id)
            conv_id = await _seed_conversation(s, org_id, project_id, [agent_id], created_by=agent_id)

            token = _target_only_token("pull_request", link.id, "PR#1")
            msg = await _seed_message(s, conv_id, agent_id, content=f"리뷰: {token}")
            result = await _insert_mention(s, org_id=org_id, message_id=msg.id, content=msg.content, created_by=agent_id)
            await s.commit()
            assert result.stored == 1
            msg_id, link_id = msg.id, link.id

        await _setup_app(app, Session, agent_id, org_id, project_id)
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/integrations/github/links/{link_id}/backlinks")
            assert resp.status_code == 200, resp.text
            source_ids = {item["source_id"] for item in resp.json()["data"]}
            assert str(msg_id) in source_ids
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_pr_link_backlinks_nonexistent_link_returns_404():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s, "PRB404")
            agent_id = await _seed_agent(s, org_id, project_id)

        await _setup_app(app, Session, agent_id, org_id, project_id)
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/integrations/github/links/{uuid.uuid4()}/backlinks")
            assert resp.status_code == 404
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_pr_link_backlinks_cross_project_returns_404():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_a = await _seed_org_project(s, "PRBX")
            from app.models.project import Project
            project_b = Project(id=uuid.uuid4(), org_id=org_id, name="ProjectB")
            s.add(project_b)
            await s.commit()

            agent_in_a = await _seed_agent(s, org_id, project_a)
            story_in_b = await _seed_story(s, org_id, project_b.id)
            link_in_b = await _seed_pr_link(s, org_id, story_in_b.id)

        await _setup_app(app, Session, agent_in_a, org_id, project_a)
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/integrations/github/links/{link_in_b.id}/backlinks")
            assert resp.status_code == 404
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


# ─── AC-parity: 레지스트리 집합 고정(조용한 드리프트 방지 핀) ───────────────────

def test_registry_target_only_types_pinned():
    """story #2889 확定 계약 — gate/pull_request/member가 TARGET_ONLY(완전지원 아님)로
    고정됐다는 판정을 테스트로 pin한다(판정 근거+무너지는 조건, feedback_pin_declarations_
    as_tests 관례). 이 세트가 조용히 늘거나 줄면(오타·재구현) 여기서 즉시 빨개진다 — FE
    (미르코군) 쪽 gate 프리뷰·원탭 카드가 기대하는 백엔드 표면의 앵커이기도 하다."""
    from app.services.reference_registry import ENTITY_RESOLVERS, TARGET_ONLY_RESOLVERS, TARGET_ONLY_TYPES

    assert TARGET_ONLY_TYPES == frozenset({"chat_message", "gate", "pull_request", "member"})
    assert set(TARGET_ONLY_RESOLVERS) == set(TARGET_ONLY_TYPES)
    # 완전지원(검색/MCP/project축/명시생성) 목록엔 이 3종이 없어야 한다 — 있으면 그 4계약도
    # 진 것으로 오인돼 POST /references 명시생성·검색 picker가 열려버린다(§reference_registry.py
    # docstring 불변식).
    for t in ("gate", "pull_request", "member"):
        assert t not in ENTITY_RESOLVERS, f"{t}는 TARGET_ONLY여야 하는데 ENTITY_RESOLVERS(완전지원)에 있음"


def test_backlinks_allowed_target_types_pinned():
    from app.services.backlinks import BACKLINKS_ALLOWED_TARGET_TYPES

    assert BACKLINKS_ALLOWED_TARGET_TYPES == frozenset({"doc", "story", "artifact", "gate", "pull_request"})
    # member는 의도적으로 backlinks 대상이 아니다(원 계약=존재판정+멘션감지까지, #2889 확定).
    assert "member" not in BACKLINKS_ALLOWED_TARGET_TYPES
