"""story #2314 — `GET /api/v2/evidence/{id}` 신설(형제 라우트 없던 갭). RED-먼저: 이 파일은
라우트가 아직 없는 시점에 작성됐다 — `git stash`로 evidence.py 변경을 되돌리면 아래 전부
404(라우트 자체 없음, FastAPI 기본)로 실패하는 것을 먼저 확認한 뒤에만 라우트를 구현한다
(같은 세션 커밋 메시지에 그 순서를 남긴다).

⭐AC2(존재 비노출): org 안·project 밖도 404로 통일한다 — #2322가 story 헬퍼(PR #2624)에서
막 세운 방향과 동형. evidence.py는 #2322의 4개 헬퍼 목록엔 없지만, 신규 라우트는 처음부터
그 방향을 따른다(403으로 새로 짓지 않는다)."""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
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


async def _seed(session):
    """org(project[grant된 agent]·other_project[무관agent]) + story(evidence 부착) +
    task(story 하위, evidence 부착) + 다른 org(교차조직 케이스)."""
    from app.models.evidence import Evidence
    from app.models.member import Member
    from app.models.organization import Organization
    from app.models.pm import Story, Task
    from app.models.project import Project
    from app.models.project_access import ProjectAccess

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    other_org = Organization(id=uuid.uuid4(), name="OtherOrg", slug=f"other-org-{uuid.uuid4().hex[:8]}")
    session.add_all([org, other_org])
    await session.commit()

    project = Project(id=uuid.uuid4(), org_id=org.id, name="Project")
    other_project = Project(id=uuid.uuid4(), org_id=org.id, name="Other Project")
    session.add_all([project, other_project])
    await session.commit()

    agent = Member(id=uuid.uuid4(), org_id=org.id, type="agent", name="Agent", is_active=True)
    stranger = Member(id=uuid.uuid4(), org_id=org.id, type="agent", name="Stranger", is_active=True)
    cross_org_agent = Member(id=uuid.uuid4(), org_id=other_org.id, type="agent", name="CrossOrgAgent", is_active=True)
    session.add_all([agent, stranger, cross_org_agent])
    await session.commit()

    session.add_all([
        ProjectAccess(id=uuid.uuid4(), project_id=project.id, member_id=agent.id, permission="granted", role="member"),
        ProjectAccess(id=uuid.uuid4(), project_id=other_project.id, member_id=stranger.id, permission="granted", role="member"),
    ])
    await session.commit()

    story = Story(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="Story", status="in-progress")
    session.add(story)
    await session.commit()

    task = Task(id=uuid.uuid4(), org_id=org.id, story_id=story.id, title="Task", status="in-progress")
    session.add(task)
    await session.commit()

    story_evidence = Evidence(
        id=uuid.uuid4(), org_id=org.id, work_item_id=story.id, work_item_type="story",
        type="url", ref="https://example.com/story-evidence", created_by=agent.id,
    )
    task_evidence = Evidence(
        id=uuid.uuid4(), org_id=org.id, work_item_id=task.id, work_item_type="task",
        type="pr", ref="https://example.com/task-evidence", created_by=agent.id,
    )
    session.add_all([story_evidence, task_evidence])
    await session.commit()

    return {
        "org_id": org.id, "other_org_id": other_org.id,
        "agent_id": agent.id, "stranger_id": stranger.id, "cross_org_agent_id": cross_org_agent.id,
        "story_id": story.id, "task_id": task.id,
        "story_evidence_id": story_evidence.id, "task_evidence_id": task_evidence.id,
    }


def _client_for(app):
    from httpx import ASGITransport, AsyncClient
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _setup_app(app, Session, member_id, org_id):
    from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
    from app.dependencies.database import get_db

    async def _db():
        async with Session() as s:
            yield s

    async def _auth():
        return AuthContext(
            user_id=str(member_id), email="agent@test",
            claims={"app_metadata": {"org_id": str(org_id), "api_key_id": "test-key"}},
        )

    async def _org():
        return org_id

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth
    app.dependency_overrides[get_verified_org_id] = _org


@pytest.mark.anyio
async def test_get_story_evidence_200_with_resolved_story_id():
    """양성대조 — story-type evidence: resolved_story_id == work_item_id 그 자체."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["agent_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/evidence/{seeded['story_evidence_id']}")
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["work_item_type"] == "story"
            assert body["ref"] == "https://example.com/story-evidence"
            assert body["resolved_story_id"] == str(seeded["story_id"])
            # AC5(MCP mention wiring) 전제조건 — reference_token이 실제로 실린다(제목이 없어
            # ref를 대신 쓴다). _resolve_mention_content(chat.py)가 이 필드를 그대로 읽는다.
            # 기대값은 실제 builder(build_reference_token)로 계산 — escape 규칙을 이 테스트에서
            # 재구현하지 않는다(쌍둥이-체계 함정 회피, 이 세션 내내 반복 걸린 그 패턴).
            from app.services.reference_token import build_reference_token
            expected_token = build_reference_token(
                "evidence", seeded["story_evidence_id"], "[url] https://example.com/story-evidence",
            )
            assert body["reference_token"] == expected_token
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_get_task_evidence_200_resolves_story_id_via_task():
    """양성대조 — task-type evidence: resolved_story_id는 task의 부모 story(2단 조인)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["agent_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/evidence/{seeded['task_evidence_id']}")
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["work_item_type"] == "task"
            assert body["work_item_id"] == str(seeded["task_id"])
            assert body["resolved_story_id"] == str(seeded["story_id"])
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_get_evidence_nonexistent_id_404():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["agent_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/evidence/{uuid.uuid4()}")
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_get_evidence_same_org_no_project_access_404_not_403():
    """AC2 핵심 — 같은 org·다른 project(무권한)는 404(403 아님, 존재 비노출 통일)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["stranger_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/evidence/{seeded['story_evidence_id']}")
            assert resp.status_code == 404, (
                f"story #2314 AC2: 같은org·다른project 무권한은 404여야 한다 — {resp.status_code}: {resp.text}"
            )
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_get_evidence_cross_org_404():
    """다른 org의 caller — org 필터가 최초 조회에서부터 걸러 404(누출 0)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["cross_org_agent_id"], seeded["other_org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/evidence/{seeded['story_evidence_id']}")
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_get_evidence_mutation_self_check_gate_actually_blocks():
    """뮤테이션 자가검증 — has_project_access를 항상-참으로 사보타주하면 stranger가 story
    evidence를 볼 수 있게 되는 것으로(누출 재현), 이 가드가 동어반복이 아님을 증명한다."""
    from app.main import app
    from app.services import project_auth as project_auth_module

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["stranger_id"], seeded["org_id"])
        client = _client_for(app)

        original_gate = project_auth_module.has_project_access

        async def _always_true(*args, **kwargs):
            return True

        import app.routers.evidence as evidence_module
        evidence_module.has_project_access = _always_true
        try:
            resp = await client.get(f"/api/v2/evidence/{seeded['story_evidence_id']}")
            assert resp.status_code == 200, (
                f"사보타주 중엔 누출이 재현돼야 한다(가드가 실제로 막고 있었다는 증거) — {resp.status_code}"
            )
        finally:
            evidence_module.has_project_access = original_gate
            await client.aclose()

        # 원복 후 GREEN 재확認 — 같은 caller가 다시 404.
        client2 = _client_for(app)
        try:
            resp2 = await client2.get(f"/api/v2/evidence/{seeded['story_evidence_id']}")
            assert resp2.status_code == 404, resp2.text
        finally:
            await client2.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
