"""story #3414(Phase1·마케팅운영, 페드루 PO 確定 2026-09-04) — 발행 명령·예약 스케줄러.

블루프린트 v3 §3 「발행 명령」·「예약 스케줄러」·「서버 발행 워커」 구현. PO 確定 (B):
재승인 판정 지점은 `submit_channel_post_draft` 하나(본문 해시 또는 scheduled_at 중
하나라도 봉인값과 다르면 재승인). 즉시 발행=scheduled_at 없음인 같은 명령(같은
`/publish` 엔드포인트가 둘 다 처리).

카디르 QA(스토리 본문 6항) 반영:
① 멱등키 동시성 — 진짜 동시 HTTP 요청(순차 아님)으로 검증.
② scheduled_at 경계 — sleep 대신 과거/미래 행을 심고 cron 1회 호출로 대조.
③ voided — 같은 gate에 completed 행+pending 행을 같이 심어 pending만 voided되는지.
④ Retry-After — 기본 백오프와 다른 값으로 헤더가 실제로 반영됐는지.
⑤ dead_letter 수동재시도 — retry 뒤 cron을 한 번 더 돌려 실제 재처리되는지.
⑥ 즉시발행 순서 — 재검증 실패 시 command 행 자체가 안 생기는지."""
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

    org = Organization(id=uuid.uuid4(), name="Publication Command Test Org", slug=slug or f"org-{uuid.uuid4().hex[:8]}")
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


# --- AC1/AC2 — 봉인+명령 생성 -------------------------------------------------


