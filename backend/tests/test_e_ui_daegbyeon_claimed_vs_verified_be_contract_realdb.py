"""E-UI-DAEGBYEON P0-04(doc claimed-vs-verified-spec-handoff §3): has_evidence(1 boolean) →
self_reported/human_verified 2신호 분리 BE 계약 — 실 Postgres 검증.

3상태 파생 실증: !self_reported(무표시, D-03 "증거 없는 Done은 승격 불가") →
self_reported & !human_verified(주장됨/claimed, agent 자가보고) →
human_verified(검증됨/verified, 휴먼 책임자 gate 승인+who/when 서명)."""
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
    from app.models.pm import Story, Task
    from app.models.project import Project
    from app.models.project_access import ProjectAccess

    org = Organization(id=uuid.uuid4(), name="CvV Org", slug=f"cvv-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()

    project = Project(id=uuid.uuid4(), org_id=org.id, name="CvV Project")
    agent = Member(id=uuid.uuid4(), org_id=org.id, type="agent", name="CvV Agent", is_active=True)
    session.add_all([project, agent])
    await session.commit()

    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project.id, member_id=agent.id, permission="granted", role="member",
    ))

    story = Story(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="CvV Story", status="in-progress")
    session.add(story)
    await session.commit()

    task = Task(id=uuid.uuid4(), org_id=org.id, story_id=story.id, title="CvV Task", status="in-progress")
    session.add(task)
    await session.commit()

    return {"org_id": org.id, "project_id": project.id, "agent_id": agent.id, "story_id": story.id, "task_id": task.id}


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
async def test_story_unmarked_state_no_evidence():
    """무표시(D-03): evidence 0건이면 self_reported/human_verified 둘 다 None(False 아님)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["agent_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/stories/{seeded['story_id']}")
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["self_reported"] is None
            assert body["human_verified"] is None
            assert body["human_verified_by"] is None
            assert body["human_verified_at"] is None
            assert body["has_evidence"] is None
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_story_claimed_state_self_reported_but_not_human_verified():
    """주장됨(claimed): agent가 evidence(pr) 첨부 → self_reported=True·human_verified은 여전히
    None(휴먼이 아직 승인 안 함). has_evidence(구 신호)도 하위호환으로 True."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        await _setup_app(app, Session, seeded["agent_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            create_resp = await client.post("/api/v2/evidence", json={
                "work_item_id": str(seeded["story_id"]), "work_item_type": "story",
                "type": "pr", "ref": "https://github.com/org/repo/pull/10",
            })
            assert create_resp.status_code == 201, create_resp.text

            resp = await client.get(f"/api/v2/stories/{seeded['story_id']}")
            body = resp.json()
            assert body["self_reported"] is True
            assert body["has_evidence"] is True
            assert body["human_verified"] is None
            assert body["human_verified_by"] is None
            assert body["human_verified_at"] is None
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_story_verified_state_after_gate_approval_with_who_and_when():
    """검증됨(verified): 휴먼 책임자 gate 승인 → human_verified=True + human_verified_by(who)
    = 승인자 member_id + human_verified_at(when) 설정. self_reported도 함께 True(같은 evidence
    테이블 — "같은 증거, 다른 주어" §1.5)."""
    from app.services.gate_service import create_gate, transition_gate

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
            approver_id = uuid.uuid4()
            role_id = uuid.uuid4()

            gate = await create_gate(
                s, org_id=seeded["org_id"], work_item_id=seeded["story_id"], work_item_type="story",
                gate_type="pr_review", member_id=seeded["agent_id"], role_id=role_id,
            )
            await s.commit()
            gate_id = gate.id

            await transition_gate(s, seeded["org_id"], gate_id, "approved", resolver_id=approver_id)
            await s.commit()

        from app.main import app
        await _setup_app(app, Session, seeded["agent_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/stories/{seeded['story_id']}")
            body = resp.json()
            assert body["human_verified"] is True
            assert body["human_verified_by"] == str(approver_id)
            assert body["human_verified_at"] is not None
            assert body["self_reported"] is True
            assert body["has_evidence"] is True
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_task_verified_state_mirrors_story():
    """story와 동형 — task도 gate_approval evidence로 human_verified+who/when 세팅."""
    from app.services.gate_service import create_gate, transition_gate

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
            approver_id = uuid.uuid4()
            role_id = uuid.uuid4()

            gate = await create_gate(
                s, org_id=seeded["org_id"], work_item_id=seeded["task_id"], work_item_type="task",
                gate_type="pr_review", member_id=seeded["agent_id"], role_id=role_id,
            )
            await s.commit()
            gate_id = gate.id

            await transition_gate(s, seeded["org_id"], gate_id, "approved", resolver_id=approver_id)
            await s.commit()

        from app.main import app
        await _setup_app(app, Session, seeded["agent_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/tasks/{seeded['task_id']}")
            body = resp.json()
            assert body["human_verified"] is True
            assert body["human_verified_by"] == str(approver_id)
            assert body["human_verified_at"] is not None
            assert body["self_reported"] is True
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_most_recent_gate_approval_wins_who_when():
    """엣지: 동일 work_item에 gate_approval evidence가 2건(재승인 등)이면 최신 1건의
    who/when이 human_verified_by/at에 반영된다."""
    from datetime import datetime, timedelta, timezone

    from app.models.evidence import Evidence

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
            first_approver_id = uuid.uuid4()
            second_approver_id = uuid.uuid4()
            now = datetime.now(timezone.utc)

            # gate 생애주기(auto-approve posture 등)와 무관하게 "복수 gate_approval evidence"
            # 시나리오만 직접 재현 — create_gate_approval_evidence_if_applicable이 실제로 만드는
            # 것과 동일 shape의 row 2건을 시간차로 삽입.
            s.add(Evidence(
                id=uuid.uuid4(), org_id=seeded["org_id"], work_item_id=seeded["story_id"],
                work_item_type="story", type="gate_approval", ref="gate-1", source="gate",
                created_by=first_approver_id, created_at=now - timedelta(hours=1),
            ))
            s.add(Evidence(
                id=uuid.uuid4(), org_id=seeded["org_id"], work_item_id=seeded["story_id"],
                work_item_type="story", type="gate_approval", ref="gate-2", source="gate",
                created_by=second_approver_id, created_at=now,
            ))
            await s.commit()

        from app.main import app
        await _setup_app(app, Session, seeded["agent_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/stories/{seeded['story_id']}")
            body = resp.json()
            assert body["human_verified"] is True
            assert body["human_verified_by"] == str(second_approver_id)
        finally:
            await client.aclose()
            app.dependency_overrides.clear()
    finally:
        await engine.dispose()
