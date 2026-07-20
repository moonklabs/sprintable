"""story #1993(E-KNOWLEDGE-LINK S1) — mentions 테이블(0200)+write-path 파서 realPG 통합 검증.

AC4 실증: 채팅/doc 멘션 삽입→mentions row·doc 재저장 시 추가/삭제 reconcile·중복 UNIQUE 1row·
자기참조 0·CHECK 제약 위반 실제 거부·본요청 실패 시 mentions 도 함께 롤백(원자성). #1982(CI
realPG 배선)로 CI 에서도 skip 없이 돈다 — 로컬은 PARITY_TEST_DATABASE_URL/ALEMBIC_DATABASE_URL
(migrated real PG) 필요.
"""
from __future__ import annotations

import os
import uuid

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

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
    """org + project + canonical member(휴먼) 1건. created_by 정규화 검증엔 별도 alias 시드."""
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


# ─── AC4-1: 채팅 멘션 삽입 → mentions row ──────────────────────────────────────


async def test_chat_mention_insert_creates_row():
    from app.models.mention import Mention
    from app.services.mention_parser import insert_chat_mentions

    engine, factory = await _session_factory()
    try:
        async with factory() as session:
            org, project, member = await _seed_org_project_member(session)
            await session.commit()

            target_doc_id = uuid.uuid4()
            message_id = uuid.uuid4()
            content = f"[참고 doc](entity:doc:{target_doc_id})"

            await insert_chat_mentions(
                session, org_id=org.id, message_id=message_id, content=content,
                created_by=member.id,
            )
            await session.commit()

            rows = (await session.execute(select(Mention).where(Mention.source_id == message_id))).scalars().all()
            assert len(rows) == 1
            row = rows[0]
            assert row.org_id == org.id
            assert row.source_type == "chat_message"
            assert row.source_id == message_id
            assert row.target_type == "doc"
            assert row.target_id == target_doc_id
            assert row.created_by == member.id
    finally:
        await engine.dispose()


# ─── AC4-2: doc 재저장 시 mentions 추가/삭제 reconcile ─────────────────────────


async def test_doc_reconcile_adds_and_removes_stale_mentions():
    from app.models.mention import Mention
    from app.services.mention_parser import reconcile_doc_mentions

    engine, factory = await _session_factory()
    try:
        async with factory() as session:
            org, project, member = await _seed_org_project_member(session)
            await session.commit()

            source_doc_id = uuid.uuid4()
            target_b = uuid.uuid4()
            target_c = uuid.uuid4()

            # 1차: B 를 wikiLink 로 멘션.
            html_v1 = f'<span data-type="wikiLink" data-doc-id="{target_b}">B</span>'
            await reconcile_doc_mentions(
                session, org_id=org.id, doc_id=source_doc_id, html_content=html_v1,
                created_by=member.id,
            )
            await session.commit()

            rows_v1 = (await session.execute(
                select(Mention.target_id).where(Mention.source_type == "doc", Mention.source_id == source_doc_id)
            )).scalars().all()
            assert set(rows_v1) == {target_b}

            # 2차: B 제거·C 추가(pageEmbed) — stale(B) 삭제 + 신규(C) insert.
            html_v2 = f'<div data-page-embed data-doc-id="{target_c}"></div>'
            await reconcile_doc_mentions(
                session, org_id=org.id, doc_id=source_doc_id, html_content=html_v2,
                created_by=member.id,
            )
            await session.commit()

            rows_v2 = (await session.execute(
                select(Mention.target_id).where(Mention.source_type == "doc", Mention.source_id == source_doc_id)
            )).scalars().all()
            assert set(rows_v2) == {target_c}
    finally:
        await engine.dispose()


# ─── AC4-3: 중복 삽입 → UNIQUE 로 1 row 만 ──────────────────────────────────────


async def test_duplicate_target_collapses_to_one_row_via_unique():
    from app.models.mention import Mention
    from app.services.mention_parser import insert_chat_mentions

    engine, factory = await _session_factory()
    try:
        async with factory() as session:
            org, project, member = await _seed_org_project_member(session)
            await session.commit()

            target_doc_id = uuid.uuid4()
            message_id = uuid.uuid4()
            content = f"[A](entity:doc:{target_doc_id})"

            await insert_chat_mentions(
                session, org_id=org.id, message_id=message_id, content=content, created_by=member.id,
            )
            await session.commit()
            # 같은 (source_type, source_id, target_type, target_id) 를 한 번 더 insert 시도
            # (예: 재시도/중복 호출 시나리오) — ON CONFLICT DO NOTHING 이 UNIQUE 를 흡수해야 한다.
            await insert_chat_mentions(
                session, org_id=org.id, message_id=message_id, content=content, created_by=member.id,
            )
            await session.commit()

            rows = (await session.execute(
                select(Mention).where(Mention.source_id == message_id, Mention.target_id == target_doc_id)
            )).scalars().all()
            assert len(rows) == 1
    finally:
        await engine.dispose()


async def test_raw_duplicate_insert_without_on_conflict_rejected_by_unique():
    """UNIQUE 제약 자체가 실제로 존재/작동하는지(ORM 우회 raw INSERT 2회)를 직접 증명."""
    from app.models.mention import Mention

    engine, factory = await _session_factory()
    try:
        async with factory() as session:
            org, project, member = await _seed_org_project_member(session)
            await session.commit()

            target_doc_id = uuid.uuid4()
            message_id = uuid.uuid4()
            session.add(Mention(
                id=uuid.uuid4(), org_id=org.id, source_type="chat_message", source_id=message_id,
                target_type="doc", target_id=target_doc_id, created_by=member.id,
            ))
            await session.commit()

            session.add(Mention(
                id=uuid.uuid4(), org_id=org.id, source_type="chat_message", source_id=message_id,
                target_type="doc", target_id=target_doc_id, created_by=member.id,
            ))
            with pytest.raises(IntegrityError):
                await session.commit()
            await session.rollback()
    finally:
        await engine.dispose()


