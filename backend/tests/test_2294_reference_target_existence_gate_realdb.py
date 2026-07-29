"""story #2294 후속(2026-07-29, 오르테가 라이브 실측 — 스레드 7256d5cc) —
`reconcile_entity_references`(mention_parser.py)의 target 실재+org 소속 검증 실PG 검증.

⛔무엇이 어긋나 있었는가: 채팅에 `[제목](entity:task:<존재하지 않는 uuid>)`를 손으로 쳐도
그대로 `references={"stored": 1, "dropped": []}`로 저장됐다 — 미르코가 코드로 좁힌 자리:
POST /references(단건)·GET /entities/search는 이미 존재판정(`ENTITY_RESOLVERS`)을 거치는데,
채팅 전송이 실제로 타는 `reconcile_entity_references`만 target_type(등록된 «타입»인가)만 보고
target_id의 «실재»는 한 번도 확認하지 않았다.

처방(PO 승인 — 새 게이트 신설 아님): POST /references·GET /search와 같은 계열인
`reference_core._batch_resolve_existence`(ENTITY_RESOLVERS 그 자체)를 재사용. 각 resolver가
`WHERE org_id == org_id`로 스코프하므로 실재하지만 다른 org 소속인 UUID도 "없음"으로 걸린다
(존재+org 소속을 한 번에 검증) — ㉠새는가(보안) 질문에 대한 답이 이것.
"""
from __future__ import annotations

import os
import uuid

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


async def _make_task(session, org_id, story_id, title="Task"):
    from app.models.pm import Task
    task = Task(id=uuid.uuid4(), org_id=org_id, story_id=story_id, title=title)
    session.add(task)
    await session.commit()
    return task


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


async def _make_conversation(session, org_id, project_id, member_ids, created_by_member_id):
    from app.models.conversation import Conversation, ConversationParticipant
    conv = Conversation(
        id=uuid.uuid4(), project_id=project_id, org_id=org_id, type="dm",
        title="Test convo", created_by=created_by_member_id,
    )
    session.add(conv)
    await session.flush()
    for mid in member_ids:
        session.add(ConversationParticipant(conversation_id=conv.id, member_id=mid))
    await session.commit()
    return conv.id


# ─── 오르테가가 dev 라이브에 실제로 친 그 시나리오 — 존재하지 않는 task ─────────


async def test_chat_mention_to_nonexistent_target_is_dropped_not_stored():
    from app.main import app
    from app.models.reference import Reference
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            member_id, user_id = await _make_human_member(s, org.id, project.id)
            conv_id = await _make_conversation(s, org.id, project.id, [member_id], member_id)

        fake_task_id = uuid.uuid4()
        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/conversations/{conv_id}/messages",
                json={"content": f"[존재하지 않는 작업](entity:task:{fake_task_id})"},
            )
            assert resp.status_code == 201, resp.text
            body = resp.json()
            assert body["references"]["stored"] == 0, body["references"]
            assert body["references"]["dropped"] == [
                {"target_type": "task", "target_id": str(fake_task_id), "reason": "target_not_found"}
            ], body["references"]
        finally:
            await client.aclose()
            app.dependency_overrides.clear()

        async with Session() as s:
            rows = (await s.execute(
                select(Reference).where(Reference.target_id == fake_task_id)
            )).scalars().all()
            assert rows == [], "존재하지 않는 target을 가리키는 행이 저장되면 안 된다"
    finally:
        await engine.dispose()


# ─── 크로스-org 실재 UUID — 존재는 하지만 이 org 소속이 아닌 대상 ──────────────


async def test_chat_mention_to_real_cross_org_target_is_dropped():
    """org B에 실재하는 task를 org A의 채팅 메시지가 가리키면 — resolver가 org로
    스코프하므로 "없음"으로 걸려야 한다(존재+org 소속을 한 번에 검증)."""
    from app.main import app
    from app.models.reference import Reference
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_a = await _make_org(s, name="OrgA")
            project_a = await _make_project(s, org_a.id)
            member_id, user_id = await _make_human_member(s, org_a.id, project_a.id)
            conv_id = await _make_conversation(s, org_a.id, project_a.id, [member_id], member_id)

            org_b = await _make_org(s, name="OrgB")
            project_b = await _make_project(s, org_b.id)
            story_b = await _make_story(s, org_b.id, project_b.id)
            task_b = await _make_task(s, org_b.id, story_b.id)

        await _setup_app_human(app, Session, user_id, org_a.id)
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/conversations/{conv_id}/messages",
                json={"content": f"[타 org 작업](entity:task:{task_b.id})"},
            )
            assert resp.status_code == 201, resp.text
            body = resp.json()
            assert body["references"]["stored"] == 0, body["references"]
            assert body["references"]["dropped"] == [
                {"target_type": "task", "target_id": str(task_b.id), "reason": "target_not_found"}
            ], body["references"]
        finally:
            await client.aclose()
            app.dependency_overrides.clear()

        async with Session() as s:
            rows = (await s.execute(
                select(Reference).where(Reference.target_id == task_b.id)
            )).scalars().all()
            assert rows == [], "크로스-org 실재 target을 가리키는 행이 저장되면 안 된다"
    finally:
        await engine.dispose()


# ─── 양성대조 — 실재+같은 org 대상은 정상 저장 ──────────────────────────────────


async def test_chat_mention_to_real_same_org_target_is_stored():
    from app.main import app
    from app.models.reference import Reference
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            member_id, user_id = await _make_human_member(s, org.id, project.id)
            conv_id = await _make_conversation(s, org.id, project.id, [member_id], member_id)
            story = await _make_story(s, org.id, project.id)
            task = await _make_task(s, org.id, story.id)

        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/conversations/{conv_id}/messages",
                json={"content": f"[진짜 작업](entity:task:{task.id})"},
            )
            assert resp.status_code == 201, resp.text
            body = resp.json()
            assert body["references"]["stored"] == 1, body["references"]
            assert body["references"]["dropped"] == [], body["references"]
        finally:
            await client.aclose()
            app.dependency_overrides.clear()

        async with Session() as s:
            rows = (await s.execute(
                select(Reference).where(Reference.target_id == task.id)
            )).scalars().all()
            assert len(rows) == 1
            assert rows[0].target_type == "task"
    finally:
        await engine.dispose()


# ─── doc write-path(reconcile_doc_mentions)도 같은 게이트를 탄다 ────────────────


async def test_doc_reconcile_to_nonexistent_target_is_dropped():
    from app.services.mention_parser import reconcile_doc_mentions
    from app.models.reference import Reference
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            member_id, user_id = await _make_human_member(s, org.id, project.id)

            source_doc_id = uuid.uuid4()
            fake_target_doc_id = uuid.uuid4()
            html = f'<span data-type="wikiLink" data-doc-id="{fake_target_doc_id}">X</span>'

            # reconcile_doc_mentions는 -> None(반환값 없음) — 존재하지 않는 대상이 «저장
            # 안 됐는지»는 DB를 직접 대조해 확認한다(로그로 dropped 발화는 이미 확認됨,
            # 위 캡처된 WARNING 참조).
            await reconcile_doc_mentions(
                s, org_id=org.id, doc_id=source_doc_id, html_content=html, created_by=member_id,
            )
            await s.commit()

            rows = (await s.execute(
                select(Reference).where(Reference.target_id == fake_target_doc_id)
            )).scalars().all()
            assert rows == []
    finally:
        await engine.dispose()
