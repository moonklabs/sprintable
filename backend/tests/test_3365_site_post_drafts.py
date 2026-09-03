"""story #3365(Phase0 S1·마케팅 운영 블루프린트 v3, 선생님 확定 2026-09-03) — 고객 에이전트가
공개 권한 없이 블로그 초안·불변 버전을 등록한다.

AC 매핑:
- AC1: 고객 에이전트가 초안 생성 API에 제출 → 201, 공개 `SitePost` 행 0.
- AC2: 원작성 주체 서버 판정(agent) — body엔 author 필드 자체가 없어 위조 표면이 없다.
- AC3: 동일 초안을 휴먼이 수정 → 새 불변 버전(기존 버전 보존).
- AC4(공개 절반): 에이전트가 공개 API(POST /site-posts)를 부르면 403 SITE_POST_PUBLISH_HUMAN_ONLY
  — 테스트는 test_3360_site_posts.py에 있다(그 파일의 사이드카).
- AC5: media_manifest 비어있지 않으면 422 MEDIA_NOT_SUPPORTED_PHASE0.
- AC6: 버전 이력 조회 시 에이전트 원안·휴먼 개정본이 별도 버전으로 관측.
  AC4(승인 절반)의 기존 가드 회귀 고정은 test_3365_external_publish_gate_human_only.py(real
  Postgres 불요 — mock 단위 테스트라 이 파일과 분리했다).

뮤테이션 1건(스토리 본문 명시) — 에이전트 공개 차단 조건 제거는 test_3360_site_posts.py의
전용 테스트가 검증한다(자체검증 완료).

seed 하네스는 test_3360_site_posts.py 패턴 그대로 재사용."""
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

    org = Organization(id=uuid.uuid4(), name="Draft Test Org", slug=slug or f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    return org.id, project.id


async def _seed_agent(session, org_id, project_id, *, name="담롱"):
    from app.models.team import TeamMember

    m = TeamMember(id=uuid.uuid4(), org_id=org_id, project_id=project_id, type="agent", name=name, is_active=True)
    session.add(m)
    await session.commit()
    return m.id


async def _seed_human(session, org_id, *, role="member"):
    from app.models.project import OrgMember
    from app.models.user import User

    user = User(id=uuid.uuid4(), email=f"human-{uuid.uuid4().hex[:8]}@test.dev", hashed_password="x")
    session.add(user)
    await session.commit()
    om = OrgMember(id=uuid.uuid4(), org_id=org_id, user_id=user.id, role=role)
    session.add(om)
    await session.commit()
    return user.id


async def _seed_story(session, org_id, project_id, *, title="2호 글"):
    from app.models.pm import Story

    story = Story(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title)
    session.add(story)
    await session.commit()
    return story.id


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def _setup_org_scoped_app(app, Session, org_id, *, user_id):
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
            user_id=str(user_id), email="caller@test",
            claims={"app_metadata": {"org_id": str(org_id)}},
        )

    from tests.conftest import override_db_and_read
    override_db_and_read(app, _db)
    app.dependency_overrides[get_current_user] = _auth


def _draft_body(*, work_item_id, slug="2ho-blog", lang="ko", title="2호 글", media_manifest=None):
    return {
        "work_item_id": str(work_item_id), "slug": slug, "lang": lang, "title": title,
        "summary": "요약입니다", "tags": ["ai"], "body_md": "# 제목\n\n본문입니다.",
        "media_manifest": media_manifest if media_manifest is not None else [],
    }


@pytest.mark.anyio
async def test_agent_creates_draft_returns_201_and_zero_public_rows():
    from app.main import app
    from app.models.site_post import SitePost
    from sqlalchemy import func, select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id)

        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts", json=_draft_body(work_item_id=story_id),
            )
        assert r.status_code == 201, r.text
        payload = r.json()
        assert payload["version"] == 1
        assert uuid.UUID(payload["draft_id"])
        assert uuid.UUID(payload["version_id"])

        async with Session() as s:
            from app.models.site_post_version import SitePostVersion
            version = (await s.execute(
                select(SitePostVersion).where(SitePostVersion.id == uuid.UUID(payload["version_id"]))
            )).scalar_one()
            public_count = (await s.execute(select(func.count()).select_from(SitePost))).scalar_one()
        assert version.author_kind == "agent"
        assert version.author_member_id == agent_id
        assert public_count == 0, "초안 제출만으로 공개 SitePost 행이 생겼다(경계 회귀)"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_human_edit_creates_new_version_and_preserves_original():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            human_id = await _seed_human(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id)
        async with _client_for(app) as client:
            r1 = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts",
                json=_draft_body(work_item_id=story_id, title="에이전트 원안"),
            )
        assert r1.status_code == 201, r1.text
        draft_id = r1.json()["draft_id"]

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r2 = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts",
                json=_draft_body(work_item_id=story_id, title="휴먼 개정판"),
            )
        assert r2.status_code == 201, r2.text
        assert r2.json()["version"] == 2
        assert r2.json()["draft_id"] == draft_id, "같은 (org,work_item,slug)인데 새 draft가 생겼다"

        async with _client_for(app) as client:
            r_hist = await client.get(f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/versions")
        assert r_hist.status_code == 200, r_hist.text
        versions = r_hist.json()
        assert len(versions) == 2
        assert versions[0]["version"] == 1
        assert versions[0]["title"] == "에이전트 원안"
        assert versions[0]["author_kind"] == "agent"
        assert versions[1]["version"] == 2
        assert versions[1]["title"] == "휴먼 개정판"
        assert versions[1]["author_kind"] == "human"
        assert versions[0]["body_sha256"] != versions[1]["body_sha256"]
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_nonempty_media_manifest_returns_422_media_not_supported_phase0():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id)

        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts",
                json=_draft_body(work_item_id=story_id, media_manifest=[{"url": "https://x/y.png"}]),
            )
        assert r.status_code == 422, r.text
        assert r.json()["error"]["code"] == "MEDIA_NOT_SUPPORTED_PHASE0", r.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_unknown_draft_id_versions_returns_404():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id)
        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)

        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_id}/site-posts/drafts/{uuid.uuid4()}/versions")
        assert r.status_code == 404, r.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
