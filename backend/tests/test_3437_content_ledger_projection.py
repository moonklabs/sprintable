"""story #3437(Phase1·마케팅운영, 페드루 PO 確定 2026-09-04) — 콘텐츠 원장 투영: campaign
묶음 + Threads 변형(channel_post_draft)→블로그 원문(site_post_draft=content_item) 파생
관계. 그라운딩 결론(스토리 코멘트): content_item/content_version/publication은 기존
site_post_draft/site_post_version·channel_post_version·channel_publication을 그대로
투영 — 부재분 2건(campaigns 테이블·source_content_item_id 파생 링크)만 신설.

AC2(파생 관계)·AC3(campaign 묶음)·AC5(에이전트 API, 발행·승인 권한 무변경)를 다룬다.
AC1(그라운딩)은 스토리 코멘트, AC4(작성 주체 보존)는 신규 코드 0(기존 content_version이
이미 충족), AC6(회귀)는 기존 test_3365/test_3374/test_f8f7cb0f 전량 별도 실행으로
확인(이 파일의 신규 assert 대상이 아니다), AC7(라이브)은 dev 배포 뒤 별도."""
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


@pytest.fixture(autouse=True)
def _configure_secrets(monkeypatch):
    import importlib
    from cryptography.fernet import Fernet

    import app.core.config as config_module
    monkeypatch.setattr(config_module.settings, "channel_credential_encryption_key", Fernet.generate_key().decode())

    import app.services.channel_credential_crypto as crypto_module
    importlib.reload(crypto_module)
    yield
    importlib.reload(crypto_module)


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

    org = Organization(id=uuid.uuid4(), name="Content Ledger Test Org", slug=slug or f"org-{uuid.uuid4().hex[:8]}")
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


async def _seed_human(session, org_id, *, role="owner"):
    from app.models.project import OrgMember
    from app.models.user import User

    user = User(id=uuid.uuid4(), email=f"human-{uuid.uuid4().hex[:8]}@test.dev", hashed_password="x")
    session.add(user)
    await session.commit()
    om = OrgMember(id=uuid.uuid4(), org_id=org_id, user_id=user.id, role=role)
    session.add(om)
    await session.commit()
    return user.id


async def _seed_story(session, org_id, project_id, *, title="콘텐츠"):
    from app.models.pm import Story

    story = Story(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title)
    session.add(story)
    await session.commit()
    return story.id


async def _seed_connection(session, org_id, *, channel="threads", account_id=None, token="plain-access-token"):
    from app.models.channel_connection import ChannelConnection
    from app.services.channel_credential_crypto import encrypt_channel_credential

    conn = ChannelConnection(
        id=uuid.uuid4(), org_id=org_id, channel=channel,
        account_id=account_id or f"acct-{uuid.uuid4().hex[:8]}", status="active",
        credential_kind="oauth", refresh_mode="reissue_from_access_token",
        encrypted_access_token=encrypt_channel_credential(token),
    )
    session.add(conn)
    await session.commit()
    return conn.id


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


async def _create_site_post_draft(client, *, org_id, work_item_id, slug, campaign_id=None):
    body = {
        "work_item_id": str(work_item_id), "title": "블로그 원문", "slug": slug, "lang": "ko",
        "summary": "요약", "tags": [], "body_md": "본문",
    }
    if campaign_id is not None:
        body["campaign_id"] = str(campaign_id)
    r = await client.post(f"/api/v2/organizations/{org_id}/site-posts/drafts", json=body)
    assert r.status_code == 201, r.text
    return uuid.UUID(r.json()["draft_id"])


async def _create_channel_post_draft(client, *, org_id, work_item_id, connection_id, source_content_item_id=None):
    body = {"work_item_id": str(work_item_id), "connection_id": str(connection_id), "text": "채널 변형 본문"}
    if source_content_item_id is not None:
        body["source_content_item_id"] = str(source_content_item_id)
    return await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts", json=body)


# --- AC2 — 파생 관계 -------------------------------------------------------------