# ─── AC4-4: 자기참조 0건 ────────────────────────────────────────────────────────


async def test_self_reference_mention_dropped():
    from app.models.mention import Mention
    from app.services.mention_parser import reconcile_doc_mentions

    engine, factory = await _session_factory()
    try:
        async with factory() as session:
            org, project, member = await _seed_org_project_member(session)
            await session.commit()

            self_doc_id = uuid.uuid4()
            html = f'<span data-type="wikiLink" data-doc-id="{self_doc_id}">self</span>'

            await reconcile_doc_mentions(
                session, org_id=org.id, doc_id=self_doc_id, html_content=html, created_by=member.id,
            )
            await session.commit()

            rows = (await session.execute(
                select(Mention).where(Mention.source_type == "doc", Mention.source_id == self_doc_id)
            )).scalars().all()
            assert len(rows) == 0
    finally:
        await engine.dispose()


# ─── AC4-5: CHECK 제약 위반 실제 거부 ───────────────────────────────────────────


async def test_check_constraint_rejects_invalid_source_type():
    from app.models.mention import Mention

    engine, factory = await _session_factory()
    try:
        async with factory() as session:
            org, project, member = await _seed_org_project_member(session)
            await session.commit()

            session.add(Mention(
                id=uuid.uuid4(), org_id=org.id, source_type="not_a_valid_type", source_id=uuid.uuid4(),
                target_type="doc", target_id=uuid.uuid4(), created_by=member.id,
            ))
            with pytest.raises(IntegrityError):
                await session.commit()
            await session.rollback()
    finally:
        await engine.dispose()


async def test_check_constraint_rejects_invalid_target_type():
    from app.models.mention import Mention

    engine, factory = await _session_factory()
    try:
        async with factory() as session:
            org, project, member = await _seed_org_project_member(session)
            await session.commit()

            session.add(Mention(
                id=uuid.uuid4(), org_id=org.id, source_type="doc", source_id=uuid.uuid4(),
                target_type="gate", target_id=uuid.uuid4(), created_by=member.id,
            ))
            with pytest.raises(IntegrityError):
                await session.commit()
            await session.rollback()
    finally:
        await engine.dispose()


# ─── AC4-6: 본요청 실패 시 mentions 도 함께 롤백(원자성) ───────────────────────


async def test_mentions_rollback_when_enclosing_transaction_fails():
    """doc 저장 트랜잭션 중간에 강제 에러 주입 → mentions row 도 남지 않아야 한다(같은 세션/
    트랜잭션 — get_db 의 rollback-on-exception 과 동형: 여기선 직접 session.rollback() 으로
    같은 효과를 재현)."""
    from app.models.mention import Mention
    from app.services.mention_parser import reconcile_doc_mentions

    engine, factory = await _session_factory()
    try:
        async with factory() as session:
            org, project, member = await _seed_org_project_member(session)
            await session.commit()

            source_doc_id = uuid.uuid4()
            target_doc_id = uuid.uuid4()
            html = f'<span data-type="wikiLink" data-doc-id="{target_doc_id}">X</span>'

            await reconcile_doc_mentions(
                session, org_id=org.id, doc_id=source_doc_id, html_content=html, created_by=member.id,
            )
            # mentions insert 는 flush 상태 — 아직 커밋 안 됨. 여기서 본요청(doc 저장)이 실패했다고
            # 가정(예: 이후 slug 충돌 등으로 라우터가 예외 raise) → get_db 의 except 블록이
            # session.rollback() 을 호출하는 것과 동형 재현.
            await session.rollback()

            rows = (await session.execute(
                select(Mention).where(Mention.source_type == "doc", Mention.source_id == source_doc_id)
            )).scalars().all()
            assert len(rows) == 0, "본요청 롤백 시 mentions 도 함께 사라져야 한다(원자 트랜잭션)"
    finally:
        await engine.dispose()


# ─── created_by canonicalize_member_id 정규화 확인 ─────────────────────────────


async def test_created_by_is_canonicalized_via_alias():
    from app.models.mention import Mention
    from app.models.member import MemberIdentityAlias
    from app.services.mention_parser import insert_chat_mentions

    engine, factory = await _session_factory()
    try:
        async with factory() as session:
            org, project, member = await _seed_org_project_member(session)
            legacy_alias_id = uuid.uuid4()
            session.add(MemberIdentityAlias(
                alias_id=legacy_alias_id, member_id=member.id, org_id=org.id, alias_source="human_team_member",
            ))
            await session.commit()

            target_doc_id = uuid.uuid4()
            message_id = uuid.uuid4()
            content = f"[A](entity:doc:{target_doc_id})"

            # created_by 로 레거시 alias_id 를 넘긴다 — insert_chat_mentions 가 canonicalize_member_id
            # 를 거쳐 canonical member.id 로 정규화해 저장해야 한다.
            await insert_chat_mentions(
                session, org_id=org.id, message_id=message_id, content=content, created_by=legacy_alias_id,
            )
            await session.commit()

            row = (await session.execute(
                select(Mention).where(Mention.source_id == message_id)
            )).scalar_one()
            assert row.created_by == member.id, "legacy alias_id 가 아닌 canonical member.id 로 저장돼야 한다"
    finally:
        await engine.dispose()
