"""story #4091(E-RECIPE-1 팔로우업, PO 확定 2026-09-21 §c) — 스토리 패널 «이것을 가리키는
것들»(EntityBacklinksSection)의 chat_message 항목이 이벤트 발행 메시지(#2637 AC 0-a,
msg_metadata.event)일 때 raw content_snippet(에이전트 채널 전용, events.py
`_render_event_message_content` — `f"- stage: {stage} ({role})"`·
`i18n_catalog events.stage_gate_already_open`의 `approver=...or ''` 원문 삽입) 대신 FE가
recipe-stage-label.ts/gate-approver-label.ts SSOT로 재구성할 수 있게, 백엔드가
`message.event = {definition_key, name, stage, role, gate_type, approver}` 구조화 필드를 얹는다.

realdb 하네스는 test_2266_story_backlinks_realdb.py의 확립된 셀프컨테인 seed 헬퍼를
그대로 복제(이 파일 자체 완결 — 그 파일이 가진 관례를 재발명하지 않는다)."""
from __future__ import annotations

import os
import uuid
from datetime import UTC, datetime

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


# ─── Seeding helpers (test_2266_story_backlinks_realdb.py와 동형 — 이 파일 자체 완결) ──


async def _make_org(session, name="Org"):
    from app.models.organization import Organization
    org = Organization(id=uuid.uuid4(), name=name, slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    return org


async def _make_project(session, org_id, name="P"):
    from app.models.project import Project
    project = Project(id=uuid.uuid4(), org_id=org_id, name=name, slug=f"proj-{uuid.uuid4().hex[:8]}")
    session.add(project)
    await session.commit()
    return project


async def _make_human_member(session, org_id, project_id):
    """test_2266_story_backlinks_realdb.py의 동명 helper와 동일 anchor 패턴(members +
    org_members + project_access 직접 write — team_members는 VIEW라 INSERT 불가)."""
    from app.models.member import Member
    from app.models.project import OrgMember
    from app.models.project_access import ProjectAccess
    from app.models.user import User

    user = User(id=uuid.uuid4(), email=f"u-{uuid.uuid4().hex[:8]}@test.local", hashed_password="x")
    session.add(user)
    await session.flush()
    om = OrgMember(id=uuid.uuid4(), org_id=org_id, user_id=user.id, role="member")
    session.add(om)
    await session.flush()
    m = Member(id=om.id, org_id=org_id, type="human", user_id=user.id, name="Human")
    session.add(m)
    await session.flush()
    session.add(ProjectAccess(project_id=project_id, org_member_id=om.id, member_id=m.id, role="member"))
    await session.commit()
    return m.id, user.id


async def _make_story(session, org_id, project_id, title="Story"):
    from app.models.pm import Story
    story = Story(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title, status="backlog")
    session.add(story)
    await session.commit()
    return story


async def _make_conversation(session, org_id, project_id, member_ids, created_by, conv_type="dm"):
    from app.models.conversation import Conversation, ConversationParticipant
    conv = Conversation(
        id=uuid.uuid4(), project_id=project_id, org_id=org_id, type=conv_type,
        title="Test convo", created_by=created_by,
    )
    session.add(conv)
    await session.flush()
    for mid in member_ids:
        session.add(ConversationParticipant(conversation_id=conv.id, member_id=mid))
    await session.commit()
    return conv.id


async def _add_message(session, conv_id, sender_id, content, msg_metadata=None, created_at=None):
    from app.models.conversation import ConversationMessage
    msg = ConversationMessage(
        id=uuid.uuid4(), conversation_id=conv_id, sender_id=sender_id,
        content=content, msg_metadata=msg_metadata, created_at=created_at or datetime.now(UTC),
    )
    session.add(msg)
    await session.commit()
    return msg


async def _make_reference(session, org_id, source_type, source_id, target_type, target_id, created_by, form="mention"):
    from app.models.reference import Reference
    ref = Reference(
        id=uuid.uuid4(), org_id=org_id, source_type=source_type, source_field="body",
        source_id=source_id, target_type=target_type, target_id=target_id, form=form,
        created_by=created_by,
    )
    session.add(ref)
    await session.commit()
    return ref


async def _make_event_definition(session, key, stage_metadata, name="샘플 레시피"):
    from app.models.event_definition import EventDefinition
    definition = EventDefinition(
        id=uuid.uuid4(), org_id=None, key=key, name=name, enabled=True,
        payload_schema={"type": "object", "properties": {}}, stage_metadata=stage_metadata,
        routing={}, version=1,
    )
    session.add(definition)
    await session.commit()
    return definition


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


_STAGE_METADATA = {
    "draft": {"role": "Creator", "action": "초안 작성"},
    "pending_approval": {
        "role": "Director", "action": "최종 발행 승인",
        "gate": {"type": "external_publish", "approver": "org_owner"},
    },
}


@pytest.mark.anyio
async def test_event_derived_message_carries_structured_event_summary():
    """⭐핵심 pin — 이벤트 발행 메시지의 backlinks 항목이 definition_key/stage/role/
    gate_type/approver를 raw 없이 구조화해 낸다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id, "P")
            member_id, user_id = await _make_human_member(s, org.id, project.id)
            # 이 DB가 매 테스트 실행마다 초기화되지 않을 수 있어(로컬 재실행) preset 유니크
            # 키(org_id IS NULL)를 실행마다 새로 짓는다.
            key = f"preset.test4091.sample_{uuid.uuid4().hex[:8]}"
            await _make_event_definition(s, key, _STAGE_METADATA)
            story = await _make_story(s, org.id, project.id, title="Target Story")
            conv_id = await _make_conversation(s, org.id, project.id, [member_id], member_id)
            msg = await _add_message(
                s, conv_id, member_id,
                f"[이벤트] {key}\n- stage: pending_approval (Director)",
                msg_metadata={
                    "event": {
                        "event_key": key,
                        "payload": {"stage": "pending_approval", "work_item_type": "story", "work_item_id": str(story.id)},
                    },
                },
            )
            await _make_reference(s, org.id, "chat_message", msg.id, "story", story.id, created_by=member_id)

        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/stories/{story.id}/backlinks")
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert len(body["data"]) == 1, body
            event = body["data"][0]["message"]["event"]
            assert event == {
                "definition_key": key, "name": "샘플 레시피", "stage": "pending_approval",
                "role": "Director", "gate_type": "external_publish", "approver": "org_owner",
            }, event
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_non_event_message_event_field_is_null_no_regression():
    """일반 멘션 메시지(msg_metadata.event 없음)는 event=null — 기존 content_snippet
    렌더 경로가 그대로 회귀 0으로 남는다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id, "P")
            member_id, user_id = await _make_human_member(s, org.id, project.id)
            story = await _make_story(s, org.id, project.id, title="Target Story")
            conv_id = await _make_conversation(s, org.id, project.id, [member_id], member_id)
            msg = await _add_message(s, conv_id, member_id, f"보는 [Story](entity:story:{story.id})")
            await _make_reference(s, org.id, "chat_message", msg.id, "story", story.id, created_by=member_id)

        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/stories/{story.id}/backlinks")
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert len(body["data"]) == 1, body
            assert body["data"][0]["message"]["event"] is None
            assert body["data"][0]["message"]["content_snippet"] != ""
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_event_key_with_missing_definition_degrades_without_inventing_values():
    """event_key/stage는 메시지 자체가 아는 값이라 그대로 남지만, 정의를 못 찾으면(삭제·
    오타 등) role/gate_type/approver는 지어내지 않고 null — 「모르면 안다고 안 한다」."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id, "P")
            member_id, user_id = await _make_human_member(s, org.id, project.id)
            # 의도적으로 event_definition을 시드하지 않는다(삭제된/존재한 적 없는 정의 재현).
            story = await _make_story(s, org.id, project.id, title="Target Story")
            conv_id = await _make_conversation(s, org.id, project.id, [member_id], member_id)
            msg = await _add_message(
                s, conv_id, member_id, "[이벤트] test4091.gone.recipe\n- stage: draft (Creator)",
                msg_metadata={
                    "event": {
                        "event_key": "test4091.gone.recipe",
                        "payload": {"stage": "draft", "work_item_type": "story", "work_item_id": str(story.id)},
                    },
                },
            )
            await _make_reference(s, org.id, "chat_message", msg.id, "story", story.id, created_by=member_id)

        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/stories/{story.id}/backlinks")
            assert resp.status_code == 200, resp.text
            body = resp.json()
            event = body["data"][0]["message"]["event"]
            assert event == {
                "definition_key": "test4091.gone.recipe", "name": None, "stage": "draft",
                "role": None, "gate_type": None, "approver": None,
            }, event
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()
