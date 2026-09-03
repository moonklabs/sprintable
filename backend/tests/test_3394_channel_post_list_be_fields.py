"""story #3394(Phase1·마케팅운영, S2c BE 선행, 페드루 PO 확定 2026-09-03/04) — 채널 포스트
목록에 site_posts(#3742)와 같은 이름의 상태 파생 필드(gate_status·reapproval_required·
sealed_content_sha256·body_sha256·published_at·published_body_sha256) + 채널 고유 발행
상태 필드(publication_status·permalink·external_id·error_code) + connection 목록의
max_text_length + draft 생성/버전이력의 tagged_link_preview.

AC 매핑:
- AC1·AC3: 목록에 site와 같은 이름 6필드.
- AC2: 채널 고유 4필드 — **조인 축이 둘**이다. `published_at`·`published_body_sha256`·
  `permalink`·`external_id`는 이 게이트의 "가장 최근 status=published" publication(버전
  무관)에서. `publication_status`·`error_code`는 "최신 버전"의 publication 행에서(없으면
  null). 발행 뒤 편집·재승인해도 이전 발행 이력이 목록에서 사라지지 않아야 한다(핵심 회귀
  가드 — test_reapproval_after_publish_keeps_old_publish_info_but_new_version_status_null).
- AC4: ChannelConnectionResponse.max_text_length(어댑터 선언값, Threads=500).
- AC5: draft 생성·버전이력 응답의 tagged_link_preview(link_url 있을 때만, 실제 발행과
  같은 값 — build_tagged_link 공용 함수 재사용).
- AC7: 실 HTTP 왕복으로 다섯 상태(초안만·승인대기·승인됨+미발행·발행됨·부분성공) 각각.
- AC8: 목록 쿼리 수가 draft 개수에 비례하지 않는다(N+1 금지, before_cursor_execute 실측)."""
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

    org = Organization(id=uuid.uuid4(), name="S2c BE Fields Test Org", slug=slug or f"org-{uuid.uuid4().hex[:8]}")
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


async def _seed_story(session, org_id, project_id, *, title="채널 포스트"):
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


async def _seed_connection(session, org_id, *, channel="threads", status="active", account_id=None, token="plain-access-token"):
    from app.models.channel_connection import ChannelConnection
    from app.services.channel_credential_crypto import encrypt_channel_credential

    conn = ChannelConnection(
        id=uuid.uuid4(), org_id=org_id, channel=channel,
        account_id=account_id or f"acct-{uuid.uuid4().hex[:8]}", status=status,
        credential_kind="oauth", refresh_mode="reissue_from_access_token",
        encrypted_access_token=encrypt_channel_credential(token) if status == "active" else None,
    )
    session.add(conn)
    await session.commit()
    return conn.id