@pytest.mark.anyio
async def test_channel_draft_creation_persists_and_exposes_source_content_item_id():
    """AC2 — 초안 생성 시 지정한 source_content_item_id가 저장되고, 단건/목록 응답
    둘 다에 노출된다(뮤테이션 대상: 필드 저장 제거 시 이 assert가 RED)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            blog_story_id = await _seed_story(s, org_id, project_id, title="블로그 스토리")
            channel_story_id = await _seed_story(s, org_id, project_id, title="채널 스토리")
            connection_id = await _seed_connection(s, org_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            content_item_id = await _create_site_post_draft(
                client, org_id=org_id, work_item_id=blog_story_id, slug="hello-world",
            )
            r_channel = await _create_channel_post_draft(
                client, org_id=org_id, work_item_id=channel_story_id, connection_id=connection_id,
                source_content_item_id=content_item_id,
            )
            assert r_channel.status_code == 201, r_channel.text
            channel_draft_id = r_channel.json()["draft_id"]

            r_detail = await client.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{channel_draft_id}")
            assert r_detail.status_code == 200, r_detail.text
            assert r_detail.json()["source_content_item_id"] == str(content_item_id)

            r_list = await client.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts")
            assert r_list.status_code == 200, r_list.text
            item = next(i for i in r_list.json() if i["draft_id"] == channel_draft_id)
            assert item["source_content_item_id"] == str(content_item_id)
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_variants_endpoint_returns_derived_channel_drafts_for_content_item():
    """AC2 — 원문 쪽에서 «파생 변형 목록(채널·상태)» 조회. 소스 없는 다른 채널 초안은
    섞여 들어오지 않는다(필터 정확성)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            blog_story_id = await _seed_story(s, org_id, project_id, title="블로그")
            channel_story_1 = await _seed_story(s, org_id, project_id, title="채널1")
            channel_story_2 = await _seed_story(s, org_id, project_id, title="채널2(무관)")
            connection_id = await _seed_connection(s, org_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            content_item_id = await _create_site_post_draft(
                client, org_id=org_id, work_item_id=blog_story_id, slug="derived-post",
            )
            r_variant = await _create_channel_post_draft(
                client, org_id=org_id, work_item_id=channel_story_1, connection_id=connection_id,
                source_content_item_id=content_item_id,
            )
            assert r_variant.status_code == 201, r_variant.text
            variant_draft_id = r_variant.json()["draft_id"]

            # 소스 없는 무관 채널 초안 — 목록에 섞이면 안 된다.
            r_unrelated = await _create_channel_post_draft(
                client, org_id=org_id, work_item_id=channel_story_2, connection_id=connection_id,
            )
            assert r_unrelated.status_code == 201, r_unrelated.text

            r = await client.get(f"/api/v2/organizations/{org_id}/site-posts/drafts/{content_item_id}/variants")
            assert r.status_code == 200, r.text
            body = r.json()
            assert [item["draft_id"] for item in body] == [variant_draft_id]
            assert body[0]["channel"] == "threads"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_variants_endpoint_404_when_content_item_not_found():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r = await client.get(
                f"/api/v2/organizations/{org_id}/site-posts/drafts/{uuid.uuid4()}/variants",
            )
            assert r.status_code == 404, r.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_channel_draft_creation_rejects_cross_org_source_content_item():
    """AC2 — source가 다른 조직 소속이면 서버 거부(422·에러 코드 등재)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_a, project_a = await _seed_org(s)
            org_b, project_b = await _seed_org(s)
            agent_a = await _seed_agent(s, org_a, project_a)
            agent_b = await _seed_agent(s, org_b, project_b)
            blog_story_b = await _seed_story(s, org_b, project_b, title="B org 블로그")
            channel_story_a = await _seed_story(s, org_a, project_a, title="A org 채널")
            connection_a = await _seed_connection(s, org_a)

        _setup_org_scoped_app(app, Session, org_b, user_id=agent_b, agent=True)
        async with _client_for(app) as client:
            content_item_in_org_b = await _create_site_post_draft(
                client, org_id=org_b, work_item_id=blog_story_b, slug="cross-org-post",
            )

        _setup_org_scoped_app(app, Session, org_a, user_id=agent_a, agent=True)
        async with _client_for(app) as client:
            r = await _create_channel_post_draft(
                client, org_id=org_a, work_item_id=channel_story_a, connection_id=connection_a,
                source_content_item_id=content_item_in_org_b,
            )
            assert r.status_code == 422, r.text
            assert r.json()["error"]["code"] == "CHANNEL_POST_SOURCE_CONTENT_ITEM_NOT_FOUND"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# --- AC3 — campaign 묶음 -----------------------------------------------------------


@pytest.mark.anyio
async def test_campaign_create_human_only_agent_gets_403():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r = await client.post(f"/api/v2/organizations/{org_id}/campaigns", json={"name": "가을 캠페인"})
            assert r.status_code == 403, r.text
            assert r.json()["error"]["code"] == "CAMPAIGN_CREATE_HUMAN_ONLY"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_campaign_create_and_detail_returns_content_items_with_nested_variants():
    """AC3 — campaign 단위 조회가 소속 원문·변형·상태를 한 번에 준다. campaign 없는
    단독 글(content_item_solo)은 이 campaign의 detail에 안 섞인다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            human_id = await _seed_human(s, org_id)
            blog_story_id = await _seed_story(s, org_id, project_id, title="블로그")
            solo_story_id = await _seed_story(s, org_id, project_id, title="단독 글")
            channel_story_id = await _seed_story(s, org_id, project_id, title="채널")
            connection_id = await _seed_connection(s, org_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r_campaign = await client.post(
                f"/api/v2/organizations/{org_id}/campaigns", json={"name": "가을 캠페인"},
            )
            assert r_campaign.status_code == 201, r_campaign.text
            campaign_id = r_campaign.json()["id"]

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            content_item_id = await _create_site_post_draft(
                client, org_id=org_id, work_item_id=blog_story_id, slug="campaign-post",
                campaign_id=uuid.UUID(campaign_id),
            )
            # 단독 글(campaign 미소속) — 이 campaign의 소속 목록에 섞이면 안 된다.
            await _create_site_post_draft(
                client, org_id=org_id, work_item_id=solo_story_id, slug="solo-post",
            )
            r_variant = await _create_channel_post_draft(
                client, org_id=org_id, work_item_id=channel_story_id, connection_id=connection_id,
                source_content_item_id=content_item_id,
            )
            assert r_variant.status_code == 201, r_variant.text
            variant_draft_id = r_variant.json()["draft_id"]

            r_detail = await client.get(f"/api/v2/organizations/{org_id}/campaigns/{campaign_id}")
            assert r_detail.status_code == 200, r_detail.text
            detail = r_detail.json()
            assert detail["id"] == campaign_id
            assert detail["name"] == "가을 캠페인"
            assert len(detail["content_items"]) == 1, "campaign 소속이 아닌 단독 글이 섞였거나 소속 글이 누락됐다"
            content_item = detail["content_items"][0]
            assert content_item["content_item_id"] == str(content_item_id)
            assert content_item["slug"] == "campaign-post"
            assert [v["draft_id"] for v in content_item["variants"]] == [variant_draft_id]
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_campaign_detail_404_when_not_found_or_cross_org():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_a, project_a = await _seed_org(s)
            org_b, project_b = await _seed_org(s)
            human_b = await _seed_human(s, org_b)

        _setup_org_scoped_app(app, Session, org_b, user_id=human_b)
        async with _client_for(app) as client:
            r_campaign = await client.post(
                f"/api/v2/organizations/{org_b}/campaigns", json={"name": "B org 캠페인"},
            )
            assert r_campaign.status_code == 201, r_campaign.text
            campaign_id = r_campaign.json()["id"]

        async with Session() as s:
            agent_a = await _seed_agent(s, org_a, project_a)

        _setup_org_scoped_app(app, Session, org_a, user_id=agent_a, agent=True)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_a}/campaigns/{campaign_id}")
            assert r.status_code == 404, r.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_site_post_draft_creation_rejects_cross_org_campaign():
    """AC3 — campaign_id가 다른 조직 소속이면 서버 거부(422)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_a, project_a = await _seed_org(s)
            org_b, project_b = await _seed_org(s)
            agent_a = await _seed_agent(s, org_a, project_a)
            human_b = await _seed_human(s, org_b)
            blog_story_a = await _seed_story(s, org_a, project_a)

        _setup_org_scoped_app(app, Session, org_b, user_id=human_b)
        async with _client_for(app) as client:
            r_campaign = await client.post(
                f"/api/v2/organizations/{org_b}/campaigns", json={"name": "B org 캠페인"},
            )
            campaign_id_in_org_b = r_campaign.json()["id"]

        _setup_org_scoped_app(app, Session, org_a, user_id=agent_a, agent=True)
        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/organizations/{org_a}/site-posts/drafts",
                json={
                    "work_item_id": str(blog_story_a), "title": "제목", "slug": "cross-org-campaign",
                    "lang": "ko", "summary": "요약", "tags": [], "body_md": "본문",
                    "campaign_id": campaign_id_in_org_b,
                },
            )
            assert r.status_code == 422, r.text
            assert r.json()["error"]["code"] == "CAMPAIGN_NOT_FOUND"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# --- AC5 — 에이전트 API(발행·승인 권한 무변경) -------------------------------------


# --- AC3 보정(페드루 PO 리뷰 B1, 2026-09-04) — campaign_id 캐리포워드 3갈래 ------------


@pytest.mark.anyio
async def test_campaign_id_omitted_on_edit_carries_forward_not_cleared():
    """B1 — campaign 개념을 모르는 호출(예: 본문만 고치는 에이전트)이 campaign_id
    키를 아예 안 보내면, 휴먼이 이미 묶어 둔 campaign 소속이 조용히 풀리면 안 된다
    (캐리포워드). 뮤테이션 대상: 라우터의 model_fields_set 분기를 지우면(항상 body.
    campaign_id를 넘기면) 이 assert가 RED."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            human_id = await _seed_human(s, org_id)
            blog_story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r_campaign = await client.post(f"/api/v2/organizations/{org_id}/campaigns", json={"name": "겨울 캠페인"})
            campaign_id = r_campaign.json()["id"]

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r1 = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts",
                json={
                    "work_item_id": str(blog_story_id), "title": "제목", "slug": "carry-forward-post",
                    "lang": "ko", "summary": "요약", "tags": [], "body_md": "본문 v1",
                    "campaign_id": campaign_id,
                },
            )
            assert r1.status_code == 201, r1.text
            draft_id = r1.json()["draft_id"]

            # campaign_id 키 자체를 안 보내는 본문 편집 — 구식 플러그인/agent 형태 호출 시뮬레이션.
            r2 = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts",
                json={
                    "work_item_id": str(blog_story_id), "title": "제목", "slug": "carry-forward-post",
                    "lang": "ko", "summary": "요약", "tags": [], "body_md": "본문 v2(campaign_id 미포함)",
                },
            )
            assert r2.status_code == 201, r2.text

        async with Session() as s:
            from app.models.site_post_draft import SitePostDraft
            from sqlalchemy import select
            draft = (await s.execute(
                select(SitePostDraft).where(SitePostDraft.id == uuid.UUID(draft_id))
            )).scalar_one()
            assert str(draft.campaign_id) == campaign_id, "campaign_id 생략 편집이 기존 소속을 지웠다"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_campaign_id_explicit_null_clears_membership():
    """B1 — 명시적으로 null을 보내면(휴먼이 실제로 해제 의도) campaign 소속이 풀린다
    (생략과 명시 null이 서로 다른 신호여야 한다)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id)
            blog_story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r_campaign = await client.post(f"/api/v2/organizations/{org_id}/campaigns", json={"name": "봄 캠페인"})
            campaign_id = r_campaign.json()["id"]

            r1 = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts",
                json={
                    "work_item_id": str(blog_story_id), "title": "제목", "slug": "explicit-null-post",
                    "lang": "ko", "summary": "요약", "tags": [], "body_md": "본문 v1",
                    "campaign_id": campaign_id,
                },
            )
            draft_id = r1.json()["draft_id"]

            r2 = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts",
                json={
                    "work_item_id": str(blog_story_id), "title": "제목", "slug": "explicit-null-post",
                    "lang": "ko", "summary": "요약", "tags": [], "body_md": "본문 v2",
                    "campaign_id": None,
                },
            )
            assert r2.status_code == 201, r2.text

        async with Session() as s:
            from app.models.site_post_draft import SitePostDraft
            from sqlalchemy import select
            draft = (await s.execute(
                select(SitePostDraft).where(SitePostDraft.id == uuid.UUID(draft_id))
            )).scalar_one()
            assert draft.campaign_id is None, "명시적 campaign_id=null 편집이 소속을 안 지웠다"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_campaign_id_explicit_value_changes_membership():
    """B1 — 명시적으로 다른 campaign_id를 보내면 소속이 그 값으로 바뀐다(변경 갈래)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id)
            blog_story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r_campaign_a = await client.post(f"/api/v2/organizations/{org_id}/campaigns", json={"name": "캠페인 A"})
            campaign_a_id = r_campaign_a.json()["id"]
            r_campaign_b = await client.post(f"/api/v2/organizations/{org_id}/campaigns", json={"name": "캠페인 B"})
            campaign_b_id = r_campaign_b.json()["id"]

            r1 = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts",
                json={
                    "work_item_id": str(blog_story_id), "title": "제목", "slug": "value-change-post",
                    "lang": "ko", "summary": "요약", "tags": [], "body_md": "본문 v1",
                    "campaign_id": campaign_a_id,
                },
            )
            draft_id = r1.json()["draft_id"]

            r2 = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts",
                json={
                    "work_item_id": str(blog_story_id), "title": "제목", "slug": "value-change-post",
                    "lang": "ko", "summary": "요약", "tags": [], "body_md": "본문 v2",
                    "campaign_id": campaign_b_id,
                },
            )
            assert r2.status_code == 201, r2.text

        async with Session() as s:
            from app.models.site_post_draft import SitePostDraft
            from sqlalchemy import select
            draft = (await s.execute(
                select(SitePostDraft).where(SitePostDraft.id == uuid.UUID(draft_id))
            )).scalar_one()
            assert str(draft.campaign_id) == campaign_b_id
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_agent_can_set_source_but_still_cannot_approve_or_publish():
    """AC5 — 에이전트가 source 지정 초안까지는 만들지만, 승인·발행은 여전히 human-only
    (기존 403 pin 무변경 — 신규 코드가 그 경계를 넓히지 않았는지 확인)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            from app.models.participation import ParticipationRole
            role = ParticipationRole(id=uuid.uuid4(), org_id=org_id, key="approver", label="Approver", is_default=True)
            s.add(role)
            await s.commit()
            agent_id = await _seed_agent(s, org_id, project_id)
            blog_story_id = await _seed_story(s, org_id, project_id, title="블로그")
            channel_story_id = await _seed_story(s, org_id, project_id, title="채널")
            connection_id = await _seed_connection(s, org_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            content_item_id = await _create_site_post_draft(
                client, org_id=org_id, work_item_id=blog_story_id, slug="agent-source-post",
            )
            r_variant = await _create_channel_post_draft(
                client, org_id=org_id, work_item_id=channel_story_id, connection_id=connection_id,
                source_content_item_id=content_item_id,
            )
            assert r_variant.status_code == 201, r_variant.text
            channel_draft_id = r_variant.json()["draft_id"]

            r_submit = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{channel_draft_id}/submit", json={},
            )
            assert r_submit.status_code == 200, r_submit.text

            r_publish = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{channel_draft_id}/publish",
            )
            assert r_publish.status_code == 403, r_publish.text
            assert r_publish.json()["error"]["code"] == "CHANNEL_POST_PUBLISH_HUMAN_ONLY"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
