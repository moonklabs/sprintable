"""story #3828(UX-v3·대화·BE 1, 페드루 PO 確定 2026-09-13) — 「지시 한 줄 → 실행 →
결과가 같은 스레드로 돌아온다」의 연결 자리(마이그 0374) 실PG 검증.

①agent_runs.conversation_id·triggering_message_id 저장/조회(org 격리·형식 검증)
②메시지 work_item 태그(approval_target류 activation과 공존) ③GET /conversations/
by-work-item(org 격리·최근순·미태그 빈 배열) ④「오늘」(story #3823) agent_progress·
needs_me 행의 conversation_id 노출."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
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
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from app.core.database import Base
    import app.models  # noqa: F401

    engine = create_async_engine(_async_url())
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _make_org(session, name="Org3828"):
    from app.models.organization import Organization
    org = Organization(id=uuid.uuid4(), name=name, slug=f"org3828-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    return org


async def _make_project(session, org_id, name="P"):
    from app.models.project import Project
    project = Project(id=uuid.uuid4(), org_id=org_id, name=name)
    session.add(project)
    await session.commit()
    return project


async def _make_member(session, org_id, project_id, *, type_="human", org_role="owner", name="member"):
    from app.models.user import User
    from app.models.project import OrgMember
    from app.models.project_access import ProjectAccess
    from app.models.member import Member
    from app.models.team import TeamMember

    user = User(id=uuid.uuid4(), email=f"u-{uuid.uuid4().hex[:8]}@test.local", hashed_password="x")
    session.add(user)
    await session.flush()
    om = OrgMember(id=uuid.uuid4(), org_id=org_id, user_id=user.id, role=org_role)
    session.add(om)
    await session.flush()
    m = Member(id=om.id, org_id=org_id, type=type_, user_id=user.id, name=name)
    session.add(m)
    await session.flush()
    session.add(ProjectAccess(project_id=project_id, org_member_id=om.id, member_id=m.id, role="member"))
    # story #0088 주석 근거 — 실 dev/prod에서 team_members는 members ⋈ project_access
    # VIEW지만, 이 테스트의 create_all()은 그 뷰 정의를 모르고 선언된 Table 그대로
    # 물리 테이블을 만든다 — ConversationParticipant.member_id FK가 이 테이블을
    # 가리키므로 같은 id로 직접 채워야 한다(test_2288/test_3821과 동일 관례).
    session.add(TeamMember(id=m.id, org_id=org_id, project_id=project_id, type=type_, name=name, is_active=True))
    await session.commit()
    return m.id, user.id


async def _make_conversation(session, org_id, project_id, *, member_ids, conv_type="dm"):
    from app.models.conversation import Conversation, ConversationParticipant

    conv = Conversation(id=uuid.uuid4(), org_id=org_id, project_id=project_id, type=conv_type, title=None)
    session.add(conv)
    await session.commit()
    for mid in member_ids:
        session.add(ConversationParticipant(id=uuid.uuid4(), conversation_id=conv.id, member_id=mid))
    await session.commit()
    return conv


async def _make_conversation_message(
    session, conv_id, sender_id, *, content="지시", msg_metadata=None,
):
    from app.models.conversation import ConversationMessage

    msg = ConversationMessage(
        id=uuid.uuid4(), conversation_id=conv_id, sender_id=sender_id, content=content,
        msg_metadata=msg_metadata or {},
    )
    session.add(msg)
    await session.commit()
    return msg


async def _make_agent_run(session, org_id, project_id, *, agent_id, status="running"):
    from app.models.agent_run import AgentRun

    run = AgentRun(id=uuid.uuid4(), org_id=org_id, project_id=project_id, agent_id=agent_id, status=status)
    session.add(run)
    await session.commit()
    return run


def _client_for(app):
    from httpx import ASGITransport, AsyncClient
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _setup_app_human(app, Session, user_id, org_id):
    from app.dependencies.auth import AuthContext, get_current_user
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
        return AuthContext(user_id=str(user_id), email="human@test", claims={"app_metadata": {"org_id": str(org_id)}})

    override_db_and_read(app, _db)
    app.dependency_overrides[get_current_user] = _auth


# ─── AC2: agent_runs.conversation_id/triggering_message_id ─────────────────


async def test_create_agent_run_stores_conversation_link_realdb():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_member(s, org.id, project.id)
            agent_id, _ = await _make_member(s, org.id, project.id, type_="agent", name="에이전트")
            conv = await _make_conversation(s, org.id, project.id, member_ids=[caller_id, agent_id])
            msg = await _make_conversation_message(s, conv.id, caller_id)

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.post("/api/v2/agent-runs", json={
                "agent_id": str(agent_id), "project_id": str(project.id),
                "conversation_id": str(conv.id), "triggering_message_id": str(msg.id),
            })
            assert resp.status_code == 201, resp.text
            body = resp.json()
            assert body["conversation_id"] == str(conv.id)
            assert body["triggering_message_id"] == str(msg.id)
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_create_agent_run_rejects_conversation_from_other_org_realdb():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_member(s, org.id, project.id)
            agent_id, _ = await _make_member(s, org.id, project.id, type_="agent", name="에이전트")

            other_org = await _make_org(s, name="OtherOrg")
            other_project = await _make_project(s, other_org.id)
            other_member_id, _ = await _make_member(s, other_org.id, other_project.id)
            other_conv = await _make_conversation(s, other_org.id, other_project.id, member_ids=[other_member_id])

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.post("/api/v2/agent-runs", json={
                "agent_id": str(agent_id), "project_id": str(project.id),
                "conversation_id": str(other_conv.id),
            })
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_create_agent_run_rejects_message_not_belonging_to_conversation_realdb():
    """AC2 — triggering_message_id가 실존해도 그 conversation_id 소속이 아니면 422."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_member(s, org.id, project.id)
            agent_id, _ = await _make_member(s, org.id, project.id, type_="agent", name="에이전트")
            conv_a = await _make_conversation(s, org.id, project.id, member_ids=[caller_id])
            conv_b = await _make_conversation(s, org.id, project.id, member_ids=[caller_id])
            msg_in_b = await _make_conversation_message(s, conv_b.id, caller_id)

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.post("/api/v2/agent-runs", json={
                "agent_id": str(agent_id), "project_id": str(project.id),
                "conversation_id": str(conv_a.id), "triggering_message_id": str(msg_in_b.id),
            })
            assert resp.status_code == 422, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_update_agent_run_sets_conversation_link_realdb():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_member(s, org.id, project.id)
            agent_id, _ = await _make_member(s, org.id, project.id, type_="agent", name="에이전트")
            conv = await _make_conversation(s, org.id, project.id, member_ids=[caller_id])
            run = await _make_agent_run(s, org.id, project.id, agent_id=agent_id)

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.patch(f"/api/v2/agent-runs/{run.id}", json={
                "status": "running", "conversation_id": str(conv.id),
            })
            assert resp.status_code == 200, resp.text
            assert resp.json()["conversation_id"] == str(conv.id)
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── AC3: 메시지 work_item 태그 ──────────────────────────────────────────────


