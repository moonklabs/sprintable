"""story #3415(Phase1·마케팅운영·BE 후속, 페드루 PO 確定 2026-09-04) — channel-posts
목록/단건에 publication_command(story #3414)의 failure_kind·next_retry_at·dead_letter_at
+ gate.sealed_scheduled_at을 노출한다. #3414가 command 행에 저장까지만 끝내고 노출은 이
스토리로 절단했다.

응답 필드 이름은 유나 「Phase 1 화면 설계 — 채널 포스트 관리」§17-2(failure_kind 정본)·
§11-5(BE 계약)를 그대로 쓴다 — `next_retry_at`은 DB 컬럼명(`next_attempt_at`)과 다르며,
그 이름 불일치는 의도(화면 계약이 정본, §17 "어긋나면 §17이 이긴다").

카디르류 QA 축(스토리 QA 절 그대로):
- N+1 비회귀(쿼리 수 draft 개수 무관 고정) — command 배치가 실제로 도는 상태에서 측정.
- 목록↔단건 parity.
- 여러 command 이력이 있는 gate에서 "최신" 것만 노출되는지(과거 completed 이력에 안
  가려지는지) — 양성대조."""
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

    org = Organization(id=uuid.uuid4(), name="3415 Command Exposure Test Org", slug=slug or f"org-{uuid.uuid4().hex[:8]}")
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


def _row_for(items, draft_id):
    match = [it for it in items if it["draft_id"] == draft_id]
    assert len(match) == 1, f"draft {draft_id} not found in list: {items}"
    return match[0]


