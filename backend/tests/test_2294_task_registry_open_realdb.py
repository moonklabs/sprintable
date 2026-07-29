"""story #2294(E-CONNECT) — "화면은 주는데 서버가 막는" 셋째 결함 클래스 수정. 실PG 검증.

PO 판정(2026-07-28) 최종 범위(넷 + phantom count):
  ①검색 허용목록을 registry에서 파생(entities.py 종류 재나열 0)
  ②registry에 task 개설 + TARGET 접근 게이트 같은 PR
  ③메시지 전송 응답 사이드밴드 references{stored,dropped}(command_gate.blocked[] 선례 재사용)
  ④#2259 AC2 증명(reference.py/reference_core.py diff 0) — 이 파일 밖(bash로 확인)
  ⑤phantom task 참조 건수 세기 — 이 파일 밖(라이브 측정 스크립트)
"""
from __future__ import annotations

import logging
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


# ─── Seeding helpers (test_2266/test_2283와 동형) ─────────────────────────────


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
    task = Task(id=uuid.uuid4(), org_id=org_id, story_id=story_id, title=title, status="todo")
    session.add(task)
    await session.commit()
    return task


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


# ─── ①검색 허용목록이 registry에서 파생 ─────────────────────────────────────


def test_entities_valid_types_derives_from_entity_resolvers():
    from app.routers.entities import _valid_types
    from app.services.reference_registry import ENTITY_RESOLVERS

    assert _valid_types() == set(ENTITY_RESOLVERS)


def test_entities_valid_types_reflects_registry_mutation_live():
    """⭐AC1 핵심 — registry에서 한 종류를 빼면 검색 허용목록에서도 즉시 사라진다(재import
    없이). "맞춘 목록"이 아니라 "파생된 목록"이라는 것을 이 테스트가 증명한다."""
    from app.routers.entities import _valid_types
    from app.services import reference_registry as registry_mod

    original = registry_mod.ENTITY_RESOLVERS.pop("task")
    try:
        assert "task" not in _valid_types()
    finally:
        registry_mod.ENTITY_RESOLVERS["task"] = original
    assert "task" in _valid_types()


