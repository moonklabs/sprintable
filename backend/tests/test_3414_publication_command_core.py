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
⑥ 즉시발행 순서 — 재검증 실패 시 command 행 자체가 안 생기는지.

story #3562(2026-09-06, 페드루 PO 確定) 후속 — 원본 `test_3414_publication_command.py`
(22 테스트·1574줄)가 CI 60초 러너 정규화 가드 상한에 걸터앉아(PR #3911 rerun 2회
연속 shard(4) 75s>70s·132s>130.6s) 주제별 3-way 분할했다: 이 파일(core)=봉인+명령
생성(AC1/AC2)+재승인 판정(PO 確定 B), `test_3414_publication_command_cron_retry.py`
=cron 워커(AC3)+dead_letter/blocked 수동재시도, `test_3414_publication_command_
edges.py`=429 응답 모양·인가·인사이트 예외 격리. 세팅 헬퍼·픽스처는 전부 이 파일이
소유(원본에 이미 있던 것 그대로, 신규 헬퍼 0) — 나머지 두 파일이 여기서 import한다."""
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


