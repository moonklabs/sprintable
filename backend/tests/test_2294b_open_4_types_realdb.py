"""story #2294 B단계(E-CONNECT, 2026-07-29) — registry에 sprint·artifact(VisualArtifact)·
hypothesis·evidence 4종을 더 연다. doc·story·epic·task가 세운 절차(resolver + project_id
resolver + TARGET 게이트)를 그대로 반복 — `goal`은 epic과 같은 테이블이라 열지 않는다.

PO 요구: "종류마다 게이트가 실제로 서는지는 «각각» 보이는 것" — 4종을 한 루프로 뭉개지 않고
타입별로 독립 twin-comparison(접근 있음 vs 없음)을 각각 둔다.
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


# ─── Seeding helpers (test_2266/test_2283/test_2294와 동형) ──────────────────


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


async def _make_sprint(session, org_id, project_id, title="Sprint"):
    from app.models.pm import Sprint
    sprint = Sprint(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title)
    session.add(sprint)
    await session.commit()
    return sprint


async def _make_artifact(session, org_id, project_id, title="Artifact"):
    from app.models.visual_artifact import VisualArtifact
    artifact = VisualArtifact(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title)
    session.add(artifact)
    await session.commit()
    return artifact


async def _make_hypothesis(session, org_id, project_id, owner_member_id, statement="H"):
    from app.models.hypothesis import Hypothesis
    hyp = Hypothesis(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, owner_member_id=owner_member_id,
        statement=statement, metric_definition={}, measure_after=datetime.now(timezone.utc),
    )
    session.add(hyp)
    await session.commit()
    return hyp


async def _make_evidence(session, org_id, work_item_id, work_item_type, created_by, ev_type="url"):
    from app.models.evidence import Evidence
    ev = Evidence(
        id=uuid.uuid4(), org_id=org_id, work_item_id=work_item_id, work_item_type=work_item_type,
        type=ev_type, ref="https://example.com", created_by=created_by,
    )
    session.add(ev)
    await session.commit()
    return ev


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


async def _make_message(session, conv_id, sender_id, content="hi"):
    from app.models.conversation import ConversationMessage
    msg = ConversationMessage(
        id=uuid.uuid4(), conversation_id=conv_id, sender_id=sender_id,
        content=content, created_at=datetime.now(timezone.utc),
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


# ─── registry 등록 + twin-system 동일성 ────────────────────────────────────────


def test_all_four_registered_in_entity_resolvers():
    from app.services.reference_registry import ENTITY_RESOLVERS
    for t in ("sprint", "artifact", "hypothesis", "evidence"):
        assert t in ENTITY_RESOLVERS, t
    assert "goal" not in ENTITY_RESOLVERS  # epic과 동일 테이블이라 안 연다


def test_all_four_registered_in_project_id_resolvers_and_keys_match():
    from app.services.reference_registry import ENTITY_RESOLVERS, PROJECT_ID_RESOLVERS
    for t in ("sprint", "artifact", "hypothesis", "evidence"):
        assert t in PROJECT_ID_RESOLVERS, t
    assert set(ENTITY_RESOLVERS) == set(PROJECT_ID_RESOLVERS)


# ─── ㉠존재판정 resolver 단위 ───────────────────────────────────────────────────


@pytest.mark.anyio
async def test_resolve_sprints_finds_existing_and_ignores_missing():
    from app.services.reference_registry import ENTITY_RESOLVERS
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            sprint = await _make_sprint(s, org.id, project.id)
            found = await ENTITY_RESOLVERS["sprint"](s, org.id, [sprint.id, uuid.uuid4()])
            assert found == {sprint.id}
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_resolve_artifacts_excludes_soft_deleted():
    from app.services.reference_registry import ENTITY_RESOLVERS
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            artifact = await _make_artifact(s, org.id, project.id)
            found_before = await ENTITY_RESOLVERS["artifact"](s, org.id, [artifact.id])
            assert found_before == {artifact.id}

            artifact.deleted_at = datetime.now(timezone.utc)
            await s.commit()
            found_after = await ENTITY_RESOLVERS["artifact"](s, org.id, [artifact.id])
            assert found_after == set()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_resolve_hypotheses_archived_still_exists():
    """archived_at은 삭제 마커가 아니라 라이프사이클 상태 — 아카이브해도 존재판정은 True."""
    from app.services.reference_registry import ENTITY_RESOLVERS
    from app.models.hypothesis import Hypothesis
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            member_id, _ = await _make_human_member(s, org.id, project.id)
            hyp = await _make_hypothesis(s, org.id, project.id, member_id)

            found_before = await ENTITY_RESOLVERS["hypothesis"](s, org.id, [hyp.id])
            assert found_before == {hyp.id}

            hyp.archived_at = datetime.now(timezone.utc)
            await s.commit()
            found_after = await ENTITY_RESOLVERS["hypothesis"](s, org.id, [hyp.id])
            assert found_after == {hyp.id}  # 여전히 존재
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_resolve_evidence_finds_existing():
    from app.services.reference_registry import ENTITY_RESOLVERS
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            member_id, _ = await _make_human_member(s, org.id, project.id)
            story = await _make_story(s, org.id, project.id)
            ev = await _make_evidence(s, org.id, story.id, "story", member_id)
            found = await ENTITY_RESOLVERS["evidence"](s, org.id, [ev.id, uuid.uuid4()])
            assert found == {ev.id}
    finally:
        await engine.dispose()


# ─── project_id resolver 단위(evidence는 폴리모픽 분기 둘 다) ─────────────────


@pytest.mark.anyio
async def test_project_id_of_sprint():
    from app.services.reference_registry import PROJECT_ID_RESOLVERS
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            sprint = await _make_sprint(s, org.id, project.id)
            resolved = await PROJECT_ID_RESOLVERS["sprint"](s, org.id, sprint.id)
            assert resolved == project.id
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_project_id_of_artifact():
    from app.services.reference_registry import PROJECT_ID_RESOLVERS
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            artifact = await _make_artifact(s, org.id, project.id)
            resolved = await PROJECT_ID_RESOLVERS["artifact"](s, org.id, artifact.id)
            assert resolved == project.id
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_project_id_of_hypothesis():
    from app.services.reference_registry import PROJECT_ID_RESOLVERS
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            member_id, _ = await _make_human_member(s, org.id, project.id)
            hyp = await _make_hypothesis(s, org.id, project.id, member_id)
            resolved = await PROJECT_ID_RESOLVERS["hypothesis"](s, org.id, hyp.id)
            assert resolved == project.id
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_project_id_of_evidence_via_story_work_item():
    from app.services.reference_registry import PROJECT_ID_RESOLVERS
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            member_id, _ = await _make_human_member(s, org.id, project.id)
            story = await _make_story(s, org.id, project.id)
            ev = await _make_evidence(s, org.id, story.id, "story", member_id)
            resolved = await PROJECT_ID_RESOLVERS["evidence"](s, org.id, ev.id)
            assert resolved == project.id
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_project_id_of_evidence_via_task_work_item():
    """evidence의 work_item_type="task"인 경우 — task→story join으로 project_id 해소."""
    from app.services.reference_registry import PROJECT_ID_RESOLVERS
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            member_id, _ = await _make_human_member(s, org.id, project.id)
            story = await _make_story(s, org.id, project.id)
            task = await _make_task(s, org.id, story.id)
            ev = await _make_evidence(s, org.id, task.id, "task", member_id)
            resolved = await PROJECT_ID_RESOLVERS["evidence"](s, org.id, ev.id)
            assert resolved == project.id
    finally:
        await engine.dispose()


# ─── ㉡TARGET 게이트 — #2283 endpoint로 타입별 독립 twin comparison ────────────


async def _twin_comparison_for_type(target_type, make_target_coro):
    """공용 뼈대 — source(chat_message)는 항상 접근 가능하게 하고, target 접근 유무만
    가른다. 각 타입은 자기 seed 함수(make_target_coro)로 target을 만든다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            chat_project = await _make_project(s, org.id, "Chat Project")
            target_project_ok = await _make_project(s, org.id, "Target Project(access)")
            target_project_bad = await _make_project(s, org.id, "Target Project(no access)")

            member_id, user_id = await _make_human_member(s, org.id, chat_project.id)
            # user도 target_project_ok에 접근권을 갖게 한다(twin의 "있음" 쪽) — 같은 member_id로
            # 두 번째 project에 grant만 추가(별도 human을 또 만들 필요 없음, member_id==org_member.id).
            from sqlalchemy import select
            from app.models.project import OrgMember
            from app.models.project_access import ProjectAccess
            om = (await s.execute(select(OrgMember).where(OrgMember.id == member_id))).scalar_one()
            s.add(ProjectAccess(project_id=target_project_ok.id, org_member_id=om.id, member_id=member_id, role="member"))
            await s.commit()

            conv_id = await _make_conversation(s, org.id, chat_project.id, [member_id], member_id)
            msg = await _make_message(s, conv_id, member_id)

            target_ok = await make_target_coro(s, org.id, target_project_ok.id, member_id)
            target_bad = await make_target_coro(s, org.id, target_project_bad.id, member_id)

        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            resp_ok = await client.post("/api/v2/references", json={
                "source_type": "chat_message", "source_id": str(msg.id),
                "target_type": target_type, "target_id": str(target_ok),
            })
            resp_bad = await client.post("/api/v2/references", json={
                "source_type": "chat_message", "source_id": str(msg.id),
                "target_type": target_type, "target_id": str(target_bad),
            })
            return resp_ok, resp_bad
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_create_reference_sprint_target_gate_twin_comparison():
    async def make(s, org_id, project_id, member_id):
        sprint = await _make_sprint(s, org_id, project_id)
        return sprint.id

    resp_ok, resp_bad = await _twin_comparison_for_type("sprint", make)
    assert resp_ok.status_code == 201, resp_ok.text
    assert resp_bad.status_code == 404, resp_bad.text


