"""story #2428 PR③(⓪tasks ⓐ) — GET /api/v2/tasks에 limit/cursor/X-Total-Count/status_ne 배선,
실 Postgres 검증. 라이브 실측 667건(현재 dev org) — list_tasks/list_my_tasks/get_overdue_tasks
3-way 공유 엔드포인트라 이 한 판 수정이 셋 다 해소한다.

축:
1. project_id 미지정(org-wide, list_in_projects 분기) — X-Total-Count가 limit truncation에도
   진짜 전체를 유지.
2. status_ne — get_overdue_tasks가 이미 보내고 있었으나 라우터가 안 받아 조용히 버려지던
   부수발견 결함의 실제 배선 확認(done 제외).
3. story_id 지정(list_paginated 분기) — 같은 X-Total-Count 계약.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

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


async def _seed(session, *, n_todo: int = 3, n_done: int = 2):
    from app.models.organization import Organization
    from app.models.pm import Story, Task
    from app.models.project import OrgMember, Project
    from app.models.project_access import ProjectAccess
    from app.models.user import User

    org = Organization(id=uuid.uuid4(), name="Org2428T", slug=f"org2428t-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()

    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()

    story = Story(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="S")
    session.add(story)
    await session.commit()

    # 단일 트랜잭션 내 여러 row는 Postgres now()가 전부 동일값이라(server_default=func.now())
    # created_at 커서 비교(<)가 동일-timestamp 행을 스킵한다 — 명시 override로 결정적 스태거.
    base = datetime.now(timezone.utc)
    total = n_todo + n_done
    task_ids = []
    seq = 0
    for i in range(n_todo):
        t = Task(
            id=uuid.uuid4(), org_id=org.id, story_id=story.id, title=f"todo-{i}", status="todo",
            created_at=base - timedelta(seconds=total - seq),
        )
        session.add(t)
        task_ids.append(t.id)
        seq += 1
    for i in range(n_done):
        t = Task(
            id=uuid.uuid4(), org_id=org.id, story_id=story.id, title=f"done-{i}", status="done",
            created_at=base - timedelta(seconds=total - seq),
        )
        session.add(t)
        seq += 1
    await session.commit()

    caller_id = uuid.uuid4()
    caller = User(id=caller_id, email=f"caller-{caller_id.hex[:8]}@test.com", hashed_password="x")
    session.add(caller)
    await session.commit()
    caller_om = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=caller_id, role="member")
    session.add(caller_om)
    await session.commit()
    session.add(ProjectAccess(
        id=uuid.uuid4(), project_id=project.id, org_member_id=caller_om.id,
        permission="granted", role="member",
    ))
    await session.commit()

    return {"org_id": org.id, "project_id": project.id, "story_id": story.id, "caller_id": caller_id, "task_ids": task_ids}


@pytest.mark.anyio
async def test_org_wide_x_total_count_is_real_total_when_truncated():
    """list_in_projects 분기 — limit=1로 잘려도 X-Total-Count는 진짜 전체(5)를 유지."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s, n_todo=3, n_done=2)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/tasks", params={"limit": 1})
            assert resp.status_code == 200, resp.text
            assert len(resp.json()) == 1
            assert resp.headers["x-total-count"] == "5", dict(resp.headers)
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_status_ne_excludes_done_get_overdue_tasks_contract():
    """get_overdue_tasks가 이미 보내던 status_ne=done이 실제로 적용되는지(부수발견 결함 fix)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s, n_todo=3, n_done=2)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/tasks", params={"status_ne": "done"})
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert len(body) == 3, body
            assert all(t["status"] != "done" for t in body)
            assert resp.headers["x-total-count"] == "3"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_story_id_scoped_branch_x_total_count():
    """story_id 지정(list_paginated 분기) — 같은 X-Total-Count 계약."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s, n_todo=3, n_done=2)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/tasks", params={"story_id": str(seeded["story_id"]), "limit": 2})
            assert resp.status_code == 200, resp.text
            assert len(resp.json()) == 2
            assert resp.headers["x-total-count"] == "5"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_no_limit_returns_all_and_total_matches_page():
    """limit 미지정(기존 동작 무회귀) — 5건 다 오고 X-Total-Count도 5."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s, n_todo=3, n_done=2)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/tasks")
            assert resp.status_code == 200, resp.text
            assert len(resp.json()) == 5
            assert resp.headers["x-total-count"] == "5"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_org_wide_last_page_x_total_count_matches_remaining_not_grand_total():
    """페드루 AC 리뷰(2026-08-17) 지적 — count_q가 cursor를 안 보면 마지막 페이지에서도
    X-Total-Count가 grand total(5)로 고정돼 has_more(=total>len(items))가 영구 참이 된다.
    5건을 limit=2로 3페이지 끝까지 실제로 걸어(org-wide 분기), 마지막 페이지에서
    X-Total-Count == len(items)(=has_more False로 정확히 떨어짐)까지 확認한다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s, n_todo=3, n_done=2)
        await _setup_app(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            # sprintable_mcp/tools/stories.py::_has_more_from_headers 규약 그대로 —
            # X-Next-Cursor는 결과가 있으면 "항상" 실리므로(진짜 다음 페이지 유무와 무관)
            # 헤더 존재가 아니라 has_more=(X-Total-Count > 이번 페이지 건수)로 멈춘다.
            seen_ids: set[str] = set()
            cursor = None
            pages = 0
            last_total = None
            last_len = None
            while True:
                params = {"limit": 2}
                if cursor:
                    params["cursor"] = cursor
                resp = await client.get("/api/v2/tasks", params=params)
                assert resp.status_code == 200, resp.text
                body = resp.json()
                pages += 1
                seen_ids.update(t["id"] for t in body)
                last_total = int(resp.headers["x-total-count"])
                last_len = len(body)
                has_more = last_total > last_len
                cursor = resp.headers.get("x-next-cursor")
                if not has_more or not body:
                    break
                assert pages < 10, "무한 루프 방지"

            assert len(seen_ids) == 5, f"5건이 페이지 전체에 걸쳐 정확히 다 나와야(중복/누락 0): {seen_ids}"
            assert pages == 3, f"5건/limit=2 → 3페이지(2+2+1)여야: {pages}"
            assert last_total == last_len, (
                f"마지막 페이지 X-Total-Count({last_total})가 그 페이지 건수({last_len})와 "
                f"같아야 has_more=False로 정확히 떨어진다 — grand total(5) 고정이면 여기서 어긋남"
            )
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
