"""story #3821(customer-zero 실측, 페드루 PO 확定 2026-09-13, PR B) — 결재 요청 카드
스레드 붕괴. 같은 (work_item_id, work_item_type, gate_type) 조합으로 같은 승인자
conversation에 이미 최상위 결재 요청 메시지가 있으면, `dispatch_approval_request_cards`
가 새 최상위 메시지를 또 만들지 않고 그 메시지의 스레드 답글로 「다시 결재가
필요합니다」를 단다(+최상위 approval_target.gate_id를 최신 gate로 갱신) — 같은 스토리에
소 PR이 여러 개 열려 merge gate가 매번 새로 생겨도(#4232~#4248류) 승인자 1:1 대화에
매번 새 챗버블이 안 쌓이게 하는 처방.

BE 절반(실 PG) — FE 렌더는 스코프 밖(approval-request-card.tsx가 이미 work_item_type
제네릭 렌더·스레드 UI는 기존 채팅 스레드 렌더 재사용, 신규 렌더 로직 0)."""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.destructive_schema,
    pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요"),
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _realdb_session():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from app.core.database import Base
    import app.models  # noqa: F401

    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql://"):
        if url.startswith(prefix):
            url = "postgresql+asyncpg://" + url[len(prefix):]
            break
    engine = create_async_engine(url)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_org_project(session):
    from app.models.organization import Organization
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="Org3821", slug=f"org3821-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    return org.id, project.id


async def _seed_human(session, org_id, project_id, *, name="member"):
    from app.models.team import TeamMember

    m = TeamMember(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, type="human",
        name=name, is_active=True,
    )
    session.add(m)
    await session.commit()
    return m.id


