"""story #3360(발행 구조·서버, 선생님 확定 2026-09-03) — 자사 사이트 글 저장·공개 API.

공개 API 계약은 story 15a18511(랜딩) 본문이 정본 — 이 테스트는 그 절의 필드명·상태코드를
그대로 assert한다(list `{"posts":[{slug,title,summary,tags,lang,published_at}]}`, detail
`{slug,title,summary,tags,lang,published_at,body_md,source_story_id}`, unknown public_key/slug
→404, lang 누락 →400). 오류 본문 형상은 계약 밖(PO 판정 2026-09-03 — 미르코군 랜딩은
res.ok만 보고 본문은 안 읽음) — 앱 전역 HTTPException 봉투 그대로 검증한다.

seed 하네스는 test_3354_pageview_counter.py 패턴(httpx ASGITransport+override_db_and_read+
claims에 org_id 직접 주입) 재사용."""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.destructive_schema,
    pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요"),
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
    from sqlalchemy import text as sa_text
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from app.core.database import Base
    import app.models  # noqa: F401

    engine = create_async_engine(_async_url())
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await conn.execute(sa_text(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_members_org_system_publisher "
            "ON members (org_id) WHERE (runtime_type = 'system-publisher' AND type = 'agent')"
        ))
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_org(session, *, slug=None):
    from app.models.organization import Organization
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="Site Posts Test Org", slug=slug or f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    return org.id, project.id


async def _seed_agent(session, org_id, project_id, *, name="publisher"):
    from app.models.team import TeamMember

    m = TeamMember(id=uuid.uuid4(), org_id=org_id, project_id=project_id, type="agent", name=name, is_active=True)
    session.add(m)
    await session.commit()
    return m.id


async def _seed_story(session, org_id, project_id, *, title="1호 글"):
    from app.models.pm import Story

    story = Story(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title)
    session.add(story)
    await session.commit()
    return story.id


async def _seed_gate(session, org_id, work_item_id, *, status="pending", gate_type="external_publish"):
    from app.models.gate import Gate

    gate = Gate(
        id=uuid.uuid4(), org_id=org_id, work_item_id=work_item_id, work_item_type="story",
        gate_type=gate_type, status=status,
    )
    session.add(gate)
    await session.commit()
    return gate.id


async def _seed_metering_key(session, org_id):
    from app.services.pageview_counter import get_or_create_active_key

    return await get_or_create_active_key(session, org_id=org_id)


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def _setup_org_scoped_app(app, Session, org_id, *, user_id=None):
    from app.dependencies.auth import AuthContext, get_current_user

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
            user_id=str(user_id or uuid.uuid4()), email="caller@test",
            claims={"app_metadata": {"org_id": str(org_id)}},
        )

    from tests.conftest import override_db_and_read
    override_db_and_read(app, _db)
    app.dependency_overrides[get_current_user] = _auth


def _setup_public_app(app, Session):
    async def _db():
        async with Session() as s:
            try:
                yield s
                await s.commit()
            except Exception:
                await s.rollback()
                raise

    from tests.conftest import override_db_and_read
    override_db_and_read(app, _db)


def _publish_body(*, work_item_id, gate_id=None, slug="hello-world", lang="ko"):
    return {
        "work_item_id": str(work_item_id), "gate_id": str(gate_id) if gate_id else None,
        "title": "AI가 «몰라요»라고 말할 때", "slug": slug, "lang": lang,
        "summary": "요약입니다", "tags": ["ai", "product"], "body_md": "# 제목\n\n본문입니다.",
    }