@pytest.mark.anyio
async def test_no_command_yet_all_new_fields_null():
    """AC3 — 상신·승인만 되고 발행/예약 요청이 아직 없으면(command 자체가 없음) 새 필드
    전부 null(지어내지 않는다)."""
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
            draft_id, gate_id = await _create_draft_submit_approve(
                client, s, org_id=org_id, connection_id=connection_id, story_id=story_id,
            )
            r_list = await client.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts")
        assert r_list.status_code == 200, r_list.text
        row = _row_for(r_list.json(), draft_id)
        assert row["failure_kind"] is None
        assert row["next_retry_at"] is None
        assert row["dead_letter_at"] is None
        assert row["scheduled_at"] is None
        assert row["command_status"] is None
        assert row["command_reason_code"] is None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_command_status_and_reason_code_distinguish_voided_pending_blocked():
    """페드루 PO 리뷰(2026-09-04, PR#3773) — voided(재승인 무효)·pending(예약 대기)·
    blocked(연결 문제 멈춤)가 failure_kind/next_retry_at/dead_letter_at만으로는 전부
    None/None/None로 구별 안 됐다. command_status(+reason_code)가 유나 §17-10 값
    그대로 이 셋을 가른다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client, Session() as s:
            story_pending = await _seed_story(s, org_id, project_id, title="pending")
            draft_pending, gate_pending = await _create_draft_submit_approve(
                client, s, org_id=org_id, connection_id=connection_id, story_id=story_pending,
                scheduled_at=datetime.now(timezone.utc) + timedelta(minutes=1),
            )
            story_voided = await _seed_story(s, org_id, project_id, title="voided")
            draft_voided, gate_voided = await _create_draft_submit_approve(
                client, s, org_id=org_id, connection_id=connection_id, story_id=story_voided,
                scheduled_at=datetime.now(timezone.utc) + timedelta(minutes=1),
            )
            story_blocked = await _seed_story(s, org_id, project_id, title="blocked")
            draft_blocked, gate_blocked = await _create_draft_submit_approve(
                client, s, org_id=org_id, connection_id=connection_id, story_id=story_blocked,
                scheduled_at=datetime.now(timezone.utc) + timedelta(minutes=1),
            )

        now = datetime.now(timezone.utc)
        async with Session() as s:
            from app.models.publication_command import PublicationCommand

            s.add_all([
                PublicationCommand(
                    id=uuid.uuid4(), org_id=org_id, gate_id=gate_pending, destination=connection_id,
                    approved_version=uuid.uuid4(), operation="publish", scheduled_at=None,
                    status="pending", requested_by_member_id=agent_id, created_at=now,
                ),
                PublicationCommand(
                    id=uuid.uuid4(), org_id=org_id, gate_id=gate_voided, destination=connection_id,
                    approved_version=uuid.uuid4(), operation="publish", scheduled_at=None,
                    status="voided", reason_code="CONTENT_CHANGED",
                    requested_by_member_id=agent_id, created_at=now,
                ),
                PublicationCommand(
                    id=uuid.uuid4(), org_id=org_id, gate_id=gate_blocked, destination=connection_id,
                    approved_version=uuid.uuid4(), operation="publish", scheduled_at=None,
                    status="blocked", failure_kind="connection",
                    requested_by_member_id=agent_id, created_at=now,
                ),
            ])
            await s.commit()

        async with _client_for(app) as client:
            r_list = await client.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts")
        items = r_list.json()
        row_pending = _row_for(items, draft_pending)
        row_voided = _row_for(items, draft_voided)
        row_blocked = _row_for(items, draft_blocked)

        assert row_pending["command_status"] == "pending"
        assert row_voided["command_status"] == "voided"
        assert row_voided["command_reason_code"] == "CONTENT_CHANGED"
        assert row_blocked["command_status"] == "blocked"
        # 셋 다 failure_kind/next_retry_at/dead_letter_at만으로는 안 갈린다는 걸 재확認
        # (blocked만 failure_kind가 있고 나머지 둘은 여전히 None — command_status가 없으면
        # pending과 voided를 화면이 구별할 길이 없었다).
        assert row_pending["failure_kind"] is None and row_voided["failure_kind"] is None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_scheduled_request_exposes_scheduled_at_from_gate_not_command():
    """AC2 — scheduled_at은 gate.sealed_scheduled_at 출처(command.scheduled_at이 아님,
    #3414에서 봉인값이 승인 판정의 정본으로 확定됨)."""
    from app.main import app

    scheduled_at = datetime.now(timezone.utc) + timedelta(days=1)
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
                scheduled_at=scheduled_at,
            )

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r_pub = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish")
            assert r_pub.status_code == 200, r_pub.text

            r_list = await client.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts")
        row = _row_for(r_list.json(), draft_id)
        assert row["scheduled_at"] is not None
        got = datetime.fromisoformat(row["scheduled_at"])
        assert abs((got - scheduled_at).total_seconds()) < 1
        # 예약 경로라 즉시발행이 아니다 — 아직 실패한 적 없으니 failure_kind 등은 null.
        assert row["failure_kind"] is None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_transient_failure_exposes_failure_kind_and_next_retry_at():
    """AC2 — cron이 일시 실패를 기록하면 목록에 failure_kind='transient'·next_retry_at이
    (DB 컬럼명 next_attempt_at을 그대로) 노출되는지."""
    from unittest.mock import AsyncMock, patch
    import app.services.threads_publish as tp
    from app.services.publication_command import process_due_publication_commands
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client, Session() as s:
            story_id = await _seed_story(s, org_id, project_id)
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

        from app.services.threads_publish import ThreadsPublishError
        with (
            patch.object(tp, "get_publishing_limit", AsyncMock(return_value=(1, 250, 86400))),
            patch.object(tp, "create_container", AsyncMock(side_effect=ThreadsPublishError(
                status_code=500, code="SERVER_ERROR", message="boom",
            ))),
        ):
            async with Session() as s:
                await process_due_publication_commands(s, now=now)

        async with _client_for(app) as client:
            r_list = await client.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts")
        row = _row_for(r_list.json(), draft_id)
        assert row["failure_kind"] == "transient"
        assert row["next_retry_at"] is not None
        assert row["dead_letter_at"] is None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_dead_letter_exposes_dead_letter_at_and_null_next_retry_at():
    """AC2 — dead_letter 도달 시 dead_letter_at은 채워지고 next_retry_at은 null(자동
    재시도 없음 — §11-3 "더 안 하나" 표현과 정합)."""
    from unittest.mock import AsyncMock, patch
    import app.services.threads_publish as tp
    from app.services.publication_command import MAX_RETRIES, process_due_publication_commands
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client, Session() as s:
            story_id = await _seed_story(s, org_id, project_id)
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
                attempt_count=MAX_RETRIES - 1,
            )
            s.add(cmd)
            await s.commit()

        from app.services.threads_publish import ThreadsPublishError
        with (
            patch.object(tp, "get_publishing_limit", AsyncMock(return_value=(1, 250, 86400))),
            patch.object(tp, "create_container", AsyncMock(side_effect=ThreadsPublishError(
                status_code=500, code="SERVER_ERROR", message="boom",
            ))),
        ):
            async with Session() as s:
                await process_due_publication_commands(s, now=now)

        async with _client_for(app) as client:
            r_list = await client.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts")
        row = _row_for(r_list.json(), draft_id)
        assert row["dead_letter_at"] is not None
        assert row["next_retry_at"] is None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_latest_command_wins_over_older_completed_history_on_same_gate():
    """스토리 QA③(양성대조) — 같은 gate에 옛 completed 이력(다른 approved_version) +
    새로 dead_letter된 최신 행이 같이 있으면, 목록은 **최신** 것만 반영한다(옛 completed
    이력에 가려지지 않는지)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client, Session() as s:
            story_id = await _seed_story(s, org_id, project_id)
            draft_id, gate_id = await _create_draft_submit_approve(
                client, s, org_id=org_id, connection_id=connection_id, story_id=story_id,
                scheduled_at=datetime.now(timezone.utc) + timedelta(minutes=1),
            )

        now = datetime.now(timezone.utc)
        async with Session() as s:
            from app.models.publication_command import PublicationCommand

            old_completed = PublicationCommand(
                id=uuid.uuid4(), org_id=org_id, gate_id=gate_id, destination=connection_id,
                approved_version=uuid.uuid4(), operation="publish", scheduled_at=None,
                status="completed", requested_by_member_id=agent_id,
                created_at=now - timedelta(hours=2),
            )
            newest_dead_letter = PublicationCommand(
                id=uuid.uuid4(), org_id=org_id, gate_id=gate_id, destination=connection_id,
                approved_version=uuid.uuid4(), operation="publish", scheduled_at=None,
                status="dead_letter", failure_kind="transient", attempt_count=5,
                dead_letter_at=now - timedelta(minutes=1), requested_by_member_id=agent_id,
                created_at=now - timedelta(minutes=5),
            )
            s.add_all([old_completed, newest_dead_letter])
            await s.commit()

        async with _client_for(app) as client:
            r_list = await client.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts")
        row = _row_for(r_list.json(), draft_id)
        assert row["failure_kind"] == "transient", (
            f"옛 completed 이력에 최신 dead_letter 행이 가려졌다: {row}"
        )
        assert row["dead_letter_at"] is not None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_list_and_detail_parity_for_new_fields():
    """AC4 — 목록↔단건이 새 필드 4종에서 동일 값을 낸다(#3403 패턴 그대로 pin)."""
    from unittest.mock import AsyncMock, patch
    import app.services.threads_publish as tp
    from app.services.publication_command import process_due_publication_commands
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client, Session() as s:
            story_id = await _seed_story(s, org_id, project_id)
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

        from app.services.threads_publish import ThreadsPublishError
        with (
            patch.object(tp, "get_publishing_limit", AsyncMock(return_value=(1, 250, 86400))),
            patch.object(tp, "create_container", AsyncMock(side_effect=ThreadsPublishError(
                status_code=500, code="SERVER_ERROR", message="boom",
            ))),
        ):
            async with Session() as s:
                await process_due_publication_commands(s, now=now)

        async with _client_for(app) as client:
            r_list = await client.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts")
            r_detail = await client.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}")
        list_row = _row_for(r_list.json(), draft_id)
        detail_row = r_detail.json()
        for key in (
            "failure_kind", "next_retry_at", "dead_letter_at", "scheduled_at",
            "command_status", "command_reason_code",
        ):
            assert list_row[key] == detail_row[key], (
                f"{key} 목록↔단건 불일치: list={list_row[key]!r} detail={detail_row[key]!r}"
            )
        assert list_row["failure_kind"] == "transient"  # 값 자체가 실려 있는지도 확認(공허통과 방지).
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_list_query_count_with_commands_does_not_scale_with_draft_count():
    """AC1(N+1 금지) — command 배치(⑥)가 실제로 도는 상태(각 draft에 dead_letter command
    존재)에서 1건→4건으로 늘려도 SELECT 수는 고정(총 6건, draft 수 무관).

    story #3394의 기존 N+1 테스트는 draft를 submit조차 안 해 gate_ids가 항상 비어 있다
    (`if gate_ids:` 가드로 ③~⑥ 배치가 전부 스킵됨) — 그 테스트는 이 새 배치 쿼리를 전혀
    실행 안 해서 회귀를 못 잡는다. 이 테스트는 gate+command가 실재하는 상태로 측정한다."""
    from sqlalchemy import event
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)

        async def _seed_draft_with_command(client, session, n: int) -> str:
            story_id = await _seed_story(session, org_id, project_id, title=f"NPlusOne {n}")
            draft_id, gate_id = await _create_draft_submit_approve(
                client, session, org_id=org_id, connection_id=connection_id, story_id=story_id,
                scheduled_at=datetime.now(timezone.utc) + timedelta(minutes=1),
            )
            from app.models.publication_command import PublicationCommand
            cmd = PublicationCommand(
                id=uuid.uuid4(), org_id=org_id, gate_id=gate_id, destination=connection_id,
                approved_version=uuid.uuid4(), operation="publish", scheduled_at=None,
                status="dead_letter", failure_kind="transient", attempt_count=5,
                dead_letter_at=datetime.now(timezone.utc), requested_by_member_id=agent_id,
            )
            session.add(cmd)
            await session.commit()
            return draft_id

        async with _client_for(app) as client, Session() as s:
            await _seed_draft_with_command(client, s, 1)

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

            for n in range(2, 5):
                await _seed_draft_with_command(client, s, n)

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

        print(f"\n=== N+1 실측(channel-posts drafts + commands): 1건 SELECT={select_count_1}, 4건 SELECT={select_count_4}")
        assert select_count_4 == select_count_1, (
            f"쿼리 수가 draft 수에 비례한다(N+1) — 1건={select_count_1}, 4건={select_count_4}"
        )
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
