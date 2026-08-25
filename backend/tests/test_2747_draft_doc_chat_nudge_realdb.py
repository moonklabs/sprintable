"""story #2747(2026-08-25, PO 판정) — draft 문서가 채팅에서 mention될 때 작성자에게
1회성 넛지(결재 상신 여부를 묻는다). PO AC 2개를 실 PG로 고정한다:
①1회성이 실제로 1회(같은 doc이 반복 mention돼도 중복 발송 금지 — 새 테이블/컬럼 없이
DM 메시지 로그 자체를 SSOT로 멱등 판정) ②수신자는 doc 작성자만(대화 참여자 전체 아님).
"""
from __future__ import annotations

import os
import uuid

import pytest
from sqlalchemy import select

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.destructive_schema,
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
    import app.models  # noqa: F401
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.core.database import Base

    engine = create_async_engine(_async_url())
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_human_member(session, org_id, project_id, *, name="M"):
    """User+OrgMember+Member(anchor)+ProjectAccess — dispatch_approval_result_reply류가
    쓰는 lookup_members_by_ids/DM 생성 경로가 요구하는 anchor 신원 전부."""
    from app.core.security import hash_password
    from app.models.member import Member
    from app.models.project import OrgMember
    from app.models.project_access import ProjectAccess
    from app.models.user import User

    user_id = uuid.uuid4()
    session.add(User(
        id=user_id, email=f"{name.lower()}-{user_id.hex[:8]}@test.com",
        hashed_password=hash_password("x"), is_active=True, email_verified=True,
    ))
    await session.commit()
    om = OrgMember(id=uuid.uuid4(), org_id=org_id, user_id=user_id, role="member")
    session.add(om)
    await session.commit()
    m = Member(id=om.id, org_id=org_id, type="human", user_id=user_id, name=name)
    session.add(m)
    await session.commit()
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project_id, org_member_id=om.id, member_id=m.id,
        permission="granted", role="member",
    ))
    await session.commit()
    # story #2747 테스트 인프라: Base.metadata.create_all()은 team_members를 alembic
    # 0088 VIEW가 아닌 평범한 물리 테이블로 만든다(로컬 realdb 관례, pgvector 불요) —
    # conversations.created_by FK가 이 표를 가리키므로 같은 id로 anchor와 짝 지어 심는다.
    from app.models.team import TeamMember

    session.add(TeamMember(
        id=m.id, org_id=org_id, project_id=project_id, user_id=user_id,
        type="human", name=name, role="member",
    ))
    await session.commit()
    return m.id


async def _seed_org_project(session):
    from app.models.organization import Organization
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="Org2747", slug=f"org2747-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    return org.id, project.id


async def _count_nudge_messages(session, doc_id):
    from app.models.conversation import ConversationMessage

    rows = (await session.execute(
        select(ConversationMessage).where(
            ConversationMessage.msg_metadata["nudge_target"]["doc_id"].astext == str(doc_id),
        )
    )).scalars().all()
    return rows


@pytest.mark.anyio
async def test_draft_doc_mention_nudges_author_once_even_if_called_twice():
    """⭐PO AC① — 같은 draft doc을 같은 작성자 대상으로 두 번 호출해도 넛지 메시지는 1건뿐."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            author_id = await _seed_human_member(s, org_id, project_id, name="Author")
            sender_id = await _seed_human_member(s, org_id, project_id, name="Sender")

        from app.services.approval_delivery import maybe_nudge_draft_doc_shared_in_chat

        doc_id = uuid.uuid4()
        async with Session() as s:
            await maybe_nudge_draft_doc_shared_in_chat(
                s, org_id=org_id, project_id=project_id, doc_id=doc_id,
                doc_title="온보딩 리서치", doc_status="draft",
                doc_author_id=author_id, sender_id=sender_id,
            )
            await s.commit()

        async with Session() as s:
            rows = await _count_nudge_messages(s, doc_id)
            assert len(rows) == 1
            assert rows[0].sender_id == sender_id

        # 두번째 호출(예: 같은 doc이 다른 메시지에서 다시 mention) — 중복 발송 금지.
        async with Session() as s:
            await maybe_nudge_draft_doc_shared_in_chat(
                s, org_id=org_id, project_id=project_id, doc_id=doc_id,
                doc_title="온보딩 리서치", doc_status="draft",
                doc_author_id=author_id, sender_id=sender_id,
            )
            await s.commit()

        async with Session() as s:
            rows = await _count_nudge_messages(s, doc_id)
            assert len(rows) == 1, f"두번째 호출이 중복 발송함: {len(rows)}건"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_non_draft_doc_mention_does_not_nudge():
    """status != draft(confirmed 등)면 넛지 자체가 안 나간다."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            author_id = await _seed_human_member(s, org_id, project_id, name="Author")
            sender_id = await _seed_human_member(s, org_id, project_id, name="Sender")

        from app.services.approval_delivery import maybe_nudge_draft_doc_shared_in_chat

        doc_id = uuid.uuid4()
        async with Session() as s:
            await maybe_nudge_draft_doc_shared_in_chat(
                s, org_id=org_id, project_id=project_id, doc_id=doc_id,
                doc_title="확定 문서", doc_status="confirmed",
                doc_author_id=author_id, sender_id=sender_id,
            )
            await s.commit()

        async with Session() as s:
            rows = await _count_nudge_messages(s, doc_id)
            assert len(rows) == 0
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_self_share_does_not_nudge():
    """⭐PO AC② 방증 — 작성자 본인이 자기 doc을 공유한 경우 자기-알림 스킵(기존 관례 동형)."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            author_id = await _seed_human_member(s, org_id, project_id, name="Author")

        from app.services.approval_delivery import maybe_nudge_draft_doc_shared_in_chat

        doc_id = uuid.uuid4()
        async with Session() as s:
            await maybe_nudge_draft_doc_shared_in_chat(
                s, org_id=org_id, project_id=project_id, doc_id=doc_id,
                doc_title="내 문서", doc_status="draft",
                doc_author_id=author_id, sender_id=author_id,
            )
            await s.commit()

        async with Session() as s:
            rows = await _count_nudge_messages(s, doc_id)
            assert len(rows) == 0
    finally:
        await engine.dispose()