@pytest.mark.anyio
async def test_post_with_unapproved_gate_returns_403_and_creates_zero_rows():
    from app.main import app
    from app.models.site_post import SitePost
    from sqlalchemy import func, select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            await _seed_gate(s, org_id, story_id, status="pending")
        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id)

        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts", json=_publish_body(work_item_id=story_id),
            )
        assert r.status_code == 403, r.text

        async with Session() as s:
            count = (await s.execute(select(func.count()).select_from(SitePost))).scalar_one()
        assert count == 0, "게이트 미승인인데 행이 생겼다(서버 chokepoint 회귀)"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_post_with_approved_gate_returns_201_and_public_api_reflects():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            gate_id = await _seed_gate(s, org_id, story_id, status="approved")
            public_key = await _seed_metering_key(s, org_id)
        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id)

        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts",
                json=_publish_body(work_item_id=story_id, gate_id=gate_id),
            )
        assert r.status_code == 201, r.text
        assert r.json()["gate_id"] == str(gate_id)

        _setup_public_app(app, Session)
        async with _client_for(app) as public_client:
            r_list = await public_client.get(
                "/api/v2/public/site-posts", params={"public_key": public_key, "lang": "ko"},
            )
            r_detail = await public_client.get(
                "/api/v2/public/site-posts/hello-world", params={"public_key": public_key, "lang": "ko"},
            )

        assert r_list.status_code == 200, r_list.text
        posts = r_list.json()["posts"]
        assert len(posts) == 1
        assert set(posts[0].keys()) == {"slug", "title", "summary", "tags", "lang", "published_at"}, \
            "list 응답 필드가 정본 계약과 다르다(랜딩이 조용히 빈 화면)"
        assert posts[0]["slug"] == "hello-world"
        assert r_list.headers.get("cache-control") == "public, s-maxage=60, stale-while-revalidate=300"

        assert r_detail.status_code == 200, r_detail.text
        detail = r_detail.json()
        assert set(detail.keys()) == {
            "slug", "title", "summary", "tags", "lang", "published_at", "body_md", "source_story_id",
        }, "detail 응답 필드가 정본 계약과 다르다"
        assert detail["body_md"] == "# 제목\n\n본문입니다."
        assert detail["source_story_id"] == str(story_id)
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_auto_passed_gate_also_counts_as_approved():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            await _seed_gate(s, org_id, story_id, status="auto_passed")
        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id)

        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts", json=_publish_body(work_item_id=story_id),
            )
        assert r.status_code == 201, r.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_invalid_slug_rejected_422():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            await _seed_gate(s, org_id, story_id, status="approved")
        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id)

        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts",
                json=_publish_body(work_item_id=story_id, slug="../x"),
            )
        assert r.status_code == 422, r.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_republish_same_org_lang_slug_upserts_single_row():
    from app.main import app
    from app.models.site_post import SitePost
    from sqlalchemy import func, select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            gate_id = await _seed_gate(s, org_id, story_id, status="approved")
        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id)

        async with _client_for(app) as client:
            await client.post(
                f"/api/v2/organizations/{org_id}/site-posts",
                json=_publish_body(work_item_id=story_id, gate_id=gate_id),
            )
            body2 = _publish_body(work_item_id=story_id, gate_id=gate_id)
            body2["title"] = "제목 수정판"
            r2 = await client.post(f"/api/v2/organizations/{org_id}/site-posts", json=body2)
        assert r2.status_code == 201, r2.text

        async with Session() as s:
            count = (await s.execute(select(func.count()).select_from(SitePost))).scalar_one()
            row = (await s.execute(select(SitePost).where(SitePost.slug == "hello-world"))).scalar_one()
        assert count == 1, "재발행인데 행이 늘었다(upsert 회귀)"
        assert row.title == "제목 수정판"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_unknown_public_key_returns_404_not_found():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        _setup_public_app(app, Session)
        async with _client_for(app) as client:
            r_list = await client.get("/api/v2/public/site-posts", params={"public_key": "garbage", "lang": "ko"})
            r_detail = await client.get(
                "/api/v2/public/site-posts/hello-world", params={"public_key": "garbage", "lang": "ko"},
            )
        assert r_list.status_code == 404
        assert r_list.json() == {"data": None, "error": {"code": "NOT_FOUND", "message": "not found"}, "meta": None}
        assert r_detail.status_code == 404
        assert r_detail.json() == {"data": None, "error": {"code": "NOT_FOUND", "message": "not found"}, "meta": None}
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_unknown_slug_returns_404():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            public_key = await _seed_metering_key(s, org_id)

        _setup_public_app(app, Session)
        async with _client_for(app) as client:
            r = await client.get(
                "/api/v2/public/site-posts/does-not-exist", params={"public_key": public_key, "lang": "ko"},
            )
        assert r.status_code == 404
        assert r.json() == {"data": None, "error": {"code": "NOT_FOUND", "message": "not found"}, "meta": None}
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_missing_lang_returns_400():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            public_key = await _seed_metering_key(s, org_id)

        _setup_public_app(app, Session)
        async with _client_for(app) as client:
            r = await client.get("/api/v2/public/site-posts", params={"public_key": public_key})
        assert r.status_code == 400, r.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_unpublished_post_excluded_from_public_reads():
    from app.main import app
    from app.models.site_post import SitePost
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            gate_id = await _seed_gate(s, org_id, story_id, status="approved")
            public_key = await _seed_metering_key(s, org_id)
        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id)

        async with _client_for(app) as client:
            await client.post(
                f"/api/v2/organizations/{org_id}/site-posts",
                json=_publish_body(work_item_id=story_id, gate_id=gate_id),
            )

        from datetime import datetime, timezone
        async with Session() as s:
            row = (await s.execute(select(SitePost).where(SitePost.slug == "hello-world"))).scalar_one()
            row.unpublished_at = datetime.now(timezone.utc)
            await s.commit()

        _setup_public_app(app, Session)
        async with _client_for(app) as public_client:
            r_list = await public_client.get(
                "/api/v2/public/site-posts", params={"public_key": public_key, "lang": "ko"},
            )
            r_detail = await public_client.get(
                "/api/v2/public/site-posts/hello-world", params={"public_key": public_key, "lang": "ko"},
            )
        assert r_list.json()["posts"] == [], "unpublished 글이 목록에 남아있다(회귀)"
        assert r_detail.status_code == 404, "unpublished 글의 본문이 여전히 공개 조회된다(회귀)"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_site_posts_cors_preflight_open():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        _setup_public_app(app, Session)
        async with _client_for(app) as client:
            r = await client.options(
                "/api/v2/public/site-posts",
                headers={"Origin": "https://sprintable.ai", "Access-Control-Request-Method": "GET"},
            )
        assert r.status_code == 204
        assert r.headers.get("access-control-allow-origin") == "*"
        assert "GET" in r.headers.get("access-control-allow-methods", "")
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
