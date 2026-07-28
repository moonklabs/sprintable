"""story #2259(C-1, E-CONNECT) — entity_references 코어 실PG 검증.

이 파일이 증명하는 것 — 오늘 판정 넷:
①(b) 읽는 시점 tombstone 판정 + 순서(권한필터→존재판정)·N+1 금지
②registry 밖 타입은 write 거부 + orphan 타입 카운트
③(스코프 밖 — proof/여분 resolver는 이 스토리에 없다, 검증할 것도 없음)
④백필이 idempotent(중복 재실행 안전) + 기존 mentions 데이터가 새 표에서 왕복된다(AC5)
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


async def _seed_story(session, org, project):
    from app.models.pm import Story
    story = Story(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="S", status="backlog")
    session.add(story)
    await session.flush()
    return story


async def _seed_doc(session, org, project):
    from app.models.doc import Doc
    doc = Doc(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="D", slug=f"d-{uuid.uuid4().hex[:8]}")
    session.add(doc)
    await session.flush()
    return doc


@pytest.mark.anyio
async def test_insert_rejects_unregistered_entity_type():
    """②registry 밖 타입은 조용히 통과가 아니라 거부."""
    from app.services.reference_core import UnregisteredEntityTypeError, insert_reference

    engine, factory = await _session_factory()
    try:
        async with factory() as session:
            org, project, member = await _seed_org_project_member(session)
            await session.commit()
            with pytest.raises(UnregisteredEntityTypeError):
                await insert_reference(
                    session, org_id=org.id, source_type="chat_message", source_field=None,
                    source_id=uuid.uuid4(), target_type="not_a_real_type", target_id=uuid.uuid4(),
                    form="mention", created_by=member.id,
                )
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_insert_rejects_invalid_form():
    from app.services.reference_core import insert_reference

    engine, factory = await _session_factory()
    try:
        async with factory() as session:
            org, project, member = await _seed_org_project_member(session)
            await session.commit()
            with pytest.raises(ValueError):
                await insert_reference(
                    session, org_id=org.id, source_type="chat_message", source_field=None,
                    source_id=uuid.uuid4(), target_type="doc", target_id=uuid.uuid4(),
                    form="not_a_real_form", created_by=member.id,
                )
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_outgoing_reference_marks_deleted_target_as_broken():
    """⭐AC4 핵심 — 대상 doc이 soft-delete되면, 읽을 때 still_exists=False로 판정된다(삭제
    콜사이트 훅 없이, 읽는 시점에)."""
    from datetime import datetime, timezone

    from app.services.reference_core import insert_reference, list_references

    engine, factory = await _session_factory()
    try:
        async with factory() as session:
            org, project, member = await _seed_org_project_member(session)
            story = await _seed_story(session, org, project)
            doc = await _seed_doc(session, org, project)
            await session.commit()

            await insert_reference(
                session, org_id=org.id, source_type="story", source_field="description",
                source_id=story.id, target_type="doc", target_id=doc.id,
                form="mention", created_by=member.id,
            )
            await session.commit()

            refs_before = await list_references(
                session, org_id=org.id, entity_type="story", entity_id=story.id, direction="outgoing",
            )
            assert len(refs_before) == 1
            assert refs_before[0].still_exists is True

            doc.deleted_at = datetime.now(timezone.utc)
            await session.commit()

            refs_after = await list_references(
                session, org_id=org.id, entity_type="story", entity_id=story.id, direction="outgoing",
            )
            assert len(refs_after) == 1, "끊어진 참조도 목록에서 사라지면 안 된다 — «끊어졌다»로 남아야 한다"
            assert refs_after[0].still_exists is False
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_incoming_direction_flips_axis_on_same_table():
    """양방향 — target 쪽에서 조회하면(incoming) source가 반환된다(같은 표, 축만 바꿈)."""
    from app.services.reference_core import insert_reference, list_references

    engine, factory = await _session_factory()
    try:
        async with factory() as session:
            org, project, member = await _seed_org_project_member(session)
            story = await _seed_story(session, org, project)
            doc = await _seed_doc(session, org, project)
            await session.commit()

            await insert_reference(
                session, org_id=org.id, source_type="story", source_field="description",
                source_id=story.id, target_type="doc", target_id=doc.id,
                form="mention", created_by=member.id,
            )
            await session.commit()

            incoming = await list_references(
                session, org_id=org.id, entity_type="doc", entity_id=doc.id, direction="incoming",
            )
            assert len(incoming) == 1
            assert incoming[0].source_type == "story"
            assert incoming[0].source_id == story.id
            assert incoming[0].still_exists is True  # source(story) 살아있음
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_visible_ids_filter_applies_before_existence_check():
    """㉠순서 — 권한 필터가 존재판정보다 먼저 적용된다(못 보는 것과 끊어진 것을 안 섞음)."""
    from app.services.reference_core import insert_reference, list_references

    engine, factory = await _session_factory()
    try:
        async with factory() as session:
            org, project, member = await _seed_org_project_member(session)
            story = await _seed_story(session, org, project)
            doc_visible = await _seed_doc(session, org, project)
            doc_hidden = await _seed_doc(session, org, project)
            await session.commit()

            for target in (doc_visible, doc_hidden):
                await insert_reference(
                    session, org_id=org.id, source_type="story", source_field="description",
                    source_id=story.id, target_type="doc", target_id=target.id,
                    form="mention", created_by=member.id,
                )
            await session.commit()

            visible = await list_references(
                session, org_id=org.id, entity_type="story", entity_id=story.id, direction="outgoing",
                visible_ids_by_type={"doc": {doc_visible.id}},
            )
            assert {r.target_id for r in visible} == {doc_visible.id}, (
                "권한 필터를 줬는데 안 보이는 doc이 결과에 새어 들어왔다"
            )
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_backfill_is_idempotent_and_old_data_round_trips():
    """⭐AC5 핵심 — 옛 mentions 데이터가 백필 후 entity_references 로 왕복(read)된다.
    같은 백필을 두 번 돌려도 중복 행이 안 생긴다(idempotent)."""
    from sqlalchemy import func, select

    from app.models.mention import Mention
    from app.models.reference import Reference
    from app.services.reference_backfill import backfill_mentions_to_references

    engine, factory = await _session_factory()
    try:
        async with factory() as session:
            org, project, member = await _seed_org_project_member(session)
            story = await _seed_story(session, org, project)
            message_id = uuid.uuid4()

            # 옛 시스템처럼 mentions 테이블에 직접 씀(백필 대상 데이터 시딩).
            old_mention = Mention(
                id=uuid.uuid4(), org_id=org.id, source_type="chat_message", source_id=message_id,
                target_type="story", target_id=story.id, created_by=member.id,
            )
            session.add(old_mention)
            await session.commit()

            n1 = await backfill_mentions_to_references(session, org_id=org.id)
            await session.commit()
            assert n1 == 1

            count_after_first = (
                await session.execute(select(func.count()).select_from(Reference).where(Reference.org_id == org.id))
            ).scalar_one()
            assert count_after_first == 1

            # 재실행 — 중복 안 생김.
            await backfill_mentions_to_references(session, org_id=org.id)
            await session.commit()
            count_after_second = (
                await session.execute(select(func.count()).select_from(Reference).where(Reference.org_id == org.id))
            ).scalar_one()
            assert count_after_second == 1, "백필 재실행이 중복 행을 만들었다 — idempotent가 아니다"

            # 왕복 — 백필된 옛 데이터가 새 read 경로로 정상 조회된다.
            from app.services.reference_core import list_references

            refs = await list_references(
                session, org_id=org.id, entity_type="chat_message", entity_id=message_id, direction="outgoing",
            )
            assert len(refs) == 1
            assert refs[0].target_type == "story"
            assert refs[0].target_id == story.id
            assert refs[0].form == "mention"  # 옛 표엔 form 개념이 없어 백필은 항상 mention.
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_orphan_type_count_catches_unregistered_type_in_storage():
    """②저장분 중 registry에 없는 타입이 있으면 orphan 점검이 잡는다(오타 방지망)."""
    import uuid as uuid_mod

    from app.models.reference import Reference
    from app.services.reference_registry import count_orphan_types

    engine, factory = await _session_factory()
    try:
        async with factory() as session:
            org, project, member = await _seed_org_project_member(session)
            story = await _seed_story(session, org, project)
            await session.commit()

            # insert_reference 를 우회해 registry 검증 없이 직접 삽입(오타 타입 시뮬레이션 —
            # write 경로가 안 걸러도 orphan 점검이 잡아야 하는 것을 증명).
            bogus = Reference(
                id=uuid_mod.uuid4(), org_id=org.id, source_type="story", source_field=None,
                source_id=story.id, target_type="sprintt",  # 오타
                target_id=uuid_mod.uuid4(), form="mention", created_by=member.id,
            )
            session.add(bogus)
            await session.commit()

            orphans = await count_orphan_types(session, org.id)
            assert orphans.get("target:sprintt") == 1
    finally:
        await engine.dispose()
