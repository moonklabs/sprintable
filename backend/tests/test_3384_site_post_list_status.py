"""story #3384(Phase0 결함, 유나 원인 진단·페드루 PO 확定 2026-09-03) — 목록 상태 칩이
게이트/발행 유무와 무관하게 항상 "초안"으로만 뜨던 결함의 근본 수정.

원인: `GET /site-posts/drafts` 목록 응답이 게이트·발행 파생 필드를 아예 담지 않았다(FE가
`deriveContentPostStatus({})`를 빈 입력으로 호출 — 상세 페이지(story #3386)가 이미 겪은
동일 계약 갭의 목록판). 수정: `list_site_post_drafts()`가 배치 조회(게이트 1건·site_posts
1건, 페이지 쿼리 포함 총 3건 고정)로 게이트·발행 상태를 붙이고, 라우터가 그 필드를 그대로
응답에 얹는다 — 상세 계약(story #3386)과 필드명 한 벌(gate_status·reapproval_required·
sealed_content_sha256·body_sha256·published_at).

AC 매핑(스토리 본문):
- 게이트 없는 초안 → gate_status/reapproval_required/sealed_content_sha256/published_at
  전부 None(지어내지 않는다).
- pending 게이트 → gate_status='pending'.
- approved 게이트 + 발행됨(site_posts 행 존재) → gate_status='approved'·published_at 값.
- body_sha256은 항상(필수 필드) 최신 버전의 해시를 그대로 반영.

seed 하네스는 test_3365_site_post_drafts.py 패턴 그대로 재사용."""
from __future__ import annotations

import hashlib
import os
import uuid
from datetime import datetime, timezone

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

    org = Organization(id=uuid.uuid4(), name="List Status Test Org", slug=slug or f"org-{uuid.uuid4().hex[:8]}")
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


async def _seed_story(session, org_id, project_id, *, title="글"):
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


def _draft_body(*, work_item_id, slug="blog", lang="ko", title="글", body_md="# 제목\n\n본문입니다."):
    return {
        "work_item_id": str(work_item_id), "slug": slug, "lang": lang, "title": title,
        "summary": "요약입니다", "tags": ["ai"], "body_md": body_md, "media_manifest": [],
    }


def _body_sha256(*, title, lang, summary, tags, body_md):
    from app.services.site_posts import compute_body_sha256
    return compute_body_sha256(title=title, lang=lang, summary=summary, tags=tags, body_md=body_md)


async def _seed_gate(session, *, org_id, work_item_id, status, reapproval_required=False, sealed_content_sha256=None):
    from app.models.gate import Gate

    g = Gate(
        id=uuid.uuid4(), org_id=org_id, work_item_id=work_item_id, work_item_type="story",
        gate_type="external_publish", status=status, reapproval_required=reapproval_required,
        sealed_content_sha256=sealed_content_sha256,
    )
    session.add(g)
    await session.commit()
    return g.id


async def _seed_site_post(
    session, *, org_id, lang, slug, title, summary, tags, body_md, gate_id, created_by_member_id, source_story_id,
):
    from app.models.site_post import SitePost

    p = SitePost(
        id=uuid.uuid4(), org_id=org_id, slug=slug, lang=lang, title=title, summary=summary, tags=tags,
        body_md=body_md, gate_id=gate_id, created_by_member_id=created_by_member_id,
        source_story_id=source_story_id, published_at=datetime.now(timezone.utc),
    )
    session.add(p)
    await session.commit()
    return p.id


@pytest.mark.anyio
async def test_list_reflects_gate_and_publication_state_per_draft():
    """AC — 게이트/발행 없는 초안·pending 게이트 초안·approved+발행된 초안이 각기 다른
    gate_status/published_at으로 목록에 뜬다(전부 'draft'로 뭉개지지 않는다, #3384 결함
    그 자체를 직접 재현·회귀 방지)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            story_none = await _seed_story(s, org_id, project_id, title="게이트 없음")
            story_pending = await _seed_story(s, org_id, project_id, title="심사중")
            story_published = await _seed_story(s, org_id, project_id, title="발행됨")

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id)
        async with _client_for(app) as client:
            r_none = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts",
                json=_draft_body(work_item_id=story_none, slug="none-slug", title="게이트 없음"),
            )
            r_pending = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts",
                json=_draft_body(work_item_id=story_pending, slug="pending-slug", title="심사중"),
            )
            r_pub = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts",
                json=_draft_body(work_item_id=story_published, slug="pub-slug", title="발행됨"),
            )
        assert r_none.status_code == 201, r_none.text
        assert r_pending.status_code == 201, r_pending.text
        assert r_pub.status_code == 201, r_pub.text

        pub_sha = _body_sha256(
            title="발행됨", lang="ko", summary="요약입니다", tags=["ai"], body_md="# 제목\n\n본문입니다.",
        )
        async with Session() as s:
            await _seed_gate(s, org_id=org_id, work_item_id=story_pending, status="pending")
            pub_gate_id = await _seed_gate(
                s, org_id=org_id, work_item_id=story_published, status="approved",
                sealed_content_sha256=pub_sha,
            )
            await _seed_site_post(
                s, org_id=org_id, lang="ko", slug="pub-slug", title="발행됨", summary="요약입니다",
                tags=["ai"], body_md="# 제목\n\n본문입니다.", gate_id=pub_gate_id, created_by_member_id=agent_id,
                source_story_id=story_published,
            )

        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_id}/site-posts/drafts")
        assert r.status_code == 200, r.text
        by_slug = {item["slug"]: item for item in r.json()}
        assert set(by_slug) == {"none-slug", "pending-slug", "pub-slug"}

        none_item = by_slug["none-slug"]
        assert none_item["gate_status"] is None
        assert none_item["reapproval_required"] is None
        assert none_item["sealed_content_sha256"] is None
        assert none_item["published_at"] is None
        assert none_item["body_sha256"], "body_sha256은 게이트/발행과 무관하게 항상 있어야 한다"

        pending_item = by_slug["pending-slug"]
        assert pending_item["gate_status"] == "pending"
        assert pending_item["published_at"] is None

        pub_item = by_slug["pub-slug"]
        assert pub_item["gate_status"] == "approved"
        assert pub_item["sealed_content_sha256"] == pub_sha
        assert pub_item["published_at"] is not None

        # 결함 재현 그 자체 — 세 항목이 전부 'draft'와 동형으로 뭉개지지 않는다(gate_status
        # 축에서 최소 하나는 None이 아니어야 한다, 원 결함의 정확한 반대 명제).
        assert any(item["gate_status"] is not None for item in by_slug.values())
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
