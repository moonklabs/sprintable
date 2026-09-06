"""story #3414(Phase1·마케팅운영, 페드루 PO 確定 2026-09-04) — 발행 명령 cron 워커+
수동 재시도(dead_letter·blocked). story #3562(2026-09-06, 페드루 PO 確定) 후속으로
`test_3414_publication_command.py`(22 테스트·1574줄)에서 분리 — 원본 파일이 CI 60초
러너 정규화 가드 상한(⑤·⑥ 반복 재발, PR #3911 rerun 2회 연속 shard(4) 75s>70s·
132s>130.6s)에 걸터앉아 주제별 3-way 분할(core·cron_retry·edges). 세팅 헬퍼·픽스처는
`test_3414_publication_command_core.py`에서 그대로 재사용(중복 재발명 0) — autouse
픽스처(`_dispose_global_engine_after_test`·`_configure_secrets`)만 pytest 관례상
파일마다 재선언(import로는 전파 안 됨).

이 파일 담당 — cron 워커(AC3)+dead_letter/blocked 수동 재시도: 카디르 QA② 비-sleep
시각경계·백오프·Retry-After·MAX_RETRIES·토큰만료 에스컬레이션·동시 배치클레임·
결정적실패 즉시dead_letter·blocked 수동재시도."""
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
    _seed_human,
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


