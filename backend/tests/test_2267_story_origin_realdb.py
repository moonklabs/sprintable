"""story #2267(C-9, E-CONNECT) — story 생성 시 「무엇에서 만들었나」(출처) 실PG 검증.

이 파일이 증명하는 것:
①origin_type/origin_id를 같이 주면 POST /api/v2/stories가 entity_references에
  relation='created_from' 행을 실제로 심는다(그리고 그 행이 GET .../backlinks에 보인다 —
  "출처를 만들었는데 정작 보여주는 화면에서 안 보이는" 그 사고가 재발 안 함을 같이 증명).
②AC8: registry 밖 source_type은 400으로 거절된다(조용히 통과 금지).
③origin_type/origin_id 중 하나만 주면(부분입력) 조용히 무시된다 — 참조 행이 안 생긴다.
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


# ─── Seeding helpers (test_2266_story_backlinks_realdb.py와 동형) ───────────


async def _make_org(session, name="Org"):
    from app.models.organization import Organization
    org = Organization(id=uuid.uuid4(), name=name, slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    return org


async def _make_project(session, org_id, name="P"):
    from app.models.project import Project
    project = Project(id=uuid.uuid4(), org_id=org_id, name=name)
    session.add(project)
    await session.commit()
    return project


async def _make_human_member(session, org_id, project_id):
    """test_2266_story_backlinks_realdb.py의 동명 helper와 동일 anchor 패턴(members +
    org_members + project_access 직접 write — team_members는 VIEW라 INSERT 불가)."""
    from app.models.member import Member
    from app.models.project import OrgMember
    from app.models.project_access import ProjectAccess
    from app.models.user import User

    user = User(id=uuid.uuid4(), email=f"u-{uuid.uuid4().hex[:8]}@test.local", hashed_password="x")
    session.add(user)
    await session.flush()
    om = OrgMember(id=uuid.uuid4(), org_id=org_id, user_id=user.id, role="member")
    session.add(om)
    await session.flush()
    m = Member(id=om.id, org_id=org_id, type="human", user_id=user.id, name="Human")
    session.add(m)
    await session.flush()
    session.add(ProjectAccess(project_id=project_id, org_member_id=om.id, member_id=m.id, role="member"))
    await session.commit()
    return m.id, user.id


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


async def _add_message(session, conv_id, sender_id, content, created_at=None):
    from app.models.conversation import ConversationMessage
    msg = ConversationMessage(
        id=uuid.uuid4(), conversation_id=conv_id, sender_id=sender_id,
        content=content, created_at=created_at or datetime.now(UTC),
    )
    session.add(msg)
    await session.commit()
    return msg


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

    async def _auth():
        return AuthContext(
            user_id=str(user_id), email="human@test",
            claims={"app_metadata": {"org_id": str(org_id)}},
        )

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth


async def _find_reference(session, *, org_id, source_type, source_id, target_id):
    from sqlalchemy import select as sa_select
    from app.models.reference import Reference
    row = (
        await session.execute(
            sa_select(Reference).where(
                Reference.org_id == org_id, Reference.source_type == source_type,
                Reference.source_id == source_id, Reference.target_id == target_id,
            )
        )
    ).scalar_one_or_none()
    return row


# ─── ①happy path — origin이 실제로 참조로 남고 backlinks에 보인다 ────────────


@pytest.mark.anyio
async def test_story_creation_with_origin_leaves_created_from_reference_visible_in_backlinks():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            member_id, user_id = await _make_human_member(s, org.id, project.id)
            conv_id = await _make_conversation(s, org.id, project.id, [member_id], created_by=member_id)
            msg = await _add_message(s, conv_id, member_id, "이걸 스토리로 만들자")

        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.post(
                "/api/v2/stories",
                json={
                    "project_id": str(project.id),
                    "org_id": str(org.id),
                    "title": "메시지에서 만든 스토리",
                    "origin_type": "chat_message",
                    "origin_id": str(msg.id),
                },
            )
            assert resp.status_code == 201, resp.text
            story_id = uuid.UUID(resp.json()["id"])

            async with Session() as s:
                ref = await _find_reference(
                    s, org_id=org.id, source_type="chat_message", source_id=msg.id, target_id=story_id,
                )
                assert ref is not None, "origin_type/origin_id를 줬는데 참조 행이 안 생겼다"
                assert ref.relation == "created_from"
                assert ref.target_type == "story"
                assert ref.source_field == "self"

            # 정작 보여주는 화면(backlinks)에서 안 보이면 「만들었는데 안 쓰임」과 같은 사고다.
            backlinks_resp = await client.get(f"/api/v2/stories/{story_id}/backlinks")
            assert backlinks_resp.status_code == 200, backlinks_resp.text
            data = backlinks_resp.json()["data"]
            assert len(data) == 1, data
            assert data[0]["relation"] == "created_from"
            assert data[0]["message"]["id"] == str(msg.id)
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


# ─── ②AC8 — registry 밖 source_type은 400 ───────────────────────────────────


@pytest.mark.anyio
async def test_story_creation_with_unregistered_origin_type_rejected_400():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            member_id, user_id = await _make_human_member(s, org.id, project.id)

        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.post(
                "/api/v2/stories",
                json={
                    "project_id": str(project.id),
                    "org_id": str(org.id),
                    "title": "잘못된 출처 타입",
                    "origin_type": "not_a_real_type",
                    "origin_id": str(uuid.uuid4()),
                },
            )
            assert resp.status_code == 400, resp.text

            # ⛔거절됐으면 스토리 자체도 안 생겨야 한다(부분 실패로 스토리만 남고 출처만
            # 빠지는 것은 "출처 없음"과 "출처 거절됨"을 구분 못 하게 만든다).
            async with Session() as s:
                from sqlalchemy import select as sa_select, func
                from app.models.pm import Story
                count = (
                    await s.execute(
                        sa_select(func.count()).select_from(Story).where(Story.org_id == org.id)
                    )
                ).scalar_one()
                assert count == 0, "출처 검증 실패인데 스토리가 커밋된 채로 남아 있다"
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


# ─── ③부분입력(하나만 지정)은 조용히 무시 — 참조 행이 안 생긴다 ─────────────


@pytest.mark.anyio
async def test_story_creation_with_only_origin_type_is_silently_ignored():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            member_id, user_id = await _make_human_member(s, org.id, project.id)

        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.post(
                "/api/v2/stories",
                json={
                    "project_id": str(project.id),
                    "org_id": str(org.id),
                    "title": "부분 출처 입력",
                    "origin_type": "chat_message",
                    # origin_id 미지정
                },
            )
            assert resp.status_code == 201, resp.text
            story_id = uuid.UUID(resp.json()["id"])

            async with Session() as s:
                from sqlalchemy import select as sa_select, func
                from app.models.reference import Reference
                count = (
                    await s.execute(
                        sa_select(func.count()).select_from(Reference).where(
                            Reference.org_id == org.id, Reference.target_id == story_id,
                        )
                    )
                ).scalar_one()
                assert count == 0, "origin_id 없이도 참조가 생겼다 — 부분입력 무시 규칙 위반"
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()
