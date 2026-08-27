"""story #3143(9a5abc24, Chat ②층·P1·BE) — 서버 집행 커맨드 카탈로그(/done·/assign·/priority) 실 PG 검증.

축: ①카탈로그 명중 시 실제 story 뮤테이션(권한=발신자 기존 API 권한 그대로, 새 판정 없음)
②실패(권한거부·미존재·모호·인자오류) 전부 명시 outcome+회신(침묵 0) ③전 건 audit log
④결과 회신 = message_kind=result(3존 카드 레일 — 텍스트 어휘만으로 렌더, 새 스키마 0)
⑤미명중(카탈로그 밖 커맨드·비-커맨드)은 완전 무부작용(회귀 0) ⑥HTTP 왕복(진짜 send_message
엔드포인트를 통해 human 발신 1건)."""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = pytest.mark.destructive_schema


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

    org = Organization(id=uuid.uuid4(), name="Org3143", slug=f"org3143-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    return org.id, project.id


async def _seed_team_member(session, org_id, project_id, *, type_="human", name="member", user_id=None, is_active=True):
    from app.models.team import TeamMember

    m = TeamMember(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, type=type_, name=name,
        user_id=user_id or (uuid.uuid4() if type_ == "human" else None), is_active=is_active,
    )
    session.add(m)
    await session.commit()
    if type_ == "agent":
        # ⚠️real dev/prod에선 team_members가 members⋈project_access UNION 뷰라 agent 행은
        # Member.id==TeamMember.id로 자동 투영되지만, 이 테스트는 create_all(진짜 테이블)이라
        # 자동 투영이 없다 — project_auth._project_access_predicate의 agent_grant_branch가
        # ProjectAccess.member_id→Member.id(type='agent')를 직접 요구하므로 수동으로 짝을
        # 맞춰준다(같은 id를 그대로 재사용 — 실 뷰의 투영 규칙과 동형).
        from app.models.member import Member
        from app.models.project_access import ProjectAccess

        session.add(Member(id=m.id, org_id=org_id, type="agent", name=name))
        await session.commit()
        session.add(ProjectAccess(
            id=uuid.uuid4(), project_id=project_id, org_member_id=None,
            member_id=m.id, permission="granted", role="member",
        ))
        await session.commit()
    return m


async def _seed_story(session, org_id, project_id, *, priority="medium", status="in-progress"):
    from app.models.pm import Story
    from sqlalchemy import select as _select, func as _func
    max_num = (await session.execute(
        _select(_func.coalesce(_func.max(Story.story_number), 0)).where(Story.project_id == project_id)
    )).scalar_one()
    story = Story(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, title="T",
        status=status, priority=priority, story_number=max_num + 1,
    )
    session.add(story)
    await session.commit()
    return story


async def _seed_conversation(session, org_id, project_id, member_ids):
    from app.models.conversation import Conversation, ConversationParticipant

    conv = Conversation(id=uuid.uuid4(), org_id=org_id, project_id=project_id, type="group")
    session.add(conv)
    await session.flush()
    for mid in member_ids:
        session.add(ConversationParticipant(conversation_id=conv.id, member_id=mid))
    await session.commit()
    return conv


async def _seed_message(session, conv_id, sender_id, content):
    from app.models.conversation import ConversationMessage

    msg = ConversationMessage(conversation_id=conv_id, sender_id=sender_id, content=content)
    session.add(msg)
    await session.commit()
    return msg


def _classify(text):
    from app.services.command_classifier import classify_command
    return classify_command(text)


# ── 카탈로그 명중: 실행 성공 ────────────────────────────────────────────────────
@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_done_command_transitions_story_and_posts_result_card():
    from app.services.chat_command_catalog import try_execute_server_command
    from app.models.chat_command_audit_log import ChatCommandAuditLog
    from app.models.conversation import ConversationMessage
    from app.models.pm import Story
    from sqlalchemy import select

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            sender = await _seed_team_member(s, org_id, project_id, name="sender")
            story = await _seed_story(s, org_id, project_id, status="in-review")
            conv = await _seed_conversation(s, org_id, project_id, [sender.id])
            msg = await _seed_message(s, conv.id, sender.id, f"/done {story.story_number}")

            executed = await try_execute_server_command(s, org_id=org_id, conv=conv, msg=msg, sender=sender)
            await s.commit()

            assert executed is True
            await s.refresh(story)
            assert story.status == "done"

            audit = (await s.execute(
                select(ChatCommandAuditLog).where(ChatCommandAuditLog.message_id == msg.id)
            )).scalars().one()
            assert audit.outcome == "executed"
            assert audit.command == "done"
            assert audit.target_id == story.id
            assert audit.after_value == "done"

            replies = (await s.execute(
                select(ConversationMessage).where(
                    ConversationMessage.conversation_id == conv.id, ConversationMessage.id != msg.id,
                )
            )).scalars().all()
            assert len(replies) == 1
            reply = replies[0]
            assert reply.msg_metadata["activation"]["kind"] == "result"
            assert "완료" in reply.content
            assert "다음:" in reply.content
            # PO 리뷰 델타(2026-08-27) — FE(#92f00dc4)가 텍스트 휴리스틱 없이 이 카드를
            # 판별하는 기계 식별자. approval_target/event와 동일 additive namespace.
            assert reply.msg_metadata["server_command"] == {"command": "done", "outcome": "executed"}
            assert "candidates" not in reply.msg_metadata["server_command"], "candidates는 ambiguous 전용 — 다른 outcome엔 키 자체가 없어야 한다"
            assert "target_story_number" not in reply.msg_metadata["server_command"], "target_story_number도 ambiguous 전용"
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_priority_command_updates_priority():
    from app.services.chat_command_catalog import try_execute_server_command
    from app.models.chat_command_audit_log import ChatCommandAuditLog
    from sqlalchemy import select

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            sender = await _seed_team_member(s, org_id, project_id)
            story = await _seed_story(s, org_id, project_id, priority="medium")
            conv = await _seed_conversation(s, org_id, project_id, [sender.id])
            msg = await _seed_message(s, conv.id, sender.id, f"/priority {story.story_number} high")

            executed = await try_execute_server_command(s, org_id=org_id, conv=conv, msg=msg, sender=sender)
            await s.commit()

            assert executed is True
            await s.refresh(story)
            assert story.priority == "high"
            audit = (await s.execute(
                select(ChatCommandAuditLog).where(ChatCommandAuditLog.message_id == msg.id)
            )).scalars().one()
            assert audit.outcome == "executed"
            assert audit.before_value == "medium"
            assert audit.after_value == "high"
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_assign_command_by_exact_name():
    from app.services.chat_command_catalog import try_execute_server_command
    from sqlalchemy import select
    from app.models.pm import Story

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            sender = await _seed_team_member(s, org_id, project_id, name="sender")
            target_member = await _seed_team_member(s, org_id, project_id, name="Mirko")
            story = await _seed_story(s, org_id, project_id)
            conv = await _seed_conversation(s, org_id, project_id, [sender.id, target_member.id])
            msg = await _seed_message(s, conv.id, sender.id, f"/assign {story.story_number} Mirko")

            executed = await try_execute_server_command(s, org_id=org_id, conv=conv, msg=msg, sender=sender)
            await s.commit()

            assert executed is True
            refreshed = (await s.execute(select(Story).where(Story.id == story.id))).scalar_one()
            assert refreshed.assignee_id == target_member.id
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_assign_command_by_unique_prefix():
    from app.services.chat_command_catalog import try_execute_server_command
    from sqlalchemy import select
    from app.models.pm import Story

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            sender = await _seed_team_member(s, org_id, project_id, name="sender")
            target_member = await _seed_team_member(s, org_id, project_id, name="Santiago")
            story = await _seed_story(s, org_id, project_id)
            conv = await _seed_conversation(s, org_id, project_id, [sender.id, target_member.id])
            msg = await _seed_message(s, conv.id, sender.id, f"/assign {story.story_number} San")

            executed = await try_execute_server_command(s, org_id=org_id, conv=conv, msg=msg, sender=sender)
            await s.commit()

            assert executed is True
            refreshed = (await s.execute(select(Story).where(Story.id == story.id))).scalar_one()
            assert refreshed.assignee_id == target_member.id
    finally:
        await engine.dispose()


# ── 실패 경로: 명시 회신·무-뮤테이션 ────────────────────────────────────────────
@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_assign_ambiguous_prefix_lists_candidates_and_does_not_mutate():
    from app.services.chat_command_catalog import try_execute_server_command
    from app.models.chat_command_audit_log import ChatCommandAuditLog
    from app.models.conversation import ConversationMessage
    from sqlalchemy import select
    from app.models.pm import Story

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            sender = await _seed_team_member(s, org_id, project_id, name="sender")
            m1 = await _seed_team_member(s, org_id, project_id, name="Santiago")
            m2 = await _seed_team_member(s, org_id, project_id, name="Santi")
            story = await _seed_story(s, org_id, project_id)
            conv = await _seed_conversation(s, org_id, project_id, [sender.id, m1.id, m2.id])
            msg = await _seed_message(s, conv.id, sender.id, f"/assign {story.story_number} San")

            executed = await try_execute_server_command(s, org_id=org_id, conv=conv, msg=msg, sender=sender)
            await s.commit()

            assert executed is True
            refreshed = (await s.execute(select(Story).where(Story.id == story.id))).scalar_one()
            assert refreshed.assignee_id is None, "모호하면 절대 집행하지 않는다"

            audit = (await s.execute(
                select(ChatCommandAuditLog).where(ChatCommandAuditLog.message_id == msg.id)
            )).scalars().one()
            assert audit.outcome == "ambiguous"

            reply = (await s.execute(
                select(ConversationMessage).where(
                    ConversationMessage.conversation_id == conv.id, ConversationMessage.id != msg.id,
                )
            )).scalars().one()
            assert "Santiago" in reply.content and "Santi" in reply.content
            # PO 리뷰 델타 2회차(2026-08-27, 미르코 FE 정독) — FE가 문장 파싱 없이 클릭형
            # 후보 행을 그리는 축. 순서는 DB 조회 순서에 의존하지 않게 집합으로 비교.
            sc = reply.msg_metadata["server_command"]
            assert sc["command"] == "assign" and sc["outcome"] == "ambiguous"
            assert set(sc["candidates"]) == {"Santiago", "Santi"}
            # PO 리뷰 델타 3회차(2026-08-27) — 후보 클릭이 "/assign #<번호> <이름>"으로
            # 채워지려면 원 스토리 번호가 필요하다(story_id는 UUID라 사람이 못 타이핑).
            assert sc["target_story_number"] == story.story_number
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_priority_invalid_level_rejected_without_mutation():
    from app.services.chat_command_catalog import try_execute_server_command
    from app.models.chat_command_audit_log import ChatCommandAuditLog
    from sqlalchemy import select
    from app.models.pm import Story

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            sender = await _seed_team_member(s, org_id, project_id)
            story = await _seed_story(s, org_id, project_id, priority="medium")
            conv = await _seed_conversation(s, org_id, project_id, [sender.id])
            msg = await _seed_message(s, conv.id, sender.id, f"/priority {story.story_number} urgent")

            executed = await try_execute_server_command(s, org_id=org_id, conv=conv, msg=msg, sender=sender)
            await s.commit()

            assert executed is True
            refreshed = (await s.execute(select(Story).where(Story.id == story.id))).scalar_one()
            assert refreshed.priority == "medium", "알 수 없는 우선순위는 절대 반영되지 않는다"
            audit = (await s.execute(
                select(ChatCommandAuditLog).where(ChatCommandAuditLog.message_id == msg.id)
            )).scalars().one()
            assert audit.outcome == "invalid_args"
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_done_unknown_story_number_not_found_no_mutation():
    from app.services.chat_command_catalog import try_execute_server_command
    from app.models.chat_command_audit_log import ChatCommandAuditLog
    from sqlalchemy import select

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            sender = await _seed_team_member(s, org_id, project_id)
            conv = await _seed_conversation(s, org_id, project_id, [sender.id])
            msg = await _seed_message(s, conv.id, sender.id, "/done 999999")

            executed = await try_execute_server_command(s, org_id=org_id, conv=conv, msg=msg, sender=sender)
            await s.commit()

            assert executed is True
            audit = (await s.execute(
                select(ChatCommandAuditLog).where(ChatCommandAuditLog.message_id == msg.id)
            )).scalars().one()
            assert audit.outcome == "invalid_args", "존재하지 않는 story_number는 애초에 참조 해석 단계에서 걸러진다"
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_no_project_access_sender_denied_no_mutation():
    """발신자가 이 project에 접근권이 없으면(다른 project 소속) — 기존 API 권한과 동일하게
    거부되고(existence-hiding 404 정책 그대로 상속 — outcome="not_found") 뮤테이션은 없다."""
    from app.services.chat_command_catalog import try_execute_server_command
    from app.models.chat_command_audit_log import ChatCommandAuditLog
    from sqlalchemy import select
    from app.models.pm import Story
    from app.models.project import Project

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            other_project = Project(id=uuid.uuid4(), org_id=org_id, name="Other")
            s.add(other_project)
            await s.commit()
            # sender는 other_project 소속 TeamMember뿐 — target story의 project_id엔 접근권 없음.
            sender = await _seed_team_member(s, org_id, other_project.id, name="outsider")
            story = await _seed_story(s, org_id, project_id, status="in-review")
            conv = await _seed_conversation(s, org_id, project_id, [])  # sender는 이 conv 참가자도 아님(catalog 자체는 참가자 검증을 안 함 — send_message가 그 축은 이미 처리)
            msg = await _seed_message(s, conv.id, sender.id, f"/done {story.story_number}")

            executed = await try_execute_server_command(s, org_id=org_id, conv=conv, msg=msg, sender=sender)
            await s.commit()

            assert executed is True
            await s.refresh(story)
            assert story.status == "in-review", "접근권 없는 발신자의 커맨드는 절대 집행되면 안 된다"
            audit = (await s.execute(
                select(ChatCommandAuditLog).where(ChatCommandAuditLog.message_id == msg.id)
            )).scalars().one()
            assert audit.outcome == "not_found"
    finally:
        await engine.dispose()


# ── 미명중: 완전 무부작용(회귀 0) ────────────────────────────────────────────────
@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_non_catalog_command_returns_false_no_side_effects():
    from app.services.chat_command_catalog import try_execute_server_command
    from app.models.chat_command_audit_log import ChatCommandAuditLog
    from app.models.conversation import ConversationMessage
    from sqlalchemy import select

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            sender = await _seed_team_member(s, org_id, project_id)
            conv = await _seed_conversation(s, org_id, project_id, [sender.id])
            msg = await _seed_message(s, conv.id, sender.id, "/help")

            executed = await try_execute_server_command(s, org_id=org_id, conv=conv, msg=msg, sender=sender)
            await s.commit()

            assert executed is False
            assert (await s.execute(select(ChatCommandAuditLog))).scalars().all() == []
            other_msgs = (await s.execute(
                select(ConversationMessage).where(ConversationMessage.id != msg.id)
            )).scalars().all()
            assert other_msgs == []
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_plain_message_returns_false_no_side_effects():
    from app.services.chat_command_catalog import try_execute_server_command
    from app.models.chat_command_audit_log import ChatCommandAuditLog
    from sqlalchemy import select

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            sender = await _seed_team_member(s, org_id, project_id)
            conv = await _seed_conversation(s, org_id, project_id, [sender.id])
            msg = await _seed_message(s, conv.id, sender.id, "그냥 평범한 메시지인데 done 이 단어가 들어있어도 커맨드 아님")

            executed = await try_execute_server_command(s, org_id=org_id, conv=conv, msg=msg, sender=sender)
            await s.commit()

            assert executed is False
            assert (await s.execute(select(ChatCommandAuditLog))).scalars().all() == []
    finally:
        await engine.dispose()


# ── 에이전트 발신자 경로 ─────────────────────────────────────────────────────────
@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_agent_sender_can_execute_same_as_human():
    from app.services.chat_command_catalog import try_execute_server_command
    from sqlalchemy import select
    from app.models.pm import Story

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            agent_sender = await _seed_team_member(s, org_id, project_id, type_="agent", name="AgentSender")
            story = await _seed_story(s, org_id, project_id, status="in-review")
            conv = await _seed_conversation(s, org_id, project_id, [agent_sender.id])
            msg = await _seed_message(s, conv.id, agent_sender.id, f"/done {story.story_number}")

            executed = await try_execute_server_command(s, org_id=org_id, conv=conv, msg=msg, sender=agent_sender)
            await s.commit()

            assert executed is True
            refreshed = (await s.execute(select(Story).where(Story.id == story.id))).scalar_one()
            assert refreshed.status == "done"
    finally:
        await engine.dispose()


# ── entity mention 토큰으로 story 참조 ──────────────────────────────────────────
@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_done_with_entity_mention_story_ref():
    from app.services.chat_command_catalog import try_execute_server_command
    from sqlalchemy import select
    from app.models.pm import Story

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            sender = await _seed_team_member(s, org_id, project_id)
            story = await _seed_story(s, org_id, project_id, status="in-review")
            conv = await _seed_conversation(s, org_id, project_id, [sender.id])
            msg = await _seed_message(s, conv.id, sender.id, f"/done [스토리 제목](entity:story:{story.id})")

            executed = await try_execute_server_command(s, org_id=org_id, conv=conv, msg=msg, sender=sender)
            await s.commit()

            assert executed is True
            refreshed = (await s.execute(select(Story).where(Story.id == story.id))).scalar_one()
            assert refreshed.status == "done"
    finally:
        await engine.dispose()


# ── 진짜 HTTP 왕복(휴먼 발신) ────────────────────────────────────────────────────
@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_http_round_trip_human_sends_done_command():
    """진짜 POST /api/v2/conversations/{id}/messages 엔드포인트를 통해 human 발신
    '/done'이 실제로 story를 전이시키고 result 카드까지 남기는지(AC6 절반 — 나머지 절반인
    에이전트 발신+dev 라이브 검증은 별도)."""
    from app.main import app
    from app.dependencies.auth import AuthContext, get_current_user
    from app.dependencies.database import get_db
    from app.routers.conversations import get_verified_org_id
    from tests.conftest import override_db_and_read
    from httpx import AsyncClient, ASGITransport
    from sqlalchemy import select
    from app.models.pm import Story
    from app.models.conversation import ConversationMessage

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            human_user_id = uuid.uuid4()
            sender = await _seed_team_member(s, org_id, project_id, name="human-sender", user_id=human_user_id)
            story = await _seed_story(s, org_id, project_id, status="in-review")
            conv = await _seed_conversation(s, org_id, project_id, [sender.id])

        async def _db():
            async with Session() as s:
                try:
                    yield s
                    await s.commit()
                except Exception:
                    await s.rollback()
                    raise

        async def _auth():
            return AuthContext(user_id=str(human_user_id), email="human@test", claims={"app_metadata": {}})

        async def _org():
            return org_id

        override_db_and_read(app, _db)
        app.dependency_overrides[get_current_user] = _auth
        app.dependency_overrides[get_verified_org_id] = _org

        client = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
        try:
            resp = await client.post(
                f"/api/v2/conversations/{conv.id}/messages",
                json={"content": f"/done {story.story_number}"},
            )
            assert resp.status_code == 201, resp.text

            # PO 리뷰 델타(2026-08-27) — GET 목록 응답에도 server_command가 top-level로
            # 노출되는지(FE #92f00dc4가 실제로 소비하는 자리) 진짜 HTTP 왕복으로 고정.
            list_resp = await client.get(f"/api/v2/conversations/{conv.id}/messages")
            assert list_resp.status_code == 200, list_resp.text
            result_items = [m for m in list_resp.json()["data"] if m.get("message_kind") == "result"]
            assert len(result_items) == 1
            assert result_items[0]["server_command"] == {"command": "done", "outcome": "executed"}
        finally:
            await client.aclose()

        async with Session() as s:
            refreshed = (await s.execute(select(Story).where(Story.id == story.id))).scalar_one()
            assert refreshed.status == "done"
            msgs = (await s.execute(
                select(ConversationMessage).where(ConversationMessage.conversation_id == conv.id)
            )).scalars().all()
            result_msgs = [m for m in msgs if (m.msg_metadata or {}).get("activation", {}).get("kind") == "result"]
            assert len(result_msgs) == 1
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
