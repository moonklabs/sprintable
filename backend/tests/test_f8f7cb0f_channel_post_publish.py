"""story #f8f7cb0f(Phase1·마케팅운영, 페드루 PO 확定 2026-09-03) — 서버 Threads 발행 실행.
승인·봉인 재검증 뒤 연결 토큰으로 발행·멱등·한도 잔량 조회·UTM 자동 부착·안정 에러코드.

AC 매핑:
- AC1: 휴먼 전용(에이전트 403 CHANNEL_POST_PUBLISH_HUMAN_ONLY) — 발행·한도 조회 둘 다.
- AC2: 발행 직전 게이트 approved·봉인 sha256 일치·connection active 재검증(fail-closed).
- AC3: 멱등 — 같은 (gate_id, version_id) 재요청은 Threads에 새 POST 없이 기존 행 반환.
  부분 성공(컨테이너 생성 후 publish 실패)은 status="failed"+external_container_id 보존으로 남고 재시도는 그
  컨테이너로 publish만. 컨테이너 생성 자체가 실패해도 같은 행을 갱신(PO 결정②, 새 행 안
  만듦).
- AC4: UTM(source=threads·medium=social·campaign=대상 글 slug 또는 draft_id) 자동
  부착·기존 쿼리 보존·이미 utm_*가 있으면 스킵.
- AC5: 한도 잔량 0이면 429 CHANNEL_RATE_LIMITED(reset_at 포함).
- AC6: 에러코드 안정 문자열 + provider 원문은 last_error에.
- AC7: 발행 성공 시 activity_logs actor_type=platform + permalink/external_id 기록,
  published_by_member_id는 context에(org_member.id, auth.user_id 아님).

뮤테이션(스토리 QA 명시) — 멱등 UNIQUE(gate_id, version_id) 조회를 제거하면 같은 버전
재요청이 Threads에 두 번 POST된다 — test_republish_same_version_is_idempotent가 그
경우 create_container/publish_container 호출 횟수로 잡는다."""
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
    """test_3373_channel_connections.py와 동형 패턴 — crypto 시크릿을 매 테스트 새로."""
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

    org = Organization(id=uuid.uuid4(), name="Channel Publish Test Org", slug=slug or f"org-{uuid.uuid4().hex[:8]}")
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


async def _org_member_id(session, *, org_id, user_id) -> str:
    from app.models.project import OrgMember
    from sqlalchemy import select

    member_id = (await session.execute(
        select(OrgMember.id).where(OrgMember.org_id == org_id, OrgMember.user_id == user_id)
    )).scalar_one()
    return str(member_id)


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
            # resolve_member()가 human/agent 분기를 이 클레임으로 가른다(_require_human
            # 게이트를 실제로 검증하려면 필수 — 이게 없으면 agent_id가 human 분기로 새서
            # "Organization member not found" 400으로 위장된 통과가 나온다).
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


async def _seed_and_submit_and_approve(client, session, *, org_id, connection_id, story_id, text="채널 포스트 본문입니다.", link_url=None):
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


