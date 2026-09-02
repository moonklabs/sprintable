"""story d1f4afcb(2026-09-02, 담롱 그라운딩·PO 판정) — 「문서가 아직 draft — 결재
상신?」 자동 넛지(story #2747)가 두 자리에서 오도한다:

①**시스템/이벤트 발신 메시지 옆에도 뜬다** — `preset.gate.verdict` 반려 통지와 같은
초에 도착해, 실행자를 정답 경로(레시피 stage 이벤트 재발행)가 아니라 별도 문서
결재(`submit_for_approval`)로 유인한다.
②**이미 external_publish 게이트가 걸린 doc에도 뜬다** — 그 게이트가 이미 발행/반려를
관장 중인데 별도 문서 결재를 권하면 상태와 모순되는 두 번째 경로가 생긴다.

이 파일은 두 축을 실 PG로 고정한다. ①은 라우터 계층(`send_message`)의 `event_context`
분기라 HTTP 경로(`test_2637_event_msg_metadata_tagging.py`와 동형 harness)로,
②는 서비스 함수(`maybe_nudge_draft_doc_shared_in_chat`) 직접 호출(`test_2747_draft_
doc_chat_nudge_realdb.py`와 동형 harness)로 검증한다."""
from __future__ import annotations

import os
import uuid

import pytest
from fastapi import BackgroundTasks
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
    """test_2747_draft_doc_chat_nudge_realdb.py::_seed_human_member 재사용(동형 복제 —
    이 파일이 별도 harness 모듈을 두지 않는 조직 관례를 그대로 따름)."""
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
    from app.models.team import TeamMember

    session.add(TeamMember(
        id=m.id, org_id=org_id, project_id=project_id, user_id=user_id,
        type="human", name=name, role="member",
    ))
    await session.commit()
    return m.id


async def _seed_agent(session, org_id, project_id, *, name="agent"):
    from app.models.team import TeamMember

    m = TeamMember(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, type="agent", name=name, is_active=True,
    )
    session.add(m)
    await session.commit()
    return m.id


async def _seed_org_project(session, *, slug_prefix="d1f4afcb"):
    from app.models.organization import Organization
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="OrgD1f4afcb", slug=f"{slug_prefix}-{uuid.uuid4().hex[:8]}")
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


async def _seed_external_publish_gate(session, org_id, doc_id, doc_title, *, status="pending"):
    """recipe_gate_hooks.py::_build_approval_neutral_facts가 실제로 채우는 형태 그대로
    (build_reference_token과 동일 포맷) — 새 포맷 발명 0."""
    from app.models.gate import Gate
    from app.services.reference_token import build_reference_token

    token = build_reference_token("doc", doc_id, doc_title)
    gate = Gate(
        id=uuid.uuid4(), org_id=org_id, work_item_type="story", work_item_id=uuid.uuid4(),
        gate_type="external_publish", status=status,
        neutral_facts={"draft_doc_reference_token": token},
    )
    session.add(gate)
    await session.commit()
    return gate.id


async def _count_nudge_messages(session, doc_id):
    from app.models.conversation import ConversationMessage

    rows = (await session.execute(
        select(ConversationMessage).where(
            ConversationMessage.msg_metadata["nudge_target"]["doc_id"].astext == str(doc_id),
        )
    )).scalars().all()
    return rows


def _auth(agent_id: uuid.UUID, org_id: uuid.UUID) -> "AuthContext":
    from app.dependencies.auth import AuthContext
    return AuthContext(
        user_id=str(agent_id), email=None,
        claims={"app_metadata": {"api_key_id": str(uuid.uuid4())}}, org_id=str(org_id),
    )


def _fake_request() -> "StarletteRequest":
    from starlette.requests import Request as StarletteRequest
    return StarletteRequest(scope={"type": "http", "headers": []})


# ─────────────────────────────────────────────────────────────────────────────
# AC2 — doc에 열린(pending/rejected) external_publish 게이트가 있으면 넛지 억제.
# ─────────────────────────────────────────────────────────────────────────────

