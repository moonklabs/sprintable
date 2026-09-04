"""story #3471(Phase1·마케팅운영, 페드루 PO 確定 2026-09-05) — 조직 콘텐츠 규칙
GET/PUT API + create/submit lint 배선(API·real DB). 순수 `lint_content()` 단위
테스트는 tests/test_3471_content_rules_lint_unit.py(destructive_schema 마커
불요·이 파일은 Base.metadata.create_all을 호출해 story 8236bbc3/#2643 가드가
마커를 강제한다)."""
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

    org = Organization(id=uuid.uuid4(), name="3471 Content Rules Test Org", slug=slug or f"org-{uuid.uuid4().hex[:8]}")
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


async def _seed_default_role(session, org_id):
    from app.models.participation import ParticipationRole

    role = ParticipationRole(id=uuid.uuid4(), org_id=org_id, key="approver", label="Approver", is_default=True)
    session.add(role)
    await session.commit()
    return role.id


async def _seed_connection(session, org_id, *, channel="threads"):
    from app.models.channel_connection import ChannelConnection
    from app.services.channel_credential_crypto import encrypt_channel_credential

    conn = ChannelConnection(
        id=uuid.uuid4(), org_id=org_id, channel=channel,
        account_id=f"acct-{uuid.uuid4().hex[:8]}", status="active",
        credential_kind="oauth", refresh_mode="reissue_from_access_token",
        encrypted_access_token=encrypt_channel_credential("plain-access-token"),
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


# ══════════════════════════════════════════════════════════════════════════════
# API 테스트
# ══════════════════════════════════════════════════════════════════════════════


@pytest.mark.anyio
async def test_owner_put_content_rules_reflected_in_get_and_version_plus_one():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            owner_id = await _seed_human(s, org_id, role="owner")

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r_get0 = await client.get(f"/api/v2/organizations/{org_id}/content-rules")
            assert r_get0.status_code == 200, r_get0.text
            assert r_get0.json() == {"org_id": str(org_id), "rules": {}, "version": 0}

            r_put = await client.put(
                f"/api/v2/organizations/{org_id}/content-rules",
                json={"rules": {"banned_terms": ["테스트금칙"], "require_utm": True}},
            )
            assert r_put.status_code == 200, r_put.text
            assert r_put.json()["version"] == 1

            r_get1 = await client.get(f"/api/v2/organizations/{org_id}/content-rules")
        assert r_get1.json()["rules"]["banned_terms"] == ["테스트금칙"]
        assert r_get1.json()["version"] == 1
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_member_put_returns_403_owner_field_untouched():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            member_id = await _seed_human(s, org_id, role="member")

        _setup_org_scoped_app(app, Session, org_id, user_id=member_id)
        async with _client_for(app) as client:
            r = await client.put(
                f"/api/v2/organizations/{org_id}/content-rules", json={"rules": {"banned_terms": ["x"]}},
            )
        assert r.status_code == 403, r.text
        assert r.json()["error"]["code"] == "CONTENT_RULES_OWNER_ONLY"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_agent_get_sees_declaration_slots_but_put_is_403():
    """에이전트: GET(톤·택소노미·채널 우선순위·브랜드 킷 그대로 실림) 허용 · PUT 403."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            owner_id = await _seed_human(s, org_id, role="owner")
            agent_id = await _seed_agent(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r_put = await client.put(
                f"/api/v2/organizations/{org_id}/content-rules",
                json={"rules": {"tone": "친근한", "taxonomy": ["블로그"], "channel_priority": ["threads"]}},
            )
            assert r_put.status_code == 200, r_put.text

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r_get = await client.get(f"/api/v2/organizations/{org_id}/content-rules")
            assert r_get.status_code == 200, r_get.text
            assert r_get.json()["rules"]["tone"] == "친근한"
            assert r_get.json()["rules"]["taxonomy"] == ["블로그"]

            r_put_agent = await client.put(
                f"/api/v2/organizations/{org_id}/content-rules", json={"rules": {"tone": "x"}},
            )
        assert r_put_agent.status_code == 403, r_put_agent.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_cross_org_rules_isolated():
    """A org 규칙이 B org 초안에 안 걸린다 — GET도 org별로 독립."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_a, project_a = await _seed_org(s)
            org_b, project_b = await _seed_org(s)
            owner_a = await _seed_human(s, org_a, role="owner")
            owner_b = await _seed_human(s, org_b, role="owner")

        _setup_org_scoped_app(app, Session, org_a, user_id=owner_a)
        async with _client_for(app) as client:
            r = await client.put(
                f"/api/v2/organizations/{org_a}/content-rules", json={"rules": {"banned_terms": ["A전용금칙"]}},
            )
            assert r.status_code == 200, r.text

        _setup_org_scoped_app(app, Session, org_b, user_id=owner_b)
        async with _client_for(app) as client:
            r_get_b = await client.get(f"/api/v2/organizations/{org_b}/content-rules")
        assert r_get_b.json() == {"org_id": str(org_b), "rules": {}, "version": 0}
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_channel_post_draft_create_reports_violation_then_submit_422_then_clear_and_pass():
    """AC1·AC2 실물 — 금칙어 있는 초안 create 응답에 violations 실림 → submit 422
    CONTENT_RULE_VIOLATION → 금칙어 없는 새 버전 create → submit 200."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            owner_id = await _seed_human(s, org_id, role="owner")
            agent_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r_put = await client.put(
                f"/api/v2/organizations/{org_id}/content-rules",
                json={"rules": {"banned_terms": ["테스트금칙"]}},
            )
            assert r_put.status_code == 200, r_put.text

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r_draft = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                json={
                    "work_item_id": str(story_id), "connection_id": str(connection_id),
                    "text": "이 글에는 테스트금칙 단어가 있습니다",
                },
            )
            assert r_draft.status_code == 201, r_draft.text
            body = r_draft.json()
            assert len(body["violations"]) == 1
            assert body["violations"][0]["code"] == "banned_term"
            draft_id = body["draft_id"]

            r_submit = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/submit", json={},
            )
            assert r_submit.status_code == 422, r_submit.text
            assert r_submit.json()["error"]["code"] == "CONTENT_RULE_VIOLATION"
            assert r_submit.json()["error"]["violations"][0]["code"] == "banned_term"

            r_draft2 = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                json={
                    "work_item_id": str(story_id), "connection_id": str(connection_id),
                    "text": "깨끗한 본문입니다",
                },
            )
            assert r_draft2.status_code == 201, r_draft2.text
            assert r_draft2.json()["violations"] == []

            r_submit2 = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/submit", json={},
            )
        assert r_submit2.status_code == 200, r_submit2.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_site_post_draft_banned_term_in_title_blocks_submit():
    """site_post는 title+summary+body_md 결합 텍스트로 lint — 제목에 금칙어가 있어도
    잡혀야 한다(body_md만 보면 놓친다)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            owner_id = await _seed_human(s, org_id, role="owner")
            agent_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r_put = await client.put(
                f"/api/v2/organizations/{org_id}/content-rules",
                json={"rules": {"banned_terms": ["금지어"]}},
            )
            assert r_put.status_code == 200, r_put.text

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r_draft = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts",
                json={
                    "work_item_id": str(story_id), "title": "금지어가 있는 제목", "slug": "banned-title-post",
                    "lang": "ko", "summary": "요약", "tags": [], "body_md": "본문", "media_manifest": [],
                },
            )
            assert r_draft.status_code == 201, r_draft.text
            assert len(r_draft.json()["violations"]) == 1
            draft_id = r_draft.json()["draft_id"]

            r_submit = await client.post(
                f"/api/v2/organizations/{org_id}/site-posts/drafts/{draft_id}/submit", json={},
            )
        assert r_submit.status_code == 422, r_submit.text
        assert r_submit.json()["error"]["code"] == "CONTENT_RULE_VIOLATION"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_lint_result_snapshot_preserves_rules_version_after_later_put():
    """AC 「과거 evidence 보존」 — 규칙 PUT 뒤에도 이미 저장된 draft.lint_result.
    rules_version은 그대로(실시간 재계산 아님)."""
    from sqlalchemy import select
    from app.models.channel_post_draft import ChannelPostDraft
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            owner_id = await _seed_human(s, org_id, role="owner")
            agent_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r_put1 = await client.put(
                f"/api/v2/organizations/{org_id}/content-rules", json={"rules": {"banned_terms": []}},
            )
            assert r_put1.status_code == 200, r_put1.text
            assert r_put1.json()["version"] == 1

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r_draft = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                json={
                    "work_item_id": str(story_id), "connection_id": str(connection_id),
                    "text": "본문",
                },
            )
            assert r_draft.status_code == 201, r_draft.text
            draft_id = uuid.UUID(r_draft.json()["draft_id"])

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r_put2 = await client.put(
                f"/api/v2/organizations/{org_id}/content-rules",
                json={"rules": {"banned_terms": ["새로생긴금칙"]}},
            )
            assert r_put2.status_code == 200, r_put2.text
            assert r_put2.json()["version"] == 2

        async with Session() as s:
            draft = (await s.execute(
                select(ChannelPostDraft).where(ChannelPostDraft.id == draft_id)
            )).scalar_one()
            assert draft.lint_result["rules_version"] == 1, "규칙 PUT 뒤에도 옛 스냅샷의 rules_version이 바뀌면 안 된다"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