async def _approve_gate_directly(session, gate_id):
    from app.models.gate import Gate
    from sqlalchemy import select

    gate = (await session.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()
    gate.status = "approved"
    gate.resolver_id = uuid.uuid4()
    gate.resolved_at = datetime.now(timezone.utc)
    await session.commit()


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


def _draft_body(*, work_item_id, connection_id, text="채널 포스트 본문입니다.", link_url=None):
    body = {"work_item_id": str(work_item_id), "connection_id": str(connection_id), "text": text}
    if link_url is not None:
        body["link_url"] = link_url
    return body


async def _seed_submit_approve(client, session, *, org_id, connection_id, story_id, text="채널 포스트 본문입니다.", link_url=None):
    r_draft = await client.post(
        f"/api/v2/organizations/{org_id}/channel-posts/drafts",
        json=_draft_body(work_item_id=story_id, connection_id=connection_id, text=text, link_url=link_url),
    )
    assert r_draft.status_code == 201, r_draft.text
    draft_id = r_draft.json()["draft_id"]
    r_submit = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/submit", json={})
    assert r_submit.status_code == 200, r_submit.text
    gate_id = uuid.UUID(r_submit.json()["gate_id"])
    await _approve_gate_directly(session, gate_id)
    return draft_id, gate_id


def _row_for(items, draft_id):
    match = [it for it in items if it["draft_id"] == draft_id]
    assert len(match) == 1, f"draft {draft_id} not found in list: {items}"
    return match[0]


@pytest.mark.anyio
async def test_list_states_draft_only_all_new_fields_null():
    """AC7(a) — 게이트조차 없는 순수 초안: 새 필드 전부 null(지어내지 않는다)."""
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
            r_draft = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                json=_draft_body(work_item_id=story_id, connection_id=connection_id),
            )
            draft_id = r_draft.json()["draft_id"]
            r_list = await client.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts")
        assert r_list.status_code == 200, r_list.text
        row = _row_for(r_list.json(), draft_id)
        for key in (
            "gate_status", "reapproval_required", "sealed_content_sha256", "published_at",
            "published_body_sha256", "publication_status", "permalink", "external_id", "error_code",
        ):
            assert row[key] is None, f"{key}는 게이트 없는 초안에서 null이어야 한다: {row}"
        assert row["body_sha256"]  # 이건 항상 있다(최신 버전 자신의 해시)
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_list_states_pending_gate():
    """AC7(b) — 상신 뒤(승인 前): gate_status=pending·sealed_content_sha256=현재 해시·
    발행 관련 필드는 전부 null."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            human_id = await _seed_human(s, org_id, role="owner")
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r_draft = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                json=_draft_body(work_item_id=story_id, connection_id=connection_id),
            )
            draft_id = r_draft.json()["draft_id"]
            body_sha256 = r_draft.json()["body_sha256"]
            r_submit = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/submit", json={})
            assert r_submit.status_code == 200, r_submit.text

            r_list = await client.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts")
        row = _row_for(r_list.json(), draft_id)
        assert row["gate_status"] == "pending"
        assert row["reapproval_required"] is False
        assert row["sealed_content_sha256"] == body_sha256
        assert row["published_at"] is None
        assert row["publication_status"] is None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_list_states_approved_not_published():
    """AC7(c) — 승인됨+미발행: gate_status=approved, 발행 관련 필드는 전부 null(승인은
    발행과 다른 사건)."""
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
            draft_id, gate_id = await _seed_submit_approve(
                client, s, org_id=org_id, connection_id=connection_id, story_id=story_id,
            )
            r_list = await client.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts")
        row = _row_for(r_list.json(), draft_id)
        assert row["gate_status"] == "approved"
        assert row["published_at"] is None
        assert row["publication_status"] is None
        assert row["permalink"] is None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_list_states_published_full_fields():
    """AC7(d) — 발행됨: published_at·permalink·external_id·published_body_sha256(=현재
    버전 해시와 동일, 방금 발행했으므로) 전부 채워지고 publication_status=published."""
    from unittest.mock import AsyncMock, patch
    import app.services.threads_publish as tp
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            human_id = await _seed_human(s, org_id, role="owner")
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client, Session() as s:
            draft_id, gate_id = await _seed_submit_approve(
                client, s, org_id=org_id, connection_id=connection_id, story_id=story_id,
            )

        with (
            patch.object(tp, "create_container", AsyncMock(return_value="creation-1")),
            patch.object(tp, "publish_container", AsyncMock(return_value="media-1")),
            patch.object(tp, "get_publishing_limit", AsyncMock(return_value=(1, 250, 86400))),
            patch.object(tp, "get_permalink", AsyncMock(return_value="https://www.threads.net/@demo/post/media-1")),
        ):
            _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
            async with _client_for(app) as client:
                r_publish = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish")
                assert r_publish.status_code == 200, r_publish.text

                _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r_list = await client.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts")
        row = _row_for(r_list.json(), draft_id)
        assert row["published_at"] is not None
        assert row["permalink"] == "https://www.threads.net/@demo/post/media-1"
        assert row["external_id"] == "media-1"
        assert row["publication_status"] == "published"
        assert row["published_body_sha256"] == row["body_sha256"]
        assert row["error_code"] is None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_list_states_partial_success_failed_status_with_container_preserved():
    """AC7(e) — 컨테이너는 생겼는데 publish 호출이 실패한 부분 성공: 실제 영속 상태는
    `status="failed"`다(외부 발행 서비스 계약 그대로 — external_container_id는 보존돼
    재시도 유효성의 진짜 신호로 남는다, "container_created" 문자열이 아니라). 목록은 그
    실제 값을 그대로 반사해야 한다 — 지어낸 값으로 덮지 않는다."""
    from unittest.mock import AsyncMock, patch
    import app.services.threads_publish as tp
    from app.services.threads_publish import ThreadsPublishError
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            human_id = await _seed_human(s, org_id, role="owner")
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client, Session() as s:
            draft_id, gate_id = await _seed_submit_approve(
                client, s, org_id=org_id, connection_id=connection_id, story_id=story_id,
            )

        with (
            patch.object(tp, "create_container", AsyncMock(return_value="creation-1")),
            patch.object(
                tp, "publish_container",
                AsyncMock(side_effect=ThreadsPublishError("X", "provider down", status_code=500)),
            ),
            patch.object(tp, "get_publishing_limit", AsyncMock(return_value=(1, 250, 86400))),
        ):
            _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
            async with _client_for(app) as client:
                r_publish = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish")
                assert r_publish.status_code == 502, r_publish.text

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r_list = await client.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts")
        row = _row_for(r_list.json(), draft_id)
        assert row["publication_status"] == "failed"
        assert row["error_code"] == "CHANNEL_PUBLISH_PROVIDER_ERROR"
        assert row["published_at"] is None
        assert row["permalink"] is None

        async with Session() as s:
            from app.models.channel_publication import ChannelPublication
            from sqlalchemy import select

            pub = (await s.execute(
                select(ChannelPublication).where(ChannelPublication.gate_id == gate_id)
            )).scalar_one()
        assert pub.external_container_id == "creation-1", "재시도 유효성의 진짜 신호(컨테이너 보존)"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_list_states_container_created_status_rendered_as_is():
    """AC7(e) 보완 — `status="container_created"`(컨테이너는 생겼고 publish 호출이 아직
    시도된 적 없는, 정상 흐름에서는 같은 함수 실행 안에서 순간적으로만 존재하는 상태)를
    행에 직접 시드해(설정용 직접 조작 — _approve_gate_directly와 동형 관례) 목록이 있는
    그대로 반사하는지만 확인한다(파생 로직 자체의 값 매핑 검증, publish 흐름 재현이 아님)."""
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
            draft_id, gate_id = await _seed_submit_approve(
                client, s, org_id=org_id, connection_id=connection_id, story_id=story_id,
            )

        async with Session() as s:
            from app.models.channel_publication import ChannelPublication
            from app.models.channel_post_version import ChannelPostVersion
            from sqlalchemy import select

            version_id = (await s.execute(
                select(ChannelPostVersion.id).where(ChannelPostVersion.draft_id == uuid.UUID(draft_id))
            )).scalar_one()
            s.add(ChannelPublication(
                id=uuid.uuid4(), org_id=org_id, gate_id=gate_id, version_id=version_id,
                connection_id=connection_id, channel="threads",
                external_container_id="creation-mid-flight", status="container_created",
            ))
            await s.commit()

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r_list = await client.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts")
        row = _row_for(r_list.json(), draft_id)
        assert row["publication_status"] == "container_created"
        assert row["published_at"] is None
        assert row["permalink"] is None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_reapproval_after_publish_keeps_old_publish_info_but_new_version_status_null():
    """PO 조인 축 정밀(2026-09-04) 회귀가드 — 발행 뒤 편집(재승인 필요)해도, 이전 발행
    이력(published_at·permalink·external_id)은 목록에서 사라지지 않는다(버전 무관 축).
    반면 publication_status(최신 버전 축)는 아직 그 새 버전이 발행된 적 없으므로 null이다.
    한 조인축으로 뭉치면 이 테스트가 published_at도 null로 떨어뜨려 RED가 난다."""
    from unittest.mock import AsyncMock, patch
    import app.services.threads_publish as tp
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            human_id = await _seed_human(s, org_id, role="owner")
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client, Session() as s:
            draft_id, gate_id = await _seed_submit_approve(
                client, s, org_id=org_id, connection_id=connection_id, story_id=story_id,
            )

        with (
            patch.object(tp, "create_container", AsyncMock(return_value="creation-1")),
            patch.object(tp, "publish_container", AsyncMock(return_value="media-1")),
            patch.object(tp, "get_publishing_limit", AsyncMock(return_value=(1, 250, 86400))),
            patch.object(tp, "get_permalink", AsyncMock(return_value="https://www.threads.net/@demo/post/media-1")),
        ):
            _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
            async with _client_for(app) as client:
                r_publish = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish")
                assert r_publish.status_code == 200, r_publish.text

        # 발행된 뒤 편집(새 버전) — approved 게이트를 pending+reapproval_required로 되돌린다.
        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r_edit = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                json=_draft_body(work_item_id=story_id, connection_id=connection_id, text="고친 본문입니다."),
            )
            assert r_edit.status_code == 201, r_edit.text
            new_body_sha256 = r_edit.json()["body_sha256"]

            r_list = await client.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts")
        row = _row_for(r_list.json(), draft_id)
        assert row["gate_status"] == "pending"
        assert row["reapproval_required"] is True
        assert row["published_at"] is not None, "이전 발행 이력이 편집 뒤에도 남아야 한다(버전 무관 축)"
        assert row["permalink"] == "https://www.threads.net/@demo/post/media-1"
        assert row["publication_status"] is None, "새 버전은 아직 발행 시도된 적 없다(최신 버전 축)"
        assert row["published_body_sha256"] != new_body_sha256, "발행분은 옛 버전 본문 해시 그대로다"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_max_text_length_on_connection_list():
    """AC4 — Threads connection은 max_text_length=500."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, role="owner")
            connection_id = await _seed_connection(s, org_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_id}/channel-connections")
        assert r.status_code == 200, r.text
        row = [c for c in r.json() if c["id"] == str(connection_id)][0]
        assert row["max_text_length"] == 500
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_tagged_link_preview_on_create_and_version_history():
    """AC5 — link_url 있으면 draft 생성 응답·버전이력 응답 둘 다 tagged_link_preview에
    UTM 태그된 최종 링크가 실린다(실제 발행이 쓰는 것과 같은 build_tagged_link 함수)."""
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
            r_draft = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                json=_draft_body(
                    work_item_id=story_id, connection_id=connection_id,
                    link_url="https://sprintable.ai/ko/blog/agent-sprint",
                ),
            )
            assert r_draft.status_code == 201, r_draft.text
            draft_id = r_draft.json()["draft_id"]
            preview = r_draft.json()["tagged_link_preview"]
            assert preview is not None
            assert preview.startswith("https://sprintable.ai/ko/blog/agent-sprint?")
            assert "utm_source=threads" in preview
            assert "utm_medium=social" in preview
            assert "utm_campaign=agent-sprint" in preview  # 대상 글 slug

            r_versions = await client.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/versions")
        assert r_versions.status_code == 200, r_versions.text
        assert r_versions.json()[0]["tagged_link_preview"] == preview

        # link_url 없는 경우 — null(지어내지 않는다).
        async with Session() as s:
            story_id_2 = await _seed_story(s, org_id, project_id)
        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r_no_link = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                json=_draft_body(work_item_id=story_id_2, connection_id=connection_id),
            )
        assert r_no_link.json()["tagged_link_preview"] is None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_list_query_count_does_not_scale_with_draft_count():
    """AC8(N+1 금지) — draft 1건→4건으로 늘려도 목록 SELECT 수는 고정(배치 조회 — 페이지
    쿼리 1 + gate 배치 1 + publication 배치 2 + version 해시 배치 1, draft 수 무관)."""
    from sqlalchemy import event
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)
            story_id = await _seed_story(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                json=_draft_body(work_item_id=story_id, connection_id=connection_id),
            )

            statements_1: list[str] = []

            def _capture(stmts):
                def _listener(conn, cursor, statement, parameters, context, executemany):
                    stmts.append(statement)
                return _listener

            listener_1 = _capture(statements_1)
            event.listen(engine.sync_engine, "before_cursor_execute", listener_1)
            try:
                r1 = await client.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts")
                assert r1.status_code == 200, r1.text
                assert len(r1.json()) == 1
            finally:
                event.remove(engine.sync_engine, "before_cursor_execute", listener_1)
            select_count_1 = len([st for st in statements_1 if st.strip().upper().startswith("SELECT")])

            # 서로 다른 work_item(=서로 다른 게이트)을 가리키는 draft 3건 추가.
            async with Session() as s:
                extra_story_ids = [await _seed_story(s, org_id, project_id) for _ in range(3)]
            for story_n in extra_story_ids:
                await client.post(
                    f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                    json=_draft_body(work_item_id=story_n, connection_id=connection_id),
                )

            statements_4: list[str] = []
            listener_4 = _capture(statements_4)
            event.listen(engine.sync_engine, "before_cursor_execute", listener_4)
            try:
                r4 = await client.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts")
                assert r4.status_code == 200, r4.text
                assert len(r4.json()) == 4
            finally:
                event.remove(engine.sync_engine, "before_cursor_execute", listener_4)
            select_count_4 = len([st for st in statements_4 if st.strip().upper().startswith("SELECT")])

        print(f"\n=== N+1 실측(channel-posts drafts): 1건 SELECT={select_count_1}, 4건 SELECT={select_count_4}")
        assert select_count_4 == select_count_1, (
            f"쿼리 수가 draft 수에 비례한다(N+1) — 1건={select_count_1}, 4건={select_count_4}"
        )
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