@pytest.mark.anyio
@pytest.mark.parametrize("gate_status", ["pending", "rejected"])
async def test_doc_with_open_external_publish_gate_does_not_nudge(gate_status):
    """⭐AC2 — pending·rejected 둘 다 "열린" 게이트로 취급해 넛지 억제."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            author_id = await _seed_human_member(s, org_id, project_id, name="Author")
            sender_id = await _seed_human_member(s, org_id, project_id, name="Sender")
            doc_id = await _seed_doc(s, org_id, project_id, author_id, title="3바퀴 draft")
            await _seed_external_publish_gate(s, org_id, doc_id, "3바퀴 draft", status=gate_status)

        from app.services.approval_delivery import maybe_nudge_draft_doc_shared_in_chat
        async with Session() as s:
            await maybe_nudge_draft_doc_shared_in_chat(
                s, org_id=org_id, project_id=project_id, doc_id=doc_id,
                doc_title="3바퀴 draft", doc_status="draft",
                doc_author_id=author_id, sender_id=sender_id,
            )
            await s.commit()

        async with Session() as s:
            rows = await _count_nudge_messages(s, doc_id)
            assert len(rows) == 0, f"열린 external_publish 게이트가 있는데도 넛지가 나감: {len(rows)}건"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_doc_with_approved_external_publish_gate_still_nudges():
    """음성대조 — approved(닫힌 게이트)는 억제 대상이 아니다(AC2 "열린"=pending/rejected만).
    이미 승인돼 발행이 끝난 doc이 draft로 남아있다면 별도 결재 상신 권유가 여전히
    유효한 신호일 수 있다 — 억제 조건을 무분별하게 넓히지 않는다."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            author_id = await _seed_human_member(s, org_id, project_id, name="Author")
            sender_id = await _seed_human_member(s, org_id, project_id, name="Sender")
            doc_id = await _seed_doc(s, org_id, project_id, author_id, title="완료된 산출물")
            await _seed_external_publish_gate(s, org_id, doc_id, "완료된 산출물", status="approved")

        from app.services.approval_delivery import maybe_nudge_draft_doc_shared_in_chat
        async with Session() as s:
            await maybe_nudge_draft_doc_shared_in_chat(
                s, org_id=org_id, project_id=project_id, doc_id=doc_id,
                doc_title="완료된 산출물", doc_status="draft",
                doc_author_id=author_id, sender_id=sender_id,
            )
            await s.commit()

        async with Session() as s:
            rows = await _count_nudge_messages(s, doc_id)
            assert len(rows) == 1, f"approved(닫힌) 게이트인데 넛지가 억제됨(과도한 억제): {len(rows)}건"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_gate_for_different_doc_does_not_suppress_nudge():
    """음성대조 — 다른 doc을 대상으로 하는 external_publish 게이트가 있어도(같은 org)
    이 doc의 넛지는 억제되지 않는다(LIKE 매치가 doc-특정적임을 고정 — 함정 doc 실재
    대조, story #3329의 「토큰 속 토큰」 회귀가드와 동형 원칙)."""
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            author_id = await _seed_human_member(s, org_id, project_id, name="Author")
            sender_id = await _seed_human_member(s, org_id, project_id, name="Sender")
            doc_id = await _seed_doc(s, org_id, project_id, author_id, title="타깃 문서")
            other_doc_id = await _seed_doc(s, org_id, project_id, author_id, title="딴 문서")
            await _seed_external_publish_gate(s, org_id, other_doc_id, "딴 문서", status="pending")

        from app.services.approval_delivery import maybe_nudge_draft_doc_shared_in_chat
        async with Session() as s:
            await maybe_nudge_draft_doc_shared_in_chat(
                s, org_id=org_id, project_id=project_id, doc_id=doc_id,
                doc_title="타깃 문서", doc_status="draft",
                doc_author_id=author_id, sender_id=sender_id,
            )
            await s.commit()

        async with Session() as s:
            rows = await _count_nudge_messages(s, doc_id)
            assert len(rows) == 1, f"딴 doc의 게이트가 이 doc의 넛지까지 억제함(오탐): {len(rows)}건"
    finally:
        await engine.dispose()


# ─────────────────────────────────────────────────────────────────────────────
# AC1 — 시스템/이벤트 발신 메시지(event_context 有)는 넛지 트리거 자체가 안 된다.
# 라우터 계층(send_message) HTTP 경로로 검증 — test_2637_event_msg_metadata_tagging.py와
# 동형 harness(publish_registry_event가 실제로 event_context를 채우는 그 경로).
# ─────────────────────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_event_generated_message_mentioning_draft_doc_does_not_nudge():
    """⭐AC1 — event_context가 있는 메시지(시스템 판정 카드)가 draft doc을 참조 토큰으로
    담고 있어도 넛지가 트리거되지 않는다(반려 통지·결재 권유 동시 도착 오도 실사고 처방)."""
    from app.routers.conversations import SendMessageRequest, send_message

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            author_id = await _seed_human_member(s, org_id, project_id, name="Author")
            publisher_id = await _seed_agent(s, org_id, project_id, name="publisher")
            doc_id = await _seed_doc(s, org_id, project_id, author_id, title="게이트 대상 문서")

            from app.routers.events import _get_or_create_event_conversation

            conv = await _get_or_create_event_conversation(
                s, org_id=org_id, project_id=project_id,
                participant_ids={publisher_id, author_id}, created_by=publisher_id,
            )
            await send_message(
                conv.id,
                SendMessageRequest(
                    content=f"게이트 반려 — 대상 산출물: [게이트 대상 문서](entity:doc:{doc_id})",
                    event_context={"event_key": "preset.gate.verdict", "payload": {"verdict": "rejected"}},
                ),
                BackgroundTasks(), db=s, auth=_auth(publisher_id, org_id), org_id=org_id,
            )

        async with Session() as s:
            rows = await _count_nudge_messages(s, doc_id)
            assert len(rows) == 0, f"event_context 메시지가 draft doc mention으로 넛지를 냄(오도 재발): {len(rows)}건"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_organic_chat_message_mentioning_draft_doc_still_nudges():
    """음성대조(AC3 회귀 0) — event_context 없는 일반 사람 채팅이 draft doc을 mention하면
    기존대로 넛지가 뜬다(라우터 배선이 실제로 event_context 유무로만 갈리는지, 조건을
    통째로 죽인 게 아닌지 확認)."""
    from app.routers.conversations import SendMessageRequest, send_message

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            author_id = await _seed_human_member(s, org_id, project_id, name="Author")
            sender_id = await _seed_human_member(s, org_id, project_id, name="Sender")
            doc_id = await _seed_doc(s, org_id, project_id, author_id, title="논의된 문서")

            from app.routers.events import _get_or_create_event_conversation

            conv = await _get_or_create_event_conversation(
                s, org_id=org_id, project_id=project_id,
                participant_ids={sender_id, author_id}, created_by=sender_id,
            )
            await send_message(
                conv.id,
                SendMessageRequest(content=f"[논의된 문서](entity:doc:{doc_id}) 검토 부탁드리는"),
                BackgroundTasks(), db=s, auth=_auth(sender_id, org_id), org_id=org_id,
            )

        async with Session() as s:
            rows = await _count_nudge_messages(s, doc_id)
            assert len(rows) == 1, f"organic 채팅 mention인데 넛지가 안 남(과도한 억제): {len(rows)}건"
    finally:
        await engine.dispose()
