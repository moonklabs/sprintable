"""E-GLANCE glance/attention 예외 스트림 BE (story db7eb049) — 실 PG.

현 프로젝트 human-attention 실신호 3종(gate_pending·blocked·merge_ready)을 project-scope로 반환하고
접근권 없는 project는 404(존재 비노출)·신호 없으면 빈배열임을 실증.
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


def _story(org_id, project_id, title, status="in-progress"):
    from app.models.pm import Story
    return Story(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title, status=status)


async def _seed(session):
    """project_a(grant·3신호 다 有)·project_b(무접근)·project_c(grant·신호0).

    P0-04(doc trust-pipeline-be-design) merge_ready 엄격화: in-review story가 human_verified(gate_
    approval evidence)까지 있어야 merge_ready로 잡힌다 — "Review Story"에 evidence를 명시 부여해
    엄격화 後에도 이 회귀 스위트가 원 계약(3신호 전부 반환)을 그대로 실증하게 한다."""
    from app.models.evidence import Evidence
    from app.models.gate import Gate
    from app.models.dependency import ItemDependency
    from app.models.member import Member
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project
    from app.models.project_access import ProjectAccess
    from app.models.user import User
    from app.models.workflow_line import WorkflowLineStepApproval

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    pa = Project(id=uuid.uuid4(), org_id=org.id, name="A")
    pb = Project(id=uuid.uuid4(), org_id=org.id, name="B")
    pc = Project(id=uuid.uuid4(), org_id=org.id, name="C")
    session.add_all([pa, pb, pc])
    await session.commit()

    # gate_pending: story_g + gate(story) + pending blocking approval(project_a).
    story_g = _story(org.id, pa.id, "Gate Story")
    session.add(story_g)
    await session.commit()
    gate = Gate(id=uuid.uuid4(), org_id=org.id, work_item_id=story_g.id, work_item_type="story",
                gate_type="review", status="pending")
    session.add(gate)
    await session.commit()
    session.add(WorkflowLineStepApproval(
        id=uuid.uuid4(), org_id=org.id, project_id=pa.id, step_run_id=uuid.uuid4(),
        approval_group_id=uuid.uuid4(), approver_member_id=uuid.uuid4(), approver_member_type="agent",
        gate_id=gate.id, kind="approver", blocking=True, status="pending",
    ))
    # blocked: story_blocked(open) blocked-by story_blocker(open) in project_a.
    story_blocker = _story(org.id, pa.id, "Blocker")
    story_blocked = _story(org.id, pa.id, "Blocked Story")
    session.add_all([story_blocker, story_blocked])
    await session.commit()
    session.add(ItemDependency(
        id=uuid.uuid4(), org_id=org.id, from_id=story_blocker.id, to_id=story_blocked.id,
        dep_type="blocks", item_type="story",
    ))
    # merge_ready: in-review story in project_a + human_verified(gate_approval evidence·P0-04 엄격화).
    story_review = _story(org.id, pa.id, "Review Story", status="in-review")
    session.add(story_review)
    await session.commit()
    reviewer = Member(id=uuid.uuid4(), org_id=org.id, type="human", name="Reviewer", org_role="admin")
    session.add(reviewer)
    await session.commit()
    session.add(Evidence(
        id=uuid.uuid4(), org_id=org.id, work_item_id=story_review.id, work_item_type="story",
        type="gate_approval", ref="approved", created_by=reviewer.id,
    ))
    await session.commit()

    caller_id = uuid.uuid4()
    caller = User(id=caller_id, email=f"caller-{caller_id.hex[:8]}@test.com", hashed_password="x")
    session.add(caller)
    await session.commit()
    om = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=caller_id, role="member")
    session.add(om)
    await session.commit()
    # caller는 project_a·project_c만 grant(project_b 무접근).
    session.add_all([
        ProjectAccess(id=uuid.uuid4(), project_id=pa.id, org_member_id=om.id, permission="granted", role="member"),
        ProjectAccess(id=uuid.uuid4(), project_id=pc.id, org_member_id=om.id, permission="granted", role="member"),
    ])
    await session.commit()

    return {"org_id": org.id, "caller_id": caller_id, "pa": pa.id, "pb": pb.id, "pc": pc.id,
            "gate_story_title": "Gate Story"}


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
async def test_attention_own_project_returns_all_three_signals():
    """회귀0: project_a grant caller → 3신호(gate_pending·blocked·merge_ready) 다 반환·gate title enrich."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/glance/attention?project_id={seeded['pa']}")
            assert resp.status_code == 200, resp.text
            items = resp.json()["items"]
            kinds = {i["kind"] for i in items}
            assert kinds == {"gate_pending", "blocked", "merge_ready"}, kinds
            gate = next(i for i in items if i["kind"] == "gate_pending")
            assert gate["title"] == seeded["gate_story_title"]  # title enrich via gate→story
            blocked = next(i for i in items if i["kind"] == "blocked")
            assert blocked["title"] == "Blocked Story"
            assert "blocker_story_id" in blocked["ref"]
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_attention_cross_project_blocked_404():
    """봉인: 접근권 없는 project_b 예외 스트림 조회 시도 → 404(존재 비노출·read exposure 차단)."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/glance/attention?project_id={seeded['pb']}")
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_attention_empty_project_returns_empty_array():
    """정직 빈상태: 신호 없는 project_c(grant) → 200 + items=[](FE '손 필요한 것 없음' 폴백·억지 0)."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/glance/attention?project_id={seeded['pc']}")
            assert resp.status_code == 200, resp.text
            assert resp.json()["items"] == []
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
