"""story #3953(마케팅·안전장치·블루프린트 §1-5, 페드루 PO 確定 2026-09-16) — 조직
전체 「외부 발행 일시 중지」 스위치 + 감사 로그.

세팅 헬퍼는 test_3414_publication_command_core.py 재사용(중복 재발명 0). 이 파일
담당: ① owner-only PUT(admin·에이전트 403) ② 즉시-발행 라우터가 pause 中 423(adapter
호출 0) ③ 워커가 pause 中 5도메인 전부 blocked+failure_kind=paused(adapter 호출
0·한 자리 삽입점이 5도메인을 막는다는 증거) ④ 해제 시 자동 재큐(retry_dead_letter_
command 재사용) — 채널포스트 1건 실제 발행까지 왕복 ⑤ 해제 재큐는 pause로 blocked된
것만 건드린다(connection 복구 대기 blocked는 무변) ⑥ 중지 순간 in_progress인 명령은
완주(어댑터 호출 중간에 안 끊김) ⑦ pause/resume 감사 로그 2건."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone

import pytest

from tests.test_3414_publication_command_core import (
    _approve_gate_directly,
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


async def _pause(client, org_id, *, paused: bool, reason: str | None = "테스트 중지"):
    return await client.put(
        f"/api/v2/organizations/{org_id}/external-publish-pause",
        json={"paused": paused, "reason": reason if paused else None},
    )


# --- ① owner-only ------------------------------------------------------------


@pytest.mark.anyio
async def test_put_pause_admin_403():
    from app.main import app

    engine, Session = await _session_factory()
    async with Session() as s:
        org_id, project_id = await _seed_org(s)
        await _seed_default_role(s, org_id)
        admin_id = await _seed_human(s, org_id, role="admin")

    _setup_org_scoped_app(app, Session, org_id, user_id=admin_id)
    async with _client_for(app) as client:
        r = await _pause(client, org_id, paused=True)
    assert r.status_code == 403, r.text


@pytest.mark.anyio
async def test_put_pause_agent_403():
    from app.main import app

    engine, Session = await _session_factory()
    async with Session() as s:
        org_id, project_id = await _seed_org(s)
        await _seed_default_role(s, org_id)
        agent_id = await _seed_agent(s, org_id, project_id)

    _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
    async with _client_for(app) as client:
        r = await _pause(client, org_id, paused=True)
    assert r.status_code == 403, r.text


@pytest.mark.anyio
async def test_put_pause_owner_200_and_get_reflects_state():
    from app.main import app

    engine, Session = await _session_factory()
    async with Session() as s:
        org_id, project_id = await _seed_org(s)
        await _seed_default_role(s, org_id)
        owner_id = await _seed_human(s, org_id, role="owner")

    _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
    async with _client_for(app) as client:
        r = await _pause(client, org_id, paused=True, reason="사고 대응")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["paused"] is True
        assert body["reason"] == "사고 대응"
        assert body["paused_at"] is not None

        r_get = await client.get(f"/api/v2/organizations/{org_id}/external-publish-pause")
        assert r_get.status_code == 200
        assert r_get.json()["paused"] is True

        r2 = await _pause(client, org_id, paused=False)
        assert r2.status_code == 200, r2.text
        assert r2.json()["paused"] is False
        assert r2.json()["reason"] is None


# --- ② 즉시-발행 라우터 423(양성대조 짝=해제 뒤 200) ---------------------------


@pytest.mark.anyio
async def test_immediate_publish_returns_423_while_paused_adapter_not_called():
    from unittest.mock import AsyncMock, patch
    import app.services.threads_publish as tp
    from app.main import app

    engine, Session = await _session_factory()
    async with Session() as s:
        org_id, project_id = await _seed_org(s)
        await _seed_default_role(s, org_id)
        agent_id = await _seed_agent(s, org_id, project_id)
        owner_id = await _seed_human(s, org_id, role="owner")
        story_id = await _seed_story(s, org_id, project_id)
        connection_id = await _seed_connection(s, org_id)

    _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
    async with _client_for(app) as client, Session() as s:
        draft_id, gate_id = await _create_draft_submit_approve(
            client, s, org_id=org_id, connection_id=connection_id, story_id=story_id,
        )

    _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
    async with _client_for(app) as client:
        r_pause = await _pause(client, org_id, paused=True)
        assert r_pause.status_code == 200

    with (
        patch.object(tp, "create_container", AsyncMock()) as mock_create,
        patch.object(tp, "publish_container", AsyncMock()) as mock_publish,
    ):
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish")
        assert r.status_code == 423, r.text
        assert r.json()["error"]["code"] == "EXTERNAL_PUBLISH_PAUSED"
        mock_create.assert_not_called()
        mock_publish.assert_not_called()

    # 양성대조 — 해제하면 같은 요청이 정상 발행(adapter 1회).
    _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
    async with _client_for(app) as client:
        r_resume = await _pause(client, org_id, paused=False)
        assert r_resume.status_code == 200

    with (
        patch.object(tp, "create_container", AsyncMock(return_value="cid-1")) as mock_create,
        patch.object(tp, "publish_container", AsyncMock(return_value="media-1")) as mock_publish,
        patch.object(tp, "get_permalink", AsyncMock(return_value="https://x/permalink")),
        patch.object(tp, "get_publishing_limit", AsyncMock(return_value=(1, 250, 86400))),
    ):
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r2 = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish")
        assert r2.status_code == 200, r2.text
        mock_create.assert_awaited_once()


# --- ③ 워커 — 5도메인 전부 한 삽입점에서 막힌다(adapter 호출 0) ------------------


@pytest.mark.anyio
async def test_worker_blocks_all_five_content_kinds_while_paused_no_dispatch_reached():
    """삽입점이 content_kind 분기보다 먼저라, 5도메인 각각의 실제 dispatch 함수
    (_process_one_site_post_command 등)가 «전혀 호출되지 않아야» 한다 — 그 함수들을
    호출되면 즉시 실패하는 스텁으로 바꿔치기해 증명한다(삽입점 하나가 빠지면 이
    테스트가 그 도메인에서 RED)."""
    from unittest.mock import AsyncMock, patch
    from app.services.publication_command import (
        _process_one_command, create_or_get_publication_command, FAILURE_KIND_PAUSED,
    )
    from app.services.external_publish_pause import set_external_publish_pause

    engine, Session = await _session_factory()
    async with Session() as s:
        org_id, project_id = await _seed_org(s)
        owner_id = await _seed_human(s, org_id, role="owner")
        await set_external_publish_pause(s, org_id=org_id, paused=True, reason="t", actor_member_id=owner_id)
        await s.commit()

        commands = []
        for kind in ("channel_post", "site_post", "comment_reply", "ads_boost", "newsletter_send"):
            cmd, _created = await create_or_get_publication_command(
                s, org_id=org_id, gate_id=uuid.uuid4(), destination=uuid.uuid4(),
                approved_version=uuid.uuid4(), requested_by_member_id=owner_id,
                scheduled_at=None, content_kind=kind,
            )
            cmd.status = "in_progress"  # _process_one_command의 전제(배치 클레임 단계 대행)
            commands.append(cmd)
        await s.commit()

        never_called = AsyncMock(side_effect=AssertionError("도메인 dispatch가 pause 삽입점을 우회했다"))
        with (
            patch("app.services.publication_command._process_one_site_post_command", never_called),
            patch("app.services.publication_command._process_one_comment_reply_command", never_called),
            patch("app.services.ads_boost_execution.process_one_ads_boost_command", never_called),
            patch("app.services.newsletter_send_execution.process_one_newsletter_send_command", never_called),
        ):
            now = datetime.now(timezone.utc)
            for cmd in commands:
                await _process_one_command(s, cmd, now=now)
            await s.commit()

        for cmd in commands:
            await s.refresh(cmd)
            assert cmd.status == "blocked", cmd.content_kind
            assert cmd.failure_kind == FAILURE_KIND_PAUSED, cmd.content_kind


# --- ④ 해제 시 자동 재큐(채널포스트 1건 실제 발행 왕복) --------------------------


@pytest.mark.anyio
async def test_resume_requeues_paused_blocked_command_and_publishes_once():
    from unittest.mock import AsyncMock, patch
    import app.services.threads_publish as tp
    from app.services.publication_command import (
        create_or_get_publication_command, process_due_publication_commands,
    )
    from app.services.external_publish_pause import set_external_publish_pause

    engine, Session = await _session_factory()
    async with Session() as s:
        org_id, project_id = await _seed_org(s)
        await _seed_default_role(s, org_id)
        owner_id = await _seed_human(s, org_id, role="owner")
        story_id = await _seed_story(s, org_id, project_id)
        connection_id = await _seed_connection(s, org_id)

    from app.main import app
    _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
    async with _client_for(app) as client, Session() as s:
        draft_id, gate_id = await _create_draft_submit_approve(
            client, s, org_id=org_id, connection_id=connection_id, story_id=story_id,
        )

    async with Session() as s:
        await set_external_publish_pause(s, org_id=org_id, paused=True, reason="t", actor_member_id=owner_id)
        from sqlalchemy import select
        from app.models.channel_post_version import ChannelPostVersion

        latest_version_id = (await s.execute(
            select(ChannelPostVersion.id).where(ChannelPostVersion.draft_id == uuid.UUID(draft_id))
            .order_by(ChannelPostVersion.created_at.desc()).limit(1)
        )).scalar_one()
        await create_or_get_publication_command(
            s, org_id=org_id, gate_id=gate_id, destination=connection_id,
            approved_version=latest_version_id, requested_by_member_id=owner_id, scheduled_at=None,
        )
        await s.commit()

    with patch.object(tp, "create_container", AsyncMock()) as mock_create:
        async with Session() as s:
            counts = await process_due_publication_commands(s)
        assert counts["blocked"] == 1
        mock_create.assert_not_called()

    async with Session() as s:
        await set_external_publish_pause(s, org_id=org_id, paused=False, reason=None, actor_member_id=owner_id)
        await s.commit()

    with (
        patch.object(tp, "create_container", AsyncMock(return_value="cid-2")) as mock_create,
        patch.object(tp, "publish_container", AsyncMock(return_value="media-2")),
        patch.object(tp, "get_permalink", AsyncMock(return_value="https://x/permalink")),
        patch.object(tp, "get_publishing_limit", AsyncMock(return_value=(1, 250, 86400))),
    ):
        async with Session() as s:
            counts = await process_due_publication_commands(s)
        assert counts["completed"] == 1
        mock_create.assert_awaited_once()


@pytest.mark.anyio
async def test_resume_does_not_touch_blocked_commands_from_other_reasons():
    """⑤ 해제 재큐는 failure_kind='paused'만 골라낸다 — connection 복구 대기로
    blocked된(다른 사유) 명령은 무변(멋대로 재큐하면 안 고쳐진 채 또 실패할 것을
    사람 모르게 재시도하는 꼴)."""
    from app.services.publication_command import create_or_get_publication_command, FAILURE_KIND_CONNECTION
    from app.services.external_publish_pause import set_external_publish_pause

    engine, Session = await _session_factory()
    async with Session() as s:
        org_id, project_id = await _seed_org(s)
        owner_id = await _seed_human(s, org_id, role="owner")

        cmd, _ = await create_or_get_publication_command(
            s, org_id=org_id, gate_id=uuid.uuid4(), destination=uuid.uuid4(),
            approved_version=uuid.uuid4(), requested_by_member_id=owner_id, scheduled_at=None,
        )
        cmd.status = "blocked"
        cmd.failure_kind = FAILURE_KIND_CONNECTION
        cmd.last_error = "CHANNEL_TOKEN_EXPIRED"
        await s.commit()
        command_id = cmd.id

        await set_external_publish_pause(s, org_id=org_id, paused=True, reason="t", actor_member_id=owner_id)
        await s.commit()
        await set_external_publish_pause(s, org_id=org_id, paused=False, reason=None, actor_member_id=owner_id)
        await s.commit()

        from sqlalchemy import select
        from app.models.publication_command import PublicationCommand

        refreshed = (await s.execute(
            select(PublicationCommand).where(PublicationCommand.id == command_id)
        )).scalar_one()
        assert refreshed.status == "blocked"
        assert refreshed.failure_kind == FAILURE_KIND_CONNECTION


# --- ⑥ 중지 순간 in_progress인 명령은 완주 ----------------------------------


@pytest.mark.anyio
async def test_command_already_in_progress_completes_even_if_paused_mid_flight():
    """_process_one_command는 진입 시 한 번만 pause를 본다 — 그 호출 도중 다른
    트랜잭션이 pause를 켜도(mock 부작용으로 흉내) 이미 시작된 처리는 안 끊긴다."""
    from unittest.mock import AsyncMock, patch
    import app.services.threads_publish as tp
    from app.services.publication_command import (
        _process_one_command, create_or_get_publication_command,
    )
    from app.services.external_publish_pause import set_external_publish_pause

    engine, Session = await _session_factory()
    async with Session() as s:
        org_id, project_id = await _seed_org(s)
        await _seed_default_role(s, org_id)
        owner_id = await _seed_human(s, org_id, role="owner")
        story_id = await _seed_story(s, org_id, project_id)
        connection_id = await _seed_connection(s, org_id)

    from app.main import app
    _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
    async with _client_for(app) as client, Session() as s:
        draft_id, gate_id = await _create_draft_submit_approve(
            client, s, org_id=org_id, connection_id=connection_id, story_id=story_id,
        )

    async with Session() as s:
        from sqlalchemy import select
        from app.models.channel_post_version import ChannelPostVersion

        latest_version_id = (await s.execute(
            select(ChannelPostVersion.id).where(ChannelPostVersion.draft_id == uuid.UUID(draft_id))
            .order_by(ChannelPostVersion.created_at.desc()).limit(1)
        )).scalar_one()
        cmd, _ = await create_or_get_publication_command(
            s, org_id=org_id, gate_id=gate_id, destination=connection_id,
            approved_version=latest_version_id, requested_by_member_id=owner_id, scheduled_at=None,
        )
        cmd.status = "in_progress"  # 배치 클레임 단계가 이미 표시했다고 가정(원 docstring 전제)
        await s.commit()
        command_id = cmd.id

    async def _create_container_then_pause(*args, **kwargs):
        # 어댑터 호출 "도중"에 다른 요청이 pause를 켠 상황을 흉내 — 이 호출 자체는
        # 이미 pause 검사를 통과한 뒤라 끊기면 안 된다.
        async with Session() as s2:
            await set_external_publish_pause(s2, org_id=org_id, paused=True, reason="mid-flight", actor_member_id=owner_id)
            await s2.commit()
        return "cid-3"

    with (
        patch.object(tp, "create_container", AsyncMock(side_effect=_create_container_then_pause)) as mock_create,
        patch.object(tp, "publish_container", AsyncMock(return_value="media-3")),
        patch.object(tp, "get_permalink", AsyncMock(return_value="https://x/permalink")),
        patch.object(tp, "get_publishing_limit", AsyncMock(return_value=(1, 250, 86400))),
    ):
        async with Session() as s:
            from sqlalchemy import select
            from app.models.publication_command import PublicationCommand

            cmd = (await s.execute(
                select(PublicationCommand).where(PublicationCommand.id == command_id)
            )).scalar_one()
            await _process_one_command(s, cmd, now=datetime.now(timezone.utc))
            await s.commit()
        mock_create.assert_awaited_once()

    async with Session() as s:
        from sqlalchemy import select
        from app.models.publication_command import PublicationCommand

        refreshed = (await s.execute(
            select(PublicationCommand).where(PublicationCommand.id == command_id)
        )).scalar_one()
        assert refreshed.status == "completed"


# --- ⑦ 감사 로그 2건 ----------------------------------------------------------


@pytest.mark.anyio
async def test_pause_resume_write_two_audit_log_entries():
    """CHANGES(디디 자체발견, 2026-09-16 — 계정 한도 재개 뒤 재확認) — permission_
    audit_logs는 action DB CHECK(member_added|member_removed|role_changed)라
    재사용 시 IntegrityError(psql \\d permission_audit_logs 실측 확認). 페드루 PO
    確認(15:04Z) — 이 코드베이스의 기존 선례(0262·0285) 그대로 전용 테이블
    external_publish_pause_audit_logs 신설, 이 테스트도 그 테이블/필드명으로."""
    from app.models.external_publish_pause_audit_log import ExternalPublishPauseAuditLog
    from sqlalchemy import select

    engine, Session = await _session_factory()
    async with Session() as s:
        org_id, project_id = await _seed_org(s)
        owner_id = await _seed_human(s, org_id, role="owner")

    from app.main import app
    _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
    async with _client_for(app) as client:
        r1 = await _pause(client, org_id, paused=True, reason="점검")
        assert r1.status_code == 200
        r2 = await _pause(client, org_id, paused=False)
        assert r2.status_code == 200

    async with Session() as s:
        rows = (await s.execute(
            select(ExternalPublishPauseAuditLog)
            .where(ExternalPublishPauseAuditLog.org_id == org_id)
            .order_by(ExternalPublishPauseAuditLog.created_at.asc())
        )).scalars().all()
        actions = [r.action for r in rows]
        assert actions == ["pause", "resume"]
        assert rows[0].reason == "점검"
        # actor_member_id는 resolve_member()의 org_member.id(휴먼 신원 축) — _seed_human이
        # 돌려주는 raw user.id와는 다른 값(신원 해소 계층이 다르다). 두 행이 같은
        # 실제 호출자(owner)에게서 왔다는 사실만 고정한다.
        assert rows[0].actor_member_id is not None
        assert rows[0].actor_member_id == rows[1].actor_member_id
