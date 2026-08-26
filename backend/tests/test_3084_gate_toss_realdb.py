"""story #3084(2026-08-25, 선생님 지시 — 결재 카드 «토스») 층1+층3 검증축:
①POST /api/v2/gates/{id}/toss — requester 또는 designated 본인만 토스 가능(403: 제3자)
②대상 conversation에 designated 본인이 참여자여야(422 target_approver_not_participant)
③성공 시 대상 conversation에 카드 사본(같은 gate_id) 삽입+conversation.gate_tossed
  Event(원 카드 보유 conversation 수신자에게)+ActivityLog(gate_tossed) 기록, 원 카드는 잔존
④같은 대상에 재토스 시 멱등(카드 중복 삽입 없음)
⑤이미 해소된 게이트는 토스 불가(409)
⑥GET /api/v2/gates/designated-pending-count — designated_approver_id=me AND status=pending
  카운트, 카드가 심긴 conversation 개수·토스 여부와 무관(층1의 "room 불문" 불변식)
⑦층2(best-effort 자동 심기) — designated가 상신 시점에 이미 참여 중인 다른 conversation이
  있으면 dispatch_approval_request_cards가 그 방에도 카드 사본을 자동으로 심는다
로컬 PG 미설정 시 skip(CI 관례 동일)."""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = pytest.mark.destructive_schema

_REAL_DB_SKIP = pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요")


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _session_factory():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from app.core.database import Base
    import app.models  # noqa: F401
    import app.models.activity_log  # noqa: F401 — toss 엔드포인트가 ActivityLog를 씀.

    engine = create_async_engine(_async_url())
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


def _client_for(app):
    from httpx import ASGITransport, AsyncClient
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _setup_app(app, Session, org_id, user_id):
    from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
    from tests.conftest import override_db_and_read

    async def _db():
        async with Session() as s:
            try:
                yield s
                await s.commit()
            except Exception:
                await s.rollback()
                raise

    async def _auth():
        return AuthContext(user_id=str(user_id), email="caller@test", claims={"app_metadata": {}})

    async def _org():
        return org_id

    override_db_and_read(app, _db)
    app.dependency_overrides[get_current_user] = _auth
    app.dependency_overrides[get_verified_org_id] = _org


async def _seed_org_member(session, org_id, project_id, *, role="member", name="member"):
    from app.models.user import User
    from app.models.project import OrgMember
    from app.models.team import TeamMember

    user = User(id=uuid.uuid4(), email=f"{name}-{uuid.uuid4().hex[:8]}@test.com", hashed_password="x")
    session.add(user)
    await session.commit()
    om = OrgMember(id=uuid.uuid4(), org_id=org_id, user_id=user.id, role=role)
    session.add(om)
    await session.commit()
    session.add(TeamMember(
        id=om.id, org_id=org_id, project_id=project_id, type="human", name=name, is_active=True,
    ))
    await session.commit()
    return user.id, om.id


