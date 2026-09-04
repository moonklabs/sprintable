"""story e4fc29fa(Phase1·마케팅운영, 페드루 PO 確定 2026-09-04, 조각③a) — 블로그 목적지
축(`site_post_drafts.connection_id`)·목적지 봉인(`gate.sealed_destination_connection_id`)·
`get_blog_destination_module` 디스패치.

캐리포워드 3갈래(생략/명시null/값)는 3437 campaign_id의 페드루 리뷰 B1 처방과 동형 —
같은 함정을 이번엔 처음부터 피해 짰다(발견 즉시 수정 습관). 목적지 봉인은 sealed_
scheduled_at(#3414)·sealed_media_sha256(620beefc)과 동형 축 — 승인 후 변경=재승인."""
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


@pytest.fixture(autouse=True)
def _stub_wordpress_blog_adapter(monkeypatch):
    """조각③b(wordpress 실 모듈)가 아직 없다 — 이 파일의 테스트가 필요로 하는 건
    "hosted_site가 아닌, 실재하는 blog kind 채널"뿐이라 test_5b27b32f_sandbox_channel.py
    선례(monkeypatch.setitem(CHANNEL_ADAPTERS, ...))와 동형으로 임시 등재한다(신규
    실 어댑터 코드 0 — 이 스텁은 B1 kind 검사 통과 여부만 재는 픽스처다)."""
    import app.services.channel_adapters as adapters_mod

    stub = adapters_mod.ChannelAdapterConfig(
        authorize_url="", token_url="", scope="", refresh_mode="manual",
        credential_kind="pasted_secret", display_name="WordPress(스텁)", kind="blog",
    )
    monkeypatch.setitem(adapters_mod.CHANNEL_ADAPTERS, "wordpress", stub)


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

    org = Organization(id=uuid.uuid4(), name="Destination Axis Test Org", slug=slug or f"org-{uuid.uuid4().hex[:8]}")
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


async def _seed_connection(session, org_id, *, channel="wordpress", account_id=None, token="plain-access-token"):
    from app.models.channel_connection import ChannelConnection
    from app.services.channel_credential_crypto import encrypt_channel_credential

    conn = ChannelConnection(
        id=uuid.uuid4(), org_id=org_id, channel=channel,
        account_id=account_id or f"acct-{uuid.uuid4().hex[:8]}", status="active",
        credential_kind="pasted_secret", refresh_mode="manual",
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


def _draft_body(*, work_item_id, slug="2ho-blog", body_md="본문 v1", connection_id=None, explicit_none=False):
    body = {
        "work_item_id": str(work_item_id), "slug": slug, "lang": "ko", "title": "2호 글",
        "summary": "요약입니다", "tags": ["ai"], "body_md": body_md, "media_manifest": [],
    }
    if connection_id is not None:
        body["connection_id"] = str(connection_id)
    elif explicit_none:
        body["connection_id"] = None
    return body


async def _approve_gate_directly(session, gate_id):
    from app.models.gate import Gate
    from sqlalchemy import select

    gate = (await session.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()
    gate.status = "approved"
    gate.resolver_id = uuid.uuid4()
    gate.resolved_at = datetime.now(timezone.utc)
    await session.commit()


# --- 캐리포워드 3갈래 ---------------------------------------------------------------


@pytest.mark.anyio
async def test_connection_id_omitted_on_edit_carries_forward():
    """생략 — 기존 값(wordpress connection) 유지. 뮤테이션 대상: 캐리포워드 센티널을
    지우면(생략=None 취급) 이 assert가 RED."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r1 = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts",
                json=_draft_body(work_item_id=story_id, body_md="v1", connection_id=connection_id),
            )
            assert r1.status_code == 201, r1.text
            draft_id = r1.json()["draft_id"]

            r2 = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts",
                json=_draft_body(work_item_id=story_id, body_md="v2(connection_id 미포함)"),
            )
            assert r2.status_code == 201, r2.text

        async with Session() as s:
            from app.models.site_post_draft import SitePostDraft
            from sqlalchemy import select
            draft = (await s.execute(
                select(SitePostDraft).where(SitePostDraft.id == uuid.UUID(draft_id))
            )).scalar_one()
            assert draft.connection_id == connection_id, "connection_id 생략 편집이 기존 목적지를 지웠다"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_connection_id_explicit_null_resets_to_hosted_site():
    """명시 null — hosted_site(None)로 해제."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r1 = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts",
                json=_draft_body(work_item_id=story_id, body_md="v1", connection_id=connection_id),
            )
            draft_id = r1.json()["draft_id"]

            r2 = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts",
                json=_draft_body(work_item_id=story_id, body_md="v2", explicit_none=True),
            )
            assert r2.status_code == 201, r2.text

        async with Session() as s:
            from app.models.site_post_draft import SitePostDraft
            from sqlalchemy import select
            draft = (await s.execute(
                select(SitePostDraft).where(SitePostDraft.id == uuid.UUID(draft_id))
            )).scalar_one()
            assert draft.connection_id is None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_connection_id_new_draft_defaults_to_hosted_site():
    """신규 draft(connection_id 생략) — hosted_site(None)가 기본값."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts",
                json=_draft_body(work_item_id=story_id),
            )
            assert r.status_code == 201, r.text
            draft_id = r.json()["draft_id"]

        async with Session() as s:
            from app.models.site_post_draft import SitePostDraft
            from sqlalchemy import select
            draft = (await s.execute(
                select(SitePostDraft).where(SitePostDraft.id == uuid.UUID(draft_id))
            )).scalar_one()
            assert draft.connection_id is None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_connection_id_cross_org_rejected_422():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_a, project_a = await _seed_org(s)
            org_b, _ = await _seed_org(s)
            agent_a = await _seed_agent(s, org_a, project_a)
            story_a = await _seed_story(s, org_a, project_a)
            connection_in_org_b = await _seed_connection(s, org_b)

        _setup_org_scoped_app(app, Session, org_a, user_id=agent_a, agent=True)
        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/organizations/{org_a}/site-posts/drafts",
                json=_draft_body(work_item_id=story_a, connection_id=connection_in_org_b),
            )
            assert r.status_code == 422, r.text
            assert r.json()["error"]["code"] == "SITE_POST_CONNECTION_NOT_FOUND"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_connection_id_social_channel_rejected_422():
    """페드루 리뷰 B1(2026-09-04) — Threads(social) 연결을 블로그 목적지로 지정하면
    초안 생성 시점에 즉시 거부한다(fail-closed) — 안 그러면 상신·봉인·승인까지
    조용히 통과하고 발행(미배선)에서야 걸린다. 뮤테이션 대상: kind 검사를 지우면
    이 assert가 RED(201로 성공)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            threads_connection_id = await _seed_connection(s, org_id, channel="threads")

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts",
                json=_draft_body(work_item_id=story_id, connection_id=threads_connection_id),
            )
            assert r.status_code == 422, r.text
            assert r.json()["error"]["code"] == "SITE_POST_DESTINATION_KIND_MISMATCH"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# --- 목적지 봉인(승인 후 변경=재승인) ------------------------------------------------