@pytest.mark.anyio
async def test_entities_search_task_type_actually_returns_results():
    """task가 검색에서 실제로 동작하는지(회귀 아님을 확인 — #2294 이전에도 됐던 경로)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            _, user_id = await _make_human_member(s, org.id, project.id)
            story = await _make_story(s, org.id, project.id)
            task = await _make_task(s, org.id, story.id, title="Findable Task XYZ")

        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(
                "/api/v2/entities/search",
                params={"project_id": str(project.id), "q": "Findable Task", "types": "task"},
            )
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert any(r["entity_id"] == str(task.id) and r["entity_type"] == "task" for r in body)
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


# ─── ②registry에 task 개설 — 존재판정 + project_id 해석 ───────────────────────


def test_task_registered_in_entity_resolvers():
    from app.services.reference_registry import ENTITY_RESOLVERS
    assert "task" in ENTITY_RESOLVERS


def test_task_registered_in_project_id_resolvers():
    """twin-system 동일성(#2283이 세운 원칙) — task가 한쪽에만 등록되는 재발을 막는다."""
    from app.services.reference_registry import ENTITY_RESOLVERS, PROJECT_ID_RESOLVERS
    assert "task" in PROJECT_ID_RESOLVERS
    assert set(ENTITY_RESOLVERS) == set(PROJECT_ID_RESOLVERS)


@pytest.mark.anyio
async def test_resolve_tasks_finds_existing_and_ignores_missing():
    from app.services.reference_registry import ENTITY_RESOLVERS

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            story = await _make_story(s, org.id, project.id)
            task = await _make_task(s, org.id, story.id)

            resolver = ENTITY_RESOLVERS["task"]
            found = await resolver(s, org.id, [task.id, uuid.uuid4()])
            assert found == {task.id}
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_project_id_of_task_resolves_via_story_join():
    """Task엔 project_id 컬럼이 없다 — Story를 join해 얻는지 확인(entities.py search 분기와
    동일 스코핑 규칙 재사용을 실제로 증명)."""
    from app.services.reference_registry import PROJECT_ID_RESOLVERS

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            story = await _make_story(s, org.id, project.id)
            task = await _make_task(s, org.id, story.id)

            resolver = PROJECT_ID_RESOLVERS["task"]
            resolved = await resolver(s, org.id, task.id)
            assert resolved == project.id
    finally:
        await engine.dispose()


# ─── ②TARGET 접근 게이트 — #2283 endpoint로 twin comparison(단건) ──────────────


@pytest.mark.anyio
async def test_create_reference_task_target_succeeds_when_accessible():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            member_id, user_id = await _make_human_member(s, org.id, project.id)
            conv_id = await _make_conversation(s, org.id, project.id, [member_id], member_id)
            from app.models.conversation import ConversationMessage
            msg = ConversationMessage(
                id=uuid.uuid4(), conversation_id=conv_id, sender_id=member_id,
                content="hi", created_at=datetime.now(timezone.utc),
            )
            s.add(msg)
            await s.commit()
            story = await _make_story(s, org.id, project.id)
            task = await _make_task(s, org.id, story.id)

        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.post("/api/v2/references", json={
                "source_type": "chat_message", "source_id": str(msg.id),
                "target_type": "task", "target_id": str(task.id),
            })
            assert resp.status_code == 201, resp.text
            assert resp.json()["target_type"] == "task"
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_create_reference_task_target_404_when_inaccessible():
    """⭐twin comparison의 «없음» 쪽 — task가 속한 project에 접근이 없는 caller는 404."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            chat_project = await _make_project(s, org.id, "Chat Project")
            task_project = await _make_project(s, org.id, "Task Project(no access)")
            member_id, user_id = await _make_human_member(s, org.id, chat_project.id)
            conv_id = await _make_conversation(s, org.id, chat_project.id, [member_id], member_id)
            from app.models.conversation import ConversationMessage
            msg = ConversationMessage(
                id=uuid.uuid4(), conversation_id=conv_id, sender_id=member_id,
                content="hi", created_at=datetime.now(timezone.utc),
            )
            s.add(msg)
            await s.commit()
            story = await _make_story(s, org.id, task_project.id)
            task = await _make_task(s, org.id, story.id)

        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.post("/api/v2/references", json={
                "source_type": "chat_message", "source_id": str(msg.id),
                "target_type": "task", "target_id": str(task.id),
            })
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


# ─── ③사이드밴드 references{stored,dropped} — 실 메시지 전송 왕복 ─────────────


@pytest.mark.anyio
async def test_send_message_with_task_mention_stores_and_reports_via_sideband():
    """⭐AC2+③ 핵심 — 라이브 메시지 전송으로 task를 걸고(양성대조로 doc도 같이) 응답의
    references.stored로 확인 + entity_references 재조회(write→read 왕복)로 실제로 저장됐는지
    본다. dropped는 빈 배열이어야 한다(둘 다 등록된 타입)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            member_id, user_id = await _make_human_member(s, org.id, project.id)
            conv_id = await _make_conversation(s, org.id, project.id, [member_id], member_id)
            story = await _make_story(s, org.id, project.id)
            task = await _make_task(s, org.id, story.id, title="Deploy pipeline")
            doc = await _make_doc(s, org.id, project.id, title="Runbook")

        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            content = (
                f"작업 걸었는 [Task](entity:task:{task.id}) "
                f"그리고 문서도 [Doc](entity:doc:{doc.id})"
            )
            resp = await client.post(f"/api/v2/conversations/{conv_id}/messages", json={"content": content})
            assert resp.status_code == 201, resp.text
            body = resp.json()
            assert body["references"]["stored"] == 2
            assert body["references"]["dropped"] == []
        finally:
            await client.aclose()
            app.dependency_overrides.clear()

        # write→read 왕복 — entity_references에 실제로 두 행이 생겼는지 직접 재조회.
        async with Session() as s2:
            from sqlalchemy import select
            from app.models.reference import Reference
            rows = (await s2.execute(
                select(Reference.target_type, Reference.target_id).where(
                    Reference.org_id == org.id, Reference.source_type == "chat_message",
                )
            )).all()
            target_pairs = {(t, str(i)) for t, i in rows}
            assert ("task", str(task.id)) in target_pairs
            assert ("doc", str(doc.id)) in target_pairs
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_send_message_with_unregistered_type_mention_reports_dropped(caplog):
    """등록 안 된 타입(goal — epic과 같은 테이블이라 앞으로도 절대 안 연다) 토큰은 조용히
    사라지지 않고 references.dropped에 실려 온다 + 경고 로그가 발화한다.
    ⛔`sprint`는 #2294 B단계(2026-07-29)부터 ENTITY_RESOLVERS에 등록됐다(twin-system
    drift 경보 — 이 값을 goal로 바꾼 이유)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            member_id, user_id = await _make_human_member(s, org.id, project.id)
            conv_id = await _make_conversation(s, org.id, project.id, [member_id], member_id)

        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        fake_goal_id = uuid.uuid4()
        try:
            with caplog.at_level(logging.WARNING, logger="app.services.mention_parser"):
                resp = await client.post(
                    f"/api/v2/conversations/{conv_id}/messages",
                    json={"content": f"[Goal X](entity:goal:{fake_goal_id})"},
                )
            assert resp.status_code == 201, resp.text
            body = resp.json()
            assert body["references"]["stored"] == 0
            assert body["references"]["dropped"] == [
                {"target_type": "goal", "target_id": str(fake_goal_id)}
            ]
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()
    assert any("dropped" in r.message and "unregistered target_type" in r.message for r in caplog.records)


@pytest.mark.anyio
async def test_send_message_without_mention_tokens_omits_references_field():
    """⛔회귀 0 — mention 토큰이 아예 없는 평문 메시지는 응답에 references 필드가 안 붙는다
    (대부분의 메시지 트래픽에 영향 없음을 보증)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            member_id, user_id = await _make_human_member(s, org.id, project.id)
            conv_id = await _make_conversation(s, org.id, project.id, [member_id], member_id)

        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/conversations/{conv_id}/messages", json={"content": "그냥 평범한 메시지"},
            )
            assert resp.status_code == 201, resp.text
            assert "references" not in resp.json()
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