async def _seed_scenario(session):
    from app.models.organization import Organization
    from app.models.project import Project
    from app.models.doc import Doc
    from app.models.gate import Gate
    from app.models.conversation import Conversation, ConversationParticipant

    org = Organization(id=uuid.uuid4(), name="Org3084", slug=f"org3084-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()

    requester_user_id, requester_member_id = await _seed_org_member(session, org.id, project.id, name="requester")
    designated_user_id, designated_member_id = await _seed_org_member(
        session, org.id, project.id, role="owner", name="designated",
    )
    outsider_user_id, outsider_member_id = await _seed_org_member(session, org.id, project.id, name="outsider")

    doc = Doc(
        id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="#3084 토스 검증 문서",
        content="본문", status="pending", slug=f"doc-{uuid.uuid4().hex[:8]}",
    )
    session.add(doc)
    await session.commit()

    gate = Gate(
        id=uuid.uuid4(), org_id=org.id, work_item_id=doc.id, work_item_type="doc",
        gate_type="doc_approval", status="pending",
        designated_approver_id=designated_member_id,
        neutral_facts={"requested_by_member_id": str(requester_member_id), "doc_title": doc.title},
    )
    session.add(gate)
    await session.commit()

    # 실 상신 카드(원 카드) — requester↔designated 페어와이즈 DM.
    from app.services.approval_delivery import dispatch_approval_request_cards
    await dispatch_approval_request_cards(
        session, org_id=org.id, work_item_type="doc", work_item_id=doc.id,
        project_id=project.id, title=doc.title, gate_id=gate.id,
        requester_id=requester_member_id, approver_ids=[designated_member_id],
        designated_approver_id=designated_member_id,
    )
    await session.commit()

    # 토스 대상 conversation — designated가 참여한 별도 방(예: PO와의 주 채널 아날로그).
    target_conv = Conversation(id=uuid.uuid4(), org_id=org.id, project_id=project.id, type="group", title="주 채널")
    session.add(target_conv)
    await session.commit()
    session.add(ConversationParticipant(id=uuid.uuid4(), conversation_id=target_conv.id, member_id=designated_member_id))
    await session.commit()

    # designated 미참여 conversation — 422 검증용.
    no_designated_conv = Conversation(id=uuid.uuid4(), org_id=org.id, project_id=project.id, type="group", title="무관 방")
    session.add(no_designated_conv)
    await session.commit()
    session.add(ConversationParticipant(id=uuid.uuid4(), conversation_id=no_designated_conv.id, member_id=outsider_member_id))
    await session.commit()

    return {
        "org_id": org.id, "project_id": project.id, "doc_id": doc.id, "gate_id": gate.id,
        "requester_user_id": requester_user_id, "requester_member_id": requester_member_id,
        "designated_user_id": designated_user_id, "designated_member_id": designated_member_id,
        "outsider_user_id": outsider_user_id, "outsider_member_id": outsider_member_id,
        "target_conversation_id": target_conv.id,
        "no_designated_conversation_id": no_designated_conv.id,
    }


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_toss_success_inserts_copy_and_broadcasts_and_logs():
    from app.main import app
    from app.models.conversation import ConversationMessage
    from app.models.event import Event
    from app.models.activity_log import ActivityLog
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_scenario(s)

        # designated 본인이 토스(자기가 다른 방으로 옮기는 경우).
        await _setup_app(app, Session, seeded["org_id"], seeded["designated_user_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/gates/{seeded['gate_id']}/toss",
                json={"target_conversation_id": str(seeded["target_conversation_id"])},
            )
            assert resp.status_code == 200, resp.text
        finally:
            await client.aclose()

        async with Session() as s:
            copies = (await s.execute(
                select(ConversationMessage).where(
                    ConversationMessage.msg_metadata["approval_target"]["gate_id"].astext == str(seeded["gate_id"]),
                )
            )).scalars().all()
            # 원 카드(requester↔designated DM) + 토스 사본(target_conversation) = 2개.
            assert len(copies) == 2
            conv_ids = {c.conversation_id for c in copies}
            assert seeded["target_conversation_id"] in conv_ids
            tossed = next(c for c in copies if c.conversation_id == seeded["target_conversation_id"])
            assert tossed.msg_metadata["approval_target"]["tossed"] is True
            assert tossed.mentioned_ids == [seeded["designated_member_id"]]

            events = (await s.execute(
                select(Event).where(Event.event_type == "conversation.gate_tossed")
            )).scalars().all()
            assert len(events) >= 1
            assert events[0].payload["target_conversation_id"] == str(seeded["target_conversation_id"])

            logs = (await s.execute(
                select(ActivityLog).where(
                    ActivityLog.entity_id == seeded["gate_id"], ActivityLog.action == "gate_tossed",
                )
            )).scalars().all()
            assert len(logs) == 1
            assert logs[0].context["target_conversation_id"] == str(seeded["target_conversation_id"])
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_toss_allowed_for_requester_too():
    """PO 판정(2026-08-25) — 권한은 requester+designated 본인 한정(admin 확장 기각).
    requester가 «designated가 실제로 있는 방을 안다»는 케이스를 커버."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_scenario(s)

        await _setup_app(app, Session, seeded["org_id"], seeded["requester_user_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/gates/{seeded['gate_id']}/toss",
                json={"target_conversation_id": str(seeded["target_conversation_id"])},
            )
            assert resp.status_code == 200, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_toss_forbidden_for_third_party():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_scenario(s)

        await _setup_app(app, Session, seeded["org_id"], seeded["outsider_user_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/gates/{seeded['gate_id']}/toss",
                json={"target_conversation_id": str(seeded["target_conversation_id"])},
            )
            assert resp.status_code == 403, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_toss_rejects_target_without_designated_participant():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_scenario(s)

        await _setup_app(app, Session, seeded["org_id"], seeded["designated_user_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/gates/{seeded['gate_id']}/toss",
                json={"target_conversation_id": str(seeded["no_designated_conversation_id"])},
            )
            assert resp.status_code == 422, resp.text
            assert resp.json()["error"]["code"] == "target_approver_not_participant"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_toss_idempotent_no_duplicate_copy_on_retoss():
    from app.main import app
    from app.models.conversation import ConversationMessage
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_scenario(s)

        await _setup_app(app, Session, seeded["org_id"], seeded["designated_user_id"])
        client = _client_for(app)
        try:
            for _ in range(2):
                resp = await client.post(
                    f"/api/v2/gates/{seeded['gate_id']}/toss",
                    json={"target_conversation_id": str(seeded["target_conversation_id"])},
                )
                assert resp.status_code == 200, resp.text
        finally:
            await client.aclose()

        async with Session() as s:
            copies = (await s.execute(
                select(ConversationMessage).where(
                    ConversationMessage.conversation_id == seeded["target_conversation_id"],
                    ConversationMessage.msg_metadata["approval_target"]["gate_id"].astext == str(seeded["gate_id"]),
                )
            )).scalars().all()
            assert len(copies) == 1  # 재토스는 멱등 — 중복 삽입 없음.
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_toss_already_resolved_gate_rejected():
    from app.main import app
    from app.models.gate import Gate
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_scenario(s)
            gate = (await s.execute(select(Gate).where(Gate.id == seeded["gate_id"]))).scalar_one()
            gate.status = "approved"
            gate.resolver_id = seeded["designated_member_id"]
            await s.commit()

        await _setup_app(app, Session, seeded["org_id"], seeded["designated_user_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/gates/{seeded['gate_id']}/toss",
                json={"target_conversation_id": str(seeded["target_conversation_id"])},
            )
            assert resp.status_code == 409, resp.text
            assert resp.json()["error"]["code"] == "gate_already_resolved"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_designated_pending_count_room_agnostic():
    """층1 불변식 — 카드가 몇 개 방에 심겼든(토스 전/후 무관) 카운트는 오직
    designated_approver_id=me AND status=pending 로만 결정된다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_scenario(s)

        await _setup_app(app, Session, seeded["org_id"], seeded["designated_user_id"])
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/gates/designated-pending-count")
            assert resp.status_code == 200, resp.text
            assert resp.json()["count"] == 1

            # 토스해도(카드가 방 2개가 돼도) 카운트는 그대로 1 — room 불문.
            toss_resp = await client.post(
                f"/api/v2/gates/{seeded['gate_id']}/toss",
                json={"target_conversation_id": str(seeded["target_conversation_id"])},
            )
            assert toss_resp.status_code == 200, toss_resp.text

            resp2 = await client.get("/api/v2/gates/designated-pending-count")
            assert resp2.status_code == 200, resp2.text
            assert resp2.json()["count"] == 1
        finally:
            await client.aclose()

        # outsider(무관자)는 0.
        await _setup_app(app, Session, seeded["org_id"], seeded["outsider_user_id"])
        client2 = _client_for(app)
        try:
            resp3 = await client2.get("/api/v2/gates/designated-pending-count")
            assert resp3.status_code == 200, resp3.text
            assert resp3.json()["count"] == 0
        finally:
            await client2.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_layer2_auto_seeds_designated_preexisting_conversation():
    """층2(best-effort 자동 심기) — designated가 상신 *시점에 이미* 참여 중인 다른
    conversation이 있으면(방금 만든 페어와이즈 DM 말고) dispatch_approval_request_cards가
    그 방에도 카드 사본을 자동으로 심는다. "최근 활성" 판정 — 방금 만든 신규 DM(updated_at=
    지금)이 아니라 그 pre-existing 방이 선택되는지가 이 테스트의 핵심(방금 만든 DM이 항상
    "최근"으로 잡혀 층2가 매번 no-op이 되는 회귀를 잡는다)."""
    from app.models.organization import Organization
    from app.models.project import Project
    from app.models.doc import Doc
    from app.models.gate import Gate
    from app.models.conversation import Conversation, ConversationParticipant, ConversationMessage
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = Organization(id=uuid.uuid4(), name="Org3084L2", slug=f"org3084l2-{uuid.uuid4().hex[:8]}")
            s.add(org)
            await s.commit()
            project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
            s.add(project)
            await s.commit()

            requester_user_id, requester_member_id = await _seed_org_member(s, org.id, project.id, name="requester")
            designated_user_id, designated_member_id = await _seed_org_member(
                s, org.id, project.id, role="owner", name="designated",
            )

            # designated가 상신 *이전부터* 참여 중이던 방(예: PO와의 주 채널 아날로그).
            preexisting_conv = Conversation(
                id=uuid.uuid4(), org_id=org.id, project_id=project.id, type="group", title="주 채널",
            )
            s.add(preexisting_conv)
            await s.commit()
            s.add(ConversationParticipant(
                id=uuid.uuid4(), conversation_id=preexisting_conv.id, member_id=designated_member_id,
            ))
            await s.commit()

            doc = Doc(
                id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="#3084 층2 검증 문서",
                content="본문", status="pending", slug=f"doc-{uuid.uuid4().hex[:8]}",
            )
            s.add(doc)
            await s.commit()

            gate = Gate(
                id=uuid.uuid4(), org_id=org.id, work_item_id=doc.id, work_item_type="doc",
                gate_type="doc_approval", status="pending",
                designated_approver_id=designated_member_id,
                neutral_facts={"requested_by_member_id": str(requester_member_id), "doc_title": doc.title},
            )
            s.add(gate)
            await s.commit()

            from app.services.approval_delivery import dispatch_approval_request_cards
            await dispatch_approval_request_cards(
                s, org_id=org.id, work_item_type="doc", work_item_id=doc.id,
                project_id=project.id, title=doc.title, gate_id=gate.id,
                requester_id=requester_member_id, approver_ids=[designated_member_id],
                designated_approver_id=designated_member_id,
            )
            await s.commit()

        async with Session() as s:
            copies = (await s.execute(
                select(ConversationMessage).where(
                    ConversationMessage.msg_metadata["approval_target"]["gate_id"].astext == str(gate.id),
                )
            )).scalars().all()
            conv_ids = {c.conversation_id for c in copies}
            # 원 카드(신규 페어와이즈 DM) + 층2 자동 심기(preexisting_conv) = 2개.
            assert len(copies) == 2
            assert preexisting_conv.id in conv_ids
    finally:
        await engine.dispose()