@pytest.mark.anyio
async def test_same_combination_three_times_collapses_to_one_root_two_replies():
    """양성대조 ① — 같은 (work_item_id, work_item_type, gate_type)로 3회 호출(같은
    스토리에 소 PR 3개가 순차로 merge gate를 새로 여는 흉내, gate_id는 매번 다름) →
    최상위 메시지 1건·스레드 답글 2건. 최상위의 approval_target.gate_id는 가장
    마지막(3번째) gate_id로 갱신돼 있어야 한다(스테일 gate_id 클릭 방지)."""
    from app.services.approval_delivery import dispatch_approval_request_cards
    from app.models.conversation import ConversationMessage
    from sqlalchemy import select

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            requester_id = await _seed_human(s, org_id, project_id, name="requester")
            approver_id = await _seed_human(s, org_id, project_id, name="approver")
            work_item_id = uuid.uuid4()
            gate_ids = [uuid.uuid4(), uuid.uuid4(), uuid.uuid4()]

            for i, gate_id in enumerate(gate_ids):
                await dispatch_approval_request_cards(
                    s, org_id=org_id, work_item_type="story", work_item_id=work_item_id,
                    project_id=project_id, title="같은 스토리", gate_id=gate_id, gate_type="merge",
                    requester_id=requester_id, approver_ids=[approver_id],
                    reopen_reason=f"PR #{4232 + i}" if i > 0 else None,
                )
                await s.commit()

            msgs = (await s.execute(
                select(ConversationMessage).order_by(ConversationMessage.created_at)
            )).scalars().all()
            roots = [m for m in msgs if m.thread_id is None]
            replies = [m for m in msgs if m.thread_id is not None]
            assert len(roots) == 1, f"최상위 메시지가 1건이 아니다: {len(roots)}건"
            assert len(replies) == 2, f"스레드 답글이 2건이 아니다: {len(replies)}건"
            assert all(r.thread_id == roots[0].id for r in replies)

            root = roots[0]
            assert root.msg_metadata["approval_target"]["gate_id"] == str(gate_ids[-1]), (
                "최상위 카드의 gate_id가 최신 gate로 갱신되지 않았다"
            )
            assert root.reply_count == 2
            assert root.last_reply_at is not None

            assert "PR #4233" in replies[0].content
            assert "PR #4234" in replies[1].content
            assert "다시 결재가 필요합니다" in replies[0].content
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_different_gate_type_same_work_item_creates_separate_root():
    """양성대조 ② — 같은 work_item_id라도 gate_type이 다르면(예: 같은 스토리의
    merge gate vs concept_approval gate) 별개 최상위 메시지가 각자 선다(스레드가
    엉뚱한 종류의 결재까지 붕괴시키면 안 된다)."""
    from app.services.approval_delivery import dispatch_approval_request_cards
    from app.models.conversation import ConversationMessage
    from sqlalchemy import select

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            requester_id = await _seed_human(s, org_id, project_id, name="requester")
            approver_id = await _seed_human(s, org_id, project_id, name="approver")
            work_item_id = uuid.uuid4()

            await dispatch_approval_request_cards(
                s, org_id=org_id, work_item_type="story", work_item_id=work_item_id,
                project_id=project_id, title="같은 스토리", gate_id=uuid.uuid4(), gate_type="merge",
                requester_id=requester_id, approver_ids=[approver_id],
            )
            await s.commit()
            await dispatch_approval_request_cards(
                s, org_id=org_id, work_item_type="story", work_item_id=work_item_id,
                project_id=project_id, title="같은 스토리", gate_id=uuid.uuid4(), gate_type="concept_approval",
                requester_id=requester_id, approver_ids=[approver_id],
            )
            await s.commit()

            msgs = (await s.execute(select(ConversationMessage))).scalars().all()
            roots = [m for m in msgs if m.thread_id is None]
            assert len(roots) == 2, f"다른 gate_type인데 스레드로 붕괴됐다: 최상위 {len(roots)}건"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_different_work_item_same_gate_type_creates_separate_root():
    """양성대조 ③(회귀 0) — work_item_id가 다르면(다른 스토리) gate_type이 같아도
    별개 최상위 메시지 — story #3815/#3816처럼 완전히 다른 카드의 merge gate끼리
    서로 스레드로 엮이면 안 된다."""
    from app.services.approval_delivery import dispatch_approval_request_cards
    from app.models.conversation import ConversationMessage
    from sqlalchemy import select

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            requester_id = await _seed_human(s, org_id, project_id, name="requester")
            approver_id = await _seed_human(s, org_id, project_id, name="approver")

            await dispatch_approval_request_cards(
                s, org_id=org_id, work_item_type="story", work_item_id=uuid.uuid4(),
                project_id=project_id, title="스토리 A(3815)", gate_id=uuid.uuid4(), gate_type="merge",
                requester_id=requester_id, approver_ids=[approver_id],
            )
            await s.commit()
            await dispatch_approval_request_cards(
                s, org_id=org_id, work_item_type="story", work_item_id=uuid.uuid4(),
                project_id=project_id, title="스토리 B(3816)", gate_id=uuid.uuid4(), gate_type="merge",
                requester_id=requester_id, approver_ids=[approver_id],
            )
            await s.commit()

            msgs = (await s.execute(select(ConversationMessage))).scalars().all()
            roots = [m for m in msgs if m.thread_id is None]
            assert len(roots) == 2, f"다른 스토리인데 스레드로 붕괴됐다: 최상위 {len(roots)}건"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_mutation_removing_root_lookup_regresses_to_new_root_every_time():
    """뮤테이션 셀프체크 — 이 테스트 자체는 GREEN이 정상(기존 조회 로직이 살아있는
    상태에서 3회 호출 → 최상위 1건). 이 파일의 첫 테스트(three_times_collapses)가
    바로 그 뮤테이션 킬러다: `existing_root` 조회 분기를 통째로 걷어내면(항상
    새 최상위 INSERT로 되돌리면) roots==3·replies==0이 되어 그 테스트가 RED로
    잡는다 — 이 테스트는 그 사실을 별도로 문서화하는 자리(로컬 뮤테이션 실행
    기록은 PR 본문 참고)."""
    from app.services.approval_delivery import dispatch_approval_request_cards
    from app.models.conversation import ConversationMessage
    from sqlalchemy import select

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            requester_id = await _seed_human(s, org_id, project_id, name="requester")
            approver_id = await _seed_human(s, org_id, project_id, name="approver")
            work_item_id = uuid.uuid4()

            for _ in range(3):
                await dispatch_approval_request_cards(
                    s, org_id=org_id, work_item_type="story", work_item_id=work_item_id,
                    project_id=project_id, title="같은 스토리", gate_id=uuid.uuid4(), gate_type="merge",
                    requester_id=requester_id, approver_ids=[approver_id],
                )
                await s.commit()

            msgs = (await s.execute(select(ConversationMessage))).scalars().all()
            roots = [m for m in msgs if m.thread_id is None]
            assert len(roots) == 1
    finally:
        await engine.dispose()
