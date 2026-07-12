"""E-SECURITY (유휴방지 MEDIUM) — standups.add_feedback write-target project-scope IDOR, 실 PG.

갭: SEC-S8 EE가 authz를 resolve_member(project_id=entry.project_id)로 고쳤으나, feedback row는
fb_repo.create(project_id=body.project_id)로 body-주장 project에 persist된다. 그 body.project_id
접근권은 미검증이라 caller가 접근권 없는 project로 feedback을 주입할 수 있다(entry-access ≠
write-target·body-claimed vs resource-actual 불일치). 특히 org-level entry(entry.project_id=None)는
resolve_member의 project 체크가 스킵돼 최고위험. FeedbackCreate.project_id는 required이므로 None
분기는 없다(가드는 전 요청 발동).

fix: persist 대상 body.project_id를 resource-actual has_project_access로 직접 검증(403).
"""
from __future__ import annotations

import os
import uuid
from datetime import date

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


async def _seed(session, *, entry_project):
    """org(project_a, project_b) + standup entry(project=entry_project·None이면 org-level) +
    caller(휴먼·project_a에만 grant·project_b 접근권 없음)."""
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project
    from app.models.project_access import ProjectAccess
    from app.models.standup import StandupEntry
    from app.models.user import User

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project_a = Project(id=uuid.uuid4(), org_id=org.id, name="Project A")
    project_b = Project(id=uuid.uuid4(), org_id=org.id, name="Project B")
    session.add_all([project_a, project_b])
    await session.commit()

    entry_pid = project_a.id if entry_project == "a" else (project_b.id if entry_project == "b" else None)
    entry = StandupEntry(
        id=uuid.uuid4(), org_id=org.id, project_id=entry_pid, sprint_id=None,
        author_id=uuid.uuid4(), date=date(2026, 7, 12),
        done="d", plan="p", blockers="b",
    )
    session.add(entry)
    await session.commit()

    caller_id = uuid.uuid4()
    caller = User(id=caller_id, email=f"caller-{caller_id.hex[:8]}@test.com", hashed_password="x")
    session.add(caller)
    await session.commit()
    caller_om = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=caller_id, role="member")
    session.add(caller_om)
    await session.commit()
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project_a.id, org_member_id=caller_om.id,
        permission="granted", role="member",
    ))
    await session.commit()

    return {
        "org_id": org.id, "project_a_id": project_a.id, "project_b_id": project_b.id,
        "entry_id": entry.id, "caller_id": caller_id,
    }


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


def _body(seeded, project_key):
    pid = seeded[f"project_{project_key}_id"]
    return {
        "org_id": str(seeded["org_id"]),
        "project_id": str(pid),
        "feedback_by_id": str(uuid.uuid4()),  # 서버가 무시(member.id로 대체)
        "review_type": "comment",
        "feedback_text": "fb",
    }


async def _feedback_count(Session, org_id, project_id):
    from sqlalchemy import text
    async with Session() as s:
        return (await s.execute(
            text("SELECT count(*) FROM standup_feedback WHERE org_id=:o AND project_id=:p"),
            {"o": org_id, "p": project_id},
        )).scalar_one()


@pytest.mark.anyio
async def test_valid_project_id_feedback_created_201():
    """회귀0: project_a grant caller가 project_a entry에 body.project_id=project_a로 피드백 → 201."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s, entry_project="a")
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.post(f"/api/v2/standups/{seeded['entry_id']}/feedback", json=_body(seeded, "a"))
            assert resp.status_code == 201, resp.text
            assert await _feedback_count(Session, seeded["org_id"], seeded["project_a_id"]) == 1
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_cross_project_body_project_id_blocked_403():
    """봉인(비-동어반복): project_a grant caller가 project_a entry에 body.project_id=project_b(무접근)로
    피드백 주입 시도 → 403 + project_b feedback 미생성(직조회)."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s, entry_project="a")
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.post(f"/api/v2/standups/{seeded['entry_id']}/feedback", json=_body(seeded, "b"))
            assert resp.status_code == 403, resp.text
            assert await _feedback_count(Session, seeded["org_id"], seeded["project_b_id"]) == 0
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_org_level_entry_cross_project_injection_blocked_403():
    """⭐최고위험 벡터: org-level entry(project_id=None)는 resolve_member 프로젝트 체크가 스킵되므로,
    가드가 없으면 무제한 주입 가능. project_a grant caller가 org-level entry에 body.project_id=
    project_b(무접근)로 피드백 주입 시도 → 403 + 미생성. write-target 가드가 이 갭을 봉인."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s, entry_project="org")  # entry.project_id = None
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.post(f"/api/v2/standups/{seeded['entry_id']}/feedback", json=_body(seeded, "b"))
            assert resp.status_code == 403, resp.text
            assert await _feedback_count(Session, seeded["org_id"], seeded["project_b_id"]) == 0
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_org_level_entry_accessible_project_still_201():
    """회귀0: org-level entry라도 caller가 접근권 가진 project(project_a)로는 정상 피드백(201) —
    가드가 접근권 있는 project는 막지 않는다(over-block 방지)."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s, entry_project="org")
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.post(f"/api/v2/standups/{seeded['entry_id']}/feedback", json=_body(seeded, "a"))
            assert resp.status_code == 201, resp.text
            assert await _feedback_count(Session, seeded["org_id"], seeded["project_a_id"]) == 1
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