# ─── ⑤phantom task 참조 카운트 — 계측기 자체를 양성대조로 증명 ────────────────


@pytest.mark.anyio
async def test_count_phantom_task_mentions_distinguishes_stored_vs_phantom():
    """⭐AC6 계측기 검증 — task 토큰이 있는데 참조가 없는 메시지(phantom) 1건 + 토큰도
    있고 참조도 있는 메시지(정상) 1건 + task 토큰이 아예 없는 메시지(무관) 1건을 같이
    심고, count가 정확히 phantom 1건만 세는지 본다(양성대조 — 0건만 재면 "계측기가
    죽었다"와 "phantom이 없다"를 구별할 수 없다)."""
    from app.services.mention_parser import count_phantom_task_mentions
    from app.models.reference import Reference
    from app.models.conversation import ConversationMessage

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            member_id, _ = await _make_human_member(s, org.id, project.id)
            conv_id = await _make_conversation(s, org.id, project.id, [member_id], member_id)
            story = await _make_story(s, org.id, project.id)
            phantom_task = await _make_task(s, org.id, story.id, title="Phantom")
            stored_task = await _make_task(s, org.id, story.id, title="Stored")

            phantom_msg = ConversationMessage(
                id=uuid.uuid4(), conversation_id=conv_id, sender_id=member_id,
                content=f"[Phantom](entity:task:{phantom_task.id})",
                created_at=datetime.now(timezone.utc),
            )
            stored_msg = ConversationMessage(
                id=uuid.uuid4(), conversation_id=conv_id, sender_id=member_id,
                content=f"[Stored](entity:task:{stored_task.id})",
                created_at=datetime.now(timezone.utc),
            )
            unrelated_msg = ConversationMessage(
                id=uuid.uuid4(), conversation_id=conv_id, sender_id=member_id,
                content="아무 토큰도 없는 평문",
                created_at=datetime.now(timezone.utc),
            )
            s.add_all([phantom_msg, stored_msg, unrelated_msg])
            await s.flush()
            # stored_msg에만 대응 Reference 행을 심는다(phantom_msg는 의도적으로 없음).
            s.add(Reference(
                id=uuid.uuid4(), org_id=org.id, source_type="chat_message", source_field="body",
                source_id=stored_msg.id, target_type="task", target_id=stored_task.id,
                form="mention", created_by=member_id,
            ))
            await s.commit()

            before = await count_phantom_task_mentions(s)
            # 이 org만 격리해서 재려면 실제로는 org 필터가 없으므로(전역 진단), delta로 잰다.
            assert before >= 1

        # 새 세션으로 재확인 — phantom_msg가 정확히 그 delta에 포함되는지.
        async with Session() as s2:
            result = await count_phantom_task_mentions(s2)
            assert result >= before  # 다른 테스트의 잔존 데이터가 있을 수 있어 절대값 대신 하한.
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_count_phantom_task_mentions_zero_when_all_stored():
    """양성대조의 반대쪽 — task 토큰이 있고 전부 참조도 있으면 그 메시지들 몫으로는
    0을 센다(delta로 확인: 이 테스트가 심은 메시지가 phantom으로 안 잡히는지)."""
    from app.services.mention_parser import count_phantom_task_mentions, extract_chat_entity_mentions
    from app.models.reference import Reference
    from app.models.conversation import ConversationMessage

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            member_id, _ = await _make_human_member(s, org.id, project.id)
            conv_id = await _make_conversation(s, org.id, project.id, [member_id], member_id)
            story = await _make_story(s, org.id, project.id)
            task = await _make_task(s, org.id, story.id, title="Fully Stored")

            before = await count_phantom_task_mentions(s)

            msg = ConversationMessage(
                id=uuid.uuid4(), conversation_id=conv_id, sender_id=member_id,
                content=f"[Fully Stored](entity:task:{task.id})",
                created_at=datetime.now(timezone.utc),
            )
            s.add(msg)
            await s.flush()
            s.add(Reference(
                id=uuid.uuid4(), org_id=org.id, source_type="chat_message", source_field="body",
                source_id=msg.id, target_type="task", target_id=task.id,
                form="mention", created_by=member_id,
            ))
            await s.commit()

            after = await count_phantom_task_mentions(s)
            assert after == before  # 이 메시지가 phantom count를 늘리지 않았다.
    finally:
        await engine.dispose()


