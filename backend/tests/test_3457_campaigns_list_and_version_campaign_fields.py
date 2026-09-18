"""story #3457(Phase1·FE, 페드루 PO 確定 2026-09-04) — 미르코 3457 AC2("기존 campaign
선택" 드롭다운) 그라운딩에서 발견한 소형 BE 갭 2건:

① `GET /organizations/{org_id}/campaigns` 목록 엔드포인트 — 지금 `campaigns.py`엔
POST·GET/{campaign_id}뿐이라 드롭다운을 채울 데이터가 없었다.
② `SitePostVersionHistoryItem`(GET .../site-posts/drafts/{id}/versions)에
`campaign_id`·표시용 `campaign_name` — 지금은 쓰기(저장 POST 캐리포워드, #3437)만
있고 읽기 응답에 필드 자체가 없어 "붙인 뒤 새로고침하면 어느 campaign인지 못 보는"
갭이었다."""
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

    org = Organization(id=uuid.uuid4(), name="3457 Campaigns List Test Org", slug=slug or f"org-{uuid.uuid4().hex[:8]}")
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


# --- ① GET /campaigns 목록 ---------------------------------------------------------


@pytest.mark.anyio
async def test_list_campaigns_returns_org_campaigns_created_at_desc():
    """뮤테이션 대상: order_by를 지우면 이 assert(순서)가 RED."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, role="owner")

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client:
            r1 = await client.post(f"/api/v2/organizations/{org_id}/campaigns", json={"name": "1호 캠페인"})
            r2 = await client.post(f"/api/v2/organizations/{org_id}/campaigns", json={"name": "2호 캠페인"})
            assert r1.status_code == 201, r1.text
            assert r2.status_code == 201, r2.text

            r_list = await client.get(f"/api/v2/organizations/{org_id}/campaigns")
        assert r_list.status_code == 200, r_list.text
        names = [row["name"] for row in r_list.json()]
        assert names == ["2호 캠페인", "1호 캠페인"]
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_list_campaigns_excludes_other_org():
    """뮤테이션 대상: org_id 필터를 지우면 이 assert가 RED(타 org 캠페인이 샌다)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_a, project_a = await _seed_org(s)
            org_b, project_b = await _seed_org(s)
            human_a = await _seed_human(s, org_a, role="owner")
            human_b = await _seed_human(s, org_b, role="owner")

        _setup_org_scoped_app(app, Session, org_b, user_id=human_b, agent=False)
        async with _client_for(app) as client:
            r = await client.post(f"/api/v2/organizations/{org_b}/campaigns", json={"name": "B org 캠페인"})
            assert r.status_code == 201, r.text

        _setup_org_scoped_app(app, Session, org_a, user_id=human_a, agent=False)
        async with _client_for(app) as client:
            r_list = await client.get(f"/api/v2/organizations/{org_a}/campaigns")
        assert r_list.status_code == 200, r_list.text
        assert r_list.json() == []
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_list_campaigns_agent_can_read():
    """GET/{campaign_id}와 동일 권한 폭 — 조직 멤버면 에이전트도 읽기 가능(생성만
    human-only)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, role="owner")
            agent_id = await _seed_agent(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client:
            r = await client.post(f"/api/v2/organizations/{org_id}/campaigns", json={"name": "캠페인"})
            assert r.status_code == 201, r.text

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r_list = await client.get(f"/api/v2/organizations/{org_id}/campaigns")
        assert r_list.status_code == 200, r_list.text
        assert len(r_list.json()) == 1
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# --- ② SitePostVersionHistoryItem campaign 필드 ------------------------------------


@pytest.mark.anyio
async def test_version_history_includes_campaign_id_and_name_when_set():
    """뮤테이션 대상: 응답에서 campaign_id/campaign_name을 빼면 이 assert가 RED —
    "붙인 뒤 새로고침하면 어느 campaign인지 못 보는" 갭 재현."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            human_id = await _seed_human(s, org_id, role="owner")
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client:
            r_campaign = await client.post(
                f"/api/v2/organizations/{org_id}/campaigns", json={"name": "9월 캠페인"},
            )
            assert r_campaign.status_code == 201, r_campaign.text
            campaign_id = r_campaign.json()["id"]

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r_draft = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts",
                json={
                    "work_item_id": str(story_id), "title": "제목", "slug": "9wol-post", "lang": "ko",
                    "summary": "요약", "tags": [], "body_md": "본문", "campaign_id": campaign_id,
                },
            )
            assert r_draft.status_code == 201, r_draft.text
            draft_id = r_draft.json()["draft_id"]

            r_versions = await client.get(
                f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/versions",
            )
        assert r_versions.status_code == 200, r_versions.text
        rows = r_versions.json()
        assert len(rows) == 1
        assert rows[0]["campaign_id"] == campaign_id
        assert rows[0]["campaign_name"] == "9월 캠페인"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_version_history_campaign_fields_null_when_no_campaign():
    """캠페인 없이 만든 draft는 campaign_id/campaign_name 둘 다 None — 지어내지
    않는다."""
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
                f"/api/v2/organizations/{org_id}/site-posts/drafts",
                json={
                    "work_item_id": str(story_id), "title": "제목", "slug": "no-campaign-post", "lang": "ko",
                    "summary": "요약", "tags": [], "body_md": "본문",
                },
            )
            assert r_draft.status_code == 201, r_draft.text
            draft_id = r_draft.json()["draft_id"]

            r_versions = await client.get(
                f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/versions",
            )
        assert r_versions.status_code == 200, r_versions.text
        rows = r_versions.json()
        assert len(rows) == 1
        assert rows[0]["campaign_id"] is None
        assert rows[0]["campaign_name"] is None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
