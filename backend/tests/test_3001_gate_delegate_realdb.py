"""story #3001(선생님 정책 확定 2026-08-24) — 카드=지정 라인 전용(정보성 폐기)+위임(튕겨내기)
신설. 핵심 검증축:
①dispatch_approval_request_cards가 지정 시 비지정자에게 카드 자체를 안 보내는지(별도
test_2985 파일에서도 검증하지만 여기선 delegate 왕복의 전제로 재확認)
②POST /api/v2/gates/{id}/delegate — 지정자 본인만 위임 가능(403: 비지정자·타인)
③위임 대상은 해소 권한자(owner/admin)여야(400: 자격 밖)
④본인 위임 금지(422)
⑤이미 해소된 게이트는 위임 불가(409)
⑥성공 시 gate.designated_approver_id 갱신+새 지정자에게 신규 액션 카드+원 지정자에게
conversation.gate_delegated Event(실시간 반영)+ActivityLog(gate_delegated) 기록
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
    import app.models.activity_log  # noqa: F401 — delegate 엔드포인트가 ActivityLog를 씀.

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
    """create_all() 세션에서는 team_members가 실 VIEW가 아니라 빈 테이블이라(마이그 없이는
    org_members만 있어도 자동 채워지지 않는다 — reference_local_realdb_pg16_pgvector 교훈)
    conversations.created_by/mentioned_ids가 참조할 TeamMember 행을 OrgMember와 **같은
    id**로 직접 심는다. dispatch_approval_request_cards가 만드는 Conversation FK가 이
    행을 요구한다(#2985 테스트 파일의 _seed_human과 동일 이유, 여긴 OrgMember.role
    조회(위임 대상 자격 검증)도 같이 필요해 User+OrgMember까지 얹은 것만 다름)."""
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


async def _seed_scenario(session, *, designated_role="member", new_approver_role="admin"):
    from app.models.organization import Organization
    from app.models.project import Project
    from app.models.doc import Doc
    from app.models.gate import Gate

    org = Organization(id=uuid.uuid4(), name="Org3001", slug=f"org3001-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()

    requester_user_id, requester_member_id = await _seed_org_member(session, org.id, project.id, name="requester")
    designated_user_id, designated_member_id = await _seed_org_member(session, org.id, project.id, role=designated_role, name="designated")
    new_approver_user_id, new_approver_member_id = await _seed_org_member(session, org.id, project.id, role=new_approver_role, name="newapprover")
    outsider_user_id, outsider_member_id = await _seed_org_member(session, org.id, project.id, role="member", name="outsider")

    doc = Doc(
        id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="#3001 위임 검증 문서",
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

    # 실 상신이면 dispatch_approval_request_cards가 이미 지정자에게 원 카드를 심어 뒀을
    # 것 — notify_gate_delegated_to_old_approver가 "실제 카드 심어진 곳"으로 project_id를
    # 역조회하므로(신규 gate_type별 해소 로직 없음) 이 카드가 먼저 있어야 위임 시 그
    # 이벤트가 실제로 발행된다.
    from app.services.approval_delivery import dispatch_approval_request_cards
    await dispatch_approval_request_cards(
        session, org_id=org.id, work_item_type="doc", work_item_id=doc.id,
        project_id=project.id, title=doc.title, gate_id=gate.id,
        requester_id=requester_member_id, approver_ids=[designated_member_id],
        designated_approver_id=designated_member_id,
    )
    await session.commit()

    return {
        "org_id": org.id, "project_id": project.id, "doc_id": doc.id, "gate_id": gate.id,
        "requester_member_id": requester_member_id,
        "designated_user_id": designated_user_id, "designated_member_id": designated_member_id,
        "new_approver_user_id": new_approver_user_id, "new_approver_member_id": new_approver_member_id,
        "outsider_user_id": outsider_user_id, "outsider_member_id": outsider_member_id,
    }


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_delegate_success_reassigns_and_dispatches_new_card_and_delegated_event():
    from app.main import app
    from app.models.gate import Gate
    from app.models.conversation import ConversationMessage
    from app.models.event import Event
    from app.models.activity_log import ActivityLog
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_scenario(s)

        await _setup_app(app, Session, seeded["org_id"], seeded["designated_user_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/gates/{seeded['gate_id']}/delegate",
                json={"new_approver_member_id": str(seeded["new_approver_member_id"])},
            )
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["designated_approver_id"] == str(seeded["new_approver_member_id"])
        finally:
            await client.aclose()

        async with Session() as s:
            gate = (await s.execute(select(Gate).where(Gate.id == seeded["gate_id"]))).scalar_one()
            assert gate.designated_approver_id == seeded["new_approver_member_id"]

            # 새 지정자에게 신규 액션 카드.
            new_msgs = (await s.execute(
                select(ConversationMessage).where(
                    ConversationMessage.msg_metadata["approval_target"]["gate_id"].astext == str(seeded["gate_id"]),
                    ConversationMessage.mentioned_ids.contains([seeded["new_approver_member_id"]]),
                )
            )).scalars().all()
            assert len(new_msgs) == 1
            assert new_msgs[0].msg_metadata["activation"]["kind"] == "request"
            assert new_msgs[0].msg_metadata["approval_target"]["designated"] is True

            # 원 지정자(위임한 사람)에게 gate_delegated 이벤트.
            events = (await s.execute(
                select(Event).where(
                    Event.event_type == "conversation.gate_delegated",
                    Event.recipient_id == seeded["designated_member_id"],
                )
            )).scalars().all()
            assert len(events) == 1
            assert events[0].payload["new_approver_id"] == str(seeded["new_approver_member_id"])

            # 감사 기록.
            logs = (await s.execute(
                select(ActivityLog).where(
                    ActivityLog.entity_id == seeded["gate_id"], ActivityLog.action == "gate_delegated",
                )
            )).scalars().all()
            assert len(logs) == 1
            assert logs[0].context["from_member_id"] == str(seeded["designated_member_id"])
            assert logs[0].context["to_member_id"] == str(seeded["new_approver_member_id"])
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_delegate_forbidden_for_non_designated_caller():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_scenario(s)

        # outsider(지정자 아님)가 위임 시도.
        await _setup_app(app, Session, seeded["org_id"], seeded["outsider_user_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/gates/{seeded['gate_id']}/delegate",
                json={"new_approver_member_id": str(seeded["new_approver_member_id"])},
            )
            assert resp.status_code == 403, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_delegate_rejects_ineligible_target_not_owner_or_admin():
    """PO 보강① — 위임 대상이 해소 권한자(owner/admin)가 아니면 400. outsider(role=member)
    로 위임하려는 시도."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_scenario(s)

        await _setup_app(app, Session, seeded["org_id"], seeded["designated_user_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/gates/{seeded['gate_id']}/delegate",
                json={"new_approver_member_id": str(seeded["outsider_member_id"])},
            )
            assert resp.status_code == 400, resp.text
            assert resp.json()["error"]["code"] == "ineligible_delegate_target"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_delegate_self_delegation_rejected():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_scenario(s)

        await _setup_app(app, Session, seeded["org_id"], seeded["designated_user_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/gates/{seeded['gate_id']}/delegate",
                json={"new_approver_member_id": str(seeded["designated_member_id"])},
            )
            assert resp.status_code == 422, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@_REAL_DB_SKIP
@pytest.mark.anyio
async def test_delegate_already_resolved_gate_rejected():
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
                f"/api/v2/gates/{seeded['gate_id']}/delegate",
                json={"new_approver_member_id": str(seeded["new_approver_member_id"])},
            )
            assert resp.status_code == 409, resp.text
            assert resp.json()["error"]["code"] == "gate_already_resolved"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
