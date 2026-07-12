"""E-DG S25: epic transition endpoint 500(INTERNAL_ERROR) 회귀 실증.

`transition_epic`(app/services/epic.py)가 `epic.status = to_status; await session.flush()`로
직접 mutation하면서 `session.refresh(epic)`을 누락했다 — `updated_at`이 `onupdate=func.now()`
서버생성값이라 flush만으로는 파이썬 객체에 반영 안 되고 unloaded 상태로 남는다. 이후
`EpicResponse.model_validate(epic)`(from_attributes)가 동기 컨텍스트에서 이 속성을 읽으려
하면 lazy-load가 트리거돼 `MissingGreenlet` → 500. story는 `StoryRepository.set_status`가
`BaseRepository.update()`(flush+refresh 쌍)를 경유해 무증상이었다(story는 되는데 epic만
500이라는 보고와 일치)."""
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


async def _seed(session, *, epic_status: str = "active"):
    from app.models.organization import Organization
    from app.models.pm import Epic
    from app.models.project import OrgMember, Project
    from app.models.user import User

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()

    project = Project(id=uuid.uuid4(), org_id=org.id, name="Project")
    session.add(project)
    await session.commit()

    human_id = uuid.uuid4()
    user = User(id=human_id, email=f"human-{human_id.hex[:8]}@test.com", hashed_password="x")
    session.add(user)
    await session.commit()
    om = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=human_id, role="owner")
    session.add(om)
    await session.commit()

    epic = Epic(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="Epic", status=epic_status)
    session.add(epic)
    await session.commit()

    return {"org_id": org.id, "epic_id": epic.id, "human_id": human_id}


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _setup_app(app, Session, user_id, org_id):
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
            user_id=str(user_id), email="caller@test",
            claims={"app_metadata": {"org_id": str(org_id)}},
        )

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _auth


@pytest.mark.anyio
async def test_epic_active_to_done_transition_200_not_500():
    """회귀: active→done이 500(MissingGreenlet) 대신 200 + updated_at 정상 반환."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s, epic_status="active")

        await _setup_app(app, Session, seeded["human_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/epics/{seeded['epic_id']}/transition", json={"status": "done"},
            )
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["status"] == "done"
            assert body["updated_at"] is not None
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_epic_active_to_archived_transition_200_not_500():
    """회귀: active→archived(native 직행)도 500 대신 200."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s, epic_status="active")

        await _setup_app(app, Session, seeded["human_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/epics/{seeded['epic_id']}/transition", json={"status": "archived"},
            )
            assert resp.status_code == 200, resp.text
            assert resp.json()["status"] == "archived"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_epic_draft_to_active_transition_200_not_500():
    """회귀: draft→active(activation, human-only overlay 경로)도 500 대신 200."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s, epic_status="draft")

        await _setup_app(app, Session, seeded["human_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.post(
                f"/api/v2/epics/{seeded['epic_id']}/transition", json={"status": "active"},
            )
            assert resp.status_code == 200, resp.text
            assert resp.json()["status"] == "active"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
