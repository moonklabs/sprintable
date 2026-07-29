"""story #2263 AC6 — `GET /api/v2/stories/{id}/references?direction=outgoing`, 첫 실제
`reference_core.list_references` 소비자. RED-먼저: 이 파일은 라우트가 아직 없는 시점에
작성됐다 — router/stories.py의 새 라우트+`_visible_target_ids`를 되돌리면 아래 전부 404
(라우트 자체 없음)로 실패하는 것을 먼저 확認한 뒤에만 구현한다.

TARGET(story 자신) 게이트는 get_story_backlinks·get_story와 동일 `_assert_story_project_access`
(#2322 PR#1 반영 — 무권한은 404). 반대편(outgoing 대상들)의 가시성은 C-3(#2261) 규율 그대로
— 못 보는 대상은 존재 자체가 새지 않는다(목록에서 조용히 빠진다, 403/404 구분 노출 없음)."""
from __future__ import annotations

import os
import uuid

import pytest

from tests.test_1994_backlink_api_realdb import (
    _client_for,
    _make_doc,
    _make_human_member,
    _make_org,
    _make_project,
    _session_factory,
    _setup_app_human,
)


async def _make_conversation(session, org_id, project_id, *, participant_ids):
    from app.models.conversation import Conversation, ConversationParticipant

    conv = Conversation(id=uuid.uuid4(), project_id=project_id, org_id=org_id, type="group", title="Conv")
    session.add(conv)
    await session.flush()
    for pid in participant_ids:
        session.add(ConversationParticipant(conversation_id=conv.id, member_id=pid))
    await session.commit()
    return conv

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


async def _make_story(session, org_id, project_id, title="Story"):
    from app.models.pm import Story
    story = Story(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title, status="in-progress")
    session.add(story)
    await session.commit()
    return story


async def _insert_ref(session, *, org_id, source_id, target_type, target_id, created_by):
    from app.services.reference_core import insert_reference
    return await insert_reference(
        session, org_id=org_id, source_type="story", source_field="description",
        source_id=source_id, target_type=target_type, target_id=target_id,
        form="mention", created_by=created_by,
    )


async def _seed(session):
    """org(project_a[caller 접근권]·project_b[무접근]) + source story(project_a) +
    outgoing refs: visible_doc(project_a) · invisible_doc(project_b, 존재하되 무권한) ·
    ghost_doc(등록 id지만 실제 row 없음, project_id resolver가 None)."""
    org = await _make_org(session)
    project_a = await _make_project(session, org.id, "A")
    project_b = await _make_project(session, org.id, "B")
    _, caller_id = await _make_human_member(session, org.id, project_a.id)

    source_story = await _make_story(session, org.id, project_a.id, title="Source")
    visible_doc = await _make_doc(session, org.id, project_a.id, title="Visible Doc")
    invisible_doc = await _make_doc(session, org.id, project_b.id, title="Invisible Doc")
    ghost_doc_id = uuid.uuid4()

    await _insert_ref(
        session, org_id=org.id, source_id=source_story.id,
        target_type="doc", target_id=visible_doc.id, created_by=caller_id,
    )
    await _insert_ref(
        session, org_id=org.id, source_id=source_story.id,
        target_type="doc", target_id=invisible_doc.id, created_by=caller_id,
    )
    await _insert_ref(
        session, org_id=org.id, source_id=source_story.id,
        target_type="doc", target_id=ghost_doc_id, created_by=caller_id,
    )
    await session.commit()

    return {
        "org_id": org.id, "caller_id": caller_id,
        "source_story_id": source_story.id,
        "visible_doc_id": visible_doc.id, "invisible_doc_id": invisible_doc.id,
        "ghost_doc_id": ghost_doc_id,
    }