@pytest.mark.anyio
async def test_destination_change_after_approval_reopens_gate_for_reapproval():
    """AC(페드루 PO 지시) — 승인 뒤 connection_id만 바꿔도(본문 그대로) 게이트가
    pending+reapproval_required로 되돌아간다(sealed_scheduled_at·sealed_media_sha256과
    동형 축). sealed_content_*는 안 건드린다(기존 관례 재확인)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client, Session() as s:
            r1 = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts",
                json=_draft_body(work_item_id=story_id, body_md="본문 그대로"),
            )
            draft_id = r1.json()["draft_id"]
            r_submit = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/submit", json={},
            )
            assert r_submit.status_code == 200, r_submit.text
            gate_id = uuid.UUID(r_submit.json()["gate_id"])
            await _approve_gate_directly(s, gate_id)

            r2 = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts",
                json=_draft_body(work_item_id=story_id, body_md="본문 그대로", connection_id=connection_id),
            )
            assert r2.status_code == 201, r2.text

        async with Session() as s:
            from app.models.gate import Gate
            from sqlalchemy import select
            gate = (await s.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()
            assert gate.status == "pending"
            assert gate.reapproval_required is True
            assert gate.sealed_destination_connection_id is None, "승인된 옛 봉인이 훼손됐다(재봉인은 submit() 재호출 몫)"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_resubmit_destination_only_change_reseals_and_is_not_noop():
    """content는 동일해도 destination만 바뀌면 submit()의 sha 동일성 조기-return을
    타면 안 된다(위 idempotency 조건에 destination 비교를 뺐으면 이 assert가 RED —
    재봉인 없이 옛 destination이 그대로 남는다)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r1 = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts",
                json=_draft_body(work_item_id=story_id, body_md="본문 동일"),
            )
            draft_id = r1.json()["draft_id"]
            r_submit1 = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/submit", json={},
            )
            assert r_submit1.status_code == 200, r_submit1.text
            gate_id = uuid.UUID(r_submit1.json()["gate_id"])

            # content 그대로, connection_id만 값으로 지정(hosted_site→wordpress).
            r2 = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts",
                json=_draft_body(work_item_id=story_id, body_md="본문 동일", connection_id=connection_id),
            )
            assert r2.status_code == 201, r2.text

            r_submit2 = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/submit", json={},
            )
            assert r_submit2.status_code == 200, r_submit2.text

        async with Session() as s:
            from app.models.gate import Gate
            from sqlalchemy import select
            gate = (await s.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()
            assert gate.sealed_destination_connection_id == connection_id, (
                "destination만 바뀐 재상신이 재봉인되지 않았다(옛 destination이 그대로 남음)"
            )
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# --- get_blog_destination_module 디스패치 -------------------------------------------


def test_get_blog_destination_module_none_returns_hosted_site():
    from app.services import hosted_site_publish
    from app.services.blog_destinations import get_blog_destination_module

    assert get_blog_destination_module(connection_id=None) is hosted_site_publish


def test_get_blog_destination_module_non_null_not_implemented_yet():
    """조각③b·④ 전까지 fail-closed — 뮤테이션 대상: 이 가드를 지우면 존재하지 않는
    목적지가 조용히 어떤 모듈로든(예: hosted_site) 떨어질 수 있다."""
    from app.services.blog_destinations import (
        BlogDestinationNotImplementedError,
        get_blog_destination_module,
    )

    with pytest.raises(BlogDestinationNotImplementedError):
        get_blog_destination_module(connection_id=uuid.uuid4())
