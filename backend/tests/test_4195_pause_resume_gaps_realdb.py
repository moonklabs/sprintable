"""story #4195 — 외부 발행 일시 중지 해제가 일부 명령을 못 되살리던 두 빈틈(까디르 3953 AC5 verdict).

- ②: 워커 진입 검사(publication_command._process_one_command)를 통과한 직후 pause가 켜져 발행 함수 안 두 번째
  검사(channel_posts.publish_channel_post_draft)에 걸리면, 예전엔 미분류 실패(백오프·attempt 증가 → dead_letter)로
  빠져 resume 대상 밖이었다. 이제 진입 검사와 같은 `blocked`·`failure_kind=paused`·attempt 불변.
- ①: 워커가 pause를 읽고 blocked를 커밋하기 전(in_progress)에 resume 스캔이 돌면 그 명령을 못 봐 해제 뒤에도
  blocked/paused로 영구 정체였다. 이제 크론 tick이 «pause가 풀린 조직의 blocked/paused»를 자가복구한다.

하네스는 test_3953_external_publish_pause.py 그대로(test_3414 헬퍼)."""
from __future__ import annotations

import os
import uuid
from unittest.mock import AsyncMock, patch

import pytest
from sqlalchemy import select

from tests.test_3414_publication_command_core import (
    _client_for,
    _create_draft_submit_approve,
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
    pytest.mark.anyio,
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
    from cryptography.fernet import Fernet

    import app.core.config as config_module
    from app.services.channel_credential_crypto import _get_multi_fernet

    monkeypatch.setattr(config_module.settings, "channel_credential_encryption_key", Fernet.generate_key().decode())
    _get_multi_fernet.cache_clear()
    yield
    _get_multi_fernet.cache_clear()


async def _setup_command(Session):
    """승인된 channel post 초안 + 즉시 발행 publication_command 1건(pending)."""
    from app.main import app
    from app.models.channel_post_version import ChannelPostVersion
    from app.services.publication_command import create_or_get_publication_command

    async with Session() as s:
        org_id, project_id = await _seed_org(s)
        await _seed_default_role(s, org_id)
        owner_id = await _seed_human(s, org_id, role="owner")
        story_id = await _seed_story(s, org_id, project_id)
        connection_id = await _seed_connection(s, org_id)
    _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
    try:
        async with _client_for(app) as client, Session() as s:
            draft_id, gate_id = await _create_draft_submit_approve(
                client, s, org_id=org_id, connection_id=connection_id, story_id=story_id,
            )
    finally:
        app.dependency_overrides.clear()
    async with Session() as s:
        version_id = (await s.execute(
            select(ChannelPostVersion.id).where(ChannelPostVersion.draft_id == uuid.UUID(draft_id))
            .order_by(ChannelPostVersion.created_at.desc()).limit(1)
        )).scalar_one()
        command, _ = await create_or_get_publication_command(
            s, org_id=org_id, gate_id=gate_id, destination=connection_id,
            approved_version=version_id, requested_by_member_id=owner_id, scheduled_at=None,
        )
        await s.commit()
        return org_id, owner_id, command.id


async def _command(Session, command_id):
    from app.models.publication_command import PublicationCommand

    async with Session() as s:
        return (await s.execute(select(PublicationCommand).where(PublicationCommand.id == command_id))).scalar_one()


def _threads_ok():
    import app.services.threads_publish as tp

    return (
        patch.object(tp, "create_container", AsyncMock(return_value="cid")),
        patch.object(tp, "publish_container", AsyncMock(return_value="media")),
        patch.object(tp, "get_permalink", AsyncMock(return_value="https://x/permalink")),
        patch.object(tp, "get_publishing_limit", AsyncMock(return_value=(1, 250, 86400))),
    )


async def test_pause_caught_by_second_check_blocks_as_paused_without_attempt_and_resumes_once():
    """⭐② — 진입 검사 통과(False) 뒤 발행 함수 안 검사에서 pause(True) → blocked·paused·attempt 불변 →
    (pause는 DB상 꺼진 상태) 다음 tick에 1회 발행."""
    import app.services.external_publish_pause as pause_module
    import app.services.threads_publish as tp
    from app.services.publication_command import process_due_publication_commands

    engine, Session = await _session_factory()
    try:
        _org_id, _owner_id, command_id = await _setup_command(Session)
        before = await _command(Session, command_id)

        flip = AsyncMock(side_effect=[(False, None), (True, "t")])
        with patch.object(pause_module, "is_external_publish_paused", flip), \
             patch.object(tp, "create_container", AsyncMock()) as mock_create:
            async with Session() as s:
                counts = await process_due_publication_commands(s)
        mock_create.assert_not_called()
        assert flip.await_count == 2  # 진입 검사 + 발행 함수 안 검사
        assert counts["blocked"] == 1, counts

        blocked = await _command(Session, command_id)
        assert blocked.status == "blocked"
        assert blocked.failure_kind == "paused"
        assert blocked.attempt_count == before.attempt_count  # 실패가 아니라 대기 — 백오프·dead_letter 경로 밖
        assert blocked.next_attempt_at is None

        # resume(여기선 pause가 DB상 꺼져 있음) → 크론 자가복구 스윕이 되살려 같은 tick에 1회 발행.
        p1, p2, p3, p4 = _threads_ok()
        with p1 as create, p2, p3, p4:
            async with Session() as s:
                counts = await process_due_publication_commands(s)
        assert counts["completed"] == 1, counts
        create.assert_awaited_once()
    finally:
        await engine.dispose()


async def test_command_blocked_after_resume_scan_is_self_healed_by_next_cron_tick():
    """⭐① — resume 스캔이 in_progress 명령을 못 본 경합을 순서대로 재현: pause ON → 워커가 클레임(in_progress)
    → resume(스캔 시점엔 대상 아님) → 워커가 blocked/paused 커밋. 예전엔 여기서 영구 정체. 다음 tick에
    자가복구로 pending → 1회 발행 · 명령 1행(중복 0)."""
    from app.models.publication_command import PublicationCommand
    from app.services.external_publish_pause import set_external_publish_pause
    from app.services.publication_command import process_due_publication_commands

    engine, Session = await _session_factory()
    try:
        org_id, owner_id, command_id = await _setup_command(Session)
        async with Session() as s:
            await set_external_publish_pause(s, org_id=org_id, paused=True, reason="t", actor_member_id=owner_id)
            cmd = (await s.execute(select(PublicationCommand).where(PublicationCommand.id == command_id))).scalar_one()
            cmd.status = "in_progress"  # 워커가 클레임하고 pause를 읽은 순간
            await s.commit()
        async with Session() as s:
            # resume — 이 순간 명령은 in_progress라 _requeue_paused_commands의 대상 밖.
            await set_external_publish_pause(s, org_id=org_id, paused=False, reason=None, actor_member_id=owner_id)
            await s.commit()
        async with Session() as s:
            cmd = (await s.execute(select(PublicationCommand).where(PublicationCommand.id == command_id))).scalar_one()
            cmd.status = "blocked"  # 워커가 (resume 뒤에) blocked/paused 커밋
            cmd.failure_kind = "paused"
            await s.commit()
        assert (await _command(Session, command_id)).status == "blocked"

        p1, p2, p3, p4 = _threads_ok()
        with p1 as create, p2, p3, p4:
            async with Session() as s:
                counts = await process_due_publication_commands(s)
        assert counts["completed"] == 1, counts
        create.assert_awaited_once()
        async with Session() as s:
            rows = (await s.execute(select(PublicationCommand).where(PublicationCommand.org_id == org_id))).scalars().all()
        assert len(rows) == 1 and rows[0].status == "completed"
    finally:
        await engine.dispose()


async def test_self_heal_leaves_still_paused_orgs_alone():
    """자가복구는 pause가 풀린 조직만 — 아직 멈춘 조직의 blocked/paused는 그대로(발행 0)."""
    import app.services.threads_publish as tp
    from app.services.external_publish_pause import set_external_publish_pause
    from app.services.publication_command import process_due_publication_commands

    engine, Session = await _session_factory()
    try:
        org_id, owner_id, command_id = await _setup_command(Session)
        async with Session() as s:
            await set_external_publish_pause(s, org_id=org_id, paused=True, reason="t", actor_member_id=owner_id)
            await s.commit()
        with patch.object(tp, "create_container", AsyncMock()) as mock_create:
            for _ in range(2):
                async with Session() as s:
                    await process_due_publication_commands(s)
        mock_create.assert_not_called()
        blocked = await _command(Session, command_id)
        assert blocked.status == "blocked" and blocked.failure_kind == "paused"
    finally:
        await engine.dispose()


async def test_site_post_branch_maps_pause_raised_inside_publish_to_blocked_paused():
    """PO 리뷰 — 사이트(블로그) 명령 분기도 같은 규칙: 진입 검사를 통과한 뒤 발행 함수 안에서 pause가 나면
    blocked·paused·attempt 불변(미분류 실패로 새지 않게). 지금 분기가 부르는 publish_site_post_external_command엔
    pause 검사가 없어 그 함수가 pause를 던지게 바꿔 끼워 경로를 강제한다."""
    from datetime import datetime, timezone

    from app.services.external_publish_pause import ExternalPublishPausedError
    from app.services.publication_command import _process_one_command, create_or_get_publication_command

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _project_id = await _seed_org(s)
            owner_id = await _seed_human(s, org_id, role="owner")
            cmd, _ = await create_or_get_publication_command(
                s, org_id=org_id, gate_id=uuid.uuid4(), destination=uuid.uuid4(), approved_version=uuid.uuid4(),
                requested_by_member_id=owner_id, scheduled_at=None, content_kind="site_post",
            )
            cmd.status = "in_progress"
            await s.commit()
            attempts_before = cmd.attempt_count

            with patch(
                "app.services.site_posts.publish_site_post_external_command",
                AsyncMock(side_effect=ExternalPublishPausedError(reason="t")),
            ):
                await _process_one_command(s, cmd, now=datetime.now(timezone.utc))
                await s.commit()
            await s.refresh(cmd)
        assert cmd.status == "blocked"
        assert cmd.failure_kind == "paused"
        assert cmd.attempt_count == attempts_before
        assert cmd.next_attempt_at is None
    finally:
        await engine.dispose()


@pytest.mark.parametrize(("status", "failure_kind"), [("blocked", "connection"), ("dead_letter", "needs_check")])
async def test_self_heal_rechecks_after_lock_and_skips_commands_changed_in_between(status, failure_kind):
    """AC2b(까디르 QA) — 자가복구가 blocked/paused id를 모은 뒤 잠그기 전에, 다른 tick이 그 명령을 처리해
    `blocked/connection`·`dead_letter/needs_check`가 됐다 → 되살리지 않는다(사람의 재시도 필요 판단 우회 금지)."""
    import app.services.publication_command as pc
    from app.models.publication_command import PublicationCommand
    from app.services.external_publish_pause import requeue_paused_commands_of_unpaused_orgs

    engine, Session = await _session_factory()
    try:
        _org_id, _owner_id, command_id = await _setup_command(Session)
        async with Session() as s:
            cmd = (await s.execute(select(PublicationCommand).where(PublicationCommand.id == command_id))).scalar_one()
            cmd.status, cmd.failure_kind = "blocked", "paused"  # 스냅샷 시점엔 자가복구 대상
            await s.commit()

        original = pc.retry_dead_letter_command

        async def other_tick_wins_then_lock(db, **kwargs):
            async with Session() as other:  # 스냅샷과 잠금 사이에 다른 tick이 커밋
                row = (await other.execute(select(PublicationCommand).where(PublicationCommand.id == command_id))).scalar_one()
                row.status, row.failure_kind = status, failure_kind
                await other.commit()
            return await original(db, **kwargs)

        with patch.object(pc, "retry_dead_letter_command", other_tick_wins_then_lock):
            async with Session() as s:
                requeued = await requeue_paused_commands_of_unpaused_orgs(s)
                await s.commit()
        assert requeued == 0
        after = await _command(Session, command_id)
        assert (after.status, after.failure_kind) == (status, failure_kind)
    finally:
        await engine.dispose()