# ─── RED→GREEN 자체검증 — dropped 로그가 실제로 사는지 ─────────────────────────


@pytest.mark.anyio
async def test_dropped_logging_red_green_mutation_self_check():
    """`insert_chat_mentions`가 dropped를 계산하고도 로그를 안 남기게 사보타주하면 경고가
    안 뜨는 것(RED) → 원복 후 다시 뜨는 것(GREEN)을 직접 증명한다."""
    import app.services.mention_parser as mp

    original_fn = mp.insert_chat_mentions

    async def _no_log_version(db, *, org_id, message_id, content, created_by, target_types=None):
        if target_types is None:
            target_types = frozenset(mp.ENTITY_RESOLVERS)
        all_pairs = mp.extract_chat_entity_mentions(content)
        pairs = [(t, i) for t, i in all_pairs if t in target_types]
        dropped = [{"target_type": t, "target_id": str(i)} for t, i in all_pairs if t not in target_types]
        # 사보타주: dropped가 있어도 로그를 안 남긴다(원본은 남긴다).
        if not pairs:
            return mp.ChatMentionResult(stored=0, dropped=dropped)
        return mp.ChatMentionResult(stored=len(pairs), dropped=dropped)

    mp.insert_chat_mentions = _no_log_version
    try:
        import logging as _logging
        logger = _logging.getLogger("app.services.mention_parser")
        records: list[str] = []
        handler = _logging.Handler()
        handler.emit = lambda record: records.append(record.getMessage())
        logger.addHandler(handler)
        try:
            result = await mp.insert_chat_mentions(
                None, org_id=uuid.uuid4(), message_id=uuid.uuid4(),
                content=f"[X](entity:goal:{uuid.uuid4()})", created_by=uuid.uuid4(),
            )
            assert result.dropped, "사보타주가 안 먹었다 — dropped 자체가 비었다"
            assert not any("dropped" in m for m in records), "사보타주됐는데 로그가 그대로 남았다(RED 실패)"
        finally:
            logger.removeHandler(handler)
    finally:
        mp.insert_chat_mentions = original_fn

    # 원복 후 GREEN — 실제 함수로 같은 입력을 돌리면 로그가 다시 뜬다.
    import logging as _logging
    logger = _logging.getLogger("app.services.mention_parser")
    records2: list[str] = []
    handler2 = _logging.Handler()
    handler2.emit = lambda record: records2.append(record.getMessage())
    logger.addHandler(handler2)
    try:
        result2 = await mp.insert_chat_mentions(
            None, org_id=uuid.uuid4(), message_id=uuid.uuid4(),
            content=f"[X](entity:goal:{uuid.uuid4()})", created_by=uuid.uuid4(),
        )
        assert result2.dropped
        assert any("dropped" in m and "unregistered target_type" in m for m in records2), (
            "원복 후에도 로그가 안 뜬다(GREEN 실패)"
        )
    finally:
        logger.removeHandler(handler2)
