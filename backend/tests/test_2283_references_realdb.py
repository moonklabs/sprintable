"""story #2283(BE) — `POST /api/v2/references`(직접생성) + `DELETE /api/v2/references/{id}`.
계약 doc `reference-direct-create-contract-20260728`(PO 확정) 그대로 실PG 검증.

검증 축:
  ①registry 밖 source_type/target_type — 400(등록 안 됨, 조용히 통과 금지)
  ②멱등 — 같은 (source, target) 튜플 재호출은 409가 아니라 200 + 기존 id 재반환
  ③양쪽-아이템 게이트(404, 존재 비노출) — source 접근·target 접근을 twin comparison(있음
    vs 없음)으로 «독립적으로» 증명한다("반쪽 금지" — 한쪽만 막고 한쪽은 새는 회귀를 잡는다)
  ④DELETE도 동일 게이트 — 삭제 권한이 생성 권한과 독립적으로 재확인되는지
  ⑤PROJECT_ID_RESOLVERS와 ENTITY_RESOLVERS 키 집합 동일(twin-system drift 방지, 테스트로 pin)
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone

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


# ─── Seeding helpers (test_2266_story_backlinks_realdb.py와 동형) ─────────────


async def _make_org(session, name="Org"):
    from app.models.organization import Organization
    org = Organization(id=uuid.uuid4(), name=name, slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    return org


async def _make_project(session, org_id, name="P"):
    from app.models.project import Project
    project = Project(id=uuid.uuid4(), org_id=org_id, name=name)
    session.add(project)
    await session.commit()
    return project


async def _make_human_member(session, org_id, project_id):
    from app.models.user import User
    from app.models.project import OrgMember
    from app.models.project_access import ProjectAccess
    from app.models.member import Member

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


async def _make_doc(session, org_id, project_id, title="Doc"):
    from app.models.doc import Doc
    doc = Doc(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title, slug=f"d-{uuid.uuid4().hex[:8]}")
    session.add(doc)
    await session.commit()
    return doc


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


async def _add_message(session, conv_id, sender_id, content, created_at=None):
    from app.models.conversation import ConversationMessage
    msg = ConversationMessage(
        id=uuid.uuid4(), conversation_id=conv_id, sender_id=sender_id,
        content=content, created_at=created_at or datetime.now(timezone.utc),
    )
    session.add(msg)
    await session.commit()
    return msg


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
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


# ─── ⑤twin-system drift 방지 ──────────────────────────────────────────────


def test_project_id_resolvers_keys_match_entity_resolvers():
    from app.services.reference_registry import ENTITY_RESOLVERS, PROJECT_ID_RESOLVERS
    assert set(PROJECT_ID_RESOLVERS) == set(ENTITY_RESOLVERS)


# ─── ①registry 밖 타입 — 400 ───────────────────────────────────────────────


@pytest.mark.anyio
async def test_create_reference_rejects_unregistered_source_type():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            _, user_id = await _make_human_member(s, org.id, project.id)
            story = await _make_story(s, org.id, project.id)

        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.post("/api/v2/references", json={
                "source_type": "task", "source_id": str(uuid.uuid4()),
                "target_type": "story", "target_id": str(story.id),
            })
            assert resp.status_code == 400, resp.text
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_create_reference_rejects_unregistered_target_type():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            member_id, user_id = await _make_human_member(s, org.id, project.id)
            conv_id = await _make_conversation(s, org.id, project.id, [member_id], member_id)
            msg = await _add_message(s, conv_id, member_id, "hi")

        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.post("/api/v2/references", json={
                "source_type": "chat_message", "source_id": str(msg.id),
                "target_type": "task", "target_id": str(uuid.uuid4()),
            })
            assert resp.status_code == 400, resp.text
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


# ─── ③양쪽-아이템 게이트 — twin comparison(독립 검증) ─────────────────────────


@pytest.mark.anyio
async def test_create_reference_404_when_source_inaccessible():
    """caller가 target(story)엔 접근하지만 source(chat_message가 속한 conversation)엔
    참여하지 않는 경우 — source 게이트 단독으로 404가 걸리는지(target 접근권만으로 새지
    않는지)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            owner_id, _ = await _make_human_member(s, org.id, project.id)
            outsider_id, outsider_user_id = await _make_human_member(s, org.id, project.id)
            story = await _make_story(s, org.id, project.id)
            conv_id = await _make_conversation(s, org.id, project.id, [owner_id], owner_id)
            msg = await _add_message(s, conv_id, owner_id, "private convo")

        # outsider는 project 접근은 있지만 conversation 참가자가 아니다.
        await _setup_app_human(app, Session, outsider_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.post("/api/v2/references", json={
                "source_type": "chat_message", "source_id": str(msg.id),
                "target_type": "story", "target_id": str(story.id),
            })
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_create_reference_404_when_target_inaccessible():
    """caller가 source(chat_message)엔 참여하지만 target(story)이 속한 project엔 접근이
    없는 경우 — target 게이트 단독으로 404가 걸리는지(source 접근권만으로 새지 않는지)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            chat_project = await _make_project(s, org.id, "Chat Project")
            story_project = await _make_project(s, org.id, "Story Project(no access)")
            member_id, user_id = await _make_human_member(s, org.id, chat_project.id)
            conv_id = await _make_conversation(s, org.id, chat_project.id, [member_id], member_id)
            msg = await _add_message(s, conv_id, member_id, "hi")
            story = await _make_story(s, org.id, story_project.id)

        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.post("/api/v2/references", json={
                "source_type": "chat_message", "source_id": str(msg.id),
                "target_type": "story", "target_id": str(story.id),
            })
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_create_reference_succeeds_when_both_accessible():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            member_id, user_id = await _make_human_member(s, org.id, project.id)
            conv_id = await _make_conversation(s, org.id, project.id, [member_id], member_id)
            msg = await _add_message(s, conv_id, member_id, "hi")
            doc = await _make_doc(s, org.id, project.id)

        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.post("/api/v2/references", json={
                "source_type": "chat_message", "source_id": str(msg.id),
                "target_type": "doc", "target_id": str(doc.id),
            })
            assert resp.status_code == 201, resp.text
            body = resp.json()
            assert body["source_type"] == "chat_message"
            assert body["source_id"] == str(msg.id)
            assert body["source_field"] == "body"
            assert body["target_type"] == "doc"
            assert body["target_id"] == str(doc.id)
            assert body["form"] == "mention"
            assert "id" in body and "created_at" in body
            return body["id"], msg.id, doc.id, org.id, user_id
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


# ─── ②멱등 ───────────────────────────────────────────────────────────────


@pytest.mark.anyio
async def test_create_reference_idempotent_same_tuple_returns_existing():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            member_id, user_id = await _make_human_member(s, org.id, project.id)
            conv_id = await _make_conversation(s, org.id, project.id, [member_id], member_id)
            msg = await _add_message(s, conv_id, member_id, "hi")
            doc = await _make_doc(s, org.id, project.id)

        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            payload = {
                "source_type": "chat_message", "source_id": str(msg.id),
                "target_type": "doc", "target_id": str(doc.id),
            }
            resp1 = await client.post("/api/v2/references", json=payload)
            assert resp1.status_code == 201, resp1.text
            resp2 = await client.post("/api/v2/references", json=payload)
            # ⛔계약: 재호출은 409가 아니라 200 + 기존 행 재반환(첫 호출만 201 — PO 판정:
            # FE가 "새로 생겼는지"를 상태코드로 구별할 수 있어야 연타가 카운트를 안 부풀린다).
            assert resp2.status_code == 200, resp2.text
            assert resp1.json()["id"] == resp2.json()["id"]
            assert resp1.json()["source_field"] == resp2.json()["source_field"] == "body"
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


# ─── ④DELETE — 동일 게이트 ─────────────────────────────────────────────────


@pytest.mark.anyio
async def test_delete_reference_404_for_nonexistent():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            _, user_id = await _make_human_member(s, org.id, project.id)

        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.delete(f"/api/v2/references/{uuid.uuid4()}")
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_delete_reference_404_when_caller_lost_target_access():
    """생성 당시엔 접근이 있었지만(다른 caller가 만든 행), 지우려는 caller는 target
    project 접근이 없는 경우 — row 존재만으로 삭제가 새지 않는지."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            chat_project = await _make_project(s, org.id, "Chat Project")
            story_project = await _make_project(s, org.id, "Story Project(no access)")
            member_id, creator_user_id = await _make_human_member(s, org.id, chat_project.id)
            conv_id = await _make_conversation(s, org.id, chat_project.id, [member_id], member_id)
            msg = await _add_message(s, conv_id, member_id, "hi")
            story = await _make_story(s, org.id, story_project.id)
            # creator도 story_project에 접근이 없으므로 API를 통해 만들 수 없다 — 직접 행 삽입.
            from app.models.reference import Reference
            ref = Reference(
                id=uuid.uuid4(), org_id=org.id, source_type="chat_message", source_field="body",
                source_id=msg.id, target_type="story", target_id=story.id, form="mention",
                created_by=member_id,
            )
            s.add(ref)
            await s.commit()
            ref_id = ref.id

        await _setup_app_human(app, Session, creator_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.delete(f"/api/v2/references/{ref_id}")
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_delete_reference_succeeds_when_both_accessible():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            member_id, user_id = await _make_human_member(s, org.id, project.id)
            conv_id = await _make_conversation(s, org.id, project.id, [member_id], member_id)
            msg = await _add_message(s, conv_id, member_id, "hi")
            doc = await _make_doc(s, org.id, project.id)

        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            create_resp = await client.post("/api/v2/references", json={
                "source_type": "chat_message", "source_id": str(msg.id),
                "target_type": "doc", "target_id": str(doc.id),
            })
            ref_id = create_resp.json()["id"]
            del_resp = await client.delete(f"/api/v2/references/{ref_id}")
            assert del_resp.status_code == 204, del_resp.text

            # 재조회하면 이미 없음(404) — 실제로 지워졌는지 확인(응답코드만 믿지 않는다).
            del_resp2 = await client.delete(f"/api/v2/references/{ref_id}")
            assert del_resp2.status_code == 404, del_resp2.text
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


# ─── RED→GREEN 자체검증 — source 게이트 무력화 시 실제로 새는지 ────────────────


@pytest.mark.anyio
async def test_source_gate_red_green_mutation_self_check():
    """`_SOURCE_TYPE_CONFIG["chat_message"].access_gate`를 임시로 no-op화하면 위
    test_create_reference_404_when_source_inaccessible의 outsider가 404 대신 201로
    새는지(=게이트가 실제로 막고 있었는지) 직접 증명한다."""
    import app.routers.references as references_module

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            owner_id, _ = await _make_human_member(s, org.id, project.id)
            outsider_id, outsider_user_id = await _make_human_member(s, org.id, project.id)
            story = await _make_story(s, org.id, project.id)
            conv_id = await _make_conversation(s, org.id, project.id, [owner_id], owner_id)
            msg = await _add_message(s, conv_id, owner_id, "private convo")

        from app.main import app

        original_config = dict(references_module._SOURCE_TYPE_CONFIG)

        async def _noop_true(*args, **kwargs):
            return True

        references_module._SOURCE_TYPE_CONFIG["chat_message"] = references_module.SourceTypeConfig(
            "body", _noop_true
        )
        try:
            await _setup_app_human(app, Session, outsider_user_id, org.id)
            client = _client_for(app)
            try:
                resp = await client.post("/api/v2/references", json={
                    "source_type": "chat_message", "source_id": str(msg.id),
                    "target_type": "story", "target_id": str(story.id),
                })
                assert resp.status_code == 201, (
                    f"사보타주가 안 먹었다(게이트가 다른 경로로도 걸리는 중?) — {resp.status_code}: {resp.text}"
                )
            finally:
                await client.aclose()
                app.dependency_overrides.clear()
        finally:
            references_module._SOURCE_TYPE_CONFIG.clear()
            references_module._SOURCE_TYPE_CONFIG.update(original_config)

        # 원복 후 GREEN 재확인.
        await _setup_app_human(app, Session, outsider_user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.post("/api/v2/references", json={
                "source_type": "chat_message", "source_id": str(msg.id),
                "target_type": "story", "target_id": str(story.id),
            })
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()
