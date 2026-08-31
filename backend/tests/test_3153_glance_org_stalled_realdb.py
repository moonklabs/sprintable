"""story #3153(93b076c8/#2250 후속) 실PG 테스트 — `/api/v2/glance/attention/org-stalled`.

문제: `/attention`은 project_id 단일 스코프라 org-briefing처럼 "전 프로젝트"를 훑는 표면에서
다른 프로젝트의 침묵을 못 본다(옛 story_stalled는 org-wide였는데 신규 stalled 신호는
project-scope인 회귀). 이 엔드포인트는 접근 가능한 전 프로젝트에 대해 기존 `/attention`과
동일 계산(`_compute_attention_for_project`, 재구현 0)을 돌려 kind="stalled"만 합친다.

AC 축: ①여러 프로젝트의 stalled가 하나로 합쳐짐 ②각 항목에 project_id/project_slug가 실림
(단일 `/attention`은 이 필드가 항상 None — 회귀 0) ③population_count가 프로젝트별 합
④접근권 없는 프로젝트는 절대 안 섞임(has_project_access 3-branch 우회 없음) ⑤AC5(1~6 배타)가
org-wide에서도 유지 — 한 프로젝트에서 gate_pending인 스토리가 그 프로젝트에서는 stalled로
안 나옴(재구현이 아니라 같은 함수 재사용이므로 당연 성립·회귀 가드용) ⑥정렬(전량, 가장 오래
무변화 먼저) 유지.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = pytest.mark.destructive_schema


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
    from app.core.database import Base
    import app.models  # noqa: F401

    engine = create_async_engine(_async_url())
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


def _story(org_id, project_id, title, status="in-progress"):
    from app.models.pm import Story
    return Story(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title, status=status)


async def _seed_two_projects(session):
    """org 1개 + project 2개(caller가 둘 다 접근 가능) + 접근권 없는 project 1개(누출 가드용)."""
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project
    from app.models.project_access import ProjectAccess
    from app.models.user import User

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()

    project_a = Project(id=uuid.uuid4(), org_id=org.id, name="A", slug="proj-a")
    project_b = Project(id=uuid.uuid4(), org_id=org.id, name="B", slug="proj-b")
    project_forbidden = Project(id=uuid.uuid4(), org_id=org.id, name="Forbidden", slug="proj-forbidden")
    session.add_all([project_a, project_b, project_forbidden])
    await session.commit()

    caller_id = uuid.uuid4()
    caller = User(id=caller_id, email=f"caller-{caller_id.hex[:8]}@test.com", hashed_password="x")
    session.add(caller)
    await session.commit()
    om = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=caller_id, role="member")
    session.add(om)
    await session.commit()
    # caller는 A·B만 grant — forbidden은 의도적으로 안 줌(누출 가드).
    session.add_all([
        ProjectAccess(id=uuid.uuid4(), project_id=project_a.id, org_member_id=om.id, permission="granted", role="member"),
        ProjectAccess(id=uuid.uuid4(), project_id=project_b.id, org_member_id=om.id, permission="granted", role="member"),
    ])
    await session.commit()
    return {
        "org_id": org.id, "caller_id": caller_id,
        "project_a": project_a.id, "project_b": project_b.id, "project_forbidden": project_forbidden.id,
    }


async def _seed_status_changed_activity(session, org_id, project_id, story_id, created_at, new_value="in-progress"):
    from app.models.pm import StoryActivity
    from sqlalchemy import update
    row = StoryActivity(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, story_id=story_id,
        activity_type="status_changed", old_value="backlog", new_value=new_value,
        created_by=uuid.uuid4(),
    )
    session.add(row)
    await session.flush()
    await session.execute(update(StoryActivity).where(StoryActivity.id == row.id).values(created_at=created_at))
    await session.commit()
    return row


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _setup_app(app, Session, user_id, org_id):
    from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
    from tests.conftest import override_db_and_read

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

    override_db_and_read(app, _db)
    app.dependency_overrides[get_current_user] = _auth
    app.dependency_overrides[get_verified_org_id] = _org


_OLD = timedelta(hours=72)


@pytest.mark.anyio
async def test_stalled_items_merged_across_accessible_projects_with_project_tags():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_two_projects(s)
            story_a = _story(seeded["org_id"], seeded["project_a"], "Silent A")
            story_b = _story(seeded["org_id"], seeded["project_b"], "Silent B")
            s.add_all([story_a, story_b])
            await s.commit()
            now = datetime.now(timezone.utc)
            await _seed_status_changed_activity(s, seeded["org_id"], seeded["project_a"], story_a.id, now - _OLD)
            await _seed_status_changed_activity(s, seeded["org_id"], seeded["project_b"], story_b.id, now - _OLD)

        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/glance/attention/org-stalled")
            assert resp.status_code == 200, resp.text
            body = resp.json()
            ids = {i["story_id"] for i in body["items"]}
            assert ids == {str(story_a.id), str(story_b.id)}
            by_id = {i["story_id"]: i for i in body["items"]}
            assert by_id[str(story_a.id)]["project_id"] == str(seeded["project_a"])
            assert by_id[str(story_a.id)]["project_slug"] == "proj-a"
            assert by_id[str(story_b.id)]["project_id"] == str(seeded["project_b"])
            assert by_id[str(story_b.id)]["project_slug"] == "proj-b"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_single_project_attention_never_carries_project_tags_no_regression():
    """기존 `/attention`(단일 project) 소비자는 이 필드가 항상 None — 회귀 0."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_two_projects(s)
            story = _story(seeded["org_id"], seeded["project_a"], "Silent")
            s.add(story)
            await s.commit()
            await _seed_status_changed_activity(
                s, seeded["org_id"], seeded["project_a"], story.id, datetime.now(timezone.utc) - _OLD,
            )

        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/glance/attention?project_id={seeded['project_a']}")
            assert resp.status_code == 200, resp.text
            item = next(i for i in resp.json()["items"] if i["kind"] == "stalled")
            assert item["project_id"] is None
            assert item["project_slug"] is None
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_forbidden_project_never_leaks_into_org_stalled():
    """접근권 없는 프로젝트의 stalled는 org-stalled에도 절대 안 섞인다(has_project_access와
    동일 3-branch 우회 없음 — accessible_project_ids_in_org 재사용 회귀가드)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_two_projects(s)
            forbidden_story = _story(seeded["org_id"], seeded["project_forbidden"], "Secret Stalled")
            s.add(forbidden_story)
            await s.commit()
            await _seed_status_changed_activity(
                s, seeded["org_id"], seeded["project_forbidden"], forbidden_story.id,
                datetime.now(timezone.utc) - _OLD,
            )

        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/glance/attention/org-stalled")
            assert resp.status_code == 200, resp.text
            ids = {i["story_id"] for i in resp.json()["items"]}
            assert str(forbidden_story.id) not in ids
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_population_count_sums_across_projects():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_two_projects(s)
            # A에 2건(모집단), B에 1건(모집단) — 48h 문턱 무관, non-done/non-backlog 활성이면 모집단.
            s.add_all([
                _story(seeded["org_id"], seeded["project_a"], "A1"),
                _story(seeded["org_id"], seeded["project_a"], "A2"),
                _story(seeded["org_id"], seeded["project_b"], "B1"),
            ])
            await s.commit()

        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/glance/attention/org-stalled")
            assert resp.status_code == 200, resp.text
            assert resp.json()["stalled_population_count"] == 3
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_no_accessible_projects_returns_empty_not_error():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        from app.models.organization import Organization
        from app.models.user import User

        async with Session() as s:
            org = Organization(id=uuid.uuid4(), name="EmptyOrg", slug=f"empty-{uuid.uuid4().hex[:8]}")
            s.add(org)
            caller_id = uuid.uuid4()
            s.add(User(id=caller_id, email=f"caller-{caller_id.hex[:8]}@test.com", hashed_password="x"))
            await s.commit()

        await _setup_app(app, Session, caller_id, org.id)
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/glance/attention/org-stalled")
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["items"] == []
            assert body["stalled_population_count"] == 0
            assert body["stalled_computed_at"] is not None
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