@pytest.mark.anyio
async def test_outgoing_references_shows_visible_target_only_includes_payload():
    """양성대조 + 누설0: visible_doc만 나오고, form·target 메타·proof_payload(mention이라
    None)를 싣는다(PO 정정 — 목록도 payload를 싣는다, 단건 상세 라우트는 안 지음)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app_human(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(
                f"/api/v2/stories/{seeded['source_story_id']}/references",
                params={"direction": "outgoing"},
            )
            assert resp.status_code == 200, resp.text
            body = resp.json()
            target_ids = {item["target_id"] for item in body["data"]}
            assert target_ids == {str(seeded["visible_doc_id"])}, (
                f"invisible_doc·ghost_doc가 새면 안 된다(누설0) — got {target_ids}"
            )
            item = body["data"][0]
            assert item["form"] == "mention"
            assert item["target_type"] == "doc"
            assert item["still_exists"] is True
            # PO 정정(2026-07-29): 목록도 proof_payload를 싣는다(단건 상세 라우트를 안 지음 —
            # C-7이 카드를 여럿 펼쳐 보이는 자리라 단건이면 N+1). mention form엔 payload가
            # 애초에 없어 None — "키가 없다"가 아니라 "값이 null"이다(필드 자체는 항상 존재).
            assert "proof_payload" in item
            assert item["proof_payload"] is None
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_outgoing_references_nonexistent_story_404():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app_human(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/stories/{uuid.uuid4()}/references", params={"direction": "outgoing"})
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_outgoing_references_no_project_access_404_not_403():
    """TARGET(story 자신) 게이트 — #2322 PR#1 통일(403 아닌 404)."""
    from app.main import app
    from app.models.member import Member
    from app.models.project import Project
    from app.models.project_access import ProjectAccess

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
            other_project = Project(id=uuid.uuid4(), org_id=seeded["org_id"], name="Other")
            stranger = Member(id=uuid.uuid4(), org_id=seeded["org_id"], type="human", name="Stranger", is_active=True)
            s.add_all([other_project, stranger])
            await s.commit()
            s.add(ProjectAccess(
                id=uuid.uuid4(), project_id=other_project.id, member_id=stranger.id,
                permission="granted", role="member",
            ))
            await s.commit()
            stranger_id = stranger.id

        await _setup_app_human(app, Session, stranger_id, seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(
                f"/api/v2/stories/{seeded['source_story_id']}/references",
                params={"direction": "outgoing"},
            )
            assert resp.status_code == 404, (
                f"story #2322 방향 계승 — 무권한은 404여야 한다 — {resp.status_code}: {resp.text}"
            )
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_outgoing_references_incoming_direction_rejected_400():
    """incoming은 이 라우트 범위 밖 — /backlinks가 이미 다룬다. 명시 400으로 거부."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app_human(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(
                f"/api/v2/stories/{seeded['source_story_id']}/references",
                params={"direction": "incoming"},
            )
            assert resp.status_code == 400, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_outgoing_references_mutation_self_check_visibility_gate_actually_blocks():
    """뮤테이션 자가검증 — has_project_access를 항상-참으로 사보타주하면 invisible_doc·
    ghost_doc까지 새는 것으로(누설 재현), 가시성 게이트가 동어반복이 아님을 증명한다."""
    import app.routers.stories as stories_module
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app_human(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)

        original_visible = stories_module._visible_target_ids

        async def _always_all_visible(session, org_id, caller_id, ids_by_type, auth, conversation_id_by_target_id=None):
            return {t: set(ids) for t, ids in ids_by_type.items()}

        stories_module._visible_target_ids = _always_all_visible
        try:
            resp = await client.get(
                f"/api/v2/stories/{seeded['source_story_id']}/references",
                params={"direction": "outgoing"},
            )
            assert resp.status_code == 200, resp.text
            target_ids = {item["target_id"] for item in resp.json()["data"]}
            assert str(seeded["invisible_doc_id"]) in target_ids, (
                "사보타주 중엔 invisible_doc이 새야 한다(가드가 실제로 막고 있었다는 증거)"
            )
        finally:
            stories_module._visible_target_ids = original_visible
            await client.aclose()

        client2 = _client_for(app)
        try:
            resp2 = await client2.get(
                f"/api/v2/stories/{seeded['source_story_id']}/references",
                params={"direction": "outgoing"},
            )
            target_ids2 = {item["target_id"] for item in resp2.json()["data"]}
            assert str(seeded["invisible_doc_id"]) not in target_ids2, "원복 후 다시 안 새야 한다"
        finally:
            await client2.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_create_proof_reference_readable_conversation_201_then_read_back():
    """왕복(write→read) — 대화를 읽을 수 있는 caller가 proof를 박으면 201 + proof_payload를
    그대로 돌려받고(PO 정정: POST 응답도 payload를 싣는다 — 저장 직후 재조회 없이 그릴 수
    있게), 그 다음 GET /references(outgoing)에서도 같은 payload로 보인다. still_exists는
    chat_message가 이제 ENTITY_RESOLVERS에 등록돼(story #2263) True로 판정된다 — 예전
    가정(등록 밖이라 None)은 이 PR 자체가 바꾼 축이다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id, "P")
            member_id, caller_id = await _make_human_member(s, org.id, project.id)
            source_story = await _make_story(s, org.id, project.id, title="Source")
            conv = await _make_conversation(s, org.id, project.id, participant_ids=[member_id])

            from app.models.conversation import ConversationMessage
            msg = ConversationMessage(
                id=uuid.uuid4(), conversation_id=conv.id, sender_id=member_id, content="quoted text",
            )
            s.add(msg)
            await s.commit()
            message_id = msg.id

        await _setup_app_human(app, Session, caller_id, org.id)
        client = _client_for(app)
        try:
            payload = {
                "conversation_id": str(conv.id),
                "start_message_id": str(message_id), "end_message_id": str(message_id),
                "snapshot": [{
                    "message_id": str(message_id), "author_id": str(caller_id),
                    "content": "quoted text", "created_at": "2026-07-29T00:00:00Z",
                }],
            }
            resp = await client.post(
                f"/api/v2/stories/{source_story.id}/references",
                json={
                    "target_type": "chat_message", "target_id": str(message_id), "form": "proof",
                    "proof_payload": payload,
                },
            )
            assert resp.status_code == 201, resp.text
            body = resp.json()
            assert body["form"] == "proof"
            assert body["target_type"] == "chat_message"
            assert body["target_id"] == str(message_id)
            assert body["proof_payload"] == payload, "POST 응답도 payload를 그대로 돌려줘야 한다"

            read_resp = await client.get(
                f"/api/v2/stories/{source_story.id}/references", params={"direction": "outgoing"},
            )
            assert read_resp.status_code == 200, read_resp.text
            items = read_resp.json()["data"]
            assert len(items) == 1
            assert items[0]["proof_payload"] == payload, "GET 목록에서도 같은 payload가 보여야 한다"
            assert items[0]["still_exists"] is True, (
                "chat_message가 이제 ENTITY_RESOLVERS에 등록돼 True로 판정돼야 한다"
            )
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_create_proof_reference_unreadable_conversation_404():
    """권한② — 그 대화를 못 읽는 caller가 조각을 박으려 하면 거부(존재 비노출 — 404)."""
    from app.main import app
    from app.models.member import Member
    from app.models.project import OrgMember
    from app.models.project_access import ProjectAccess
    from app.models.user import User

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id, "P")
            participant_member_id, _ = await _make_human_member(s, org.id, project.id)
            source_story = await _make_story(s, org.id, project.id, title="Source")
            conv = await _make_conversation(s, org.id, project.id, participant_ids=[participant_member_id])
            message_id = uuid.uuid4()

            # stranger: project 접근권은 있으나(그래서 source story 게이트는 통과) 이
            # conversation의 participant가 아니다.
            user_id = uuid.uuid4()
            s.add(User(id=user_id, email=f"s-{user_id.hex[:8]}@test.com", hashed_password="x"))
            await s.commit()
            om = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=user_id, role="member")
            s.add(om)
            await s.commit()
            stranger = Member(id=om.id, org_id=org.id, type="human", user_id=user_id, name="Stranger")
            s.add(stranger)
            await s.commit()
            s.add(ProjectAccess(
                id=uuid.uuid4(), project_id=project.id, org_member_id=om.id, member_id=om.id,
                permission="granted", role="member",
            ))
            await s.commit()
            stranger_id = user_id

        await _setup_app_human(app, Session, stranger_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/stories/{source_story.id}/references",
                json={
                    "target_type": "chat_message", "target_id": str(message_id), "form": "proof",
                    "proof_payload": {"conversation_id": str(conv.id), "snapshot": []},
                },
            )
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_create_reference_unsupported_combination_400():
    """target_type/form이 chat_message/proof 조합이 아니면 명시 400(조용한 무시 금지)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id, "P")
            _, caller_id = await _make_human_member(s, org.id, project.id)
            source_story = await _make_story(s, org.id, project.id, title="Source")

        await _setup_app_human(app, Session, caller_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/stories/{source_story.id}/references",
                json={
                    "target_type": "doc", "target_id": str(uuid.uuid4()), "form": "mention",
                    "proof_payload": {"conversation_id": str(uuid.uuid4())},
                },
            )
            assert resp.status_code == 400, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
