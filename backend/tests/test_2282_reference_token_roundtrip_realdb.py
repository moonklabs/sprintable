"""story #2282(E-CONNECT) AC4 — 왕복 실증: 응답이 준 reference_token을 그대로 채팅에 보내면
entity_references에 행이 생기고 백링크에 뜬다. "문자열이 그럴듯하다"로 끝내지 않는다(AC4
자체 문구) — 실제 파서(extract_chat_entity_mentions)로 다시 파싱되는 것까지 증명한다.
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


async def _seed_org_project_member(session):
    """⛔#2266/#2273의 동명 helper와 달리 write-path 단독 테스트가 아니라 read-path
    (list_doc_backlinks) authz까지 재는지라 ProjectAccess도 명시 부여한다(test_1994의
    `_make_human_member`와 동형 — 없으면 캐ller가 project 접근이 없어 backlinks에서
    조용히 걸러진다, 이번 파일 작성 중 직접 걸린 자리)."""
    from app.models.organization import Organization
    from app.models.project import Project, OrgMember
    from app.models.project_access import ProjectAccess
    from app.models.user import User
    from app.models.member import Member

    user = User(id=uuid.uuid4(), email=f"u-{uuid.uuid4().hex[:8]}@test.local", hashed_password="x")
    session.add(user)
    await session.flush()
    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.flush()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="Project")
    session.add(project)
    await session.flush()
    om = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=user.id, role="member")
    session.add(om)
    await session.flush()
    member = Member(id=om.id, org_id=org.id, type="human", user_id=user.id, name="Test Human")
    session.add(member)
    await session.flush()
    session.add(ProjectAccess(project_id=project.id, org_member_id=om.id, member_id=member.id, role="member"))
    await session.commit()
    return org, project, member


async def _make_conversation(session, org_id, project_id, member_ids, created_by, conv_type="dm"):
    from app.models.conversation import Conversation, ConversationParticipant
    conv = Conversation(
        id=uuid.uuid4(), project_id=project_id, org_id=org_id, type=conv_type,
        title="Test convo", created_by=created_by,
    )
    session.add(conv)
    await session.flush()
    for mid in member_ids:
        session.add(ConversationParticipant(conversation_id=conv.id, member_id=mid))
    await session.commit()
    return conv.id


async def _add_message(session, conv_id, sender_id, content):
    from app.models.conversation import ConversationMessage
    msg = ConversationMessage(id=uuid.uuid4(), conversation_id=conv_id, sender_id=sender_id, content=content)
    session.add(msg)
    await session.commit()
    return msg


@pytest.mark.anyio
async def test_doc_response_reference_token_roundtrips_through_chat_into_entity_references():
    """⭐AC4 핵심 — 실 doc의 DocResponse.reference_token을 채팅 content로 그대로 보내면
    entity_references에 doc-target 행이 생기고, GET /docs/{id}/backlinks에 뜬다."""
    from app.models.doc import Doc
    from app.models.reference import Reference
    from app.schemas.doc import DocResponse
    from app.services.mention_parser import insert_chat_mentions
    from sqlalchemy import select

    engine, factory = await _session_factory()
    try:
        async with factory() as session:
            org, project, member = await _seed_org_project_member(session)
            other_member = (await _seed_org_project_member(session))[2]
            doc = Doc(
                id=uuid.uuid4(), org_id=org.id, project_id=project.id,
                title="Pricing Policy v2.1", slug=f"pricing-{uuid.uuid4().hex[:8]}", content="",
            )
            session.add(doc)
            await session.commit()

            # 응답이 실제로 주는 값 그대로(모델 검증 우회 없음).
            doc_response = DocResponse.model_validate(doc)
            token = doc_response.reference_token
            assert token == f"[Pricing Policy v2.1](entity:doc:{doc.id})"

            conv_id = await _make_conversation(
                session, org.id, project.id, [member.id, other_member.id], member.id,
            )
            msg = await _add_message(session, conv_id, member.id, f"참고: {token}")
            await insert_chat_mentions(
                session, org_id=org.id, message_id=msg.id, content=msg.content,
                created_by=member.id,
            )
            await session.commit()

            rows = (await session.execute(
                select(Reference).where(Reference.source_id == msg.id)
            )).scalars().all()
            assert len(rows) == 1
            assert rows[0].target_type == "doc"
            assert rows[0].target_id == doc.id
            assert rows[0].form == "mention"

            from app.services.backlinks import list_doc_backlinks
            from app.dependencies.auth import AuthContext
            auth = AuthContext(user_id=str(member.user_id), email="human@test", claims={})
            result = await list_doc_backlinks(
                session, org_id=org.id, doc_id=doc.id, auth=auth, limit=30, cursor=None,
            )
            assert any(item["source_id"] == str(msg.id) for item in result["data"])
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_story_response_reference_token_roundtrips_through_chat():
    """AC4 story 반쪽 — story의 reference_token도 왕복이 실제로 되는지(#2266 story-backlinks
    경로까지)."""
    from app.models.pm import Story
    from app.models.reference import Reference
    from app.schemas.story import StoryResponse
    from app.services.mention_parser import insert_chat_mentions
    from sqlalchemy import select

    engine, factory = await _session_factory()
    try:
        async with factory() as session:
            org, project, member = await _seed_org_project_member(session)
            story = Story(
                id=uuid.uuid4(), org_id=org.id, project_id=project.id,
                title="Fix login bug", status="backlog",
            )
            session.add(story)
            await session.commit()

            story_response = StoryResponse.model_validate(story)
            token = story_response.reference_token
            assert token == f"[Fix login bug](entity:story:{story.id})"

            message_id = uuid.uuid4()
            await insert_chat_mentions(
                session, org_id=org.id, message_id=message_id, content=f"보는 중: {token}",
                created_by=member.id,
            )
            await session.commit()

            rows = (await session.execute(
                select(Reference).where(Reference.source_id == message_id)
            )).scalars().all()
            assert len(rows) == 1
            assert rows[0].target_type == "story"
            assert rows[0].target_id == story.id
    finally:
        await engine.dispose()
