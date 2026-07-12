"""E-GLANCE hero ProofCapsule envelope (story b464daa1) — 실 PG.

현재 에픽 활성 story의 Proof Capsule 소비 payload를 no-fiction 정직 소스로 반환하고(claim·proof_count·
auto_verify·gate 구조필드·trustSeal), project-scope 가드(cross-project 404)·무증거 story 정직 최소
(proof_count 0·self_reported False·auto_verify null·gate null)임을 실증. ac_met/risk/diff는 계약상 미포함.
"""
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
    from app.models.evidence import Evidence
    from app.models.gate import Gate
    from app.models.member import Member
    from app.models.organization import Organization
    from app.models.pm import Story
    from app.models.project import OrgMember, Project
    from app.models.project_access import ProjectAccess
    from app.models.user import User

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    pa = Project(id=uuid.uuid4(), org_id=org.id, name="A")
    pb = Project(id=uuid.uuid4(), org_id=org.id, name="B")
    session.add_all([pa, pb])
    await session.commit()

    # story_full: rich signals. story_empty: 무증거. story_b: cross-project.
    story_full = Story(id=uuid.uuid4(), org_id=org.id, project_id=pa.id, title="Full Story", status="in-review")
    story_empty = Story(id=uuid.uuid4(), org_id=org.id, project_id=pa.id, title="Empty Story", status="in-progress")
    story_b = Story(id=uuid.uuid4(), org_id=org.id, project_id=pb.id, title="B Story", status="in-progress")
    session.add_all([story_full, story_empty, story_b])
    await session.commit()

    reviewer = Member(id=uuid.uuid4(), org_id=org.id, type="human", name="Reviewer", org_role="admin")
    session.add(reviewer)
    await session.commit()
    # evidence: self_reported(url) + human_verified(gate_approval by human reviewer).
    session.add_all([
        Evidence(id=uuid.uuid4(), org_id=org.id, work_item_id=story_full.id, work_item_type="story",
                 type="url", ref="http://ev", created_by=uuid.uuid4()),
        Evidence(id=uuid.uuid4(), org_id=org.id, work_item_id=story_full.id, work_item_type="story",
                 type="gate_approval", ref="approved", created_by=reviewer.id),
    ])
    # merge gate(auto_verify=passed) + pending pr_review gate(결정점).
    session.add_all([
        Gate(id=uuid.uuid4(), org_id=org.id, work_item_id=story_full.id, work_item_type="story",
             gate_type="merge", status="approved", evidence_status="sufficient"),
        Gate(id=uuid.uuid4(), org_id=org.id, work_item_id=story_full.id, work_item_type="story",
             gate_type="pr_review", status="pending", requires_human=True,
             decision_basis="needs human review", auto_decision_reason="ask_human"),
    ])
    await session.commit()

    caller_id = uuid.uuid4()
    caller = User(id=caller_id, email=f"caller-{caller_id.hex[:8]}@test.com", hashed_password="x")
    session.add(caller)
    await session.commit()
    om = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=caller_id, role="member")
    session.add(om)
    await session.commit()
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=pa.id, org_member_id=om.id, permission="granted", role="member",
    ))
    await session.commit()

    return {"org_id": org.id, "caller_id": caller_id,
            "story_full": story_full.id, "story_empty": story_empty.id, "story_b": story_b.id}


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _setup_app(app, Session, user_id, org_id):
    from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
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
        return AuthContext(user_id=str(user_id), email="caller@test", claims={"app_metadata": {"org_id": str(org_id)}})

    async def _org():
        return org_id

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth
    app.dependency_overrides[get_verified_org_id] = _org


@pytest.mark.anyio
async def test_hero_full_signals():
    """회귀0: rich story → claim·proof_count·auto_verify(passed)·gate 구조필드·trustSeal(human_verified
    +by name/role) 전부 정직 배선."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/glance/hero?story_id={seeded['story_full']}")
            assert resp.status_code == 200, resp.text
            b = resp.json()
            assert b["claim"] == "Full Story"
            assert b["proof_count"] == 2
            assert b["auto_verify"] == "passed"
            assert b["gate"]["gate_type"] == "pr_review"
            assert b["gate"]["decision_basis"] == "needs human review"
            assert b["gate"]["auto_decision_reason"] == "ask_human"
            t = b["trust"]
            assert t["self_reported"] is True
            assert t["human_verified"] is True
            assert t["human_verified_by"]["name"] == "Reviewer"
            assert t["human_verified_by"]["role"] == "admin"
            assert t["human_verified_at"] is not None
            # no-fiction: ac/risk/diff 미포함.
            assert "ac_met" not in b and "risk" not in b and "diff" not in b
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_hero_empty_story_honest_minimal():
    """무증거 story → 정직 최소(proof_count 0·self_reported/human_verified False·auto_verify null·gate null)."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/glance/hero?story_id={seeded['story_empty']}")
            assert resp.status_code == 200, resp.text
            b = resp.json()
            assert b["proof_count"] == 0
            assert b["auto_verify"] is None
            assert b["gate"] is None
            assert b["trust"]["self_reported"] is False
            assert b["trust"]["human_verified"] is False
            assert b["trust"]["human_verified_by"] is None
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_hero_cross_project_blocked_404():
    """봉인: 접근권 없는 project_b story의 hero 조회 시도 → 404(존재 비노출)."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/glance/hero?story_id={seeded['story_b']}")
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
