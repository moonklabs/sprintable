"""story #3381(Phase0 후속·결함, 페드루 PO 확定 2026-09-03) — 발행 취소(비공개) 경로 신설.

AC 매핑:
- AC1: owner/admin이 «발행 취소»를 누르면 공개 API 단건 404·목록 제외·랜딩 404(행 보존).
- AC2: 에이전트 키의 unpublish는 403 SITE_POST_UNPUBLISH_HUMAN_ONLY.
- AC3: 비공개 뒤 내용 불변 재발행은 기존 승인으로 가능, 내용 변경 시 재승인 요구(S2 규율).
- AC4: activity_logs에 비공개 1건(actor_type=platform·수행 휴먼 기록).
- AC(추가, PO 결정 본문) — owner/admin 전용(단순 member 휴먼은 403).

뮤테이션 1건(스토리 본문 명시) — 휴먼 전용 가드(_require_owner_or_admin의 human 체크)를
제거하면 test_agent_gets_403_human_only가 200으로 RED가 되어야 한다."""
from __future__ import annotations

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

    org = Organization(id=uuid.uuid4(), name="Unpublish Test Org", slug=slug or f"org-{uuid.uuid4().hex[:8]}")
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


async def _org_member_id(session, org_id, user_id):
    """휴먼의 auth.user_id(users.id)가 아니라 org_member.id를 잰다 — resolve_member()가
    감사 로그 귀속에 실제로 쓰는 축(member-bound 리소스 관례)."""
    from app.models.project import OrgMember
    from sqlalchemy import select

    return (await session.execute(
        select(OrgMember.id).where(OrgMember.org_id == org_id, OrgMember.user_id == user_id)
    )).scalar_one()


async def _seed_default_role(session, org_id):
    from app.models.participation import ParticipationRole

    role = ParticipationRole(id=uuid.uuid4(), org_id=org_id, key="approver", label="Approver", is_default=True)
    session.add(role)
    await session.commit()
    return role.id


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def _setup_org_scoped_app(app, Session, org_id, *, user_id, agent: bool = False):
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
        claims = {"app_metadata": {"org_id": str(org_id)}}
        if agent:
            # resolve_member() 경로용 — is_agent_caller()는 DB 진실만 보지만
            # _require_owner_or_admin(resolve_member 경유)은 이 클레임으로 에이전트/휴먼을
            # 가른다(member_resolver.py::_resolve_member_legacy).
            claims["app_metadata"]["api_key_id"] = "test-agent-key"
        return AuthContext(user_id=str(user_id), email="caller@test", claims=claims)

    from tests.conftest import override_db_and_read
    override_db_and_read(app, _db)
    app.dependency_overrides[get_current_user] = _auth


def _draft_body(*, work_item_id, slug="2ho-blog", lang="ko", title="2호 글", body_md="# 제목\n\n본문입니다."):
    return {
        "work_item_id": str(work_item_id), "slug": slug, "lang": lang, "title": title,
        "summary": "요약입니다", "tags": ["ai"], "body_md": body_md, "media_manifest": [],
    }


