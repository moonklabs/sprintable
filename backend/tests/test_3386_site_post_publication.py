"""story #3386(Phase0 결함, 유나 원인 진단·페드루 PO 확定 2026-09-03) — 상세 화면 S8
(발행됨·URL·행위자) 계약 신설: GET .../site-posts/drafts/{draft_id}/publication.

원인: FE가 deriveContentPostStatus()에 hasPublishedSitePost를 항상 undefined로 넘겨(서버
계약 자체가 없었음) 발행된 글도 "승인됨"으로 그려지고 URL·행위자가 안 보이고 «발행» 버튼이
다시 열려 있었다. 이 endpoint가 그 입력을 실제 값으로 채운다.

AC 매핑:
- 발행된 draft → published_at·url·published_by_member_id·published_body_sha256 전부 실값.
- 발행된 적 없는 draft → 404가 아니라 200+전부 null(「모른다」와 「발행 안 됐다」를 구별 —
  draft 자체가 없다=404, 발행 안 됐다=200+null).
- unpublish된 draft → 다시 전부 null(story #3381의 unpublished_at 축과 동일 조회 규율).
- published_body_sha256은 "지금 라이브인 본문"의 해시다 — 승인 후 편집(재승인 대기 중)해도
  아직 재발행 전이면 이 값은 옛 내용 그대로다(재발행 가능 판정의 축)."""
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

    org = Organization(id=uuid.uuid4(), name="Publication Test Org", slug=slug or f"org-{uuid.uuid4().hex[:8]}")
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


async def _org_member_id(session, *, org_id, user_id) -> str:
    """story 194acb63 — published_by_member_id는 이제 org_member.id다(auth.user_id/User.id
    가 아니다). 테스트가 실제로 그 값을 검증하려면 시드 결과를 되짚어 읽어야 한다(#3739
    리뷰의 _org_member_id() 패턴 그대로)."""
    from app.models.project import OrgMember
    from sqlalchemy import select

    member_id = (await session.execute(
        select(OrgMember.id).where(OrgMember.org_id == org_id, OrgMember.user_id == user_id)
    )).scalar_one()
    return str(member_id)


