"""story #3419(Phase1·마케팅운영, 페드루 PO 確定 2026-09-04) — 채널 포스트 «발행 취소»
서버 경로. ① 예약 명령 취소(POST .../cancel-scheduled) ② 발행된 글 회수(POST
.../unpublish, Threads 공식 삭제 API).

PO 確定 요지:
- ①-a 취소 대상 = pending·blocked·dead_letter(사람이 "이 명령을 끝내겠다"는 뜻). 그 외
  (in_progress·completed·voided·cancelled)는 409.
- ②-a Threads 삭제는 스코프 threads_delete가 필요 — 연결의 `scopes`(연결 시점에 어댑터
  `scope` 문자열을 그대로 저장, 그라운딩 확認)에 없으면 422 CHANNEL_SCOPE_INSUFFICIENT.
  기존 연결(이 스토리 前 저장분)은 항상 여기 걸린다(의도) — 새 연결부터 자동 해소.
- 둘 다 owner/admin 전용(site_posts unpublish 관례와 동일, 발행 자체보다 좁은 권한)."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

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

    org = Organization(id=uuid.uuid4(), name="3419 Cancel Unpublish Test Org", slug=slug or f"org-{uuid.uuid4().hex[:8]}")
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


async def _seed_connection(
    session, org_id, *, channel="threads", status="active", account_id=None, token="plain-access-token",
    scopes=None,
):
    from app.models.channel_connection import ChannelConnection
    from app.services.channel_credential_crypto import encrypt_channel_credential

    kwargs = {}
    if scopes is not None:
        kwargs["scopes"] = scopes
    conn = ChannelConnection(
        id=uuid.uuid4(), org_id=org_id, channel=channel,
        account_id=account_id or f"acct-{uuid.uuid4().hex[:8]}", status=status,
        credential_kind="oauth", refresh_mode="reissue_from_access_token",
        encrypted_access_token=encrypt_channel_credential(token) if status == "active" else None,
        **kwargs,
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


def _draft_body(*, work_item_id, connection_id, text="채널 포스트 본문입니다."):
    return {"work_item_id": str(work_item_id), "connection_id": str(connection_id), "text": text}


async def _create_draft_submit_approve(
    client, session, *, org_id, connection_id, story_id, text="채널 포스트 본문입니다.",
    scheduled_at: datetime | None = None,
):
    r_draft = await client.post(
        f"/api/v2/organizations/{org_id}/channel-posts/drafts",
        json=_draft_body(work_item_id=story_id, connection_id=connection_id, text=text),
    )
    assert r_draft.status_code == 201, r_draft.text
    draft_id = r_draft.json()["draft_id"]
    submit_body = {}
    if scheduled_at is not None:
        submit_body["scheduled_at"] = scheduled_at.isoformat()
    r_submit = await client.post(
        f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/submit", json=submit_body,
    )
    assert r_submit.status_code == 200, r_submit.text
    gate_id = uuid.UUID(r_submit.json()["gate_id"])
    await _approve_gate_directly(session, gate_id)
    return draft_id, gate_id


# --- AC1 — 예약 명령 취소 ---------------------------------------------------------


@pytest.mark.anyio
async def test_cancel_pending_command_then_cron_does_not_pick_it_up():
    """AC1 핵심 + QA 회귀 가드 — pending 취소 뒤 cancelled로 전이하고, cron 배치가
    (구조적으로 안전하지만) 실제로도 그 명령을 안 집는지 실측한다."""
    from app.main import app
    from app.services.publication_command import process_due_publication_commands

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
            draft_id, gate_id = await _create_draft_submit_approve(
                client, s, org_id=org_id, connection_id=connection_id, story_id=story_id,
                scheduled_at=datetime.now(timezone.utc) + timedelta(minutes=1),
            )

        now = datetime.now(timezone.utc)
        async with Session() as s:
            from app.models.publication_command import PublicationCommand
            from app.models.channel_post_version import ChannelPostVersion
            from sqlalchemy import select
            version_id = (await s.execute(
                select(ChannelPostVersion.id).where(ChannelPostVersion.draft_id == uuid.UUID(draft_id))
            )).scalar_one()
            cmd = PublicationCommand(
                id=uuid.uuid4(), org_id=org_id, gate_id=gate_id, destination=connection_id,
                approved_version=version_id, operation="publish",
                scheduled_at=now - timedelta(minutes=1), status="pending", requested_by_member_id=agent_id,
            )
            s.add(cmd)
            await s.commit()
            cmd_id = cmd.id

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r_cancel = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/cancel-scheduled",
            )
        assert r_cancel.status_code == 200, r_cancel.text
        body = r_cancel.json().get("data") or r_cancel.json()
        assert body["status"] == "cancelled"
        assert body["reason_code"] == "CANCELLED_BY_HUMAN"

        # cron 배치를 실제로 한 번 돌려도 이 명령이 처리 안 되는지(status 불변).
        async with Session() as s:
            await process_due_publication_commands(s, now=now)
        async with Session() as s:
            from app.models.publication_command import PublicationCommand
            from sqlalchemy import select
            cmd_row = (await s.execute(select(PublicationCommand).where(PublicationCommand.id == cmd_id))).scalar_one()
            assert cmd_row.status == "cancelled", "cron이 cancelled 명령을 건드림(회귀)"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_cancel_blocked_and_dead_letter_commands_allowed():
    """PO 確定 ①-a — blocked·dead_letter도 취소 대상(cron이 어차피 안 집는 상태지만
    사람이 명시적으로 끝낼 수 있어야 한다)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            human_id = await _seed_human(s, org_id, role="admin")
            connection_id = await _seed_connection(s, org_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        for status in ("blocked", "dead_letter"):
            async with _client_for(app) as client, Session() as s:
                story_id = await _seed_story(s, org_id, project_id, title=status)
                draft_id, gate_id = await _create_draft_submit_approve(
                    client, s, org_id=org_id, connection_id=connection_id, story_id=story_id,
                    scheduled_at=datetime.now(timezone.utc) + timedelta(minutes=1),
                )

            async with Session() as s:
                from app.models.publication_command import PublicationCommand
                cmd = PublicationCommand(
                    id=uuid.uuid4(), org_id=org_id, gate_id=gate_id, destination=connection_id,
                    approved_version=uuid.uuid4(), operation="publish", scheduled_at=None,
                    status=status, requested_by_member_id=agent_id,
                )
                s.add(cmd)
                await s.commit()

            _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
            async with _client_for(app) as client:
                r_cancel = await client.post(
                    f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/cancel-scheduled",
                )
            assert r_cancel.status_code == 200, f"{status} 취소 실패: {r_cancel.text}"
            body = r_cancel.json().get("data") or r_cancel.json()
            assert body["status"] == "cancelled", f"{status}에서 취소 안 됨: {body}"

            _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_cancel_completed_command_returns_409_with_current_status():
    """AC1 — 이미 끝난(completed) 명령을 취소하려 하면 409(현재 상태 실림)."""
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
            draft_id, gate_id = await _create_draft_submit_approve(
                client, s, org_id=org_id, connection_id=connection_id, story_id=story_id,
                scheduled_at=datetime.now(timezone.utc) + timedelta(minutes=1),
            )

        async with Session() as s:
            from app.models.publication_command import PublicationCommand
            cmd = PublicationCommand(
                id=uuid.uuid4(), org_id=org_id, gate_id=gate_id, destination=connection_id,
                approved_version=uuid.uuid4(), operation="publish", scheduled_at=None,
                status="completed", requested_by_member_id=agent_id,
            )
            s.add(cmd)
            await s.commit()

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r_cancel = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/cancel-scheduled",
            )
        assert r_cancel.status_code == 409, r_cancel.text
        body = r_cancel.json()
        error = body.get("error") or body
        assert error["code"] == "PUBLICATION_COMMAND_NOT_CANCELLABLE"
        assert error["current_status"] == "completed"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_cancel_no_command_returns_404():
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
            draft_id, _gate_id = await _create_draft_submit_approve(
                client, s, org_id=org_id, connection_id=connection_id, story_id=story_id,
            )

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r_cancel = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/cancel-scheduled",
            )
        assert r_cancel.status_code == 404, r_cancel.text
        body = r_cancel.json()
        error = body.get("error") or body
        assert error["code"] == "PUBLICATION_COMMAND_NOT_FOUND"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_cancel_agent_caller_forbidden():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{uuid.uuid4()}/cancel-scheduled",
            )
        assert r.status_code == 403, r.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_cancel_member_role_forbidden_owner_admin_only():
    """AC3 — site-posts unpublish 관례 그대로: 일반 member는 못 한다(owner/admin만)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            member_id = await _seed_human(s, org_id, role="member")

        _setup_org_scoped_app(app, Session, org_id, user_id=member_id)
        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{uuid.uuid4()}/cancel-scheduled",
            )
        assert r.status_code == 403, r.text
        body = r.json()
        error = body.get("error") or body
        assert error["code"] == "CHANNEL_POST_CANCEL_UNPUBLISH_OWNER_OR_ADMIN_ONLY"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# --- AC2 — 발행된 글 회수(unpublish) ------------------------------------------------


async def _publish_immediately(app, Session, *, org_id, connection_id, story_id, agent_id, human_id):
    """즉시발행 성공까지 왕복(mock)한 뒤 (draft_id, gate_id, external_id)를 돌려준다.
    상신(에이전트 가능)과 발행(휴먼 전용)이 서로 다른 actor라 컨텍스트를 각각 스위치
    한다 — 이 함수 호출 뒤 app 컨텍스트는 human_id로 남는다(그대로 취소/회수 호출
    가능)."""
    from unittest.mock import AsyncMock, patch
    import app.services.threads_publish as tp

    _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
    async with _client_for(app) as client, Session() as s:
        draft_id, gate_id = await _create_draft_submit_approve(
            client, s, org_id=org_id, connection_id=connection_id, story_id=story_id,
        )

    _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
    with (
        patch.object(tp, "get_publishing_limit", AsyncMock(return_value=(1, 250, 86400))),
        patch.object(tp, "create_container", AsyncMock(return_value="creation-x")),
        patch.object(tp, "publish_container", AsyncMock(return_value="media-x")),
        patch.object(tp, "get_permalink", AsyncMock(return_value="https://www.threads.net/@demo/post/media-x")),
    ):
        async with _client_for(app) as client:
            r_pub = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish")
    assert r_pub.status_code == 200, r_pub.text
    return draft_id, gate_id, "media-x"


@pytest.mark.anyio
async def test_unpublish_scope_insufficient_returns_422_with_required_scopes():
    """PO 確定 ②-a 핵심 — 기존 연결(threads_delete 스코프 없이 저장)로는 회수가
    422 CHANNEL_SCOPE_INSUFFICIENT로 막힌다(required_scopes 실림). Threads 호출
    0건(mock 미설치 상태에서 성공하면 실제로 호출을 안 한 것 — 가드가 먼저 막았다는
    뜻)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            human_id = await _seed_human(s, org_id, role="owner")
            story_id = await _seed_story(s, org_id, project_id)
            # scopes 명시 안 함 — server_default=[](threads_delete 없음), 기존 연결 재현.
            connection_id = await _seed_connection(s, org_id)

        draft_id, gate_id, external_id = await _publish_immediately(
            app, Session, org_id=org_id, connection_id=connection_id, story_id=story_id,
            agent_id=agent_id, human_id=human_id,
        )
        async with _client_for(app) as client:
            r_unpub = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/unpublish")
        assert r_unpub.status_code == 422, r_unpub.text
        body = r_unpub.json()
        error = body.get("error") or body
        assert error["code"] == "CHANNEL_SCOPE_INSUFFICIENT"
        assert "threads_delete" in error["required_scopes"]
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_unpublish_success_with_sufficient_scope_marks_unpublished_preserves_external_id():
    """AC2 — 스코프가 있으면 실제 삭제 호출→성공 시 status='unpublished'·external_id
    보존(지워지지 않음)·시각 기록(updated_at)."""
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
            connection_id = await _seed_connection(
                s, org_id, scopes=["threads_basic", "threads_content_publish", "threads_delete"],
            )

        draft_id, gate_id, external_id = await _publish_immediately(
            app, Session, org_id=org_id, connection_id=connection_id, story_id=story_id,
            agent_id=agent_id, human_id=human_id,
        )
        with patch.object(tp, "delete_media", AsyncMock(return_value=None)) as mock_delete:
            async with _client_for(app) as client:
                r_unpub = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/unpublish")
        assert r_unpub.status_code == 200, r_unpub.text
        body = r_unpub.json().get("data") or r_unpub.json()
        assert body["status"] == "unpublished"
        assert body["external_id"] == external_id
        assert body["unpublished_at"] is not None
        assert mock_delete.await_count == 1
        _, kwargs = mock_delete.call_args
        assert kwargs["media_id"] == external_id
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_unpublish_not_published_returns_409():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            human_id = await _seed_human(s, org_id, role="owner")
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_connection(
                s, org_id, scopes=["threads_basic", "threads_content_publish", "threads_delete"],
            )

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client, Session() as s:
            draft_id, gate_id = await _create_draft_submit_approve(
                client, s, org_id=org_id, connection_id=connection_id, story_id=story_id,
            )

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r_unpub = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/unpublish")
        assert r_unpub.status_code == 409, r_unpub.text
        body = r_unpub.json()
        error = body.get("error") or body
        assert error["code"] == "CHANNEL_POST_NOT_PUBLISHED"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_unpublish_twice_second_time_returns_409_not_published():
    """양성대조 — unpublish 성공 뒤 다시 시도하면(이미 회수됨) 409(재-삭제 시도가
    Threads로 안 나가야 한다)."""
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
            connection_id = await _seed_connection(
                s, org_id, scopes=["threads_basic", "threads_content_publish", "threads_delete"],
            )

        draft_id, gate_id, external_id = await _publish_immediately(
            app, Session, org_id=org_id, connection_id=connection_id, story_id=story_id,
            agent_id=agent_id, human_id=human_id,
        )
        with patch.object(tp, "delete_media", AsyncMock(return_value=None)) as mock_delete:
            async with _client_for(app) as client:
                r1 = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/unpublish")
                assert r1.status_code == 200, r1.text
                r2 = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/unpublish")
        assert r2.status_code == 409, r2.text
        error = r2.json().get("error") or r2.json()
        assert error["code"] == "CHANNEL_POST_NOT_PUBLISHED"
        assert mock_delete.await_count == 1, "두 번째 호출이 Threads DELETE를 또 냈다"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_unpublish_provider_error_maps_to_502():
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
            connection_id = await _seed_connection(
                s, org_id, scopes=["threads_basic", "threads_content_publish", "threads_delete"],
            )

        draft_id, gate_id, external_id = await _publish_immediately(
            app, Session, org_id=org_id, connection_id=connection_id, story_id=story_id,
            agent_id=agent_id, human_id=human_id,
        )

        from app.services.threads_publish import ThreadsPublishError

        with patch.object(
            tp, "delete_media",
            AsyncMock(side_effect=ThreadsPublishError("THREADS_DELETE_MEDIA_FAILED", "boom", status_code=500)),
        ):
            async with _client_for(app) as client:
                r_unpub = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/unpublish")
        assert r_unpub.status_code == 502, r_unpub.text
        error = r_unpub.json().get("error") or r_unpub.json()
        assert error["code"] == "CHANNEL_PUBLISH_PROVIDER_ERROR"

        # 실패했으니 status는 여전히 published(unpublished로 잘못 바뀌면 안 된다).
        async with Session() as s:
            from app.models.channel_publication import ChannelPublication
            from sqlalchemy import select
            pub = (await s.execute(
                select(ChannelPublication).where(ChannelPublication.gate_id == gate_id)
            )).scalar_one()
            assert pub.status == "published", "실패했는데 unpublished로 바뀜(회귀)"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_unpublish_agent_caller_forbidden():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{uuid.uuid4()}/unpublish",
            )
        assert r.status_code == 403, r.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_unpublish_unsupported_channel_returns_422():
    """AC2 — 어댑터가 supports_unpublish=False로 선언한 채널은 스코프 확인 前에 이미
    422(서버도 독립적으로 거부 — FE 버튼 미노출과 별개의 방어선)."""
    from unittest.mock import patch
    from app.main import app
    import app.services.channel_posts as cp_module
    from app.services.channel_adapters import ChannelAdapterConfig

    unsupported_adapter = ChannelAdapterConfig(
        authorize_url="https://example.test/oauth", token_url="https://example.test/token",
        scope="basic", refresh_mode="manual", max_text_length=500,
        supports_unpublish=False,
    )

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            human_id = await _seed_human(s, org_id, role="owner")
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_connection(
                s, org_id, scopes=["threads_basic", "threads_content_publish", "threads_delete"],
            )

        draft_id, gate_id, external_id = await _publish_immediately(
            app, Session, org_id=org_id, connection_id=connection_id, story_id=story_id,
            agent_id=agent_id, human_id=human_id,
        )
        with patch.object(cp_module, "get_channel_adapter", return_value=unsupported_adapter):
            async with _client_for(app) as client:
                r_unpub = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/unpublish")
        assert r_unpub.status_code == 422, r_unpub.text
        error = r_unpub.json().get("error") or r_unpub.json()
        assert error["code"] == "CHANNEL_UNPUBLISH_UNSUPPORTED"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
