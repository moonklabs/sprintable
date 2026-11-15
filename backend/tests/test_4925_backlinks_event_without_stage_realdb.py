"""story 4925 — the «이것을 가리키는 것들» / «무엇에서 만들었나» line for an event message that has NO `stage` (the steer instruction · an org's own event): `message.event` carries the same card the stage events get —
`{definition_key, name, stage: null, role: null, gate_type: null, approver: null}` — and nothing else: no payload. Before this the field was null for them (story 4091 wrote it for the recipe stage events only), so the screen
could say only «이벤트». Who may read it is unchanged: the story's project gate answers 404 to a person without access, with nothing of the card in the body.

realdb 하네스는 test_4091_backlinks_event_summary_realdb.py의 셀프컨테인 seed 헬퍼를 그대로 복제한다."""
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
        return AuthContext(
            user_id=str(user_id), email="human@test",
            claims={"app_metadata": {"org_id": str(org_id)}},
        )

    # story #2451(§6 Phase3) 가드(카디르 QA #4466 CI FAIL 발견) — get_db만 걸고 get_read_db를
    # 빠뜨리면 read-replica 라우팅 경로가 이 테스트의 오버라이드를 안 타 구조적으로 놓친다.
    override_db_and_read(app, _db)
    app.dependency_overrides[get_current_user] = _auth



_STAGE_METADATA = {"draft": {"role": "Creator", "action": "초안 작성"}}
_CARD_KEYS = {"definition_key", "name", "stage", "role", "gate_type", "approver"}


async def _make_org_definition(session, org_id, org_slug, name="배포 확인"):
    from app.models.event_definition import EventDefinition
    key = f"org.{org_slug}.deploy_checked"
    definition = EventDefinition(
        id=uuid.uuid4(), org_id=org_id, key=key, name=name, enabled=True,
        payload_schema={"type": "object", "properties": {}}, stage_metadata={},
        routing={}, version=1,
    )
    session.add(definition)
    await session.commit()
    return key