async def _approve_gate_directly(session, gate_id, *, status="approved"):
    from app.models.gate import Gate
    from sqlalchemy import select

    gate = (await session.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()
    gate.status = status
    gate.resolver_id = uuid.uuid4()
    gate.resolved_at = datetime.now(timezone.utc)
    await session.commit()


async def _submit_and_approve(client, session, *, org_id, draft_id, status="approved"):
    r = await client.post(f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/submit", json={})
    assert r.status_code == 200, r.text
    gate_id = uuid.UUID(r.json()["gate_id"])
    await _approve_gate_directly(session, gate_id, status=status)
    return gate_id


async def _seed_and_publish(app, Session, *, org_id, project_id, human_role="owner"):
    """공통 셋업 — 에이전트가 초안 제출·상신·승인·human이 발행까지 마친 상태를 만든다.
    반환: (agent_id, human_id, story_id, draft_id, url)."""
    async with Session() as s:
        await _seed_default_role(s, org_id)
        agent_id = await _seed_agent(s, org_id, project_id)
        human_id = await _seed_human(s, org_id, role=human_role)
        story_id = await _seed_story(s, org_id, project_id)

    _setup_org_scoped_app(app, Session, org_id, user_id=agent_id)
    async with _client_for(app) as client, Session() as s:
        r_draft = await client.post(
            f"/api/v2/organizations/{org_id}/site-posts/drafts", json=_draft_body(work_item_id=story_id),
        )
        assert r_draft.status_code == 201, r_draft.text
        draft_id = r_draft.json()["draft_id"]
        await _submit_and_approve(client, s, org_id=org_id, draft_id=draft_id)

    _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
    async with _client_for(app) as client:
        r_pub = await client.post(f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/publish")
    assert r_pub.status_code == 200, r_pub.text
    return agent_id, human_id, story_id, draft_id, r_pub.json()["url"]


@pytest.mark.anyio
async def test_owner_unpublish_makes_public_404_and_list_excludes_row_preserved():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
        agent_id, human_id, story_id, draft_id, url = await _seed_and_publish(
            app, Session, org_id=org_id, project_id=project_id, human_role="owner",
        )

        from urllib.parse import urlparse
        parsed = urlparse(url)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r_unpub = await client.post(f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/unpublish")
        assert r_unpub.status_code == 200, r_unpub.text
        assert r_unpub.json()["slug"] == "2ho-blog"
        assert r_unpub.json()["unpublished_at"]

        # AC1 — 공개 단건 API 404.
        async with _client_for(app) as anon_client:
            r_public = await anon_client.get(parsed.path + "?" + parsed.query)
        assert r_public.status_code == 404, r_public.text

        # AC1 — 목록에서 제외.
        async with _client_for(app) as anon_client:
            r_list = await anon_client.get(
                f"/api/v2/public/site-posts?public_key={parsed.query.split('public_key=')[1].split('&')[0]}&lang=ko",
            )
        assert r_list.status_code == 200, r_list.text
        assert r_list.json()["posts"] == []

        # 행 보존(삭제 아님) — DB에서 직접 확認.
        async with Session() as s:
            from app.models.site_post import SitePost
            from sqlalchemy import select
            rows = (await s.execute(select(SitePost).where(SitePost.org_id == org_id))).scalars().all()
        assert len(rows) == 1
        assert rows[0].unpublished_at is not None
        assert rows[0].body_md == "# 제목\n\n본문입니다."
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_admin_role_can_also_unpublish():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
        agent_id, human_id, story_id, draft_id, url = await _seed_and_publish(
            app, Session, org_id=org_id, project_id=project_id, human_role="admin",
        )

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r_unpub = await client.post(f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/unpublish")
        assert r_unpub.status_code == 200, r_unpub.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_member_role_cannot_unpublish_403():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
        agent_id, human_id, story_id, draft_id, url = await _seed_and_publish(
            app, Session, org_id=org_id, project_id=project_id, human_role="member",
        )

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r_unpub = await client.post(f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/unpublish")
        assert r_unpub.status_code == 403, r_unpub.text
        assert r_unpub.json()["error"]["code"] == "SITE_POST_UNPUBLISH_OWNER_OR_ADMIN_ONLY", r_unpub.text

        # 목록·공개는 그대로 살아있어야 한다(거부됐으므로 아무 것도 안 바뀜).
        from urllib.parse import urlparse
        parsed = urlparse(url)
        async with _client_for(app) as anon_client:
            r_public = await anon_client.get(parsed.path + "?" + parsed.query)
        assert r_public.status_code == 200
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_agent_gets_403_human_only():
    """뮤테이션 대상 — _require_owner_or_admin의 human 체크를 제거하면 이 테스트가 200으로
    반드시 실패해야 한다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
        agent_id, human_id, story_id, draft_id, url = await _seed_and_publish(
            app, Session, org_id=org_id, project_id=project_id, human_role="owner",
        )

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r_unpub = await client.post(f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/unpublish")
        assert r_unpub.status_code == 403, r_unpub.text
        assert r_unpub.json()["error"]["code"] == "SITE_POST_UNPUBLISH_HUMAN_ONLY", r_unpub.text

        async with Session() as s:
            from app.models.site_post import SitePost
            from sqlalchemy import select
            row = (await s.execute(select(SitePost).where(SitePost.org_id == org_id))).scalar_one()
        assert row.unpublished_at is None, "거부됐는데 비공개 상태가 됐다"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_unpublish_writes_platform_activity_log_with_human_actor():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
        agent_id, human_id, story_id, draft_id, url = await _seed_and_publish(
            app, Session, org_id=org_id, project_id=project_id, human_role="owner",
        )

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r_unpub = await client.post(f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/unpublish")
        assert r_unpub.status_code == 200, r_unpub.text

        async with Session() as s:
            from app.models.activity_log import ActivityLog
            from sqlalchemy import select
            logs = (await s.execute(
                select(ActivityLog).where(
                    ActivityLog.org_id == org_id, ActivityLog.action == "site_post_unpublished",
                )
            )).scalars().all()
        assert len(logs) == 1
        log = logs[0]
        assert log.actor_type == "platform"
        assert log.actor_id is None
        async with Session() as s:
            expected_member_id = await _org_member_id(s, org_id, human_id)
        assert log.context["unpublished_by_member_id"] == str(expected_member_id), (
            "member id(org_member.id)가 아니라 user id를 기록하면 안 된다(member-bound 축)"
        )
        assert log.context["unpublished_by_member_id"] != str(human_id), (
            "user_id를 그대로 기록했다면(리그레션) 이 assertion이 잡는다 — "
            "human_id(users.id)와 org_member.id는 다른 값이어야 정상"
        )
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_republish_after_unpublish_with_unchanged_content_reuses_existing_approval():
    """AC3 — 비공개 뒤 내용 불변 재발행은 기존 승인으로 가능(재상신 불요)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
        agent_id, human_id, story_id, draft_id, url = await _seed_and_publish(
            app, Session, org_id=org_id, project_id=project_id, human_role="owner",
        )

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r_unpub = await client.post(f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/unpublish")
        assert r_unpub.status_code == 200, r_unpub.text

        # 재상신(submit) 없이 곧바로 재발행 — 기존 승인·봉인 그대로 유효해야 통과.
        async with _client_for(app) as client:
            r_republish = await client.post(f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/publish")
        assert r_republish.status_code == 200, r_republish.text

        from urllib.parse import urlparse
        parsed = urlparse(url)
        async with _client_for(app) as anon_client:
            r_public = await anon_client.get(parsed.path + "?" + parsed.query)
        assert r_public.status_code == 200
        assert r_public.json()["body_md"] == "# 제목\n\n본문입니다."

        async with Session() as s:
            from app.models.site_post import SitePost
            from sqlalchemy import select
            rows = (await s.execute(select(SitePost).where(SitePost.org_id == org_id))).scalars().all()
        assert len(rows) == 1, "재발행이 새 행을 만들면 안 된다(같은 org,lang,slug upsert)"
        assert rows[0].unpublished_at is None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_content_changed_after_unpublish_requires_reapproval():
    """AC3 — 비공개 뒤 내용이 바뀌면(S2 규율대로 게이트가 pending+reapproval_required로
    되돌아감) 재상신·재승인 없는 재발행 시도는 403(승인 필요)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
        agent_id, human_id, story_id, draft_id, url = await _seed_and_publish(
            app, Session, org_id=org_id, project_id=project_id, human_role="owner",
        )

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r_unpub = await client.post(f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/unpublish")
        assert r_unpub.status_code == 200, r_unpub.text

        # 내용 편집(새 버전) — 승인된 적 있는 게이트라 pending+reapproval_required로 되돌아간다.
        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id)
        async with _client_for(app) as client:
            r_v2 = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts",
                json=_draft_body(work_item_id=story_id, body_md="# 제목\n\n수정된 본문."),
            )
        assert r_v2.status_code == 201, r_v2.text

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r_republish = await client.post(f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/publish")
        assert r_republish.status_code == 403, r_republish.text
        assert r_republish.json()["error"]["code"] == "EXTERNAL_PUBLISH_APPROVAL_REQUIRED"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_unpublish_unknown_draft_404():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, role="owner")

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r_unpub = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts/{uuid.uuid4()}/unpublish",
            )
        assert r_unpub.status_code == 404, r_unpub.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_unpublish_when_nothing_currently_published_returns_409():
    """draft는 존재하지만(초안만 있고 발행된 적 없음) 비공개할 대상 자체가 없는 경우."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            human_id = await _seed_human(s, org_id, role="owner")
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id)
        async with _client_for(app) as client:
            r_draft = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts", json=_draft_body(work_item_id=story_id),
            )
        draft_id = r_draft.json()["draft_id"]
        # submit·publish 전혀 안 함 — 발행된 적 없는 초안.

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r_unpub = await client.post(f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/unpublish")
        assert r_unpub.status_code == 409, r_unpub.text
        assert r_unpub.json()["error"]["code"] == "SITE_POST_NOT_PUBLISHED", r_unpub.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_double_unpublish_returns_409_second_time():
    """이미 비공개된 것을 다시 unpublish하면 409(대상이 없다는 뜻은 동일)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
        agent_id, human_id, story_id, draft_id, url = await _seed_and_publish(
            app, Session, org_id=org_id, project_id=project_id, human_role="owner",
        )

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r1 = await client.post(f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/unpublish")
        assert r1.status_code == 200, r1.text

        async with _client_for(app) as client:
            r2 = await client.post(f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/unpublish")
        assert r2.status_code == 409, r2.text
        assert r2.json()["error"]["code"] == "SITE_POST_NOT_PUBLISHED"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_two_languages_published_for_same_work_item_unpublish_only_targets_its_own_draft():
    """페드루 PO 코드리뷰(2026-09-03 11:02Z) 회귀 — 같은 work_item에 서로 다른 slug·lang의
    글 둘이 발행돼 있을 때(_upsert_site_post_row의 유일키는 (org_id,lang,slug)라 둘 다
    별개 행) 한쪽만 unpublish해도 MultipleResultsFound(500) 없이 정확히 그 draft의 행만
    비공개되고 다른 언어는 그대로 공개 유지돼야 한다.

    두 SitePost 행을 직접 시드한다(HTTP 왕복 아님) — 이 시스템의 게이트는 work_item_id
    하나당 1개뿐이라(submit_site_post_draft가 work_item_id로만 게이트를 찾는다) 같은
    work_item의 두 draft를 정상 submit→approve→publish 왕복으로 각각 승인시키면 나중
    submit이 먼저 승인된 게이트를 되밟아 pending으로 되돌려 버린다(이 자체가 이 스토리
    범위 밖의 별개 기존 결함 후보 — 이 테스트는 그와 무관하게 «두 언어 행이 이미 공존하는
    상태에서 unpublish의 조회 축이 유일한지»만 검증한다)."""
    from app.main import app
    from app.models.site_post import SitePost
    from app.models.site_post_draft import SitePostDraft
    from app.models.site_post_version import SitePostVersion

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, role="owner")
            story_id = await _seed_story(s, org_id, project_id)

            gate_id = uuid.uuid4()
            fake_author = uuid.uuid4()

            draft_ko = SitePostDraft(id=uuid.uuid4(), org_id=org_id, work_item_id=story_id, slug="2ho-blog-ko")
            draft_en = SitePostDraft(id=uuid.uuid4(), org_id=org_id, work_item_id=story_id, slug="2ho-blog-en")
            s.add_all([draft_ko, draft_en])
            await s.flush()

            s.add_all([
                SitePostVersion(
                    id=uuid.uuid4(), draft_id=draft_ko.id, version=1, title="2호 글(ko)", lang="ko",
                    summary="요약", tags=[], body_md="한국어 본문", body_sha256="ko-sha",
                    author_member_id=fake_author, author_kind="human",
                ),
                SitePostVersion(
                    id=uuid.uuid4(), draft_id=draft_en.id, version=1, title="2호 글(en)", lang="en",
                    summary="summary", tags=[], body_md="English body", body_sha256="en-sha",
                    author_member_id=fake_author, author_kind="human",
                ),
            ])

            s.add_all([
                SitePost(
                    id=uuid.uuid4(), org_id=org_id, lang="ko", slug="2ho-blog-ko", title="2호 글(ko)",
                    summary="요약", tags=[], body_md="한국어 본문", published_at=datetime.now(timezone.utc),
                    source_story_id=story_id, gate_id=gate_id, created_by_member_id=fake_author,
                    unpublished_at=None,
                ),
                SitePost(
                    id=uuid.uuid4(), org_id=org_id, lang="en", slug="2ho-blog-en", title="2호 글(en)",
                    summary="summary", tags=[], body_md="English body", published_at=datetime.now(timezone.utc),
                    source_story_id=story_id, gate_id=gate_id, created_by_member_id=fake_author,
                    unpublished_at=None,
                ),
            ])
            await s.commit()

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r_unpub = await client.post(f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_ko.id}/unpublish")
        assert r_unpub.status_code == 200, r_unpub.text  # MultipleResultsFound(500)면 여기서 잡힌다

        async with Session() as s:
            from sqlalchemy import select
            ko_post = (await s.execute(
                select(SitePost).where(SitePost.org_id == org_id, SitePost.slug == "2ho-blog-ko")
            )).scalar_one()
            en_post = (await s.execute(
                select(SitePost).where(SitePost.org_id == org_id, SitePost.slug == "2ho-blog-en")
            )).scalar_one()
        assert ko_post.unpublished_at is not None, "ko만 비공개 대상이었다"
        assert en_post.unpublished_at is None, "en은 건드리면 안 된다"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