async def test_send_message_stores_work_item_tag_and_coexists_with_activation_realdb():
    from app.main import app
    from sqlalchemy import select
    from app.models.conversation import ConversationMessage

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_member(s, org.id, project.id)
            other_id, _ = await _make_member(s, org.id, project.id, name="other")
            conv = await _make_conversation(s, org.id, project.id, member_ids=[caller_id, other_id])
            work_item_id = uuid.uuid4()

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.post(f"/api/v2/conversations/{conv.id}/messages", json={
                "content": "지시 한 줄",
                "work_item": {"type": "story", "id": str(work_item_id)},
                "message_kind": "request", "expects_response": True,
            })
            assert resp.status_code == 201, resp.text
        finally:
            await client.aclose()

        async with Session() as s2:
            msg = (await s2.execute(
                select(ConversationMessage).where(ConversationMessage.conversation_id == conv.id)
            )).scalar_one()
            assert msg.msg_metadata["work_item"] == {"type": "story", "id": str(work_item_id)}
            assert msg.msg_metadata["activation"]["kind"] == "request", "work_item 태그가 기존 activation 축을 밀어내지 않는다"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_send_message_without_work_item_leaves_metadata_unaffected_realdb():
    """AC3 양성대조 — work_item 생략 시 msg_metadata에 그 키 자체가 없다(완전 무변)."""
    from app.main import app
    from sqlalchemy import select
    from app.models.conversation import ConversationMessage

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_member(s, org.id, project.id)
            conv = await _make_conversation(s, org.id, project.id, member_ids=[caller_id])

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.post(f"/api/v2/conversations/{conv.id}/messages", json={"content": "평범한 메시지"})
            assert resp.status_code == 201, resp.text
        finally:
            await client.aclose()

        async with Session() as s2:
            msg = (await s2.execute(
                select(ConversationMessage).where(ConversationMessage.conversation_id == conv.id)
            )).scalar_one()
            assert not (msg.msg_metadata or {}).get("work_item")
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── AC4: GET /conversations/by-work-item ───────────────────────────────────


