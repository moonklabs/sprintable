"""story #2260(C-2) — 파서의 «대상 종류 하드코딩» 제거 실PG 검증.

AC1 핵심: 「메시지 → 스토리」임베드가 실제로 만들어진다(죽은 경로였던 것 — 스키마 CHECK는
이미 story/epic을 허용했지만 mention_parser.py가 doc으로만 필터링했다). 왕복(write→read)으로
증명한다. AC2(하드코딩 리터럴 제거)는 이 테스트가 story/epic target_type 이 실제로 써지는
것으로 간접 증명 — insert_chat_mentions 안에 target_type="doc" 리터럴이 남아 있었다면 이
테스트들은 전부 실패했을 것이다.

⛔story #2273(C-1b): write target이 `entity_references`(Reference)로 재배선돼 이 파일도
그쪽을 조회하도록 갱신됐다.
"""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
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
    from app.models.organization import Organization
    from app.models.project import Project
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

    member = Member(id=uuid.uuid4(), org_id=org.id, type="human", user_id=user.id, name="Test Human")
    session.add(member)
    await session.flush()

    return org, project, member


@pytest.mark.anyio
async def test_chat_mention_to_story_round_trips():
    """⭐AC1 핵심 — 메시지→스토리 임베드가 실제로 만들어지고 다시 읽힌다(죽은 경로 재현/해소)."""
    from sqlalchemy import select

    from app.models.reference import Reference
    from app.services.mention_parser import insert_chat_mentions

    engine, factory = await _session_factory()
    try:
        async with factory() as session:
            org, project, member = await _seed_org_project_member(session)
            await session.commit()

            target_story_id = uuid.uuid4()
            message_id = uuid.uuid4()
            content = f"[관련 스토리](entity:story:{target_story_id})"

            await insert_chat_mentions(
                session, org_id=org.id, message_id=message_id, content=content,
                created_by=member.id,
            )
            await session.commit()

            rows = (
                await session.execute(select(Reference).where(Reference.source_id == message_id))
            ).scalars().all()
            assert len(rows) == 1, (
                "메시지→스토리 멘션이 저장되지 않았다 — insert_chat_mentions 안 어딘가에 "
                "target_type이 다시 하드코딩됐을 가능성"
            )
            row = rows[0]
            assert row.target_type == "story"
            assert row.target_id == target_story_id
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_chat_mention_to_epic_round_trips():
    """같은 메시지에 doc·story·epic 세 종류가 섞여도 전부 저장된다 — 종류별 분기가 코드에 없다."""
    from sqlalchemy import select

    from app.models.reference import Reference
    from app.services.mention_parser import insert_chat_mentions

    engine, factory = await _session_factory()
    try:
        async with factory() as session:
            org, project, member = await _seed_org_project_member(session)
            await session.commit()

            doc_id, story_id, epic_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
            message_id = uuid.uuid4()
            content = (
                f"[문서](entity:doc:{doc_id}) [스토리](entity:story:{story_id}) "
                f"[에픽](entity:epic:{epic_id})"
            )

            await insert_chat_mentions(
                session, org_id=org.id, message_id=message_id, content=content,
                created_by=member.id,
            )
            await session.commit()

            rows = (
                await session.execute(select(Reference).where(Reference.source_id == message_id))
            ).scalars().all()
            got = {(r.target_type, r.target_id) for r in rows}
            assert got == {("doc", doc_id), ("story", story_id), ("epic", epic_id)}
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_target_types_param_is_the_boundary_not_a_body_branch():
    """target_types 는 호출부가 내리는 경계값이다 — 좁히면 그 타입만 걸러진다(본문 안 분기가
    아니라 시그니처 파라미터가 결정한다는 것을 직접 증명)."""
    from sqlalchemy import select

    from app.models.reference import Reference
    from app.services.mention_parser import insert_chat_mentions

    engine, factory = await _session_factory()
    try:
        async with factory() as session:
            org, project, member = await _seed_org_project_member(session)
            await session.commit()

            doc_id, story_id = uuid.uuid4(), uuid.uuid4()
            message_id = uuid.uuid4()
            content = f"[문서](entity:doc:{doc_id}) [스토리](entity:story:{story_id})"

            await insert_chat_mentions(
                session, org_id=org.id, message_id=message_id, content=content,
                created_by=member.id, target_types=frozenset({"doc"}),
            )
            await session.commit()

            rows = (
                await session.execute(select(Reference).where(Reference.source_id == message_id))
            ).scalars().all()
            got = {(r.target_type, r.target_id) for r in rows}
            assert got == {("doc", doc_id)}, "target_types 로 좁혔는데 story가 새어 들어왔다"
    finally:
        await engine.dispose()
