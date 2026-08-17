"""story #2428 PR④(ⓐ 나머지 4건) — list_sprints/list_retro_sessions/list_artifacts/
list_artifact_comments 페이지네이션 실 Postgres 검증.

sprints/retros는 stories.py/goals.py/tasks.py와 동형인 X-Total-Count/X-Next-Cursor 헤더
규약(project_id 지정 시 list_paginated 위임, 미지정 시 SQL-level IN 스코프인
list_in_projects 신설분). visual_artifacts는 이미 자체 `{data,meta}` 봉투를 쓰고 있어 그
가족(docs.py 정본 규약 A — limit+1 오버페치 + has_more/next_cursor body meta)을 그대로
따른다(새 규약 발명 0)."""
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


async def _setup_app_org(app, Session, user_id, org_id):
    """org_id만 claims에 싣는 표준 harness(sprints/retros — get_verified_org_id 경유)."""
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


async def _setup_app_org_project(app, Session, user_id, org_id, project_id):
    """org_id+project_id를 claims에 함께 싣는 harness(visual_artifacts — `_get_org_project`가
    claims.app_metadata.project_id를 직접 읽음, DB 조회 없음 — test_2262_artifact_
    unresolved_comment_count_realdb.py의 `_setup_app_human`과 동형)."""
    from app.dependencies.auth import AuthContext, get_current_user
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
        return AuthContext(
            user_id=str(user_id), email="caller@test",
            claims={"app_metadata": {"org_id": str(org_id), "project_id": str(project_id)}},
        )

    override_db_and_read(app, _db)
    app.dependency_overrides[get_current_user] = _auth