@pytest.mark.anyio
async def test_publication_info_all_fields_present_when_published():
    """story 194acb63(배포 11 실측) 정정 반영 — url은 이제 발행 액션 자체의 url(백엔드
    API 주소 폴백, `_resolve_public_url`)과 더는 같지 않다(그게 결함이었다). 이 endpoint의
    url은 `settings.public_site_base_url`(랜딩 베이스) 전용 경로로 따로 조립된다 —
    테스트는 그 설정을 직접 주입해 실제 랜딩 URL 패턴을 검증한다. published_by_member_id도
    org_member.id로 정정."""
    from app.core.config import settings as app_settings
    from app.main import app

    engine, Session = await _session_factory()
    original_base_url = app_settings.public_site_base_url
    app_settings.public_site_base_url = "https://sprintable.ai"
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            human_id = await _seed_human(s, org_id, role="owner")
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
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

        async with _client_for(app) as client:
            r_info = await client.get(f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/publication")
        assert r_info.status_code == 200, r_info.text
        body = r_info.json()
        assert body["published_at"] == r_pub.json()["published_at"]
        assert body["url"] == "https://sprintable.ai/ko/blog/2ho-blog"
        assert "public_key" not in body["url"] and "run.app" not in body["url"], (
            "공개 URL이 백엔드 API 주소로 새면 안 된다(배포 11 실사고 재현 방지)"
        )
        async with Session() as s:
            from app.models.project import OrgMember
            from sqlalchemy import select

            expected_member_id = await _org_member_id(s, org_id=org_id, user_id=human_id)
            exists = (await s.execute(
                select(OrgMember.id).where(OrgMember.id == uuid.UUID(body["published_by_member_id"]))
            )).scalar_one_or_none()
        assert exists is not None, "AC — published_by_member_id는 org_members 테이블에 실존해야 한다"
        assert body["published_by_member_id"] == expected_member_id
        assert body["published_by_member_id"] != str(human_id), (
            "published_by_member_id가 User.id 그대로면 안 된다(org_member.id여야 한다)"
        )
        assert body["published_body_sha256"]  # 실값(빈 문자열/None 아님)
    finally:
        app_settings.public_site_base_url = original_base_url
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_publication_url_null_when_public_site_base_url_unset():
    """AC1 — 랜딩 베이스(settings.public_site_base_url)가 미설정이면(오늘 dev의 실제
    기본값, deploy SSOT로 아직 안 채워졌던 상태와 동형) url은 지어내지 않고 null이다 —
    백엔드 API 주소로 몰래 폴백하지 않는다(그게 바로 배포 11 결함이었다)."""
    from app.core.config import settings as app_settings
    from app.main import app

    engine, Session = await _session_factory()
    original_base_url = app_settings.public_site_base_url
    app_settings.public_site_base_url = ""
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            human_id = await _seed_human(s, org_id, role="owner")
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client, Session() as s:
            r_draft = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts", json=_draft_body(work_item_id=story_id),
            )
            draft_id = r_draft.json()["draft_id"]
            await _submit_and_approve(client, s, org_id=org_id, draft_id=draft_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r_pub = await client.post(f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/publish")
        assert r_pub.status_code == 200, r_pub.text

        async with _client_for(app) as client:
            r_info = await client.get(f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/publication")
        assert r_info.status_code == 200, r_info.text
        assert r_info.json()["url"] is None, "랜딩 베이스 미설정이면 url은 null이어야 한다(지어내지 않는다)"
    finally:
        app_settings.public_site_base_url = original_base_url
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_publication_info_all_null_when_never_published_not_404():
    """AC6 — 「모른다」와 「발행 안 됐다」는 다른 신호다: draft 자체가 없으면 404, draft는
    있는데 발행 이력이 없으면 200+전부 null."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r_draft = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts", json=_draft_body(work_item_id=story_id),
            )
            draft_id = r_draft.json()["draft_id"]
            # submit·publish 전혀 안 함.

            r_info = await client.get(f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/publication")
        assert r_info.status_code == 200, r_info.text
        assert r_info.json() == {
            "published_at": None, "url": None, "published_by_member_id": None, "published_body_sha256": None,
            "destination": "hosted_site", "channel_publication": None, "command": None,
        }
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_publication_info_404_for_unknown_draft():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, role="owner")

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r_info = await client.get(
                f"/api/v2/organizations/{org_id}/site-posts/drafts/{uuid.uuid4()}/publication",
            )
        assert r_info.status_code == 404, r_info.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_publication_info_all_null_after_unpublish():
    """story #3381 축 재사용 확認 — unpublished_at을 세우면(직접 DB, #3739 병합 전 이
    브랜치에 그 라우터가 아직 없어 서비스 축만 재현) publication 조회도 즉시 null로
    돌아간다(같은 (org,lang,slug) 조회 규율을 공유하므로 자연히 일치)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            human_id = await _seed_human(s, org_id, role="owner")
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client, Session() as s:
            r_draft = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts", json=_draft_body(work_item_id=story_id),
            )
            draft_id = r_draft.json()["draft_id"]
            await _submit_and_approve(client, s, org_id=org_id, draft_id=draft_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r_pub = await client.post(f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/publish")
        assert r_pub.status_code == 200, r_pub.text

        async with Session() as s:
            from app.models.site_post import SitePost
            from sqlalchemy import select, update
            post_id = (await s.execute(
                select(SitePost.id).where(SitePost.org_id == org_id, SitePost.slug == "2ho-blog")
            )).scalar_one()
            await s.execute(
                update(SitePost).where(SitePost.id == post_id).values(unpublished_at=datetime.now(timezone.utc))
            )
            await s.commit()

        async with _client_for(app) as client:
            r_info = await client.get(f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/publication")
        assert r_info.status_code == 200, r_info.text
        assert r_info.json() == {
            "published_at": None, "url": None, "published_by_member_id": None, "published_body_sha256": None,
            "destination": "hosted_site", "channel_publication": None, "command": None,
        }
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_published_body_sha256_reflects_live_content_not_pending_edit():
    """AC2 판단 근거 — 승인 후 편집(새 버전 생성, 재승인 대기)해도 아직 재발행을 누르지
    않았으면 published_body_sha256은 여전히 «라이브인» 옛 내용의 해시다. FE가 이 값을
    gate.sealed_content_sha256과 비교해 "재승인된 새 버전이 아직 안 나갔다"를 판정한다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            human_id = await _seed_human(s, org_id, role="owner")
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client, Session() as s:
            r_draft = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts", json=_draft_body(work_item_id=story_id),
            )
            draft_id = r_draft.json()["draft_id"]
            await _submit_and_approve(client, s, org_id=org_id, draft_id=draft_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r_pub = await client.post(f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/publish")
        assert r_pub.status_code == 200, r_pub.text

        async with _client_for(app) as client:
            r_info_before = await client.get(
                f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/publication",
            )
        live_sha_before_edit = r_info_before.json()["published_body_sha256"]

        # 승인 후 편집 — 새 버전(재승인 대기), 아직 재발행은 안 눌렀다.
        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r_v2 = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts",
                json=_draft_body(work_item_id=story_id, body_md="# 제목\n\n수정된 본문."),
            )
        assert r_v2.status_code == 201, r_v2.text

        async with _client_for(app) as client:
            r_info_after = await client.get(
                f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/publication",
            )
        assert r_info_after.json()["published_body_sha256"] == live_sha_before_edit, (
            "재발행을 안 눌렀는데 published_body_sha256이 바뀌면 안 된다(아직 라이브가 옛 버전)"
        )
        assert r_info_after.json()["published_at"] == r_info_before.json()["published_at"], (
            "published_at도 재발행 전엔 그대로여야 한다"
        )
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_agent_can_read_publication_info_no_human_only_restriction():
    """열람은 승인·발행 경계 밖 — list_site_post_drafts_endpoint와 동일 관례, 에이전트도
    읽을 수 있다(토큰은 안 실리므로 노출 위험 없음)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r_draft = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts", json=_draft_body(work_item_id=story_id),
            )
            draft_id = r_draft.json()["draft_id"]
            r_info = await client.get(f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/publication")
        assert r_info.status_code == 200, r_info.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
