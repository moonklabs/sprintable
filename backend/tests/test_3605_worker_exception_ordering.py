"""story #3605(BE·소형·신뢰, PO 確定 2026-09-07) — 3598 AC6 일반화 도중 실측으로
드러난 결함: `publication_command.py::_process_one_command`(발행 cron 워커)의
`except ChannelTokenExpiredError as exc: error_code = "CHANNEL_TOKEN_EXPIRED"`가
그 서브클래스(`ChannelConnectionRevokedError`·`ChannelConnectionAuthError`, 둘 다
#3598/#3605이 ChannelTokenExpiredError를 상속해 기존 except 절이 그대로 잡게
설계)도 먼저 잡아 error_code 문자열을 무조건 "CHANNEL_TOKEN_EXPIRED"로 하드코딩
— channel_posts.py::publish_channel_post_draft가 inline으로 이미 정확히 승격해
둔 connection.status(revoked/error)를, 이 워커가 `apply_command_failure`를
잘못된 error_code로 다시 호출해 "expired"로 덮어써 버렸다. 서브클래스 except
절을 부모보다 먼저 두는 순서로 고쳤다(3605) — 이 파일은 그 수정이 실제로 최종
connection.status를 지키는지 실DB로 고정한다.

세팅 헬퍼는 test_3414_publication_command_core.py 재사용(중복 재발명 0)."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from tests.test_3414_publication_command_core import (
    _client_for,
    _create_draft_submit_approve,
    _seed_agent,
    _seed_connection,
    _seed_default_role,
    _seed_org,
    _seed_story,
    _session_factory,
    _setup_org_scoped_app,
)

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


async def _seed_command_targeting_new_draft(
    *, org_id, project_id, agent_id, connection_id, session_factory_result,
) -> tuple[uuid.UUID, uuid.UUID]:
    """draft 생성→제출→승인 뒤, 그 승인된 버전을 향하는 pending PublicationCommand
    1건을 직접 만든다(test_3414_publication_command_cron_retry.py::
    test_cron_token_expired_blocks_command_and_escalates_connection_status와
    동형 — cron 워커가 그 command를 집도록)."""
    from app.models.publication_command import PublicationCommand
    from app.models.channel_post_version import ChannelPostVersion
    from sqlalchemy import select

    _, Session = session_factory_result
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
    return cmd_id, gate_id


@pytest.mark.anyio
async def test_cron_worker_revoked_connection_stays_revoked_not_downgraded_to_expired():
    """⭐뮤테이션 대상 — except 절 순서를 원복(ChannelConnectionRevokedError를
    ChannelTokenExpiredError보다 아래로)하면 이 assert가 "expired"로 깨져야 한다."""
    from unittest.mock import AsyncMock, patch
    import app.services.threads_publish as tp
    from app.main import app
    from app.services.publication_command import process_due_publication_commands

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)

        cmd_id, _ = await _seed_command_targeting_new_draft(
            org_id=org_id, project_id=project_id, agent_id=agent_id, connection_id=connection_id,
            session_factory_result=(engine, Session),
        )

        from app.services.threads_publish import ThreadsPublishError
        now = datetime.now(timezone.utc)
        with (
            patch.object(tp, "get_publishing_limit", AsyncMock(return_value=(1, 250, 86400))),
            patch.object(tp, "create_container", AsyncMock(side_effect=ThreadsPublishError(
                status_code=401, code="REVOKED", message="session revoked",
                provider_error_code=190, provider_error_subcode=490, provider_error_type="OAuthException",
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
            assert conn.status == "revoked"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_cron_worker_permission_error_family_promotes_connection_to_error_status():
    """AC1 — code==10(190 밖 family)도 발행 워커 경로에서 실제로 CONNECTION kind로
    승격되는지 종단 확認(단위테스트는 classify_graph_error_code만 검증, 이건 그
    결과가 실제 connection.status에 도달하는지까지)."""
    from unittest.mock import AsyncMock, patch
    import app.services.threads_publish as tp
    from app.main import app
    from app.services.publication_command import process_due_publication_commands

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            connection_id = await _seed_connection(s, org_id)

        cmd_id, _ = await _seed_command_targeting_new_draft(
            org_id=org_id, project_id=project_id, agent_id=agent_id, connection_id=connection_id,
            session_factory_result=(engine, Session),
        )

        from app.services.threads_publish import ThreadsPublishError
        now = datetime.now(timezone.utc)
        with (
            patch.object(tp, "get_publishing_limit", AsyncMock(return_value=(1, 250, 86400))),
            patch.object(tp, "create_container", AsyncMock(side_effect=ThreadsPublishError(
                status_code=401, code="PERMISSION_ERROR", message="app lacks permission",
                provider_error_code=10, provider_error_subcode=None, provider_error_type=None,
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
            assert conn.status == "error"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