async def _seed_org_project_caller(session):
    """org+project+caller(project_access 부여) — sprints/retros org-wide IN-scope 테스트용."""
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project
    from app.models.project_access import ProjectAccess
    from app.models.user import User

    org = Organization(id=uuid.uuid4(), name="Org2428PR4B", slug=f"org2428pr4b-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()

    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
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

    return {"org_id": org.id, "project_id": project.id, "caller_id": caller_id}


def _stagger(base: datetime, total: int, seq: int) -> datetime:
    return base - timedelta(seconds=total - seq)


# ─── list_sprints ───────────────────────────────────────────────────────────


@pytest.mark.anyio
async def test_list_sprints_project_scoped_last_page_x_total_count_matches_remaining():
    from app.main import app
    from app.models.pm import Sprint

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_org_project_caller(s)
            base = datetime.now(timezone.utc)
            for i in range(5):
                s.add(Sprint(
                    id=uuid.uuid4(), org_id=seeded["org_id"], project_id=seeded["project_id"],
                    title=f"sprint-{i}", created_at=_stagger(base, 5, i),
                ))
            await s.commit()
        await _setup_app_org(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            seen_ids: set[str] = set()
            cursor = None
            pages = 0
            last_total = last_len = None
            while True:
                params = {"project_id": str(seeded["project_id"]), "limit": 2}
                if cursor:
                    params["cursor"] = cursor
                resp = await client.get("/api/v2/sprints", params=params)
                assert resp.status_code == 200, resp.text
                body = resp.json()
                pages += 1
                seen_ids.update(x["id"] for x in body)
                last_total = int(resp.headers["x-total-count"])
                last_len = len(body)
                has_more = last_total > last_len
                cursor = resp.headers.get("x-next-cursor")
                if not has_more or not body:
                    break
                assert pages < 10
            assert len(seen_ids) == 5
            assert pages == 3
            assert last_total == last_len
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_list_sprints_org_wide_excludes_inaccessible_project():
    """project_id 미지정(org-wide) — accessible_project_ids_in_org SQL-level IN 스코프가
    caller 접근권 밖 project의 sprint를 실제로 배제하는지 실 PG로 확認(SEC-S8 계약,
    list_in_projects 신설분)."""
    from app.main import app
    from app.models.pm import Sprint
    from app.models.project import Project

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_org_project_caller(s)
            other_project = Project(id=uuid.uuid4(), org_id=seeded["org_id"], name="OtherP")
            s.add(other_project)
            await s.commit()
            base = datetime.now(timezone.utc)
            for i in range(3):
                s.add(Sprint(
                    id=uuid.uuid4(), org_id=seeded["org_id"], project_id=seeded["project_id"],
                    title=f"mine-{i}", created_at=_stagger(base, 3, i),
                ))
            s.add(Sprint(id=uuid.uuid4(), org_id=seeded["org_id"], project_id=other_project.id, title="not-mine"))
            await s.commit()
        await _setup_app_org(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/sprints")
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert {x["title"] for x in body} == {"mine-0", "mine-1", "mine-2"}
            assert resp.headers["x-total-count"] == "3"

            # cursor 페이지 끝까지 걸어 last-page has_more=False까지 확認(list_in_projects의
            # count_q가 cursor 누락이면 마지막 페이지에서도 total=3 grand-total 고정으로
            # has_more가 영구 참이 될 것 — base.py/task.py와 동형 mutation-kill 대상).
            seen_ids: set[str] = set()
            cursor = None
            pages = 0
            last_total = last_len = None
            while True:
                params = {"limit": 2}
                if cursor:
                    params["cursor"] = cursor
                resp = await client.get("/api/v2/sprints", params=params)
                assert resp.status_code == 200, resp.text
                page = resp.json()
                pages += 1
                seen_ids.update(x["id"] for x in page)
                last_total = int(resp.headers["x-total-count"])
                last_len = len(page)
                has_more = last_total > last_len
                cursor = resp.headers.get("x-next-cursor")
                if not has_more or not page:
                    break
                assert pages < 10
            assert len(seen_ids) == 3
            assert pages == 2
            assert last_total == last_len
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── list_retro_sessions ────────────────────────────────────────────────────


@pytest.mark.anyio
async def test_list_retro_sessions_project_scoped_last_page_x_total_count_matches_remaining():
    from app.main import app
    from app.models.retro import RetroSession

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_org_project_caller(s)
            base = datetime.now(timezone.utc)
            for i in range(5):
                s.add(RetroSession(
                    id=uuid.uuid4(), org_id=seeded["org_id"], project_id=seeded["project_id"],
                    title=f"retro-{i}", created_at=_stagger(base, 5, i),
                ))
            await s.commit()
        await _setup_app_org(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            seen_ids: set[str] = set()
            cursor = None
            pages = 0
            last_total = last_len = None
            while True:
                params = {"project_id": str(seeded["project_id"]), "limit": 2}
                if cursor:
                    params["cursor"] = cursor
                resp = await client.get("/api/v2/retros", params=params)
                assert resp.status_code == 200, resp.text
                body = resp.json()
                pages += 1
                seen_ids.update(x["id"] for x in body)
                last_total = int(resp.headers["x-total-count"])
                last_len = len(body)
                has_more = last_total > last_len
                cursor = resp.headers.get("x-next-cursor")
                if not has_more or not body:
                    break
                assert pages < 10
            assert len(seen_ids) == 5
            assert pages == 3
            assert last_total == last_len
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_list_retro_sessions_org_wide_excludes_inaccessible_project():
    from app.main import app
    from app.models.retro import RetroSession
    from app.models.project import Project

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_org_project_caller(s)
            other_project = Project(id=uuid.uuid4(), org_id=seeded["org_id"], name="OtherP")
            s.add(other_project)
            await s.commit()
            base = datetime.now(timezone.utc)
            for i in range(3):
                s.add(RetroSession(
                    id=uuid.uuid4(), org_id=seeded["org_id"], project_id=seeded["project_id"],
                    title=f"mine-{i}", created_at=_stagger(base, 3, i),
                ))
            s.add(RetroSession(id=uuid.uuid4(), org_id=seeded["org_id"], project_id=other_project.id, title="not-mine"))
            await s.commit()
        await _setup_app_org(app, Session, seeded["caller_id"], seeded["org_id"])
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/retros")
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert {x["title"] for x in body} == {"mine-0", "mine-1", "mine-2"}
            assert resp.headers["x-total-count"] == "3"

            seen_ids: set[str] = set()
            cursor = None
            pages = 0
            last_total = last_len = None
            while True:
                params = {"limit": 2}
                if cursor:
                    params["cursor"] = cursor
                resp = await client.get("/api/v2/retros", params=params)
                assert resp.status_code == 200, resp.text
                page = resp.json()
                pages += 1
                seen_ids.update(x["id"] for x in page)
                last_total = int(resp.headers["x-total-count"])
                last_len = len(page)
                has_more = last_total > last_len
                cursor = resp.headers.get("x-next-cursor")
                if not has_more or not page:
                    break
                assert pages < 10
            assert len(seen_ids) == 3
            assert pages == 2
            assert last_total == last_len
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── list_artifacts ─────────────────────────────────────────────────────────


async def _make_artifact(session, org_id, project_id, created_at, title="A"):
    from app.models.visual_artifact import ArtifactVersion, VisualArtifact
    artifact = VisualArtifact(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title,
        source="created", latest_version_number=1, created_by=uuid.uuid4(), created_at=created_at,
    )
    session.add(artifact)
    await session.flush()
    session.add(ArtifactVersion(id=uuid.uuid4(), artifact_id=artifact.id, version_number=1))
    await session.commit()
    return artifact


@pytest.mark.anyio
async def test_list_artifacts_limit_plus_one_overfetch_has_more_and_last_page_false():
    from app.main import app
    from app.models.organization import Organization
    from app.models.project import Project

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
            s.add(org)
            await s.commit()
            project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
            s.add(project)
            await s.commit()
            base = datetime.now(timezone.utc)
            for i in range(5):
                await _make_artifact(s, org.id, project.id, _stagger(base, 5, i), title=f"a{i}")
        await _setup_app_org_project(app, Session, uuid.uuid4(), org.id, project.id)
        client = _client_for(app)
        try:
            seen_ids: set[str] = set()
            cursor = None
            pages = 0
            last_meta = None
            while True:
                params = {"limit": 2}
                if cursor:
                    params["cursor"] = cursor
                resp = await client.get("/api/v2/visual-artifacts", params=params)
                assert resp.status_code == 200, resp.text
                body = resp.json()
                pages += 1
                seen_ids.update(x["id"] for x in body["data"])
                last_meta = body["meta"]
                cursor = last_meta.get("next_cursor")
                if not last_meta.get("has_more") or not body["data"]:
                    break
                assert pages < 10
            assert len(seen_ids) == 5
            assert pages == 3
            assert last_meta["has_more"] is False
            assert last_meta["next_cursor"] is None
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ─── list_artifact_comments ─────────────────────────────────────────────────


async def _make_comment(session, org_id, project_id, artifact_id, created_at, content="c"):
    from app.models.visual_artifact import ArtifactComment
    c = ArtifactComment(
        id=uuid.uuid4(), artifact_id=artifact_id, org_id=org_id, project_id=project_id,
        content=content, created_by=uuid.uuid4(), created_at=created_at,
    )
    session.add(c)
    await session.commit()
    return c


@pytest.mark.anyio
async def test_list_artifact_comments_limit_plus_one_overfetch_forward_cursor_last_page_false():
    from app.main import app
    from app.models.organization import Organization
    from app.models.project import Project

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
            s.add(org)
            await s.commit()
            project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
            s.add(project)
            await s.commit()
            artifact = await _make_artifact(s, org.id, project.id, datetime.now(timezone.utc), title="art")
            base = datetime.now(timezone.utc)
            # 오래된순(asc) 정렬 — i=0이 가장 오래됨(가장 먼저 나와야).
            for i in range(5):
                await _make_comment(s, org.id, project.id, artifact.id, _stagger(base, 5, i), content=f"c{i}")
        await _setup_app_org_project(app, Session, uuid.uuid4(), org.id, project.id)
        client = _client_for(app)
        try:
            seen_ids: set[str] = set()
            cursor = None
            pages = 0
            last_meta = None
            while True:
                params = {"limit": 2}
                if cursor:
                    params["cursor"] = cursor
                resp = await client.get(f"/api/v2/visual-artifacts/{artifact.id}/comments", params=params)
                assert resp.status_code == 200, resp.text
                body = resp.json()
                pages += 1
                seen_ids.update(x["id"] for x in body["data"])
                last_meta = body["meta"]
                cursor = last_meta.get("next_cursor")
                if not last_meta.get("has_more") or not body["data"]:
                    break
                assert pages < 10
            assert len(seen_ids) == 5
            assert pages == 3
            assert last_meta["has_more"] is False
            assert last_meta["next_cursor"] is None
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