@pytest.mark.anyio
async def test_submit_with_scheduled_at_seals_it_and_publish_returns_scheduled_command():
    """AC1·AC2 — scheduled_at을 실어 상신하면 gate.sealed_scheduled_at에 봉인되고,
    승인 뒤 발행 요청은 command만 만들고 Threads는 안 부른다."""
    from unittest.mock import AsyncMock, patch
    import app.services.threads_publish as tp
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

        with (
            patch.object(tp, "create_container", AsyncMock()) as mock_create,
            patch.object(tp, "publish_container", AsyncMock()) as mock_publish,
        ):
            _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
            async with _client_for(app) as client:
                r = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish")
            assert r.status_code == 200, r.text
            body = r.json()["data"] if "data" in r.json() else r.json()
            assert body["scheduled"] is True
            assert body["command_id"] is not None
            assert body["scheduled_at"] is not None
            mock_create.assert_not_called()
            mock_publish.assert_not_called()

        async with Session() as s:
            from app.models.gate import Gate
            from sqlalchemy import select
            gate = (await s.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()
            assert gate.sealed_scheduled_at is not None

            from app.models.publication_command import PublicationCommand
            cmd = (await s.execute(
                select(PublicationCommand).where(PublicationCommand.gate_id == gate_id)
            )).scalar_one()
            assert cmd.status == "pending"
            assert cmd.scheduled_at is not None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_publish_immediate_no_scheduled_at_completes_synchronously_and_marks_command_completed():
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
            draft_id, gate_id = await _create_draft_submit_approve(
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
                r = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish")
            assert r.status_code == 200, r.text
            body = r.json()["data"] if "data" in r.json() else r.json()
            assert body["scheduled"] is False
            assert body["permalink"] == "https://www.threads.net/@demo/post/media-1"

        async with Session() as s:
            from app.models.publication_command import PublicationCommand
            from sqlalchemy import select
            cmd = (await s.execute(
                select(PublicationCommand).where(PublicationCommand.gate_id == gate_id)
            )).scalar_one()
            assert cmd.status == "completed"
            assert cmd.scheduled_at is None

            # story #3474(페드루 리뷰 확認②, 2026-09-05) — 이 즉시-발행 경로는
            # `_process_one_command`(cron 워커)를 안 거치는 별도 동기 경로다. 원장이
            # 이 경로에서도 실제로 쓰이는지(워커 전용 반쪽 계측이 아닌지)를 이 기존
            # ok-경로 테스트에 한 줄로 고정한다.
            from app.models.publication_attempt import PublicationAttempt
            attempt = (await s.execute(
                select(PublicationAttempt).where(PublicationAttempt.command_id == cmd.id)
            )).scalar_one()
            assert attempt.approval_check == "ok"
            assert attempt.adapter_called is True
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_publish_denied_when_gate_not_approved_creates_no_orphan_command():
    """카디르 QA⑥ — 재검증 실패(게이트 미승인)로 요청이 거부되면 command 행 자체가
    안 생겨야 한다(고아 pending 행이 남아 워커가 엉뚱하게 재시도하는 것을 방지)."""
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
            r_submit = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/submit", json={},
            )
            assert r_submit.status_code == 200, r_submit.text
            # 승인 안 함 — pending 그대로.

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish")
        assert r.status_code == 403, r.text

        async with Session() as s:
            from app.models.publication_command import PublicationCommand
            from sqlalchemy import select
            rows = (await s.execute(select(PublicationCommand))).scalars().all()
            assert len(rows) == 0, "게이트 미승인으로 거부됐는데 command 행이 생겼다(고아 행)"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_publish_immediate_idempotent_no_duplicate_command_sequential():
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
            draft_id, gate_id = await _create_draft_submit_approve(
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
                r1 = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish")
                assert r1.status_code == 200, r1.text
                r2 = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish")
                assert r2.status_code == 200, r2.text

        async with Session() as s:
            from app.models.publication_command import PublicationCommand
            from sqlalchemy import select
            rows = (await s.execute(
                select(PublicationCommand).where(PublicationCommand.gate_id == gate_id)
            )).scalars().all()
            assert len(rows) == 1, "같은 (org,destination,approved_version,operation) 재요청이 새 행을 만들었다"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_publish_immediate_true_concurrent_requests_single_command_row():
    """카디르 QA① — 순차 호출이 아니라 진짜 동시 두 요청(asyncio.gather)으로 검증한다.
    story #3395(PR#3757)와 동형 클래스(UNIQUE 위반 500 위험) — SAVEPOINT+재조회 방어가
    실제로 동작하는지. #3757의 barrier 기법 그대로 재사용 — asyncio.Event로 두 요청을
    `resolve_command_target` 반환 직전(=command upsert 직전 지점)에서 강제로 겹치게
    한다. 이게 없으면 로컬 실행 순서가 우연히 순차가 돼 버려 레이스 자체가 재현 안 될
    수 있다(실측: barrier 없이 먼저 시도했을 때 실제로 재현이 안 됐다)."""
    import asyncio
    from unittest.mock import AsyncMock, patch
    import app.services.channel_posts as channel_posts_service
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
            draft_id, gate_id = await _create_draft_submit_approve(
                client, s, org_id=org_id, connection_id=connection_id, story_id=story_id,
            )

        arrived = asyncio.Event()
        arrived_count = 0
        real_resolve_command_target = channel_posts_service.resolve_command_target

        async def _barrier_resolve_command_target(*args, **kwargs):
            nonlocal arrived_count
            result = await real_resolve_command_target(*args, **kwargs)
            arrived_count += 1
            if arrived_count >= 2:
                arrived.set()
            await arrived.wait()  # 둘 다 여기 도착해야 통과 — upsert 직전 지점을 겹치게 한다.
            return result

        with (
            patch.object(channel_posts_service, "resolve_command_target", side_effect=_barrier_resolve_command_target),
            patch.object(tp, "create_container", AsyncMock(return_value="creation-1")),
            patch.object(tp, "publish_container", AsyncMock(return_value="media-1")),
            patch.object(tp, "get_publishing_limit", AsyncMock(return_value=(1, 250, 86400))),
            patch.object(tp, "get_permalink", AsyncMock(return_value="https://www.threads.net/@demo/post/media-1")),
        ):
            _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
            async with _client_for(app) as client_a, _client_for(app) as client_b:
                r_a, r_b = await asyncio.gather(
                    client_a.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish"),
                    client_b.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish"),
                )
            assert r_a.status_code == 200, r_a.text
            assert r_b.status_code == 200, r_b.text

        async with Session() as s:
            from app.models.publication_command import PublicationCommand
            from sqlalchemy import select
            rows = (await s.execute(
                select(PublicationCommand).where(PublicationCommand.gate_id == gate_id)
            )).scalars().all()
            assert len(rows) == 1, "진짜 동시 요청 2건이 publication_commands에 서로 다른 행을 만들었다"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# --- 재승인 판정(PO 確定 B) — submit_channel_post_draft 단일 지점 -------------------


@pytest.mark.anyio
async def test_resubmit_identical_content_and_schedule_is_noop():
    from app.main import app

    scheduled_at = datetime.now(timezone.utc) + timedelta(days=1)
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
                scheduled_at=scheduled_at,
            )
            r_resubmit = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/submit",
                json={"scheduled_at": scheduled_at.isoformat()},
            )
            assert r_resubmit.status_code == 200, r_resubmit.text

            from app.models.gate import Gate
            from sqlalchemy import select
            gate = (await s.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()
            assert gate.status == "approved", "무변경 재상신이 승인을 되돌렸다(no-op이어야 함)"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_resubmit_schedule_change_after_approval_triggers_reapproval_and_voids_only_pending_command():
    """PO 정정3 (B) + 카디르 QA③ — 본문은 그대로, scheduled_at만 바뀐 재상신도 승인을
    되돌리고(gate.status를 pending으로) 대기 중 command를 voided(SCHEDULE_CHANGED)로
    무효화한다. 페드루 리뷰 nit K — reapproval_required 자체는 False로 남는다(Gate
    모델 문서화 계약: 그건 "시스템이 조용히 되돌렸다"는 신호고, 이건 사람이 방금
    명시적으로 재상신한 경로라 True가 될 이유가 없다 — 아래 assert 참고). 양성대조:
    같은 gate에 이미 completed 상태인 옛 행이 하나 더 있어도 그 행은 안 건드리는지
    (gate_id만으로 뭉개면 다른 행까지 오염되는 결함을 잡는다)."""
    from unittest.mock import AsyncMock, patch
    import app.services.threads_publish as tp
    from app.main import app

    scheduled_at_1 = datetime.now(timezone.utc) + timedelta(days=1)
    scheduled_at_2 = datetime.now(timezone.utc) + timedelta(days=2)
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
                scheduled_at=scheduled_at_1,
            )

        # 양성대조 표본 — 같은 gate에 이미 종결된(completed) command 행 하나를 직접 심는다
        # (다른 approved_version — UNIQUE 키가 달라야 별개 행으로 들어간다).
        async with Session() as s:
            from app.models.publication_command import PublicationCommand
            old_completed = PublicationCommand(
                id=uuid.uuid4(), org_id=org_id, gate_id=gate_id, destination=connection_id,
                approved_version=uuid.uuid4(), operation="publish", scheduled_at=None,
                status="completed", requested_by_member_id=uuid.uuid4(),
            )
            s.add(old_completed)
            await s.commit()
            old_completed_id = old_completed.id

        # scheduled_at_1로 예약 발행 요청 — pending command 1건 생성.
        with (
            patch.object(tp, "create_container", AsyncMock()),
            patch.object(tp, "publish_container", AsyncMock()),
        ):
            _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
            async with _client_for(app) as client:
                r_pub = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish")
                assert r_pub.status_code == 200, r_pub.text
                pending_command_id = uuid.UUID((r_pub.json().get("data") or r_pub.json())["command_id"])

        # 본문은 그대로, scheduled_at만 바꿔 재상신 — 재승인 트리거돼야 한다.
        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r_resubmit = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/submit",
                json={"scheduled_at": scheduled_at_2.isoformat()},
            )
            assert r_resubmit.status_code == 200, r_resubmit.text

        async with Session() as s:
            from app.models.gate import Gate
            from app.models.publication_command import PublicationCommand
            from sqlalchemy import select

            gate = (await s.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()
            assert gate.status == "pending"
            # reapproval_required는 "시스템이 조용히 되돌렸다"는 신호(Gate 모델 문서화된
            # 계약) — 이건 사람이 방금 명시적으로 재상신한 경로라 False로 복귀하는 게
            # 기존 설계 그대로(submit_channel_post_draft 재상신은 항상 False로 리셋).
            assert gate.reapproval_required is False
            # 페드루 리뷰 nit K — "not None"만으론 값 자체가 새 요청(scheduled_at_2)로
            # 갱신됐는지 증명 못 한다(옛 값이 그대로 남아도 통과). 정확한 값 대조.
            assert gate.sealed_scheduled_at == scheduled_at_2

            voided = (await s.execute(
                select(PublicationCommand).where(PublicationCommand.id == pending_command_id)
            )).scalar_one()
            assert voided.status == "voided"
            assert voided.reason_code == "SCHEDULE_CHANGED"

            # 양성대조 — 옛 completed 행은 절대 안 건드려졌는지.
            untouched = (await s.execute(
                select(PublicationCommand).where(PublicationCommand.id == old_completed_id)
            )).scalar_one()
            assert untouched.status == "completed", "gate_id만으로 뭉개져 종결된 다른 행까지 오염됐다"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_resubmit_content_change_after_approval_voids_with_content_changed_reason():
    """새 draft 버전(본문 편집)이 approved→pending을 되돌리는 조용한 경로
    (_reseal_gate_on_new_version)도 대기 중 command를 voided(CONTENT_CHANGED)로
    무효화하는지."""
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
            draft_id, gate_id = await _create_draft_submit_approve(
                client, s, org_id=org_id, connection_id=connection_id, story_id=story_id,
                scheduled_at=datetime.now(timezone.utc) + timedelta(days=1),
            )

        with (
            patch.object(tp, "create_container", AsyncMock()),
            patch.object(tp, "publish_container", AsyncMock()),
        ):
            _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
            async with _client_for(app) as client:
                r_pub = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish")
                assert r_pub.status_code == 200, r_pub.text
                pending_command_id = uuid.UUID((r_pub.json().get("data") or r_pub.json())["command_id"])

        # 본문 편집(새 버전) — 명시적 재상신 없이 _reseal_gate_on_new_version 훅만 탄다.
        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r_edit = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                json=_draft_body(work_item_id=story_id, connection_id=connection_id, text="수정된 본문입니다."),
            )
            assert r_edit.status_code == 201, r_edit.text

        async with Session() as s:
            from app.models.publication_command import PublicationCommand
            from sqlalchemy import select
            voided = (await s.execute(
                select(PublicationCommand).where(PublicationCommand.id == pending_command_id)
            )).scalar_one()
            assert voided.status == "voided"
            assert voided.reason_code == "CONTENT_CHANGED"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# --- cron 워커(AC3) — 카디르 QA② 비-sleep 시각경계 ----------------------------------


