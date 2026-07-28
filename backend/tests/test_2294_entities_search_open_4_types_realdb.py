"""story #2294 B단계 후속(E-CONNECT, 2026-07-29) — "받아들이는 것"(entities.py `_valid_types`,
registry에서 파생)과 "찾는 것"(`_SEARCH_HANDLERS`)이 갈리는 것을 오르테가가 라이브로 잡았다:
`types=sprint` 등이 400이 아니라 200/0건으로 «받아들여지기»는 했지만 실제 SELECT 분기가
없어 데이터가 있어도(양성대조: sprint 16개 실재) 조용히 0건을 냈다.

처방: `_SEARCH_HANDLERS`(entity_type→검색 handler SSOT dict) 신설 + registry에 있는데
handler가 없으면 500(조용히 0건 금지) + twin-key 테스트(#2283이 세운 그 자와 동형)로
"registry에 있는데 검색이 못 찾는 종류가 0"인 것을 고정.
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


async def _make_sprint(session, org_id, project_id, title="Findable Sprint"):
    from app.models.pm import Sprint
    sprint = Sprint(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title)
    session.add(sprint)
    await session.commit()
    return sprint


async def _make_artifact(session, org_id, project_id, title="Findable Artifact"):
    from app.models.visual_artifact import VisualArtifact
    artifact = VisualArtifact(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title)
    session.add(artifact)
    await session.commit()
    return artifact


async def _make_hypothesis(session, org_id, project_id, owner_member_id, statement="Findable Hypothesis"):
    from app.models.hypothesis import Hypothesis
    hyp = Hypothesis(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, owner_member_id=owner_member_id,
        statement=statement, metric_definition={}, measure_after=datetime.now(timezone.utc),
    )
    session.add(hyp)
    await session.commit()
    return hyp


async def _make_evidence(session, org_id, work_item_id, work_item_type, created_by, ref="https://findable.example"):
    from app.models.evidence import Evidence
    ev = Evidence(
        id=uuid.uuid4(), org_id=org_id, work_item_id=work_item_id, work_item_type=work_item_type,
        type="url", ref=ref, created_by=created_by,
    )
    session.add(ev)
    await session.commit()
    return ev


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


# ─── twin-key — 「받아들이는 것」과 「찾는 것」이 같은 집합인지 ─────────────────


def test_search_handlers_keys_match_entity_resolvers():
    """⭐#2283이 세운 twin-key 원칙과 동형 — registry(ENTITY_RESOLVERS)에 있는데
    _SEARCH_HANDLERS에 없는 종류가 «0»인 것을 고정한다. 한쪽만 열리면 이 테스트가 RED."""
    from app.routers.entities import _SEARCH_HANDLERS
    from app.services.reference_registry import ENTITY_RESOLVERS

    assert set(_SEARCH_HANDLERS) == set(ENTITY_RESOLVERS)


@pytest.mark.anyio
async def test_search_rejects_registered_type_without_handler_instead_of_silent_zero():
    """⛔registry엔 있는데 handler가 없는 상태를 인위로 만들어(sabotage) 500이 나는지 —
    "조용히 0건"으로 다시 새지 않는다는 것을 직접 증명한다(RED→GREEN 자체검증과 동형)."""
    import app.routers.entities as entities_module
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            _, user_id = await _make_human_member(s, org.id, project.id)

        original_handlers = dict(entities_module._SEARCH_HANDLERS)
        del entities_module._SEARCH_HANDLERS["sprint"]  # registry엔 여전히 있음(sabotage 지점)
        try:
            await _setup_app_human(app, Session, user_id, org.id)
            client = _client_for(app)
            try:
                resp = await client.get(
                    "/api/v2/entities/search",
                    params={"project_id": str(project.id), "types": "sprint"},
                )
                assert resp.status_code == 500, (
                    f"handler 없는 registry 타입이 조용히 통과했다(200이면 사고 재발) — {resp.status_code}: {resp.text}"
                )
            finally:
                await client.aclose()
                app.dependency_overrides.clear()
        finally:
            entities_module._SEARCH_HANDLERS.clear()
            entities_module._SEARCH_HANDLERS.update(original_handlers)

        # 원복 후 GREEN 재확認 — 같은 요청이 정상 200을 낸다.
        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(
                "/api/v2/entities/search",
                params={"project_id": str(project.id), "types": "sprint"},
            )
            assert resp.status_code == 200, resp.text
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


# ─── 양성대조 — 각 타입이 실제로 검색되는지(오르테가가 겪은 정확한 그 시나리오) ──


@pytest.mark.anyio
async def test_search_finds_sprint_with_data_present():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            _, user_id = await _make_human_member(s, org.id, project.id)
            sprint = await _make_sprint(s, org.id, project.id)

        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(
                "/api/v2/entities/search",
                params={"project_id": str(project.id), "types": "sprint", "q": "Findable"},
            )
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert any(r["entity_id"] == str(sprint.id) and r["entity_type"] == "sprint" for r in body)
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_search_finds_artifact_with_data_present():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            _, user_id = await _make_human_member(s, org.id, project.id)
            artifact = await _make_artifact(s, org.id, project.id)

        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(
                "/api/v2/entities/search",
                params={"project_id": str(project.id), "types": "artifact", "q": "Findable"},
            )
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert any(r["entity_id"] == str(artifact.id) and r["entity_type"] == "artifact" for r in body)
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_search_finds_hypothesis_with_data_present():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            member_id, user_id = await _make_human_member(s, org.id, project.id)
            hyp = await _make_hypothesis(s, org.id, project.id, member_id)

        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(
                "/api/v2/entities/search",
                params={"project_id": str(project.id), "types": "hypothesis", "q": "Findable"},
            )
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert any(r["entity_id"] == str(hyp.id) and r["entity_type"] == "hypothesis" for r in body)
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_search_finds_evidence_via_story_work_item_with_data_present():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            member_id, user_id = await _make_human_member(s, org.id, project.id)
            story = await _make_story(s, org.id, project.id)
            ev = await _make_evidence(s, org.id, story.id, "story", member_id)

        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(
                "/api/v2/entities/search",
                params={"project_id": str(project.id), "types": "evidence", "q": "findable"},
            )
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert any(r["entity_id"] == str(ev.id) and r["entity_type"] == "evidence" for r in body)
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_search_finds_evidence_via_task_work_item_with_data_present():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            from app.models.pm import Task
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            member_id, user_id = await _make_human_member(s, org.id, project.id)
            story = await _make_story(s, org.id, project.id)
            task = Task(id=uuid.uuid4(), org_id=org.id, story_id=story.id, title="T", status="todo")
            s.add(task)
            await s.commit()
            ev = await _make_evidence(s, org.id, task.id, "task", member_id)

        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(
                "/api/v2/entities/search",
                params={"project_id": str(project.id), "types": "evidence", "q": "findable"},
            )
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert any(r["entity_id"] == str(ev.id) and r["entity_type"] == "evidence" for r in body)
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_search_all_eight_types_in_one_request_when_no_types_filter():
    """⭐오르테가가 예고한 다음 시험 — 여덟 종류를 한 요청(types 생략=전체)에 박아 재는 것과
    같은 모양. 각 타입 1건씩 심고 응답에 여덟 다 있는지 본다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            member_id, user_id = await _make_human_member(s, org.id, project.id)
            story = await _make_story(s, org.id, project.id, title="ZZZ Story")
            sprint = await _make_sprint(s, org.id, project.id, title="ZZZ Sprint")
            artifact = await _make_artifact(s, org.id, project.id, title="ZZZ Artifact")
            hyp = await _make_hypothesis(s, org.id, project.id, member_id, statement="ZZZ Hypothesis")
            ev = await _make_evidence(s, org.id, story.id, "story", member_id, ref="https://zzz.example")

            from app.models.doc import Doc
            doc = Doc(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="ZZZ Doc", slug=f"zzz-{uuid.uuid4().hex[:8]}")
            s.add(doc)
            from app.models.pm import Goal, Task
            epic = Goal(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="ZZZ Epic", status="active")
            s.add(epic)
            task = Task(id=uuid.uuid4(), org_id=org.id, story_id=story.id, title="ZZZ Task", status="todo")
            s.add(task)
            await s.commit()

        await _setup_app_human(app, Session, user_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get(
                "/api/v2/entities/search",
                params={"project_id": str(project.id), "q": "ZZZ"},
            )
            assert resp.status_code == 200, resp.text
            body = resp.json()
            found_types = {r["entity_type"] for r in body}
            assert found_types == {"story", "doc", "epic", "task", "sprint", "artifact", "hypothesis", "evidence"}, (
                f"여덟 종류가 다 안 나왔다: {found_types}"
            )
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()