@pytest.mark.anyio
async def test_create_reference_artifact_target_gate_twin_comparison():
    async def make(s, org_id, project_id, member_id):
        artifact = await _make_artifact(s, org_id, project_id)
        return artifact.id

    resp_ok, resp_bad = await _twin_comparison_for_type("artifact", make)
    assert resp_ok.status_code == 201, resp_ok.text
    assert resp_bad.status_code == 404, resp_bad.text


@pytest.mark.anyio
async def test_create_reference_hypothesis_target_gate_twin_comparison():
    async def make(s, org_id, project_id, member_id):
        hyp = await _make_hypothesis(s, org_id, project_id, member_id)
        return hyp.id

    resp_ok, resp_bad = await _twin_comparison_for_type("hypothesis", make)
    assert resp_ok.status_code == 201, resp_ok.text
    assert resp_bad.status_code == 404, resp_bad.text


@pytest.mark.anyio
async def test_create_reference_evidence_target_gate_twin_comparison():
    async def make(s, org_id, project_id, member_id):
        story = await _make_story(s, org_id, project_id)
        ev = await _make_evidence(s, org_id, story.id, "story", member_id)
        return ev.id

    resp_ok, resp_bad = await _twin_comparison_for_type("evidence", make)
    assert resp_ok.status_code == 201, resp_ok.text
    assert resp_bad.status_code == 404, resp_bad.text