@pytest.mark.anyio
async def test_cron_claims_only_due_scheduled_commands_not_future_ones():
    """카디르 QA② — sleep 대신 과거/미래로 정확히 고정한 두 행을 심고 cron을 그 자리에서
    1회 호출해 대조한다."""
    from unittest.mock import AsyncMock, patch
    import app.services.threads_publish as tp
    from app.services.publication_command import process_due_publication_commands

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)

        from app.main import app
        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client, Session() as s:
            story_past = await _seed_story(s, org_id, project_id, title="과거분")
            story_future = await _seed_story(s, org_id, project_id, title="미래분")
            draft_past, gate_past = await _create_draft_submit_approve(
                client, s, org_id=org_id, connection_id=connection_id, story_id=story_past,
                text="과거 예약", scheduled_at=datetime.now(timezone.utc) + timedelta(minutes=1),
            )
            draft_future, gate_future = await _create_draft_submit_approve(
                client, s, org_id=org_id, connection_id=connection_id, story_id=story_future,
                text="미래 예약", scheduled_at=datetime.now(timezone.utc) + timedelta(minutes=1),
            )

        now = datetime.now(timezone.utc)
        async with Session() as s:
            from app.models.publication_command import PublicationCommand
            from app.models.channel_post_version import ChannelPostVersion
            from sqlalchemy import select

            async def _version_id_for(draft_id):
                return (await s.execute(
                    select(ChannelPostVersion.id).where(ChannelPostVersion.draft_id == uuid.UUID(draft_id))
                )).scalar_one()

            past_cmd = PublicationCommand(
                id=uuid.uuid4(), org_id=org_id, gate_id=gate_past, destination=connection_id,
                approved_version=await _version_id_for(draft_past), operation="publish",
                scheduled_at=now - timedelta(hours=1), status="pending", requested_by_member_id=agent_id,
            )
            future_cmd = PublicationCommand(
                id=uuid.uuid4(), org_id=org_id, gate_id=gate_future, destination=connection_id,
                approved_version=await _version_id_for(draft_future), operation="publish",
                scheduled_at=now + timedelta(hours=1), status="pending", requested_by_member_id=agent_id,
            )
            s.add_all([past_cmd, future_cmd])
            await s.commit()
            past_cmd_id, future_cmd_id = past_cmd.id, future_cmd.id

        with (
            patch.object(tp, "create_container", AsyncMock(return_value="creation-x")),
            patch.object(tp, "publish_container", AsyncMock(return_value="media-x")),
            patch.object(tp, "get_publishing_limit", AsyncMock(return_value=(1, 250, 86400))),
            patch.object(tp, "get_permalink", AsyncMock(return_value="https://www.threads.net/@demo/post/media-x")),
        ):
            async with Session() as s:
                await process_due_publication_commands(s, now=now)

        async with Session() as s:
            from app.models.publication_command import PublicationCommand
            from sqlalchemy import select
            past = (await s.execute(select(PublicationCommand).where(PublicationCommand.id == past_cmd_id))).scalar_one()
            future = (await s.execute(select(PublicationCommand).where(PublicationCommand.id == future_cmd_id))).scalar_one()
            assert past.status == "completed", "도래한(과거) scheduled_at 행을 cron이 안 집었다"
            assert future.status == "pending", "미도래(미래) scheduled_at 행을 cron이 잘못 집었다"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_cron_retryable_failure_backs_off_with_attempt_count():
    from unittest.mock import AsyncMock, patch
    import app.services.threads_publish as tp
    from app.services.publication_command import process_due_publication_commands

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)

        from app.main import app
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
            cmd_id = cmd.id

        from app.services.threads_publish import ThreadsPublishError
        with (
            patch.object(tp, "get_publishing_limit", AsyncMock(return_value=(1, 250, 86400))),
            patch.object(tp, "create_container", AsyncMock(side_effect=ThreadsPublishError(
                status_code=500, code="SERVER_ERROR", message="boom",
            ))),
        ):
            async with Session() as s:
                await process_due_publication_commands(s, now=now)

        async with Session() as s:
            from app.models.publication_command import PublicationCommand
            from sqlalchemy import select
            cmd = (await s.execute(select(PublicationCommand).where(PublicationCommand.id == cmd_id))).scalar_one()
            assert cmd.status == "pending"
            assert cmd.attempt_count == 1
            assert cmd.failure_kind == "transient"
            assert cmd.next_attempt_at is not None
            assert cmd.next_attempt_at > now
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_cron_rate_limited_uses_retry_after_value_not_default_backoff():
    """카디르 QA④ — 기본 백오프와 다른 값(Retry-After: 120)을 mock에 실어, next_attempt_at
    이 그 값(now+120s, 허용오차 수 초)인지 계산한다. "미래인지"만 보면 헤더 무시해도
    통과하므로 정확한 값을 assert한다."""
    from unittest.mock import AsyncMock, patch
    import app.services.threads_publish as tp
    from app.services.publication_command import process_due_publication_commands

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)

        from app.main import app
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
            cmd_id = cmd.id

        # get_publishing_limit이 quota_usage>=quota_total로 보이게 해 ChannelRateLimitedError
        # 를 유도(reset_at 확정값으로 — quota_duration=300초). 페드루 리뷰 블로커D —
        # 원래 120초는 attempt_count=1의 기본 백오프(60*2^1=120)와 **같은 값**이라
        # 헤더를 무시해도 이 테스트가 통과했다(우연히 안 틀릴 수 없는 값). 기본
        # 백오프 어느 attempt_count와도 안 겹치는 300초로 바꿔 헤더가 실제로 읽혔을
        # 때만 통과하게 한다.
        with patch.object(tp, "get_publishing_limit", AsyncMock(return_value=(250, 250, 300))):
            async with Session() as s:
                await process_due_publication_commands(s, now=now)

        async with Session() as s:
            from app.models.publication_command import PublicationCommand
            from sqlalchemy import select
            cmd = (await s.execute(select(PublicationCommand).where(PublicationCommand.id == cmd_id))).scalar_one()
            assert cmd.failure_kind == "transient"
            expected = now + timedelta(seconds=300)
            delta = abs((cmd.next_attempt_at - expected).total_seconds())
            assert delta < 5, f"next_attempt_at이 Retry-After(300s) 값을 안 썼다: {cmd.next_attempt_at} vs {expected}"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_cron_max_retries_reaches_dead_letter():
    from unittest.mock import AsyncMock, patch
    import app.services.threads_publish as tp
    from app.services.publication_command import MAX_RETRIES, process_due_publication_commands

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)

        from app.main import app
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
            cmd_id = cmd.id

        from app.services.threads_publish import ThreadsPublishError
        with (
            patch.object(tp, "get_publishing_limit", AsyncMock(return_value=(1, 250, 86400))),
            patch.object(tp, "create_container", AsyncMock(side_effect=ThreadsPublishError(
                status_code=500, code="SERVER_ERROR", message="boom",
            ))),
        ):
            async with Session() as s:
                await process_due_publication_commands(s, now=now)

        async with Session() as s:
            from app.models.publication_command import PublicationCommand
            from sqlalchemy import select
            cmd = (await s.execute(select(PublicationCommand).where(PublicationCommand.id == cmd_id))).scalar_one()
            assert cmd.status == "dead_letter"
            assert cmd.dead_letter_at is not None
            assert cmd.next_attempt_at is None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_cron_token_expired_blocks_command_and_escalates_connection_status():
    from unittest.mock import AsyncMock, patch
    import app.services.threads_publish as tp
    from app.services.publication_command import process_due_publication_commands

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)

        from app.main import app
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
            cmd_id = cmd.id

        from app.services.threads_publish import ThreadsPublishError
        with (
            patch.object(tp, "get_publishing_limit", AsyncMock(return_value=(1, 250, 86400))),
            patch.object(tp, "create_container", AsyncMock(side_effect=ThreadsPublishError(
                status_code=401, code="TOKEN_EXPIRED", message="expired token",
            ))),
        ):
            async with Session() as s:
                await process_due_publication_commands(s, now=now)

        async with Session() as s:
            from app.models.publication_command import PublicationCommand
            from app.models.channel_connection import ChannelConnection
            from sqlalchemy import select
            cmd = (await s.execute(select(PublicationCommand).where(PublicationCommand.id == cmd_id))).scalar_one()
            assert cmd.status == "blocked"
            assert cmd.failure_kind == "connection"
            conn = (await s.execute(select(ChannelConnection).where(ChannelConnection.id == connection_id))).scalar_one()
            assert conn.status == "expired"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_dead_letter_retry_endpoint_then_next_cron_tick_reprocesses():
    """카디르 QA⑤ — retry 뒤 status만 확인하고 끝내지 않는다. 그 다음 cron tick을
    실제로 한 번 더 돌려서 진짜 재처리되는지까지 본다(next_attempt_at이 안 풀리는
    결함을 잡는다)."""
    from unittest.mock import AsyncMock, patch
    import app.services.threads_publish as tp
    from app.services.publication_command import process_due_publication_commands

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            human_id = await _seed_human(s, org_id, role="owner")
            connection_id = await _seed_connection(s, org_id)

        from app.main import app
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
                scheduled_at=now - timedelta(hours=1), status="dead_letter",
                dead_letter_at=now - timedelta(minutes=10), next_attempt_at=now + timedelta(hours=999),
                attempt_count=5, requested_by_member_id=agent_id,
            )
            s.add(cmd)
            await s.commit()
            cmd_id = cmd.id

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r_retry = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/publication-commands/{cmd_id}/retry",
            )
            assert r_retry.status_code == 200, r_retry.text
            body = r_retry.json().get("data") or r_retry.json()
            assert body["status"] == "pending"

        with (
            patch.object(tp, "create_container", AsyncMock(return_value="creation-y")),
            patch.object(tp, "publish_container", AsyncMock(return_value="media-y")),
            patch.object(tp, "get_publishing_limit", AsyncMock(return_value=(1, 250, 86400))),
            patch.object(tp, "get_permalink", AsyncMock(return_value="https://www.threads.net/@demo/post/media-y")),
        ):
            async with Session() as s:
                await process_due_publication_commands(s, now=datetime.now(timezone.utc))

        async with Session() as s:
            from app.models.publication_command import PublicationCommand
            from sqlalchemy import select
            cmd = (await s.execute(select(PublicationCommand).where(PublicationCommand.id == cmd_id))).scalar_one()
            assert cmd.status == "completed", "retry 뒤 status만 pending이 됐을 뿐 다음 cron tick에서 실제로 재처리되지 않았다"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_retry_non_dead_letter_command_returns_404():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            human_id = await _seed_human(s, org_id, role="owner")

        async with Session() as s:
            from app.models.publication_command import PublicationCommand
            cmd = PublicationCommand(
                id=uuid.uuid4(), org_id=org_id, gate_id=uuid.uuid4(), destination=uuid.uuid4(),
                approved_version=uuid.uuid4(), operation="publish", status="completed",
                requested_by_member_id=uuid.uuid4(),
            )
            s.add(cmd)
            await s.commit()
            cmd_id = cmd.id

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/publication-commands/{cmd_id}/retry")
        assert r.status_code == 404, r.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_cron_batch_claim_holds_lock_until_whole_batch_marked_in_progress_no_double_processing():
    """페드루 리뷰 블로커A — 겹친 두 tick이 같은 배치의 뒷 순번 행을 이중 처리하지
    않는지, 실제 두 세션의 동시 호출로 검증한다(순차 호출로는 이 결함이 재현되지
    않는다 — 첫 tick이 완전히 끝난 뒤 둘째 tick이 시작되면 첫 tick이 이미 다 처리해
    버려 겹칠 여지가 없다).

    시나리오: 배치에 cmd_1(먼저 처리됨)·cmd_2(나중 처리됨) 두 건. tick_a가 cmd_1을
    처리·commit한 직후 — 배치 클레임이 통짜 commit으로 이미 끝났다면 이 시점에 cmd_2는
    이미 DB에 in_progress로 박혀 있다 — 바로 그 순간 tick_b를 동시에 돌린다. 클레임이
    건별 commit이던 원래 구조라면 cmd_1의 per-item commit이 트랜잭션을 끝내며 cmd_2의
    락도 함께 풀려버려(cmd_2는 아직 손 안 댄 채 'pending'), tick_b가 cmd_2를 마저 집어
    이중 처리한다."""
    from unittest.mock import AsyncMock, patch
    import asyncio
    import app.services.threads_publish as tp
    import app.services.publication_command as pc_module

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)

        from app.main import app
        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client, Session() as s:
            story_1 = await _seed_story(s, org_id, project_id, title="배치1")
            story_2 = await _seed_story(s, org_id, project_id, title="배치2")
            draft_1, gate_1 = await _create_draft_submit_approve(
                client, s, org_id=org_id, connection_id=connection_id, story_id=story_1,
                text="배치1 본문", scheduled_at=datetime.now(timezone.utc) + timedelta(minutes=1),
            )
            draft_2, gate_2 = await _create_draft_submit_approve(
                client, s, org_id=org_id, connection_id=connection_id, story_id=story_2,
                text="배치2 본문", scheduled_at=datetime.now(timezone.utc) + timedelta(minutes=1),
            )

        now = datetime.now(timezone.utc)
        async with Session() as s:
            from app.models.publication_command import PublicationCommand
            from app.models.channel_post_version import ChannelPostVersion
            from sqlalchemy import select

            async def _version_id_for(draft_id):
                return (await s.execute(
                    select(ChannelPostVersion.id).where(ChannelPostVersion.draft_id == uuid.UUID(draft_id))
                )).scalar_one()

            # created_at을 명시적으로 벌려 order_by(created_at.asc())가 cmd_1을 먼저
            # 집도록 고정한다(사람 눈에도 결정적인 순서로 재현 가능하게).
            cmd_1 = PublicationCommand(
                id=uuid.uuid4(), org_id=org_id, gate_id=gate_1, destination=connection_id,
                approved_version=await _version_id_for(draft_1), operation="publish",
                scheduled_at=now - timedelta(minutes=1), status="pending", requested_by_member_id=agent_id,
                created_at=now - timedelta(seconds=2),
            )
            cmd_2 = PublicationCommand(
                id=uuid.uuid4(), org_id=org_id, gate_id=gate_2, destination=connection_id,
                approved_version=await _version_id_for(draft_2), operation="publish",
                scheduled_at=now - timedelta(minutes=1), status="pending", requested_by_member_id=agent_id,
                created_at=now - timedelta(seconds=1),
            )
            s.add_all([cmd_1, cmd_2])
            await s.commit()
            cmd_1_id, cmd_2_id = cmd_1.id, cmd_2.id

        cmd2_about_to_process = asyncio.Event()
        release_tick_b_result = asyncio.Event()
        process_calls: list[uuid.UUID] = []
        real_process_one = pc_module._process_one_command
        paused_once = False

        async def _tracking_process_one(db, command, *, now):
            nonlocal paused_once
            if command.id == cmd_2_id and not paused_once:
                paused_once = True
                cmd2_about_to_process.set()
                await asyncio.wait_for(release_tick_b_result.wait(), timeout=10)
            process_calls.append(command.id)
            await real_process_one(db, command, now=now)

        async def _tick_a():
            async with Session() as s:
                return await pc_module.process_due_publication_commands(s, now=now)

        async def _tick_b():
            await asyncio.wait_for(cmd2_about_to_process.wait(), timeout=10)
            async with Session() as s:
                result = await pc_module.process_due_publication_commands(s, now=now)
            release_tick_b_result.set()
            return result

        with (
            patch.object(tp, "create_container", AsyncMock(return_value="creation-batch")),
            patch.object(tp, "publish_container", AsyncMock(return_value="media-batch")),
            patch.object(tp, "get_publishing_limit", AsyncMock(return_value=(1, 250, 86400))),
            patch.object(tp, "get_permalink", AsyncMock(return_value="https://www.threads.net/@demo/post/media-batch")),
            patch.object(pc_module, "_process_one_command", _tracking_process_one),
        ):
            await asyncio.wait_for(asyncio.gather(_tick_a(), _tick_b()), timeout=20)

        assert process_calls.count(cmd_2_id) == 1, (
            f"cmd_2가 겹친 tick에 이중 처리됐다(배치 클레임 commit이 건별로 쪼개져 있었다는 뜻): {process_calls}"
        )
        async with Session() as s:
            from app.models.publication_command import PublicationCommand
            from sqlalchemy import select
            cmd_1_row = (await s.execute(select(PublicationCommand).where(PublicationCommand.id == cmd_1_id))).scalar_one()
            cmd_2_row = (await s.execute(select(PublicationCommand).where(PublicationCommand.id == cmd_2_id))).scalar_one()
            assert cmd_1_row.status == "completed"
            assert cmd_2_row.status == "completed"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_cron_deterministic_failure_goes_straight_to_dead_letter_no_auto_retry():
    """페드루 리뷰 블로커C — 결정적 실패(매핑표 밖 error_code라 fail-closed로
    needs_check로 떨어진 것들 포함)는 transient처럼 지수 백오프 재시도 큐에 들어가지
    않고 즉시 dead_letter로 멈춘다(자동 재시도 0회 — attempt_count는 1에서 멈춘다).
    양성대조: 두 번째 cron tick을 더 돌려도 재시도 시도조차 없어야 한다(next_attempt_at
    이 애초에 None이라 WHERE절에서 안 잡히는지).

    story #3474(2026-09-05) 갱신 — 이 테스트가 재현하는 정확히 그 시나리오(게이트가
    승인을 잃은 뒤 워커가 뒤늦게 발견)가 이제는 매핑표를 거쳐 dead_letter로 가는 게
    아니라 blocked_unapproved로 즉시 종결한다(재시도 개념 자체가 안 맞는 종류 —
    apply_command_failure/dead_letter 경로 자체를 안 탄다, attempt_count 무변).
    publication_attempts 원장에 approval_check='missing'·adapter_called=False 행이
    남는지도 이 테스트에서 같이 확認한다(디디 그라운딩 대상 시나리오 그대로)."""
    from app.services.publication_command import process_due_publication_commands

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)

        from app.main import app
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
            from app.models.gate import Gate
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
            # 결정적 실패 유도 — 게이트가 승인 상태를 잃었다(void_pending_commands_for_gate
            # 훅이 보통 이 경합을 선점하지만, 놓친 경우를 워커가 마지막으로 만나는
            # 시나리오를 직접 DB 조작으로 재현한다). publish_channel_post_draft가 자체
            # 재검증에서 ExternalPublishGateNotApprovedError를 던진다 — 그 error_code
            # (EXTERNAL_PUBLISH_APPROVAL_REQUIRED)는 매핑표 밖이라 needs_check.
            gate = (await s.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()
            gate.status = "pending"
            await s.commit()
            cmd_id = cmd.id

        async with Session() as s:
            await process_due_publication_commands(s, now=now)

        async with Session() as s:
            from app.models.publication_command import PublicationCommand
            from sqlalchemy import select
            cmd_row = (await s.execute(select(PublicationCommand).where(PublicationCommand.id == cmd_id))).scalar_one()
            # story #3474 — 게이트 재검증 실패는 이제 blocked_unapproved로 즉시
            # 종결한다(apply_command_failure/dead_letter 경로 미진입 — attempt_count
            # 무변).
            assert cmd_row.status == "blocked_unapproved"
            assert cmd_row.attempt_count == 0
            assert cmd_row.dead_letter_at is None
            assert cmd_row.next_attempt_at is None

        # story #3474 — publication_attempts 원장: 승인 없는 adapter 호출 0건을
        # 증명하는 그 행(missing·adapter_called=False)이 실제로 남는지.
        async with Session() as s:
            from app.models.publication_attempt import PublicationAttempt
            from sqlalchemy import select
            attempt = (await s.execute(
                select(PublicationAttempt).where(PublicationAttempt.command_id == cmd_id)
            )).scalar_one()
            assert attempt.approval_check == "missing"
            assert attempt.adapter_called is False

        # 양성대조 — 두 번째 tick을 더 돌려도(자동으로는) 아무 것도 안 바뀐다.
        async with Session() as s:
            await process_due_publication_commands(s, now=now + timedelta(hours=1))
        async with Session() as s:
            from app.models.publication_command import PublicationCommand
            from sqlalchemy import select
            cmd_row = (await s.execute(select(PublicationCommand).where(PublicationCommand.id == cmd_id))).scalar_one()
            assert cmd_row.status == "blocked_unapproved", "결정적 실패가 두 번째 tick에서 조용히 재시도됐다"
            assert cmd_row.attempt_count == 0
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_retry_endpoint_accepts_blocked_command_then_next_cron_tick_reprocesses():
    """페드루 리뷰 블로커B — dead_letter만 받던 수동 재시도가 blocked(연결 복구 대기)도
    받는지, 카디르 QA⑤와 동형으로 status만 바뀌는 게 아니라 다음 cron tick이 실제로
    재처리하는지까지 본다(토큰 재인증 등으로 연결이 복구됐다고 가정한 시나리오)."""
    from unittest.mock import AsyncMock, patch
    import app.services.threads_publish as tp
    from app.services.publication_command import process_due_publication_commands

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            human_id = await _seed_human(s, org_id, role="owner")
            connection_id = await _seed_connection(s, org_id)

        from app.main import app
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
                scheduled_at=now - timedelta(hours=1), status="blocked", failure_kind="connection",
                last_error="token expired(seed)", attempt_count=1, requested_by_member_id=agent_id,
            )
            s.add(cmd)
            await s.commit()
            cmd_id = cmd.id

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id)
        async with _client_for(app) as client:
            r_retry = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/publication-commands/{cmd_id}/retry",
            )
            assert r_retry.status_code == 200, r_retry.text
            body = r_retry.json().get("data") or r_retry.json()
            assert body["status"] == "pending"

        with (
            patch.object(tp, "create_container", AsyncMock(return_value="creation-z")),
            patch.object(tp, "publish_container", AsyncMock(return_value="media-z")),
            patch.object(tp, "get_publishing_limit", AsyncMock(return_value=(1, 250, 86400))),
            patch.object(tp, "get_permalink", AsyncMock(return_value="https://www.threads.net/@demo/post/media-z")),
        ):
            async with Session() as s:
                await process_due_publication_commands(s, now=datetime.now(timezone.utc))

        async with Session() as s:
            from app.models.publication_command import PublicationCommand
            from sqlalchemy import select
            cmd_row = (await s.execute(select(PublicationCommand).where(PublicationCommand.id == cmd_id))).scalar_one()
            assert cmd_row.status == "completed", "retry 뒤 status만 pending이 됐을 뿐 다음 cron tick에서 실제로 재처리되지 않았다"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_publish_immediate_rate_limited_returns_retry_after_header_and_command_state():
    """페드루 리뷰 블로커E·F — 즉시 발행이 429(quota)로 실패하면 응답에 Retry-After
    헤더(실값)가 실리고, body(error 객체)에도 command_status·next_attempt_at이 함께
    나가 사람이 "언제 자동 재시도되는지" 알 수 있는지."""
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

        from app.main import app as _app
        _setup_org_scoped_app(_app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(_app) as client, Session() as s:
            draft_id, gate_id = await _create_draft_submit_approve(
                client, s, org_id=org_id, connection_id=connection_id, story_id=story_id,
            )

        with patch.object(tp, "get_publishing_limit", AsyncMock(return_value=(250, 250, 300))):
            _setup_org_scoped_app(_app, Session, org_id, user_id=human_id)
            async with _client_for(_app) as client:
                r_pub = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish")

        assert r_pub.status_code == 429, r_pub.text
        assert r_pub.headers.get("retry-after") == "300", dict(r_pub.headers)
        body = r_pub.json()
        error = body.get("error") or body
        assert error["command_status"] == "pending"
        assert error["next_attempt_at"] is not None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_retry_command_endpoint_agent_caller_forbidden():
    """페드루 리뷰 nit L — 발행 엔드포인트처럼 retry도 human-only(_require_human)인지
    에이전트 키 호출로 확인(기존엔 발행 human-only 테스트만 있고 retry는 없었다)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            agent_id = await _seed_agent(s, org_id, project_id)

        async with Session() as s:
            from app.models.publication_command import PublicationCommand
            cmd = PublicationCommand(
                id=uuid.uuid4(), org_id=org_id, gate_id=uuid.uuid4(), destination=uuid.uuid4(),
                approved_version=uuid.uuid4(), operation="publish", status="dead_letter",
                requested_by_member_id=uuid.uuid4(),
            )
            s.add(cmd)
            await s.commit()
            cmd_id = cmd.id

        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/publication-commands/{cmd_id}/retry")
        assert r.status_code == 403, r.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_cron_endpoint_requires_cron_secret(monkeypatch):
    """기존 cron.py 다른 엔드포인트와 동일 가드(CRON_SECRET Bearer) 재사용 확認 — DB
    세션(`get_worker_db`)까지 스캐폴딩(override_db_and_read가 안 거는 별도 dependency
    key)해서 진짜로 verify_cron()이 거부하는지 본다(연결 실패로 500이 나면 이 테스트가
    실제로 뭘 검증했는지 알 수 없다)."""
    import app.routers.cron as cron_module
    from app.dependencies.database import get_worker_db
    from app.main import app
    from httpx import AsyncClient, ASGITransport

    monkeypatch.setattr(cron_module, "CRON_SECRET", "test-cron-secret")

    engine, Session = await _session_factory()
    try:
        async def _worker_db():
            async with Session() as s:
                yield s

        app.dependency_overrides[get_worker_db] = _worker_db
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            r_no_auth = await client.post("/api/v2/internal/cron/publication-commands")
            assert r_no_auth.status_code == 401, r_no_auth.text
            r_wrong_auth = await client.post(
                "/api/v2/internal/cron/publication-commands",
                headers={"Authorization": "Bearer wrong-secret"},
            )
            assert r_wrong_auth.status_code == 401, r_wrong_auth.text
            r_right_auth = await client.post(
                "/api/v2/internal/cron/publication-commands",
                headers={"Authorization": "Bearer test-cron-secret"},
            )
            assert r_right_auth.status_code == 200, r_right_auth.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