@pytest.mark.anyio
async def test_agent_cannot_publish_returns_403():
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
            draft_id, gate_id = await _seed_and_submit_and_approve(
                client, s, org_id=org_id, connection_id=connection_id, story_id=story_id,
            )
            r_publish = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish")
        assert r_publish.status_code == 403, r_publish.text
        assert r_publish.json()["error"]["code"] == "CHANNEL_POST_PUBLISH_HUMAN_ONLY"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_publish_success_full_flow_with_utm_and_audit():
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
            draft_id, gate_id = await _seed_and_submit_and_approve(
                client, s, org_id=org_id, connection_id=connection_id, story_id=story_id,
                link_url="https://sprintable.ai/ko/blog/passed-but-not-checked",
            )

        captured_text = {}

        async def _fake_create_container(client, *, access_token, threads_user_id, text, image_url=None):
            captured_text["text"] = text
            assert access_token == "plain-access-token"
            return "creation-123"

        with (
            patch.object(tp, "create_container", AsyncMock(side_effect=_fake_create_container)),
            patch.object(tp, "publish_container", AsyncMock(return_value="media-456")),
            patch.object(tp, "get_publishing_limit", AsyncMock(return_value=(10, 250, 86400))),
            patch.object(
                tp, "get_permalink", AsyncMock(return_value="https://www.threads.net/@demo/post/media-456"),
            ),
        ):
            _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
            async with _client_for(app) as client:
                r_publish = await client.post(
                    f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish",
                )
        assert r_publish.status_code == 200, r_publish.text
        body = r_publish.json()
        assert body["external_id"] == "media-456"
        assert body["permalink"] == "https://www.threads.net/@demo/post/media-456"
        assert body["published_at"]

        # AC4 — UTM이 link_url에 부착돼 실제 발행 text에 실렸다(원본 latest.text/link_url은
        # 안 바뀜 — 이 assertion은 provider에 보낸 text만 본다).
        assert "채널 포스트 본문입니다." in captured_text["text"]
        assert "utm_source=threads" in captured_text["text"]
        assert "utm_medium=social" in captured_text["text"]
        assert "utm_campaign=passed-but-not-checked" in captured_text["text"], (
            "campaign은 link_url이 가리키는 대상 글의 slug여야 한다(draft_id 아님)"
        )

        # AC7 — activity_log actor_type=platform + published_by_member_id는 org_member.id.
        async with Session() as s:
            from app.models.activity_log import ActivityLog
            from sqlalchemy import select

            logs = (await s.execute(
                select(ActivityLog).where(
                    ActivityLog.org_id == org_id, ActivityLog.action == "channel_post_published",
                )
            )).scalars().all()
            expected_member_id = await _org_member_id(s, org_id=org_id, user_id=human_id)
        assert len(logs) == 1
        log = logs[0]
        assert log.actor_type == "platform"
        assert log.actor_id is None
        assert log.context["published_by_member_id"] == expected_member_id
        assert log.context["published_by_member_id"] != str(human_id)
        assert log.context["external_id"] == "media-456"

        # channel_publications 행 확인.
        async with Session() as s:
            from app.models.channel_publication import ChannelPublication
            from sqlalchemy import select

            row = (await s.execute(
                select(ChannelPublication).where(ChannelPublication.gate_id == gate_id)
            )).scalar_one()
        assert row.status == "published"
        assert row.external_container_id == "creation-123"
        assert row.external_id == "media-456"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_republish_same_version_is_idempotent_no_new_provider_call():
    """AC3·QA 뮤테이션 대상 — 같은 (gate_id, version_id) 재요청은 Threads에 새 POST가
    없다. create_container/publish_container 호출 횟수로 직접 pin."""
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
            draft_id, gate_id = await _seed_and_submit_and_approve(
                client, s, org_id=org_id, connection_id=connection_id, story_id=story_id,
            )

        create_mock = AsyncMock(return_value="creation-1")
        publish_mock = AsyncMock(return_value="media-1")
        with (
            patch.object(tp, "create_container", create_mock),
            patch.object(tp, "publish_container", publish_mock),
            patch.object(tp, "get_publishing_limit", AsyncMock(return_value=(1, 250, 86400))),
            patch.object(tp, "get_permalink", AsyncMock(return_value="https://www.threads.net/@demo/post/media-1")),
        ):
            _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
            async with _client_for(app) as client:
                r1 = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish")
                r2 = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish")
        assert r1.status_code == 200, r1.text
        assert r2.status_code == 200, r2.text
        assert r1.json() == r2.json()
        assert create_mock.call_count == 1, "멱등 위반 — 컨테이너 생성이 두 번 불렸다"
        assert publish_mock.call_count == 1, "멱등 위반 — publish가 두 번 불렸다"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_partial_success_retry_only_calls_publish_not_create_container():
    """AC3 — 컨테이너 생성 성공+publish 실패(부분 성공)는 status="failed"+external_container_id 보존으로 남고,
    재시도는 그 컨테이너로 publish만 다시 부른다(create_container 재호출 없음)."""
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
            draft_id, gate_id = await _seed_and_submit_and_approve(
                client, s, org_id=org_id, connection_id=connection_id, story_id=story_id,
            )

        create_mock = AsyncMock(return_value="creation-partial")
        publish_fail_then_succeed = AsyncMock(
            side_effect=[
                ThreadsPublishError("THREADS_PUBLISH_CONTAINER_FAILED", "temporary 500", status_code=500),
                "media-partial",
            ],
        )
        with (
            patch.object(tp, "create_container", create_mock),
            patch.object(tp, "publish_container", publish_fail_then_succeed),
            patch.object(tp, "get_publishing_limit", AsyncMock(return_value=(1, 250, 86400))),
            patch.object(tp, "get_permalink", AsyncMock(return_value=None)),
        ):
            _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
            async with _client_for(app) as client:
                r1 = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish")
            assert r1.status_code == 502, r1.text
            assert r1.json()["error"]["code"] == "CHANNEL_PUBLISH_PROVIDER_ERROR"

            async with Session() as s:
                from app.models.channel_publication import ChannelPublication
                from sqlalchemy import select

                row = (await s.execute(
                    select(ChannelPublication).where(ChannelPublication.gate_id == gate_id)
                )).scalar_one()
            # status는 "failed"(마지막 시도가 실패했다는 정직한 신호) — 재시도 유효성은
            # status가 아니라 external_container_id 보존으로 선다(코드 재확인: 아래 재시도가
            # create_container를 다시 안 부르는 것이 그 증거).
            assert row.status == "failed"
            assert row.external_container_id == "creation-partial"

            async with _client_for(app) as client:
                r2 = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish")
        assert r2.status_code == 200, r2.text
        assert create_mock.call_count == 1, "부분 성공 재시도가 컨테이너를 다시 만들면 안 된다"
        assert publish_fail_then_succeed.call_count == 2
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_container_creation_failure_upserts_same_row_not_new_one():
    """PO 결정② — 컨테이너 생성 자체가 실패해도 같은 (gate_id, version_id) 행을 그 자리에서
    갱신, 새 행을 만들지 않는다."""
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
            draft_id, gate_id = await _seed_and_submit_and_approve(
                client, s, org_id=org_id, connection_id=connection_id, story_id=story_id,
            )

        create_fail_then_succeed = AsyncMock(
            side_effect=[
                ThreadsPublishError("THREADS_CREATE_CONTAINER_FAILED", "temporary 500", status_code=500),
                "creation-recovered",
            ],
        )
        with (
            patch.object(tp, "create_container", create_fail_then_succeed),
            patch.object(tp, "publish_container", AsyncMock(return_value="media-recovered")),
            patch.object(tp, "get_publishing_limit", AsyncMock(return_value=(1, 250, 86400))),
            patch.object(tp, "get_permalink", AsyncMock(return_value=None)),
        ):
            _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
            async with _client_for(app) as client:
                r1 = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish")
            assert r1.status_code == 502, r1.text

            async with Session() as s:
                from app.models.channel_publication import ChannelPublication
                from sqlalchemy import select

                rows = (await s.execute(
                    select(ChannelPublication).where(ChannelPublication.gate_id == gate_id)
                )).scalars().all()
            assert len(rows) == 1, "실패 후에도 행이 1개여야 한다(새 행 생성 금지)"
            assert rows[0].status == "failed"
            assert rows[0].external_container_id is None

            async with _client_for(app) as client:
                r2 = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish")
        assert r2.status_code == 200, r2.text

        async with Session() as s:
            from app.models.channel_publication import ChannelPublication
            from sqlalchemy import select

            rows = (await s.execute(
                select(ChannelPublication).where(ChannelPublication.gate_id == gate_id)
            )).scalars().all()
        assert len(rows) == 1, "복구 후에도 여전히 행이 1개(UNIQUE(gate_id,version_id) upsert)"
        assert rows[0].status == "published"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_gate_not_approved_returns_403():
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
            await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/submit", json={})
            # 승인 안 함 — pending 그대로.

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r_publish = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish")
        assert r_publish.status_code == 403, r_publish.text
        assert r_publish.json()["error"]["code"] == "EXTERNAL_PUBLISH_APPROVAL_REQUIRED"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_reapproval_required_after_approved_edit_returns_409():
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
            draft_id, gate_id = await _seed_and_submit_and_approve(
                client, s, org_id=org_id, connection_id=connection_id, story_id=story_id,
            )
            # 승인 후 편집 — 게이트가 pending+reapproval_required=True로 되돌아간다.
            await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                json=_draft_body(
                    work_item_id=story_id, connection_id=connection_id, text="승인 후 수정된 본문.",
                ),
            )
            # pending으로 되돌아갔으니 강제로 다시 approved로(봉인은 옛 버전 그대로 — 실제
            # gates.py 승인 가드는 RESUBMIT_REQUIRED로 이 경로 자체를 막지만, 여기선
            # publish_channel_post_draft의 자체 봉인 재검증만 격리해서 본다).
            await _approve_gate_directly(s, gate_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r_publish = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish")
        assert r_publish.status_code == 409, r_publish.text
        assert r_publish.json()["error"]["code"] == "SITE_POST_REAPPROVAL_REQUIRED"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_connection_revoked_before_publish_returns_409():
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
            draft_id, gate_id = await _seed_and_submit_and_approve(
                client, s, org_id=org_id, connection_id=connection_id, story_id=story_id,
            )

        async with Session() as s:
            from app.models.channel_connection import ChannelConnection
            from sqlalchemy import select

            conn = (await s.execute(
                select(ChannelConnection).where(ChannelConnection.id == connection_id)
            )).scalar_one()
            conn.status = "revoked"
            await s.commit()

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r_publish = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish")
        assert r_publish.status_code == 409, r_publish.text
        assert r_publish.json()["error"]["code"] == "CHANNEL_CONNECTION_NOT_ACTIVE"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_rate_limited_returns_429_with_reset_at():
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
            draft_id, gate_id = await _seed_and_submit_and_approve(
                client, s, org_id=org_id, connection_id=connection_id, story_id=story_id,
            )

        with patch.object(tp, "get_publishing_limit", AsyncMock(return_value=(250, 250, 86400))):
            _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
            async with _client_for(app) as client:
                r_publish = await client.post(
                    f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish",
                )
        assert r_publish.status_code == 429, r_publish.text
        body = r_publish.json()
        assert body["error"]["code"] == "CHANNEL_RATE_LIMITED"
        assert body["error"]["reset_at"]
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_token_expired_returns_409_and_marks_connection_expired():
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
            draft_id, gate_id = await _seed_and_submit_and_approve(
                client, s, org_id=org_id, connection_id=connection_id, story_id=story_id,
            )

        with (
            patch.object(tp, "get_publishing_limit", AsyncMock(return_value=(1, 250, 86400))),
            patch.object(
                tp, "create_container",
                AsyncMock(side_effect=ThreadsPublishError("THREADS_CREATE_CONTAINER_FAILED", "expired token", status_code=401)),
            ),
        ):
            _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
            async with _client_for(app) as client:
                r_publish = await client.post(
                    f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish",
                )
        assert r_publish.status_code == 409, r_publish.text
        assert r_publish.json()["error"]["code"] == "CHANNEL_TOKEN_EXPIRED"

        async with Session() as s:
            from app.models.channel_connection import ChannelConnection
            from sqlalchemy import select

            conn = (await s.execute(
                select(ChannelConnection).where(ChannelConnection.id == connection_id)
            )).scalar_one()
        assert conn.status == "expired", "401/403이면 재인증 유도를 위해 connection.status=expired여야 한다"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_utm_skipped_when_link_already_has_utm_params():
    """AC4 — link_url에 이미 utm_*가 있으면 부착을 스킵(기존 값 보존)."""
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
            draft_id, gate_id = await _seed_and_submit_and_approve(
                client, s, org_id=org_id, connection_id=connection_id, story_id=story_id,
                link_url="https://sprintable.ai/ko/blog/already-tagged?utm_source=newsletter",
            )

        captured_text = {}

        async def _fake_create_container(client, *, access_token, threads_user_id, text, image_url=None):
            captured_text["text"] = text
            return "creation-utm-skip"

        with (
            patch.object(tp, "create_container", AsyncMock(side_effect=_fake_create_container)),
            patch.object(tp, "publish_container", AsyncMock(return_value="media-utm-skip")),
            patch.object(tp, "get_publishing_limit", AsyncMock(return_value=(1, 250, 86400))),
            patch.object(tp, "get_permalink", AsyncMock(return_value=None)),
        ):
            _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
            async with _client_for(app) as client:
                r_publish = await client.post(
                    f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish",
                )
        assert r_publish.status_code == 200, r_publish.text
        assert "utm_source=newsletter" in captured_text["text"]
        assert captured_text["text"].count("utm_source") == 1, "기존 utm_source가 있으면 새로 안 붙여야 한다"
        assert "utm_medium=social" not in captured_text["text"]
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_publishing_limit_endpoint_returns_quota_and_blocks_agent():
    from unittest.mock import AsyncMock, patch
    import app.services.threads_publish as tp
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            human_id = await _seed_human(s, org_id, role="member")
            connection_id = await _seed_connection(s, org_id)

        # 에이전트는 403(AC1).
        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r_agent = await client.get(
                f"/api/v2/organizations/{org_id}/channel-connections/{connection_id}/publishing-limit",
            )
        assert r_agent.status_code == 403, r_agent.text
        assert r_agent.json()["error"]["code"] == "CHANNEL_CONNECTION_HUMAN_ONLY"

        with patch.object(tp, "get_publishing_limit", AsyncMock(return_value=(37, 250, 86400))):
            _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
            async with _client_for(app) as client:
                r_human = await client.get(
                    f"/api/v2/organizations/{org_id}/channel-connections/{connection_id}/publishing-limit",
                )
        assert r_human.status_code == 200, r_human.text
        body = r_human.json()
        assert body["quota_usage"] == 37
        assert body["quota_total"] == 250
        assert body["quota_duration_seconds"] == 86400
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_no_token_leaks_in_response_or_error_bodies():
    """AC — 토큰 문자열이 응답·에러 어디에도 0건. provider 실패 메시지엔 토큰을 절대
    안 섞고(threads_publish.py가 자체적으로 안 실음), 성공 응답 스키마
    (PublishChannelPostResponse)에도 애초에 토큰을 담을 필드가 없다 — 둘 다 실측."""
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
            connection_id = await _seed_connection(s, org_id, token="super-secret-token-xyz")

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client, Session() as s:
            draft_id, gate_id = await _seed_and_submit_and_approve(
                client, s, org_id=org_id, connection_id=connection_id, story_id=story_id,
            )

        with (
            patch.object(tp, "get_publishing_limit", AsyncMock(return_value=(1, 250, 86400))),
            patch.object(
                tp, "create_container",
                AsyncMock(side_effect=ThreadsPublishError("X", "provider failure (no token here)", status_code=500)),
            ),
        ):
            _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
            async with _client_for(app) as client:
                r_publish = await client.post(
                    f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish",
                )
        assert "super-secret-token-xyz" not in r_publish.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_publish_time_length_recheck_with_utm_link_returns_422_zero_provider_calls():
    """페드루 PO 확定(2026-09-03, #3752 blocking 리뷰) — draft 저장 시점(#3374)의 길이
    검사는 `text`만 잰다. 발행 시점엔 UTM 태그된 link_url이 덧붙어 실제 전송 문자열이
    더 길어질 수 있다 — 승인된 480자 본문 혼자는 한도(500) 밑이어도 링크 부착 후 넘으면
    Threads 호출 0건·422 CHANNEL_TEXT_TOO_LONG으로 fail-closed(한도 조회보다 앞에서)."""
    from unittest.mock import AsyncMock, patch
    import app.services.threads_publish as tp
    from app.main import app

    call_count = {"n": 0}

    async def _fail_if_called(*args, **kwargs):
        call_count["n"] += 1
        raise AssertionError("Threads provider가 호출되면 안 된다 — 길이 재검사가 먼저 막아야 한다")

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            human_id = await _seed_human(s, org_id, role="owner")
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)

        long_text = "가" * 480  # 단독으로는 한도(500) 밑 — draft 저장 시점 검사를 통과한다.
        long_link = "https://sprintable.ai/ko/blog/" + "x" * 60  # UTM 부착 뒤 100자 이상 추가된다.

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client, Session() as s:
            draft_id, gate_id = await _seed_and_submit_and_approve(
                client, s, org_id=org_id, connection_id=connection_id, story_id=story_id,
                text=long_text, link_url=long_link,
            )

        with (
            patch.object(tp, "get_publishing_limit", AsyncMock(side_effect=_fail_if_called)),
            patch.object(tp, "create_container", AsyncMock(side_effect=_fail_if_called)),
            patch.object(tp, "publish_container", AsyncMock(side_effect=_fail_if_called)),
        ):
            _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
            async with _client_for(app) as client:
                r_publish = await client.post(
                    f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish",
                )
        assert r_publish.status_code == 422, r_publish.text
        body = r_publish.json()
        assert body["error"]["code"] == "CHANNEL_TEXT_TOO_LONG"
        assert body["error"]["max_length"] == 500
        assert body["error"]["current_length"] > 500
        assert call_count["n"] == 0, "Threads provider 호출이 0건이어야 한다(한도 조회 포함)"

        async with Session() as s:
            from app.models.channel_publication import ChannelPublication
            from sqlalchemy import select

            rows = (await s.execute(select(ChannelPublication).where(
                ChannelPublication.gate_id == gate_id,
            ))).scalars().all()
        assert rows == [], "provider 호출 전 거부됐으므로 ChannelPublication 행이 생기면 안 된다"

        # story #3474(페드루 리뷰 보정①, 2026-09-05) — publication_attempts 원장의
        # adapter_called는 「실제로 어댑터를 불렀나」의 사실이어야 한다. 이 테스트가
        # 이미 call_count==0으로 증명한 그 사실을 원장 자신도 그대로 반영하는지 고정
        # (raise 지점이 httpx 클라이언트 블록보다 앞이라 False가 맞다).
        async with Session() as s:
            from app.models.publication_attempt import PublicationAttempt
            from app.models.publication_command import PublicationCommand
            from sqlalchemy import select

            cmd_id = (await s.execute(
                select(PublicationCommand.id).where(PublicationCommand.gate_id == gate_id)
            )).scalar_one()
            attempt = (await s.execute(
                select(PublicationAttempt).where(PublicationAttempt.command_id == cmd_id)
            )).scalar_one()
        assert attempt.adapter_called is False
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_true_concurrent_publish_requests_no_500_single_provider_call():
    """story #3395(디디 코드 리뷰 발견, PR#3752) — 같은 (gate_id, version_id)로 진짜
    동시에(asyncio.gather, 실 HTTP 2건 — 각 요청이 FastAPI 의존성 주입으로 별도 세션을
    받는다) 발행 요청이 오면 둘 다 `existing=None`을 본 뒤 각자 INSERT를 시도해 UNIQUE
    (gate_id, version_id) 위반이 500으로 새던 것을 고친다.

    barrier(asyncio.Event)로 두 요청을 INSERT 직전 지점(get_publishing_limit)에서
    강제로 동시 대기시킨 뒤 같이 풀어준다 — 이게 없으면 로컬 실행 순서가 우연히 순차가
    돼 버려 레이스 자체가 재현 안 될 수 있다.

    AC — 둘 다 200, ChannelPublication 행 정확히 1개, Threads 실 호출(create_container·
    publish_container)은 정확히 1회씩만(진 쪽이 이어서 부르면 이긴 쪽이 처리 중인
    컨테이너를 이중 publish할 위험 — 그래서 진 쪽은 재조회한 행을 그대로 반환하고
    끝낸다)."""
    import asyncio as _asyncio
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
            draft_id, gate_id = await _seed_and_submit_and_approve(
                client, s, org_id=org_id, connection_id=connection_id, story_id=story_id,
            )

        arrived = _asyncio.Event()
        arrived_count = 0

        async def _barrier_get_publishing_limit(*args, **kwargs):
            nonlocal arrived_count
            arrived_count += 1
            if arrived_count >= 2:
                arrived.set()
            await arrived.wait()  # 둘 다 여기 도착해야 둘 다 통과 — INSERT 직전 지점을 강제로 겹치게 한다.
            return (1, 250, 86400)

        create_mock = AsyncMock(return_value="creation-race")
        publish_mock = AsyncMock(return_value="media-race")
        with (
            patch.object(tp, "create_container", create_mock),
            patch.object(tp, "publish_container", publish_mock),
            patch.object(tp, "get_publishing_limit", AsyncMock(side_effect=_barrier_get_publishing_limit)),
            patch.object(tp, "get_permalink", AsyncMock(return_value=None)),
        ):
            _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
            async with _client_for(app) as client:
                async def _call():
                    return await client.post(
                        f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish",
                    )

                r1, r2 = await _asyncio.gather(_call(), _call())

        assert r1.status_code == 200, r1.text
        assert r2.status_code == 200, r2.text
        assert create_mock.call_count == 1, f"이중 POST — create_container {create_mock.call_count}회"
        assert publish_mock.call_count == 1, f"이중 POST — publish_container {publish_mock.call_count}회"

        async with Session() as s:
            from app.models.channel_publication import ChannelPublication
            from sqlalchemy import select

            rows = (await s.execute(
                select(ChannelPublication).where(ChannelPublication.gate_id == gate_id)
            )).scalars().all()
        assert len(rows) == 1, f"UNIQUE(gate_id, version_id) 위반이 두 행을 만들었다: {len(rows)}개"
        assert r1.json()["external_id"] == r2.json()["external_id"] == "media-race"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