@pytest.mark.anyio
async def test_event_without_a_stage_carries_its_definition_name_and_key_and_nothing_of_the_payload():
    """⭐핵심 pin — stage 없는 이벤트(조직 정의)도 이름 · 키가 나오고, 그 밖엔 아무것도 안 나온다(payload의 값은 응답 어디에도 없다)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id, "P")
            member_id, user_id = await _make_human_member(s, org.id, project.id)
            key = await _make_org_definition(s, org.id, org.slug)
            story = await _make_story(s, org.id, project.id, title="Target Story")
            conv_id = await _make_conversation(s, org.id, project.id, [member_id], member_id)
            msg = await _add_message(
                s, conv_id, member_id, f"[이벤트] {key}\n- note: 비밀 메모 4925\n- build_number: 4242",
                msg_metadata={"event": {"event_key": key, "payload": {"note": "비밀 메모 4925", "build_number": 4242}}},
            )
            await _make_reference(s, org.id, "chat_message", msg.id, "story", story.id, created_by=member_id)

        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/stories/{story.id}/backlinks")
            assert resp.status_code == 200, resp.text
            event = resp.json()["data"][0]["message"]["event"]
            assert event == {
                "definition_key": key, "name": "배포 확인", "stage": None,
                "role": None, "gate_type": None, "approver": None,
            }, event
            assert set(event) == _CARD_KEYS, "the same keys the stage events get — no more"
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_event_without_a_stage_and_without_a_definition_says_no_name():
    """steer 지시처럼 stage 없는 이벤트의 정의를 못 찾으면(삭제 등) 이름을 지어내지 않는다 — name null, stage null."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id, "P")
            member_id, user_id = await _make_human_member(s, org.id, project.id)
            story = await _make_story(s, org.id, project.id, title="Target Story")
            conv_id = await _make_conversation(s, org.id, project.id, [member_id], member_id)
            msg = await _add_message(
                s, conv_id, member_id, "[이벤트] test4925.gone.event\n- instruction: 확인",
                msg_metadata={"event": {"event_key": "test4925.gone.event", "payload": {"instruction": "확인"}}},
            )
            await _make_reference(s, org.id, "chat_message", msg.id, "story", story.id, created_by=member_id)

        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/stories/{story.id}/backlinks")
            assert resp.status_code == 200, resp.text
            assert resp.json()["data"][0]["message"]["event"] == {
                "definition_key": "test4925.gone.event", "name": None, "stage": None,
                "role": None, "gate_type": None, "approver": None,
            }
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_a_person_without_access_to_the_story_gets_nothing_of_the_card():
    """누가 볼 수 있는지는 그대로 — 스토리의 프로젝트에 접근이 없는 사람은 404이고 본문 어디에도 정의 이름 · 키 · payload가 없다(같은 스토리를 접근 있는 사람은 200으로 이름을 본다)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id, "P")
            other_project = await _make_project(s, org.id, "Other")
            member_with_access, user_with_access = await _make_human_member(s, org.id, project.id)
            _member_without_access, user_without_access = await _make_human_member(s, org.id, other_project.id)
            key = await _make_org_definition(s, org.id, org.slug, name="배포 확인 4925")
            story = await _make_story(s, org.id, project.id, title="Target Story")
            conv_id = await _make_conversation(s, org.id, project.id, [member_with_access], member_with_access)
            msg = await _add_message(
                s, conv_id, member_with_access, f"[이벤트] {key}\n- note: 비밀 메모 4925",
                msg_metadata={"event": {"event_key": key, "payload": {"note": "비밀 메모 4925"}}},
            )
            await _make_reference(s, org.id, "chat_message", msg.id, "story", story.id, created_by=member_with_access)

        await _setup_app_human(app, Session, user_with_access, org.id)
        client = _client_for(app)
        try:
            ok = await client.get(f"/api/v2/stories/{story.id}/backlinks")
            assert ok.status_code == 200 and ok.json()["data"][0]["message"]["event"]["name"] == "배포 확인 4925", ok.text
        finally:
            await client.aclose()
            app.dependency_overrides.clear()

        await _setup_app_human(app, Session, user_without_access, org.id)
        client = _client_for(app)
        try:
            denied = await client.get(f"/api/v2/stories/{story.id}/backlinks")
            assert denied.status_code == 404, denied.text
            for secret in ("배포 확인 4925", key, "비밀 메모 4925"):
                assert secret not in denied.text, f"{secret!r} leaked to a person without access"
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_a_deleted_event_message_gives_no_card_whatever_its_kind():
    """⭐카디르 보안 렌즈 — 지운(묘비) 메시지: 삭제는 content만 비우고 msg_metadata를 남기고 행은 still_exists=false로 남는다. 잘못 보냈다 지운 이벤트의 키 · 정의 이름이 «이것을 가리키는 것들»에 남으면 안 된다
    (stage 있는 이벤트 · 없는 이벤트 둘 다 — 되돌리면 RED)."""
    from app.main import app

    engine, Session = await _session_factory()
    stage_key = f"preset.test4925.sample_{uuid.uuid4().hex[:8]}"
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id, "P")
            member_id, user_id = await _make_human_member(s, org.id, project.id)
            no_stage_key = await _make_org_definition(s, org.id, org.slug, name="지운 정의 이름 4925")
            await _make_event_definition(s, stage_key, _STAGE_METADATA, name="지운 레시피 이름 4925")
            story = await _make_story(s, org.id, project.id, title="Target Story")
            conv_id = await _make_conversation(s, org.id, project.id, [member_id], member_id)
            for key, payload in ((no_stage_key, {"note": "x"}), (stage_key, {"stage": "draft"})):
                msg = await _add_message(s, conv_id, member_id, f"[이벤트] {key}", msg_metadata={"event": {"event_key": key, "payload": payload}})
                msg.deleted_at = datetime.now(UTC)
                msg.content = ""
                await s.commit()
                await _make_reference(s, org.id, "chat_message", msg.id, "story", story.id, created_by=member_id)

        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/stories/{story.id}/backlinks")
            assert resp.status_code == 200, resp.text
            data = resp.json()["data"]
            assert len(data) == 2 and all(row["still_exists"] is False for row in data), data
            assert all(row["message"]["event"] is None for row in data), data
            for secret in ("지운 정의 이름 4925", "지운 레시피 이름 4925", no_stage_key, stage_key):
                assert secret not in resp.text, f"{secret!r} stayed on a deleted message's row"
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        from sqlalchemy import text
        async with engine.begin() as conn:
            await conn.execute(text("DELETE FROM event_definitions WHERE key = :k AND org_id IS NULL"), {"k": stage_key})
        await engine.dispose()


@pytest.mark.anyio
async def test_a_person_with_the_story_but_not_in_the_room_gets_no_row_and_no_card():
    """카디르 렌즈 보탬 — 스토리 접근은 있으나 그 대화방 참가자가 아닌 사람: 행도 카드도 없다(방 가시성 술어가 그대로)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id, "P")
            in_room, user_in_room = await _make_human_member(s, org.id, project.id)
            _outside, user_outside = await _make_human_member(s, org.id, project.id)  # the same project, so the story is reachable
            key = await _make_org_definition(s, org.id, org.slug, name="방 밖 이름 4925")
            story = await _make_story(s, org.id, project.id, title="Target Story")
            conv_id = await _make_conversation(s, org.id, project.id, [in_room], in_room)
            msg = await _add_message(s, conv_id, in_room, f"[이벤트] {key}\n- note: x", msg_metadata={"event": {"event_key": key, "payload": {"note": "x"}}})
            await _make_reference(s, org.id, "chat_message", msg.id, "story", story.id, created_by=in_room)

        await _setup_app_human(app, Session, user_in_room, org.id)
        client = _client_for(app)
        try:
            ok = await client.get(f"/api/v2/stories/{story.id}/backlinks")
            assert ok.status_code == 200 and ok.json()["data"][0]["message"]["event"]["name"] == "방 밖 이름 4925", ok.text
        finally:
            await client.aclose()
            app.dependency_overrides.clear()

        await _setup_app_human(app, Session, user_outside, org.id)
        client = _client_for(app)
        try:
            out = await client.get(f"/api/v2/stories/{story.id}/backlinks")
            assert out.status_code == 200, out.text
            assert out.json()["data"] == [], out.text
            for secret in ("방 밖 이름 4925", key):
                assert secret not in out.text
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_a_key_that_belongs_to_another_organizations_definition_gets_no_name():
    """카디르 렌즈 보탬 — 다른 조직의 정의 키를 부른 메시지: 그 조직 정의의 이름을 읽지 않는다(name null) — 되돌리면(조직 조건 제거) RED."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            other_org = await _make_org(s, name="Other")
            project = await _make_project(s, org.id, "P")
            member_id, user_id = await _make_human_member(s, org.id, project.id)
            foreign_key = await _make_org_definition(s, other_org.id, other_org.slug, name="남의 조직 이름 4925")
            story = await _make_story(s, org.id, project.id, title="Target Story")
            conv_id = await _make_conversation(s, org.id, project.id, [member_id], member_id)
            msg = await _add_message(s, conv_id, member_id, f"[이벤트] {foreign_key}", msg_metadata={"event": {"event_key": foreign_key, "payload": {}}})
            await _make_reference(s, org.id, "chat_message", msg.id, "story", story.id, created_by=member_id)

        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/stories/{story.id}/backlinks")
            assert resp.status_code == 200, resp.text
            event = resp.json()["data"][0]["message"]["event"]
            assert event["name"] is None, event
            assert "남의 조직 이름 4925" not in resp.text
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()
