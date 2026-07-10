"""E-VERIFY V0-S2(story 3fbd048d): has_evidence 신호 + gate_approval 자동 편입 — 실 Postgres 검증."""
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
    from app.models.member import Member
    from app.models.organization import Organization
    from app.models.project import Project
    from app.models.project_access import ProjectAccess
    from app.models.pm import Story, Task

    org = Organization(id=uuid.uuid4(), name="V0-S2 Org", slug=f"v0s2-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()

    project = Project(id=uuid.uuid4(), org_id=org.id, name="V0-S2 Project")
    agent = Member(id=uuid.uuid4(), org_id=org.id, type="agent", name="Evidence Agent", is_active=True)
    session.add_all([project, agent])
    await session.commit()

    grant = ProjectAccess(
        id=uuid.uuid4(), project_id=project.id, member_id=agent.id, permission="granted", role="member",
    )
    session.add(grant)

    story = Story(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="V0-S2 Story", status="in-progress")
    session.add(story)
    await session.commit()

    task = Task(id=uuid.uuid4(), org_id=org.id, story_id=story.id, title="V0-S2 Task", status="in-progress")
    session.add(task)
    await session.commit()

    return org.id, project.id, agent.id, story.id, task.id


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
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
async def test_story_has_evidence_none_by_default_true_after_attach():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id, agent_id, story_id, _task_id = await _seed(s)

        await _setup_app(app, Session, agent_id, org_id)
        client = _client_for(app)
        try:
            before = await client.get(f"/api/v2/stories/{story_id}")
            assert before.status_code == 200, before.text
            body_before = before.json()
            assert body_before["has_evidence"] is None
            assert "has_evidence" in body_before  # 필드 자체는 존재(None) — false 아님

            create_resp = await client.post("/api/v2/evidence", json={
                "work_item_id": str(story_id), "work_item_type": "story",
                "type": "pr", "ref": "https://github.com/org/repo/pull/2",
            })
            assert create_resp.status_code == 201, create_resp.text

            after = await client.get(f"/api/v2/stories/{story_id}")
            assert after.json()["has_evidence"] is True

            list_resp = await client.get("/api/v2/stories", params={"project_id": str(project_id)})
            assert list_resp.status_code == 200
            matching = [s for s in list_resp.json() if s["id"] == str(story_id)]
            assert len(matching) == 1
            assert matching[0]["has_evidence"] is True
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_task_has_evidence_none_by_default_true_after_attach():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id, agent_id, story_id, task_id = await _seed(s)

        await _setup_app(app, Session, agent_id, org_id)
        client = _client_for(app)
        try:
            before = await client.get(f"/api/v2/tasks/{task_id}")
            assert before.json()["has_evidence"] is None

            create_resp = await client.post("/api/v2/evidence", json={
                "work_item_id": str(task_id), "work_item_type": "task",
                "type": "deploy", "ref": "https://example.com/deploy/1",
            })
            assert create_resp.status_code == 201, create_resp.text

            after = await client.get(f"/api/v2/tasks/{task_id}")
            assert after.json()["has_evidence"] is True

            list_resp = await client.get("/api/v2/tasks", params={"story_id": str(story_id)})
            matching = [t for t in list_resp.json() if t["id"] == str(task_id)]
            assert matching[0]["has_evidence"] is True
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_gate_approval_auto_creates_evidence_and_flips_signal():
    """HITL gate 승인 → gate_approval evidence 자동 편입 → story.has_evidence=True."""
    from app.models.gate import Gate
    from app.services.gate_service import create_gate, transition_gate

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id, agent_id, story_id, _task_id = await _seed(s)
            approver_id = uuid.uuid4()
            role_id = uuid.uuid4()

            gate = await create_gate(
                s, org_id=org_id, work_item_id=story_id, work_item_type="story",
                gate_type="pr_review", member_id=agent_id, role_id=role_id,
            )
            await s.commit()
            gate_id = gate.id

            await transition_gate(s, org_id, gate_id, "approved", resolver_id=approver_id)
            await s.commit()

        async with Session() as s:
            from sqlalchemy import select
            from app.models.evidence import Evidence

            rows = (await s.execute(
                select(Evidence).where(
                    Evidence.work_item_id == story_id, Evidence.work_item_type == "story",
                    Evidence.type == "gate_approval",
                )
            )).scalars().all()
            assert len(rows) == 1, "gate_approval evidence 자동 생성 안 됨"
            assert rows[0].ref == str(gate_id)
            assert rows[0].created_by == approver_id

        from app.main import app
        await _setup_app(app, Session, agent_id, org_id)
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/stories/{story_id}")
            assert resp.json()["has_evidence"] is True
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_gate_rejected_does_not_create_evidence():
    """회귀: reject 전이는 gate_approval evidence를 만들지 않는다."""
    from app.services.gate_service import create_gate, transition_gate

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id, agent_id, story_id, _task_id = await _seed(s)
            approver_id = uuid.uuid4()
            role_id = uuid.uuid4()

            gate = await create_gate(
                s, org_id=org_id, work_item_id=story_id, work_item_type="story",
                gate_type="pr_review", member_id=agent_id, role_id=role_id,
            )
            await s.commit()
            gate_id = gate.id

            await transition_gate(s, org_id, gate_id, "rejected", resolver_id=approver_id, note="no")
            await s.commit()

        async with Session() as s:
            from sqlalchemy import select
            from app.models.evidence import Evidence

            rows = (await s.execute(
                select(Evidence).where(Evidence.work_item_id == story_id, Evidence.type == "gate_approval")
            )).scalars().all()
            assert rows == []
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_gate_approval_for_non_story_task_work_item_type_is_noop():
    """블라인드 스코프 가드: work_item_type이 story/task가 아니면(예: doc) evidence 생성 안 함
    (Evidence CHECK 제약이 story/task만 허용 — 위반 시 500 방지)."""
    from app.services.evidence_service import create_gate_approval_evidence_if_applicable
    from app.models.gate import Gate

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id, agent_id, story_id, _task_id = await _seed(s)
            fake_gate = Gate(
                id=uuid.uuid4(), org_id=org_id, work_item_id=uuid.uuid4(), work_item_type="doc",
                gate_type="doc_approval", status="approved",
            )
            await create_gate_approval_evidence_if_applicable(s, fake_gate, "approved", uuid.uuid4())
            await s.commit()

            from sqlalchemy import select
            from app.models.evidence import Evidence
            rows = (await s.execute(
                select(Evidence).where(Evidence.work_item_id == fake_gate.work_item_id)
            )).scalars().all()
            assert rows == []
    finally:
        await engine.dispose()