async def test_list_conversations_by_work_item_returns_tagged_conversation_realdb():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_member(s, org.id, project.id)
            conv = await _make_conversation(s, org.id, project.id, member_ids=[caller_id])
            work_item_id = uuid.uuid4()
            await _make_conversation_message(
                s, conv.id, caller_id,
                msg_metadata={"work_item": {"type": "story", "id": str(work_item_id)}},
            )

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(
                "/api/v2/conversations/by-work-item",
                params={"work_item_type": "story", "work_item_id": str(work_item_id)},
            )
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert len(body) == 1
            assert body[0]["id"] == str(conv.id)
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_list_conversations_by_work_item_empty_when_untagged_realdb():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_member(s, org.id, project.id)

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(
                "/api/v2/conversations/by-work-item",
                params={"work_item_type": "story", "work_item_id": str(uuid.uuid4())},
            )
            assert resp.status_code == 200, resp.text
            assert resp.json() == []
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_list_conversations_by_work_item_org_isolation_realdb():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_member(s, org.id, project.id)

            other_org = await _make_org(s, name="OtherOrg2")
            other_project = await _make_project(s, other_org.id)
            other_member_id, _ = await _make_member(s, other_org.id, other_project.id)
            other_conv = await _make_conversation(s, other_org.id, other_project.id, member_ids=[other_member_id])
            work_item_id = uuid.uuid4()
            await _make_conversation_message(
                s, other_conv.id, other_member_id,
                msg_metadata={"work_item": {"type": "story", "id": str(work_item_id)}},
            )

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(
                "/api/v2/conversations/by-work-item",
                params={"work_item_type": "story", "work_item_id": str(work_item_id)},
            )
            assert resp.status_code == 200, resp.text
            assert resp.json() == [], "다른 org의 태그가 새면 안 된다"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_list_conversations_by_work_item_excludes_conversation_caller_not_in_realdb():
    """페드루 PO 리뷰 CHANGES(PR #4253) — 같은 org 소속이어도 캐폴러가 참여자가
    아닌 대화(태그된 DM 등)는 새면 안 된다(403 죽은 링크·DM 존재 노출 방지)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_member(s, org.id, project.id)
            other_id, _ = await _make_member(s, org.id, project.id, name="other")
            # 캐폴러는 참여하지 않는 같은 org 내 다른 DM.
            other_conv = await _make_conversation(s, org.id, project.id, member_ids=[other_id])
            work_item_id = uuid.uuid4()
            await _make_conversation_message(
                s, other_conv.id, other_id,
                msg_metadata={"work_item": {"type": "story", "id": str(work_item_id)}},
            )

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(
                "/api/v2/conversations/by-work-item",
                params={"work_item_type": "story", "work_item_id": str(work_item_id)},
            )
            assert resp.status_code == 200, resp.text
            assert resp.json() == [], "캐폴러가 참여 안 한 같은 org의 대화가 새면 안 된다"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_today_needs_me_conversation_id_null_when_caller_not_participant_realdb():
    """페드루 PO 리뷰 CHANGES(PR #4253) — needs_me 행도 같은 원칙: 태그된 conversation에
    캐폴러가 참여자가 아니면 conversation_id는 null(존재 노출 금지)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id, )
            caller_id, caller_user_id = await _make_member(s, org.id, project.id, org_role="owner")
            other_id, _ = await _make_member(s, org.id, project.id, name="other")

            from app.models.pm import Story
            from app.models.workflow_line import WorkflowLineStepRun, WorkflowLineStepApproval

            story = Story(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="승인 대상2", status="in-progress")
            s.add(story)
            await s.commit()
            run_row = WorkflowLineStepRun(
                id=uuid.uuid4(), org_id=org.id, project_id=project.id,
                entity_type="story", entity_id=story.id,
                from_status="in-review", to_status="done", status="pending", mode="enforcing",
                effective_gate_type="qa", correlation_id=uuid.uuid4(), transition_id=uuid.uuid4().hex,
            )
            s.add(run_row)
            await s.commit()
            approval = WorkflowLineStepApproval(
                id=uuid.uuid4(), org_id=org.id, project_id=project.id,
                step_run_id=run_row.id, approval_group_id=uuid.uuid4(),
                approver_member_id=caller_id, approver_member_type="human",
                kind="approver", blocking=True, status="pending",
            )
            s.add(approval)
            await s.commit()

            # 캐폴러가 참여하지 않는 대화에 같은 story를 태그(예: 제3자 DM에서 언급).
            other_conv = await _make_conversation(s, org.id, project.id, member_ids=[other_id])
            await _make_conversation_message(
                s, other_conv.id, other_id,
                msg_metadata={"work_item": {"type": "story", "id": str(story.id)}},
            )

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/today")
            assert resp.status_code == 200, resp.text
            items = resp.json()["needs_me"]
            item = next(i for i in items if i["work_item"]["id"] == str(story.id))
            assert item["conversation_id"] is None, "캐폴러가 참여 안 한 대화 id가 새면 안 된다"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_today_needs_me_conversation_project_id_is_the_conversations_own_project_realdb():
    """story #4231 — 태그된 대화가 work_item과 **다른 프로젝트**에 있으면 conversation_project_id는 대화 쪽 프로젝트
    (FE 딥링크가 현재 p · work_item 프로젝트가 아니라 대화 자기 프로젝트로 가게)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id, )
            other_project = await _make_project(s, org.id, name="Q")
            caller_id, caller_user_id = await _make_member(s, org.id, project.id, org_role="owner")

            from app.models.pm import Story
            from app.models.workflow_line import WorkflowLineStepRun, WorkflowLineStepApproval

            story = Story(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="승인 대상3", status="in-progress")
            s.add(story)
            await s.commit()
            run_row = WorkflowLineStepRun(
                id=uuid.uuid4(), org_id=org.id, project_id=project.id,
                entity_type="story", entity_id=story.id,
                from_status="in-review", to_status="done", status="pending", mode="enforcing",
                effective_gate_type="qa", correlation_id=uuid.uuid4(), transition_id=uuid.uuid4().hex,
            )
            s.add(run_row)
            await s.commit()
            s.add(WorkflowLineStepApproval(
                id=uuid.uuid4(), org_id=org.id, project_id=project.id,
                step_run_id=run_row.id, approval_group_id=uuid.uuid4(),
                approver_member_id=caller_id, approver_member_type="human",
                kind="approver", blocking=True, status="pending",
            ))
            await s.commit()

            # 캐폴러가 참여한 대화지만 **다른 프로젝트**의 대화에서 story를 태그.
            conv = await _make_conversation(s, org.id, other_project.id, member_ids=[caller_id])
            await _make_conversation_message(
                s, conv.id, caller_id,
                msg_metadata={"work_item": {"type": "story", "id": str(story.id)}},
            )

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/today")
            assert resp.status_code == 200, resp.text
            item = next(i for i in resp.json()["needs_me"] if i["work_item"]["id"] == str(story.id))
            assert item["conversation_id"] == str(conv.id)
            assert item["conversation_project_id"] == str(other_project.id), "대화 자기 프로젝트여야(work_item 프로젝트 아님)"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_today_agent_progress_conversation_id_null_when_caller_not_participant_realdb():
    """페드루 PO 리뷰 CHANGES(PR #4253) — agent_progress 행도 같은 원칙."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_member(s, org.id, project.id)
            agent_id, _ = await _make_member(s, org.id, project.id, type_="agent", name="에이전트")
            other_id, _ = await _make_member(s, org.id, project.id, name="other")
            # run의 conversation은 캐폴러 없이 다른 사람만 참여.
            other_conv = await _make_conversation(s, org.id, project.id, member_ids=[other_id, agent_id])

            from app.models.pm import Story
            from app.models.agent_run import AgentRun

            story = Story(
                id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="위임된 일2",
                status="in-progress", assignee_id=caller_id,
            )
            s.add(story)
            await s.commit()
            run = AgentRun(
                id=uuid.uuid4(), org_id=org.id, project_id=project.id, agent_id=agent_id,
                story_id=story.id, status="running", conversation_id=other_conv.id,
            )
            s.add(run)
            await s.commit()

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/today")
            assert resp.status_code == 200, resp.text
            progress = resp.json()["agent_progress"]
            assert len(progress) == 1
            assert progress[0]["conversation_id"] is None, "캐폴러가 참여 안 한 대화 id가 새면 안 된다"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_list_conversations_by_work_item_returns_most_recent_first_realdb():
    """AC4 — 여러 conversation이 같은 work_item을 태그했으면 가장 최근 태그 순."""
    from app.main import app
    import asyncio

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_member(s, org.id, project.id)
            conv_old = await _make_conversation(s, org.id, project.id, member_ids=[caller_id])
            conv_new = await _make_conversation(s, org.id, project.id, member_ids=[caller_id])
            work_item_id = uuid.uuid4()
            await _make_conversation_message(
                s, conv_old.id, caller_id,
                msg_metadata={"work_item": {"type": "story", "id": str(work_item_id)}},
            )
            await asyncio.sleep(0.01)
            await _make_conversation_message(
                s, conv_new.id, caller_id,
                msg_metadata={"work_item": {"type": "story", "id": str(work_item_id)}},
            )

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(
                "/api/v2/conversations/by-work-item",
                params={"work_item_type": "story", "work_item_id": str(work_item_id)},
            )
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert [row["id"] for row in body] == [str(conv_new.id), str(conv_old.id)]
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── AC5: 「오늘」 conversation_id 노출 ───────────────────────────────────────


async def test_today_agent_progress_exposes_conversation_id_realdb():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_member(s, org.id, project.id)
            agent_id, _ = await _make_member(s, org.id, project.id, type_="agent", name="에이전트")
            conv = await _make_conversation(s, org.id, project.id, member_ids=[caller_id, agent_id])

            from app.models.pm import Story
            from app.models.agent_run import AgentRun

            story = Story(
                id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="위임된 일",
                status="in-progress", assignee_id=caller_id,
            )
            s.add(story)
            await s.commit()
            run = AgentRun(
                id=uuid.uuid4(), org_id=org.id, project_id=project.id, agent_id=agent_id,
                story_id=story.id, status="running", conversation_id=conv.id,
            )
            s.add(run)
            await s.commit()

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/today")
            assert resp.status_code == 200, resp.text
            progress = resp.json()["agent_progress"]
            assert len(progress) == 1
            assert progress[0]["conversation_id"] == str(conv.id)
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


async def test_today_needs_me_exposes_tagged_conversation_id_realdb():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            caller_id, caller_user_id = await _make_member(s, org.id, project.id, org_role="owner")

            from app.models.pm import Story
            from app.models.workflow_line import WorkflowLineStepRun, WorkflowLineStepApproval

            story = Story(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="승인 대상", status="in-progress")
            s.add(story)
            await s.commit()

            run_row = WorkflowLineStepRun(
                id=uuid.uuid4(), org_id=org.id, project_id=project.id,
                entity_type="story", entity_id=story.id,
                from_status="in-review", to_status="done", status="pending", mode="enforcing",
                effective_gate_type="qa", correlation_id=uuid.uuid4(), transition_id=uuid.uuid4().hex,
            )
            s.add(run_row)
            await s.commit()
            approval = WorkflowLineStepApproval(
                id=uuid.uuid4(), org_id=org.id, project_id=project.id,
                step_run_id=run_row.id, approval_group_id=uuid.uuid4(),
                approver_member_id=caller_id, approver_member_type="human",
                kind="approver", blocking=True, status="pending",
            )
            s.add(approval)
            await s.commit()

            conv = await _make_conversation(s, org.id, project.id, member_ids=[caller_id])
            await _make_conversation_message(
                s, conv.id, caller_id,
                msg_metadata={"work_item": {"type": "story", "id": str(story.id)}},
            )

        await _setup_app_human(app, Session, caller_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/today")
            assert resp.status_code == 200, resp.text
            items = resp.json()["needs_me"]
            item = next(i for i in items if i["work_item"]["id"] == str(story.id))
            assert item["conversation_id"] == str(conv.id)
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# AC6 뮤테이션 2(org 격리 제거·태그 저장 제거)는 위 org_isolation·empty_when_untagged
# 테스트가 이미 킬러 역할을 한다 — 로컬 수동 뮤테이션(소스 레벨) 실행 기록은 PR
# 본문에 남긴다(새 placeholder 테스트를 추가하지 않는다, 3821/3823/3829와 동일 관례).
