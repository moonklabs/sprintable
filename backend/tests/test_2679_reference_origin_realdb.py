"""story #2679([채팅·참조] «샾+숫자» 텍스트 자동 링크화가 거짓 참조를 제조) — 실PG 검증.

미르코 핸드오프 스펙(스토리 본문) + PO 스코프 확대 판정(ⓐ, 2026-08-16: chat뿐 아니라
story description/acceptance_criteria의 `resolve_bare_number_story_refs`(#2269 C-11 축A)도
같은 클래스라 함께 origin='auto'로 가른다) 그대로 검증한다.

커버:
  ①WRITE — chat 경로: 브라켓 명시 멘션(`send_message` 통해 실 전송)은 origin='explicit',
    맨 `#N`(story_ref_promoter 승격)은 origin='auto'.
  ②WRITE — story description 경로: 브라켓 명시 멘션은 origin='explicit', 맨 `#N`은
    origin='auto'(resolve_bare_number_story_refs, `_reconcile_story_references_and_candidates`
    공용 코어 경유).
  ③READ — GET /api/v2/stories/{id}/backlinks: origin='auto' 참조는 응답에서 빠지고
    origin='explicit'만 나온다(그래프/카운트 오염 제거가 이 스토리의 핵심 관심사).
  ④무회귀 — 기존 명시 참조(브라켓 토큰)는 여전히 backlinks에 뜬다(음성대조와 짝을 이루는
    양성대조 — origin 필터가 전부를 지워버리는 공허과잉이 아님을 확인).
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


# ─── seeding — test_1994/test_2266/test_2629의 동형 anchor 패턴 재사용 ──────────

async def _seed_org_project(session):
    from app.models.organization import Organization
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="Org2679", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    return org, project


async def _seed_human(session, org_id, project_id):
    from app.models.member import Member
    from app.models.project import OrgMember
    from app.models.project_access import ProjectAccess
    from app.models.user import User

    user_id = uuid.uuid4()
    session.add(User(id=user_id, email=f"h-{user_id.hex[:8]}@test.com", hashed_password="x"))
    await session.commit()
    om = OrgMember(id=uuid.uuid4(), org_id=org_id, user_id=user_id, role="member")
    session.add(om)
    await session.commit()
    session.add(Member(id=om.id, org_id=org_id, type="human", user_id=user_id, name="Human"))
    await session.commit()
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project_id, org_member_id=om.id, member_id=om.id,
        permission="granted", role="member",
    ))
    await session.commit()
    return om.id, user_id


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


async def _seed_story(session, org_id, project_id, *, number, title="S"):
    from app.models.pm import Story
    story = Story(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title,
        status="backlog", story_number=number,
    )
    session.add(story)
    await session.commit()
    return story


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


def _agent_auth(agent_id, org_id):
    from app.dependencies.auth import AuthContext
    return AuthContext(
        user_id=str(agent_id), email=None,
        claims={"app_metadata": {"org_id": str(org_id), "api_key_id": str(uuid.uuid4())}},
    )


def _client_for(app):
    from httpx import ASGITransport, AsyncClient
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _setup_app_human(app, Session, user_id, org_id):
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

    async def _user():
        return AuthContext(user_id=str(user_id), email="h@test.com", claims={"app_metadata": {"org_id": str(org_id)}})

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _user


# ─── ① WRITE — chat 경로 ────────────────────────────────────────────────────────

async def test_chat_bare_number_reference_stored_as_auto():
    from fastapi import BackgroundTasks
    from app.models.reference import Reference
    from app.routers.conversations import SendMessageRequest, send_message
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, project = await _seed_org_project(s)
            agent_id = await _seed_agent(s, org.id, project.id)
            target = await _seed_story(s, org.id, project.id, number=24, title="타깃")
            conv_id = await _seed_conversation(s, org.id, project.id, [agent_id], created_by=agent_id)

        async with Session() as s:
            result = await send_message(
                conversation_id=conv_id,
                body=SendMessageRequest(content="확인은 #24 참고"),
                background_tasks=BackgroundTasks(),
                db=s, auth=_agent_auth(agent_id, org.id), org_id=org.id,
            )

        async with Session() as s:
            rows = (await s.execute(
                select(Reference).where(
                    Reference.org_id == org.id,
                    Reference.source_id == uuid.UUID(result["data"]["id"]),
                    Reference.target_type == "story", Reference.target_id == target.id,
                )
            )).scalars().all()
            assert len(rows) == 1
            assert rows[0].origin == "auto"
    finally:
        await engine.dispose()


async def test_chat_explicit_bracket_mention_stored_as_explicit():
    from fastapi import BackgroundTasks
    from app.models.reference import Reference
    from app.routers.conversations import SendMessageRequest, send_message
    from app.services.reference_token import build_reference_token
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, project = await _seed_org_project(s)
            agent_id = await _seed_agent(s, org.id, project.id)
            target = await _seed_story(s, org.id, project.id, number=24, title="타깃")
            conv_id = await _seed_conversation(s, org.id, project.id, [agent_id], created_by=agent_id)

        token = build_reference_token("story", target.id, "타깃")
        async with Session() as s:
            result = await send_message(
                conversation_id=conv_id,
                body=SendMessageRequest(content=f"참고: {token}"),
                background_tasks=BackgroundTasks(),
                db=s, auth=_agent_auth(agent_id, org.id), org_id=org.id,
            )

        async with Session() as s:
            rows = (await s.execute(
                select(Reference).where(
                    Reference.org_id == org.id,
                    Reference.source_id == uuid.UUID(result["data"]["id"]),
                    Reference.target_type == "story", Reference.target_id == target.id,
                )
            )).scalars().all()
            assert len(rows) == 1
            assert rows[0].origin == "explicit"
    finally:
        await engine.dispose()


# ─── ② WRITE — story description 경로(#2269 축A, PO 스코프 확대 ⓐ) ─────────────

async def test_story_description_bare_number_reference_stored_as_auto():
    from app.routers.stories import _reconcile_story_references_and_candidates
    from app.models.reference import Reference
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, project = await _seed_org_project(s)
            member_id, _user_id = await _seed_human(s, org.id, project.id)
            target = await _seed_story(s, org.id, project.id, number=24, title="타깃")
            source = await _seed_story(s, org.id, project.id, number=25, title="소스")
            source.description = "관련: #24 확인 바람"
            await s.commit()

            await _reconcile_story_references_and_candidates(
                s, org_id=org.id, story=source, check_description=True,
                check_acceptance_criteria=False, mention_actor_id=member_id,
            )
            await s.commit()

        async with Session() as s:
            rows = (await s.execute(
                select(Reference).where(
                    Reference.org_id == org.id, Reference.source_type == "story",
                    Reference.source_id == source.id,
                    Reference.target_type == "story", Reference.target_id == target.id,
                )
            )).scalars().all()
            assert len(rows) == 1
            assert rows[0].origin == "auto"
    finally:
        await engine.dispose()


async def test_story_description_explicit_bracket_mention_stored_as_explicit():
    from app.routers.stories import _reconcile_story_references_and_candidates
    from app.models.reference import Reference
    from app.services.reference_token import build_reference_token
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, project = await _seed_org_project(s)
            member_id, _user_id = await _seed_human(s, org.id, project.id)
            target = await _seed_story(s, org.id, project.id, number=24, title="타깃")
            source = await _seed_story(s, org.id, project.id, number=25, title="소스")
            token = build_reference_token("story", target.id, "타깃")
            source.description = f"관련: {token} 확인 바람"
            await s.commit()

            await _reconcile_story_references_and_candidates(
                s, org_id=org.id, story=source, check_description=True,
                check_acceptance_criteria=False, mention_actor_id=member_id,
            )
            await s.commit()

        async with Session() as s:
            rows = (await s.execute(
                select(Reference).where(
                    Reference.org_id == org.id, Reference.source_type == "story",
                    Reference.source_id == source.id,
                    Reference.target_type == "story", Reference.target_id == target.id,
                )
            )).scalars().all()
            assert len(rows) == 1
            assert rows[0].origin == "explicit"
    finally:
        await engine.dispose()


# ─── ③④ READ — GET /api/v2/stories/{id}/backlinks: auto 제외·explicit 포함 ──────

async def _make_reference(session, org_id, source_type, source_id, target_type, target_id, created_by, origin):
    from app.models.reference import Reference
    ref = Reference(
        id=uuid.uuid4(), org_id=org_id, source_type=source_type, source_field="body",
        source_id=source_id, target_type=target_type, target_id=target_id, form="mention",
        origin=origin, created_by=created_by,
    )
    session.add(ref)
    await session.commit()
    return ref


async def test_backlinks_endpoint_excludes_auto_includes_explicit():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org, project = await _seed_org_project(s)
            caller_id, caller_user_id = await _seed_human(s, org.id, project.id)
            target = await _seed_story(s, org.id, project.id, number=1, title="타깃")
            auto_source = await _seed_story(s, org.id, project.id, number=2, title="auto 소스")
            explicit_source = await _seed_story(s, org.id, project.id, number=3, title="explicit 소스")
            await _make_reference(
                s, org.id, "story", auto_source.id, "story", target.id, caller_id, "auto",
            )
            await _make_reference(
                s, org.id, "story", explicit_source.id, "story", target.id, caller_id, "explicit",
            )

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/stories/{target.id}/backlinks")
            assert resp.status_code == 200, resp.text
            body = resp.json()
            source_ids = {item["source_id"] for item in body["data"]}
            # 핵심 관심사(스토리 원 제목) — auto(#2679의 원 결함 클래스)는 그래프에서 빠진다.
            assert str(auto_source.id) not in source_ids, "auto 참조가 backlinks에 새면 안 됨"
            # 음성대조와 짝(양성대조) — origin 필터가 전부를 지우는 공허과잉이 아님을 확인.
            assert str(explicit_source.id) in source_ids, "explicit 참조는 그대로 떠야 함"
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()
