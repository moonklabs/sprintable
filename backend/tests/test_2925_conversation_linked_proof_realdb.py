"""story #2925(2921-S2 선행, 유나 서면 확定) — ConversationItem에 「행 승격 신호」(linked_proof)
동봉. L1 대화 행은 참조(게이트) 있는 대화만 ProofCapsule card로 승격·색은 참조 대상의 실제
상태가 몬다·참조 없으면 plain(fail-safe·거짓 색 금지).

그라운딩(코드 실측, 2026-08-23): 대화가 게이트를 "임베드"하는 유일한 실 메커니즘은
`dispatch_approval_request_cards`(approval_delivery.py)가 심는
`ConversationMessage.msg_metadata['approval_target']['gate_id']`뿐 — entity_references는
이 경로를 안 거쳐(mentions 추출은 일반 send_message 경로에서만) 채워지지 않는다. 이 테스트는
그 실 메커니즘을 직접 재현한다(approval_delivery.py 자체를 호출하지 않고 동형 message row를
직접 심는다 — 이 스토리의 관심사는 list_conversations의 소비/도출 로직이지 배달 자체가 아님).
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

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
    from app.models.member import Member
    from app.models.organization import Organization
    from app.models.project import Project
    from app.models.project_access import ProjectAccess
    from app.models.user import User

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()

    user_id = uuid.uuid4()
    session.add(User(id=user_id, email=f"me-{user_id.hex[:8]}@test.com", hashed_password="x"))
    await session.commit()
    me = Member(id=uuid.uuid4(), org_id=org.id, type="human", user_id=user_id, name="Me")
    session.add(me)
    await session.commit()
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project.id, member_id=me.id, permission="granted", role="member",
    ))
    await session.commit()

    return {"org_id": org.id, "project_id": project.id, "user_id": user_id, "member_id": me.id}


async def _seed_conversation(session, *, org_id, project_id, member_id, title="Convo"):
    from app.models.conversation import Conversation, ConversationParticipant

    conv = Conversation(
        id=uuid.uuid4(), project_id=project_id, org_id=org_id, type="group",
        title=title, created_by=member_id,
    )
    session.add(conv)
    await session.flush()
    session.add(ConversationParticipant(conversation_id=conv.id, member_id=member_id))
    await session.commit()
    return conv


async def _seed_approval_message(session, *, conv_id, sender_id, gate_id, created_at):
    from app.models.conversation import ConversationMessage

    msg = ConversationMessage(
        id=uuid.uuid4(), conversation_id=conv_id, sender_id=sender_id,
        content="'X' 결재 요청", created_at=created_at,
        msg_metadata={
            "activation": {"audience": [str(sender_id)], "kind": "request", "expects_response": True},
            "approval_target": {
                "work_item_type": "story", "work_item_id": str(uuid.uuid4()),
                "gate_id": str(gate_id), "actions": ["approve", "reject"],
            },
        },
    )
    session.add(msg)
    await session.commit()
    return msg


async def _seed_gate(session, *, org_id, status, requires_human=True, work_item_id=None):
    from app.models.gate import Gate
    from app.services.merge_verdict_gate import MERGE_GATE_TYPE

    gate = Gate(
        id=uuid.uuid4(), org_id=org_id, work_item_id=work_item_id or uuid.uuid4(),
        work_item_type="story", gate_type=MERGE_GATE_TYPE, status=status,
        requires_human=requires_human,
    )
    session.add(gate)
    await session.commit()
    return gate


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


T0 = datetime(2026, 8, 23, 8, 0, 0, tzinfo=timezone.utc)


def _t(minutes: int) -> datetime:
    return T0 + timedelta(minutes=minutes)


async def _list_conversations(client, project_id):
    resp = await client.get("/api/v2/conversations", params={"project_id": str(project_id)})
    assert resp.status_code == 200, resp.text
    return resp.json()["data"]


@pytest.mark.parametrize(
    "gate_status,requires_human,expected_state",
    [
        ("pending", True, "pending_human"),
        ("pending", False, "waiting"),
        ("held", True, "waiting"),
        ("approved", False, "verified"),
        ("auto_passed", False, "verified"),
        ("rejected", False, "violation"),
    ],
)
async def test_linked_proof_state_mapping(gate_status, requires_human, expected_state):
    """게이트 status(+requires_human) → linked_proof.state 매핑(PO 전달 유나 확定 매핑)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_org_project_member(s)
            conv = await _seed_conversation(
                s, org_id=seeded["org_id"], project_id=seeded["project_id"], member_id=seeded["member_id"],
            )
            gate = await _seed_gate(
                s, org_id=seeded["org_id"], status=gate_status, requires_human=requires_human,
            )
            await _seed_approval_message(
                s, conv_id=conv.id, sender_id=seeded["member_id"], gate_id=gate.id, created_at=_t(0),
            )
            conv_id, gate_id = conv.id, gate.id

        await _setup_app_human(app, Session, seeded["user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            data = await _list_conversations(client, seeded["project_id"])
        finally:
            await client.aclose()

        assert len(data) == 1
        assert data[0]["id"] == str(conv_id)
        assert data[0]["linked_proof"] == {
            "kind": "gate", "state": expected_state, "gate_id": str(gate_id),
        }
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_linked_proof_null_when_no_gate_reference():
    """참조(게이트) 없는 대화 = null(fail-safe·거짓 색 금지) — 스토리 핵심 불변식."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_org_project_member(s)
            conv = await _seed_conversation(
                s, org_id=seeded["org_id"], project_id=seeded["project_id"], member_id=seeded["member_id"],
            )
            conv_id = conv.id

        await _setup_app_human(app, Session, seeded["user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            data = await _list_conversations(client, seeded["project_id"])
        finally:
            await client.aclose()

        assert len(data) == 1
        assert data[0]["id"] == str(conv_id)
        assert data[0]["linked_proof"] is None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_linked_proof_voided_gate_treated_as_no_reference():
    """voided는 4상태 어디에도 안 맞는 관리자-회수 상태 — 거짓 색을 칠하느니 null(지어내지 않는다)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_org_project_member(s)
            conv = await _seed_conversation(
                s, org_id=seeded["org_id"], project_id=seeded["project_id"], member_id=seeded["member_id"],
            )
            gate = await _seed_gate(s, org_id=seeded["org_id"], status="voided")
            await _seed_approval_message(
                s, conv_id=conv.id, sender_id=seeded["member_id"], gate_id=gate.id, created_at=_t(0),
            )
            conv_id = conv.id

        await _setup_app_human(app, Session, seeded["user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            data = await _list_conversations(client, seeded["project_id"])
        finally:
            await client.aclose()

        assert len(data) == 1
        assert data[0]["id"] == str(conv_id)
        assert data[0]["linked_proof"] is None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_linked_proof_prefers_open_gate_over_resolved_when_both_referenced():
    """한 대화에 재상신 등으로 게이트 참조가 둘(하나 closed·하나 open)이면 열린 쪽 우선
    (스토리 「열린 게이트(우선)」 원칙)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_org_project_member(s)
            conv = await _seed_conversation(
                s, org_id=seeded["org_id"], project_id=seeded["project_id"], member_id=seeded["member_id"],
            )
            closed_gate = await _seed_gate(s, org_id=seeded["org_id"], status="approved")
            open_gate = await _seed_gate(s, org_id=seeded["org_id"], status="pending", requires_human=True)
            # closed가 먼저(과거) 배달, open이 나중(최신) — 실제 재상신 흐름과 동형.
            await _seed_approval_message(
                s, conv_id=conv.id, sender_id=seeded["member_id"], gate_id=closed_gate.id, created_at=_t(0),
            )
            await _seed_approval_message(
                s, conv_id=conv.id, sender_id=seeded["member_id"], gate_id=open_gate.id, created_at=_t(5),
            )
            conv_id, open_gate_id = conv.id, open_gate.id

        await _setup_app_human(app, Session, seeded["user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            data = await _list_conversations(client, seeded["project_id"])
        finally:
            await client.aclose()

        assert len(data) == 1
        assert data[0]["id"] == str(conv_id)
        assert data[0]["linked_proof"] == {
            "kind": "gate", "state": "pending_human", "gate_id": str(open_gate_id),
        }
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_linked_proof_falls_back_to_most_recent_resolved_when_no_open_candidate():
    """열린 후보가 하나도 없으면(전부 해소) 가장 최근 해소된 게이트를 보여준다 — 승인 완료도
    "증명"으로서 보여줄 가치가 있다는 2916-B 원칙(전부 null로 숨기지 않음)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_org_project_member(s)
            conv = await _seed_conversation(
                s, org_id=seeded["org_id"], project_id=seeded["project_id"], member_id=seeded["member_id"],
            )
            older_gate = await _seed_gate(s, org_id=seeded["org_id"], status="rejected")
            newer_gate = await _seed_gate(s, org_id=seeded["org_id"], status="approved")
            await _seed_approval_message(
                s, conv_id=conv.id, sender_id=seeded["member_id"], gate_id=older_gate.id, created_at=_t(0),
            )
            await _seed_approval_message(
                s, conv_id=conv.id, sender_id=seeded["member_id"], gate_id=newer_gate.id, created_at=_t(5),
            )
            conv_id, newer_gate_id = conv.id, newer_gate.id

        await _setup_app_human(app, Session, seeded["user_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            data = await _list_conversations(client, seeded["project_id"])
        finally:
            await client.aclose()

        assert len(data) == 1
        assert data[0]["linked_proof"] == {
            "kind": "gate", "state": "verified", "gate_id": str(newer_gate_id),
        }
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_linked_proof_batch_query_not_n_plus_1():
    """대화 3개 각각 열린 게이트를 참조해도, linked_proof 도출 쿼리는 정확히 2회(approval_target
    조회 1 + Gate 배치조회 1)여야 한다 — 대화 수와 무관(N+1 방지, 스토리 성능 제약)."""
    from app.main import app
    from sqlalchemy import event

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_org_project_member(s)
            conv_ids = []
            for i in range(3):
                conv = await _seed_conversation(
                    s, org_id=seeded["org_id"], project_id=seeded["project_id"],
                    member_id=seeded["member_id"], title=f"Convo {i}",
                )
                gate = await _seed_gate(s, org_id=seeded["org_id"], status="pending", requires_human=True)
                await _seed_approval_message(
                    s, conv_id=conv.id, sender_id=seeded["member_id"], gate_id=gate.id, created_at=_t(i),
                )
                conv_ids.append(conv.id)

        await _setup_app_human(app, Session, seeded["user_id"], seeded["org_id"])
        client = _client_for(app)

        linked_proof_query_count = 0
        gate_batch_query_count = 0

        def _before_cursor_execute(conn, cursor, statement, parameters, context, executemany):
            nonlocal linked_proof_query_count, gate_batch_query_count
            low = statement.lower()
            # asyncpg는 리터럴을 바인드 파라미터($1 등)로 보내 'approval_target'/'gate_id'
            # 문자열 자체는 컴파일된 SQL에 안 남는다 — 대신 각 쿼리 고유의 구조적 시그니처로 식별.
            if "conversation_messages.metadata[" in low and "conversation_messages.conversation_id" in low:
                linked_proof_query_count += 1
            if low.strip().startswith("select gate.id, gate.org_id"):
                gate_batch_query_count += 1

        event.listen(engine.sync_engine, "before_cursor_execute", _before_cursor_execute)
        try:
            data = await _list_conversations(client, seeded["project_id"])
        finally:
            event.remove(engine.sync_engine, "before_cursor_execute", _before_cursor_execute)
            await client.aclose()

        assert len(data) == 3
        for item in data:
            assert item["linked_proof"] is not None and item["linked_proof"]["state"] == "pending_human"

        assert linked_proof_query_count == 1, (
            f"approval_target 조회가 {linked_proof_query_count}회(N+1 의심, 대화 3개)"
        )
        assert gate_batch_query_count == 1, (
            f"Gate 배치조회가 {gate_batch_query_count}회(N+1 의심, 대화 3개)"
        )
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
