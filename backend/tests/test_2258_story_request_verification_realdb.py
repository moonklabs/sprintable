"""story #2258 AC2 — POST /api/v2/stories/{id}/request-verification.

발견: 제네릭 게이트 생성(POST /api/v2/gates)은 이미 있었다(work_item_type 무관, BE 완비) — 그런데
story-detail-panel.tsx 어디에도 그걸 부르는 곳이 없었다(FE 미배선). 이유는 GateCreateRequest가
member_id/role_id를 client가 알아야 하는데 그걸 알아낼 방법이 화면에 없었기 때문 — doc.py::
transition_doc이 doc_approval 게이트를 상신 시 자동 생성하며 role_id를 `_default_role_id`로
서버가 스스로 해소하는 것과 동형으로, story 쪽에도 얇은 래퍼 엔드포인트를 신설했다.
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


async def _seed(session, *, with_default_role: bool = True):
    from app.models.organization import Organization
    from app.models.participation import ParticipationRole
    from app.models.pm import Story
    from app.models.project import OrgMember, Project
    from app.models.project_access import ProjectAccess
    from app.models.user import User

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()

    proj = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(proj)
    await session.commit()

    proj_b = Project(id=uuid.uuid4(), org_id=org.id, name="P-other")
    session.add(proj_b)
    await session.commit()

    story = Story(id=uuid.uuid4(), org_id=org.id, project_id=proj.id, title="검증 대상 스토리")
    story_other = Story(id=uuid.uuid4(), org_id=org.id, project_id=proj_b.id, title="타 프로젝트 스토리")
    session.add_all([story, story_other])
    await session.commit()

    caller_id = uuid.uuid4()
    caller = User(id=caller_id, email=f"caller-{caller_id.hex[:8]}@test.com", hashed_password="x")
    session.add(caller)
    await session.commit()

    om = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=caller_id, role="member")
    session.add(om)
    await session.commit()
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=proj.id, org_member_id=om.id, permission="granted", role="member",
    ))
    await session.commit()

    # _resolve_team_member_id(stories.py) 폴백: team_members(뷰, 직접 insert 불가)에 안 걸리면
    # resolve_member(member_resolver.py)가 human JWT를 org_member.id로 해소한다(위 om 재사용).
    if with_default_role:
        role = ParticipationRole(id=uuid.uuid4(), org_id=org.id, key="qa", label="QA", is_default=True)
        session.add(role)
        await session.commit()

    return {
        "org_id": org.id, "caller_id": caller_id,
        "story_id": story.id, "story_other_id": story_other.id,
        "project_id": proj.id,
    }


def _client_for(app):
    from httpx import ASGITransport, AsyncClient
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


async def _gate_rows(Session, work_item_id):
    from sqlalchemy import text
    async with Session() as s:
        return (await s.execute(
            text("SELECT id, gate_type, work_item_type, status FROM gate WHERE work_item_id = :i"),
            {"i": work_item_id},
        )).all()


@pytest.mark.anyio
async def test_request_verification_creates_qa_gate_201_and_persists():
    """AC2 본체: 붙인 뒤 다시 읽어서 붙어 있는 것(write→read) — 응답 201뿐 아니라 gates 테이블
    직조회로 실제 저장을 확인한다."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.post(f"/api/v2/stories/{seeded['story_id']}/request-verification")
            assert resp.status_code == 201, resp.text
            body = resp.json()
            assert body["gate_type"] == "qa"
            assert body["work_item_type"] == "story"
            assert body["work_item_id"] == str(seeded["story_id"])
        finally:
            await client.aclose()

        rows = await _gate_rows(Session, seeded["story_id"])
        assert len(rows) == 1, "gates 테이블에 실제로 저장되지 않음(write→read 실패)"
        assert rows[0][1] == "qa"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_request_verification_idempotent_no_duplicate_gate():
    """create_gate 멱등성 재사용 확인 — 두 번 요청해도 gate가 1개만 남는다(중복 게이트 방지)."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            r1 = await client.post(f"/api/v2/stories/{seeded['story_id']}/request-verification")
            r2 = await client.post(f"/api/v2/stories/{seeded['story_id']}/request-verification")
            assert r1.status_code == 201, r1.text
            assert r2.status_code == 201, r2.text
            assert r1.json()["id"] == r2.json()["id"], "재요청이 새 게이트를 또 만듦(멱등 깨짐)"
        finally:
            await client.aclose()

        rows = await _gate_rows(Session, seeded["story_id"])
        assert len(rows) == 1
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_request_verification_without_default_role_falls_back_not_500():
    """org에 is_default role이 없어도(placeholder role_id=story.id 폴백) 500 없이 정상 생성."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s, with_default_role=False)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.post(f"/api/v2/stories/{seeded['story_id']}/request-verification")
            assert resp.status_code == 201, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_request_verification_cross_project_blocked_404_no_gate():
    """봉인: 접근권 없는 project의 story에 검증요청 시도 → 404(story #2322, 2026-07-29 —
    예전엔 403이었으나 존재 비노출 규율로 통일) + gate 미생성."""
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.post(f"/api/v2/stories/{seeded['story_other_id']}/request-verification")
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()

        rows = await _gate_rows(Session, seeded["story_other_id"])
        assert len(rows) == 0, "무접근 project story에 게이트가 생성됨(IDOR)"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_request_verification_not_found_404():
    from app.main import app
    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.post(f"/api/v2/stories/{uuid.uuid4()}/request-verification")
            assert resp.status_code == 404, resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
