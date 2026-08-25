"""story #2747(2026-08-25, PO 판정) — draft 문서가 채팅에서 mention될 때 작성자에게
1회성 넛지(결재 상신 여부를 묻는다). PO AC 2개를 실 PG로 고정한다:
①1회성이 실제로 1회 — 발신자·대화 무관 **작성자당 전역 1회**(DocChatNudgeDispatch
uq(org_id, doc_id) reservation row·카디르 QA 2R로 배달과 같은 SAVEPOINT 원자단위로
정정) ②수신자는 doc 작성자만(대화 참여자 전체 아님). 회귀가드 3경로: 순차 2발신자·
동시 asyncio.gather·배달 강제실패 後 정상 재시도.
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


async def _seed_doc(session, org_id, project_id, author_id, *, status="draft", title="Doc"):
    from app.models.doc import Doc

    doc = Doc(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, created_by=author_id,
        status=status, title=title, slug=f"{title.lower()}-{uuid.uuid4().hex[:8]}",
    )
    session.add(doc)
    await session.commit()
    return doc.id


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
    """⭐PO AC① 기본형 — 같은 draft doc을 같은 작성자 대상으로 두 번 호출해도 넛지 메시지는
    1건뿐(같은 sender·같은 세션이 반복 mention하는 가장 흔한 경우)."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            author_id = await _seed_human_member(s, org_id, project_id, name="Author")
            sender_id = await _seed_human_member(s, org_id, project_id, name="Sender")
            doc_id = await _seed_doc(s, org_id, project_id, author_id)

        from app.services.approval_delivery import maybe_nudge_draft_doc_shared_in_chat
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
async def test_two_different_senders_sequential_still_nudge_author_once():
    """⭐카디르 QA(#3465) 재현 경로(b) — 서로 다른 두 발신자가 각자 딴 시점·딴 DM에서 같은
    draft doc을 mention해도 작성자에게 가는 넛지는 통산 1건(원 구현은 DM당 1회라 여기서
    2건이 나갔다 — 작성자당 전역 1회가 AC)."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            author_id = await _seed_human_member(s, org_id, project_id, name="Author")
            sender_a = await _seed_human_member(s, org_id, project_id, name="SenderA")
            sender_b = await _seed_human_member(s, org_id, project_id, name="SenderB")
            doc_id = await _seed_doc(s, org_id, project_id, author_id)

        from app.services.approval_delivery import maybe_nudge_draft_doc_shared_in_chat
        async with Session() as s:
            await maybe_nudge_draft_doc_shared_in_chat(
                s, org_id=org_id, project_id=project_id, doc_id=doc_id,
                doc_title="온보딩 리서치", doc_status="draft",
                doc_author_id=author_id, sender_id=sender_a,
            )
            await s.commit()

        async with Session() as s:
            # sender_b는 sender_a와 완전히 다른 DM(참가자 쌍이 다름)에서 같은 doc을 mention.
            await maybe_nudge_draft_doc_shared_in_chat(
                s, org_id=org_id, project_id=project_id, doc_id=doc_id,
                doc_title="온보딩 리서치", doc_status="draft",
                doc_author_id=author_id, sender_id=sender_b,
            )
            await s.commit()

        async with Session() as s:
            rows = await _count_nudge_messages(s, doc_id)
            assert len(rows) == 1, f"서로 다른 발신자가 각자 DM에서 mention해 중복 발송됨: {len(rows)}건"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_concurrent_mentions_still_nudge_author_once():
    """⭐카디르 QA(#3465) 재현 경로(a) — asyncio.gather 동시 호출도 UNIQUE 제약(reservation
    row)이 직렬화해 넛지는 정확히 1건(SELECT→INSERT SAVEPOINT는 이 레이스를 못 막았었다)."""
    import asyncio

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            author_id = await _seed_human_member(s, org_id, project_id, name="Author")
            sender_a = await _seed_human_member(s, org_id, project_id, name="SenderA")
            sender_b = await _seed_human_member(s, org_id, project_id, name="SenderB")
            doc_id = await _seed_doc(s, org_id, project_id, author_id)

        from app.services.approval_delivery import maybe_nudge_draft_doc_shared_in_chat

        async def _call(sender_id):
            async with Session() as s:
                await maybe_nudge_draft_doc_shared_in_chat(
                    s, org_id=org_id, project_id=project_id, doc_id=doc_id,
                    doc_title="온보딩 리서치", doc_status="draft",
                    doc_author_id=author_id, sender_id=sender_id,
                )
                await s.commit()

        await asyncio.gather(_call(sender_a), _call(sender_b))

        async with Session() as s:
            rows = await _count_nudge_messages(s, doc_id)
            assert len(rows) == 1, f"동시 호출이 레이스로 중복 발송됨: {len(rows)}건"
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
            doc_id = await _seed_doc(s, org_id, project_id, author_id)

        from app.services.approval_delivery import maybe_nudge_draft_doc_shared_in_chat
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
            doc_id = await _seed_doc(s, org_id, project_id, author_id)

        from app.services.approval_delivery import maybe_nudge_draft_doc_shared_in_chat
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


@pytest.mark.anyio
async def test_delivery_failure_rolls_back_reservation_and_retry_succeeds():
    """⭐카디르 QA 2R(#3465) probe 재현 — reservation과 실 배달이 분리된 두 SAVEPOINT였을 때는
    배달 실패(예: DM/이벤트 dispatch 도중 예외) 後 reservation만 남아 그 doc이 영구히
    "이미 넛지 보냄"으로 오판돼 이후 정상 재시도까지 전부 조용히 막혔다(중복보다 나쁜
    영구 침묵). 같은 SAVEPOINT 원자 단위로 묶은 뒤에는: ①강제 실패 시 메시지 0건(reservation도
    같이 롤백) ②그 다음 정상 호출이 실제로 성공해 메시지 1건이 생긴다(재시도 가능)."""
    from unittest.mock import patch

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            author_id = await _seed_human_member(s, org_id, project_id, name="Author")
            sender_id = await _seed_human_member(s, org_id, project_id, name="Sender")
            doc_id = await _seed_doc(s, org_id, project_id, author_id)

        from app.services.approval_delivery import maybe_nudge_draft_doc_shared_in_chat

        # 1차: 배달 단계(이벤트 dispatch)에서 강제 예외 — reservation도 같이 롤백돼야 한다.
        async with Session() as s:
            with patch(
                "app.routers.conversations._dispatch_conversation_event",
                side_effect=RuntimeError("일시적 배달 실패(강제)"),
            ):
                await maybe_nudge_draft_doc_shared_in_chat(
                    s, org_id=org_id, project_id=project_id, doc_id=doc_id,
                    doc_title="온보딩 리서치", doc_status="draft",
                    doc_author_id=author_id, sender_id=sender_id,
                )
                await s.commit()

        async with Session() as s:
            rows = await _count_nudge_messages(s, doc_id)
            assert len(rows) == 0, "강제 실패 後에도 메시지가 생김(예상 밖)"
            from app.models.doc_chat_nudge_dispatch import DocChatNudgeDispatch
            reservations = (await s.execute(
                select(DocChatNudgeDispatch).where(DocChatNudgeDispatch.doc_id == doc_id)
            )).scalars().all()
            assert len(reservations) == 0, (
                f"reservation이 배달 실패에도 살아남음(영구 침묵 버그 재발): {len(reservations)}건"
            )

        # 2차: 정상 재시도 — 이번엔 실제로 성공해야 한다(영구 침묵 아님).
        async with Session() as s:
            await maybe_nudge_draft_doc_shared_in_chat(
                s, org_id=org_id, project_id=project_id, doc_id=doc_id,
                doc_title="온보딩 리서치", doc_status="draft",
                doc_author_id=author_id, sender_id=sender_id,
            )
            await s.commit()

        async with Session() as s:
            rows = await _count_nudge_messages(s, doc_id)
            assert len(rows) == 1, f"재시도가 정상 성공하지 못함: {len(rows)}건"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_integrity_error_branch_discriminates_uq_dup_from_other_bidirectional(caplog):
    """⭐카디르 QA 5R(#3465) — 4R의 `e.orig.constraint_name` 추출이 asyncpg에선 실제로
    항상 None이었다(SQLAlchemy가 asyncpg 예외를 어댑터 래퍼로 한 번 더 감싸고 진짜
    constraint_name은 `e.orig.__cause__`에 있음) — 그런데 4R 테스트가 "경고가 존재하나"만
    봐서 이 no-op을 통과시켰다(카디르 실PG 독립 재현). **양방향**으로 고정한다:
    ①정상 uq 중복(같은 doc 두 번 호출) → "예상 밖" 경고 **0건**(조용히 skip 그대로) ②
    비-uq IntegrityError(FK 위반) → "예상 밖" 경고 **정확히 1건**. 둘 다 봐야 추출 자체가
    실제로 되는지(아니면 그냥 전부 skip해도 ①은 우연히 통과) 걸린다."""
    import logging

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            author_id = await _seed_human_member(s, org_id, project_id, name="Author")
            sender_id = await _seed_human_member(s, org_id, project_id, name="Sender")
            dup_doc_id = await _seed_doc(s, org_id, project_id, author_id)

        from app.services.approval_delivery import maybe_nudge_draft_doc_shared_in_chat

        with caplog.at_level(logging.WARNING, logger="app.services.approval_delivery"):
            # ① 정상 uq 중복 — 두 번째 호출은 IntegrityError(uq) → 조용히 skip, 경고 0건.
            async with Session() as s:
                await maybe_nudge_draft_doc_shared_in_chat(
                    s, org_id=org_id, project_id=project_id, doc_id=dup_doc_id,
                    doc_title="온보딩 리서치", doc_status="draft",
                    doc_author_id=author_id, sender_id=sender_id,
                )
                await s.commit()
            async with Session() as s:
                await maybe_nudge_draft_doc_shared_in_chat(
                    s, org_id=org_id, project_id=project_id, doc_id=dup_doc_id,
                    doc_title="온보딩 리서치", doc_status="draft",
                    doc_author_id=author_id, sender_id=sender_id,
                )
                await s.commit()

            dup_warnings = [r for r in caplog.records if "예상 밖" in r.message]
            assert len(dup_warnings) == 0, (
                f"정상 uq 중복인데 '예상 밖'으로 오분류됨(추출 실패): {len(dup_warnings)}건"
            )

            # ② 비-uq IntegrityError(FK 위반, 실 Doc 행 없는 doc_id) — 경고 정확히 1건.
            ghost_doc_id = uuid.uuid4()
            async with Session() as s:
                await maybe_nudge_draft_doc_shared_in_chat(
                    s, org_id=org_id, project_id=project_id, doc_id=ghost_doc_id,
                    doc_title="유령 문서", doc_status="draft",
                    doc_author_id=author_id, sender_id=sender_id,
                )
                await s.commit()

        fk_warnings = [r for r in caplog.records if "예상 밖" in r.message]
        assert len(fk_warnings) == 1, (
            f"FK IntegrityError가 '예상 밖'으로 정확히 1건 로그되지 않음: {len(fk_warnings)}건"
        )
        async with Session() as s:
            assert len(await _count_nudge_messages(s, ghost_doc_id)) == 0
    finally:
        await engine.dispose()
