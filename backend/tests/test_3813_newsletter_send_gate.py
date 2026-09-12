"""story #3813(Phase3·3-4 PR2, 페드루 PO 確定 2026-09-12) — 뉴스레터 발송
요청 + `newsletter_send` 게이트(봉인 3열)·「변경=재승인」(ads_boost.py 동형)·
실행(sandbox만, 실 스티비 API 호출 0) 회귀. 세팅 헬퍼는 test_3806_ads_boost_gate.py
와 동형(중복 재발명 금지) — draft+version+publication 실 체인은 그 파일의
`_seed_publication` 그대로 재사용."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from tests.test_e4fc29fa_site_post_orchestration import _seed_org, _session_factory, _seed_default_role, _seed_agent
from tests.test_3475_publishing_metrics import _seed_human, _client_for, _setup_org_scoped_app
from tests.test_3497_insight_snapshots import _seed_channel_connection
from tests.test_3806_ads_boost_gate import _approve_gate, _seed_publication
from tests.test_f8f7cb0f_channel_post_publish import (
    _approve_gate_directly, _seed_connection as _seed_oauth_connection, _seed_story,
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


def _send_body(*, segment_name="전체 구독자", hours_from_now=1):
    return {
        "segment_name": segment_name,
        "scheduled_at": (datetime.now(timezone.utc) + timedelta(hours=hours_from_now)).isoformat(),
    }


async def _setup(session_factory_result, *, channel="stibee_sandbox", pub_status_published=True):
    engine, Session = session_factory_result
    async with Session() as s:
        org_id, project_id = await _seed_org(s)
        owner_id = await _seed_human(s, org_id, role="owner")
        conn = await _seed_channel_connection(s, org_id, channel=channel)
        await _seed_default_role(s, org_id)
        pub, work_item_id = await _seed_publication(s, org_id=org_id, connection_id=conn.id, channel=channel)
        if not pub_status_published:
            pub.status = "container_created"
            await s.commit()
    return engine, Session, org_id, project_id, owner_id, pub, work_item_id, conn.id


@pytest.mark.anyio
async def test_fresh_send_request_creates_pending_gate_with_sealed_three():
    from app.main import app
    from app.models.gate import Gate
    from sqlalchemy import select

    engine, Session, org_id, project_id, owner_id, pub, _, _conn_id = await _setup(await _session_factory())
    try:
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/organizations/{org_id}/publications/{pub.id}/newsletter-sends",
                json=_send_body(),
            )
        assert r.status_code == 201, r.text
        body = r.json()
        assert body["status"] == "pending"
        assert body["reapproval_required"] is False
        assert body["sealed_newsletter_segment_name"] == "전체 구독자"

        async with Session() as s:
            gate = (await s.execute(select(Gate).where(Gate.id == uuid.UUID(body["gate_id"])))).scalar_one()
            assert gate.gate_type == "newsletter_send"
            assert gate.status == "pending"
            assert gate.sealed_newsletter_version_id is not None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_agent_key_gets_403():
    from app.main import app

    engine, Session, org_id, project_id, owner_id, pub, _, _conn_id = await _setup(await _session_factory())
    try:
        async with Session() as s:
            agent_id = await _seed_agent(s, org_id, project_id)
        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/organizations/{org_id}/publications/{pub.id}/newsletter-sends",
                json=_send_body(),
            )
        assert r.status_code == 403, r.text
        assert r.json()["error"]["code"] == "NEWSLETTER_SEND_CREATE_HUMAN_ONLY"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_unknown_publication_returns_404():
    from app.main import app

    engine, Session, org_id, project_id, owner_id, _pub, _, _conn_id = await _setup(await _session_factory())
    try:
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/organizations/{org_id}/publications/{uuid.uuid4()}/newsletter-sends",
                json=_send_body(),
            )
        assert r.status_code == 404, r.text
        assert r.json()["error"]["code"] == "NEWSLETTER_SEND_PUBLICATION_NOT_FOUND"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_non_newsletter_channel_rejected():
    """threads 발행물엔 newsletter_send 게이트를 못 연다 — 그라운딩③(수신자 세그먼트는
    뉴스레터 채널에서만 의미가 있다)."""
    from app.main import app

    engine, Session, org_id, project_id, owner_id, pub, _, _conn_id = await _setup(
        await _session_factory(), channel="threads",
    )
    try:
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/organizations/{org_id}/publications/{pub.id}/newsletter-sends",
                json=_send_body(),
            )
        assert r.status_code == 422, r.text
        assert r.json()["error"]["code"] == "NEWSLETTER_SEND_INVALID_CHANNEL"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_not_yet_published_campaign_rejected():
    """PO 明示(2026-09-12) — 「발행」(캠페인 생성)과 「발송」은 순서가 있는 두 단계."""
    from app.main import app

    engine, Session, org_id, project_id, owner_id, pub, _, _conn_id = await _setup(
        await _session_factory(), pub_status_published=False,
    )
    try:
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/organizations/{org_id}/publications/{pub.id}/newsletter-sends",
                json=_send_body(),
            )
        assert r.status_code == 409, r.text
        assert r.json()["error"]["code"] == "NEWSLETTER_SEND_NOT_PUBLISHED"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_resubmit_while_approved_reopens_and_voids_pending_commands():
    """ads_boost.py::test_resubmit_while_approved_lower_budget_reopens_and_voids_
    pending_commands와 동형(카드 AC2 "변경=재승인" 양성대조)."""
    from app.main import app
    from app.models.gate import Gate
    from app.models.publication_command import PublicationCommand
    from sqlalchemy import select

    engine, Session, org_id, project_id, owner_id, pub, _, _conn_id = await _setup(await _session_factory())
    try:
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r1 = await client.post(
                f"/api/v2/organizations/{org_id}/publications/{pub.id}/newsletter-sends",
                json=_send_body(segment_name="세그먼트A"),
            )
        assert r1.status_code == 201, r1.text
        gate_id = uuid.UUID(r1.json()["gate_id"])

        async with Session() as s:
            await _approve_gate(s, gate_id, owner_id)
            gate_before = (await s.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()
            version_before = gate_before.sealed_newsletter_version_id
            # 승인된 게이트에 걸린 pending 명령 1건 — 재오픈 시 voided 확認 표본.
            pending_cmd = PublicationCommand(
                id=uuid.uuid4(), org_id=org_id, gate_id=gate_id, destination=_conn_id,
                approved_version=version_before, requested_by_member_id=owner_id,
                operation="send", content_kind="newsletter_send", status="pending",
            )
            s.add(pending_cmd)
            await s.commit()
            pending_cmd_id = pending_cmd.id

        async with _client_for(app) as client:
            r2 = await client.post(
                f"/api/v2/organizations/{org_id}/publications/{pub.id}/newsletter-sends",
                json=_send_body(segment_name="세그먼트B"),
            )
        assert r2.status_code == 201, r2.text
        body2 = r2.json()
        assert body2["status"] == "pending"
        assert body2["reapproval_required"] is True
        assert body2["sealed_newsletter_segment_name"] == "세그먼트B"

        async with Session() as s:
            gate_after = (await s.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()
            assert gate_after.sealed_newsletter_version_id != version_before, "재봉인마다 새 UUID여야 한다"
            voided = (await s.execute(
                select(PublicationCommand).where(PublicationCommand.id == pending_cmd_id)
            )).scalar_one()
            assert voided.status == "voided", voided.status
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_pending_gate_resubmit_stays_pending_no_reapproval_flag():
    """아직 승인 前(pending)이면 그대로 재봉인만(상태 전이 無, reapproval_required
    여전히 False) — ads_boost.py 동형 규율."""
    from app.main import app

    engine, Session, org_id, project_id, owner_id, pub, _, _conn_id = await _setup(await _session_factory())
    try:
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r1 = await client.post(
                f"/api/v2/organizations/{org_id}/publications/{pub.id}/newsletter-sends",
                json=_send_body(segment_name="세그먼트A"),
            )
            r2 = await client.post(
                f"/api/v2/organizations/{org_id}/publications/{pub.id}/newsletter-sends",
                json=_send_body(segment_name="세그먼트B"),
            )
        assert r1.status_code == 201 and r2.status_code == 201
        assert r1.json()["gate_id"] == r2.json()["gate_id"]
        assert r2.json()["status"] == "pending"
        assert r2.json()["reapproval_required"] is False
        assert r2.json()["sealed_newsletter_segment_name"] == "세그먼트B"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_execution_succeeds_on_sandbox_channel_and_records_activity():
    from app.main import app
    from app.models.activity_log import ActivityLog
    from app.models.gate import Gate
    from app.models.publication_command import PublicationCommand
    from app.services.newsletter_send_execution import process_one_newsletter_send_command
    from sqlalchemy import select

    engine, Session, org_id, project_id, owner_id, pub, _, _conn_id = await _setup(await _session_factory())
    try:
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/organizations/{org_id}/publications/{pub.id}/newsletter-sends",
                json=_send_body(),
            )
        gate_id = uuid.UUID(r.json()["gate_id"])

        async with Session() as s:
            await _approve_gate(s, gate_id, owner_id)
            gate = (await s.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()
            command = PublicationCommand(
                id=uuid.uuid4(), org_id=org_id, gate_id=gate_id, destination=_conn_id,
                approved_version=gate.sealed_newsletter_version_id, requested_by_member_id=owner_id,
                operation="send", content_kind="newsletter_send", status="pending",
            )
            s.add(command)
            await s.commit()
            command_id = command.id

        async with Session() as s:
            command = (await s.execute(select(PublicationCommand).where(PublicationCommand.id == command_id))).scalar_one()
            await process_one_newsletter_send_command(s, command, now=datetime.now(timezone.utc))
            await s.commit()

        async with Session() as s:
            command = (await s.execute(select(PublicationCommand).where(PublicationCommand.id == command_id))).scalar_one()
            assert command.status == "completed", command.last_error
            logs = (await s.execute(
                select(ActivityLog).where(ActivityLog.entity_id == gate_id, ActivityLog.action == "newsletter_send_succeeded")
            )).scalars().all()
            assert len(logs) == 1, logs
            assert logs[0].context["recipient_count"] == 4_200
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def _prep_real_stibee_send_command(monkeypatch, *, reserve_email_impl):
    """story #3813 PR5-b — 실 stibee 발송 공용 세팅(발행 요청→승인→PublicationCommand
    생성→`stibee_client.reserve_email`만 monkeypatch, 실 네트워크 0). 반환된 command_id
    로 `process_one_newsletter_send_command`를 부르면 된다."""
    from app.models.gate import Gate
    from app.models.publication_command import PublicationCommand
    from app.main import app
    from sqlalchemy import select

    import app.services.stibee_client as stibee_client_module

    monkeypatch.setattr(stibee_client_module, "reserve_email", reserve_email_impl)

    engine, Session, org_id, project_id, owner_id, pub, _, conn_id = await _setup(
        await _session_factory(), channel="stibee",
    )
    # story #3813 PR5-b — 실 reserve는 email_id를 int()로 캐스팅한다(스티비 email
    # id는 정수) — 공용 헬퍼 기본값 "media-1"(다른 채널 형태)은 여기 안 맞는다.
    async with Session() as s:
        pub_row = (await s.execute(select(pub.__class__).where(pub.__class__.id == pub.id))).scalar_one()
        pub_row.external_id = "9999"
        await s.commit()

    _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
    async with _client_for(app) as client:
        r = await client.post(
            f"/api/v2/organizations/{org_id}/publications/{pub.id}/newsletter-sends",
            json=_send_body(),
        )
    gate_id = uuid.UUID(r.json()["gate_id"])

    async with Session() as s:
        await _approve_gate(s, gate_id, owner_id)
        gate = (await s.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()
        command = PublicationCommand(
            id=uuid.uuid4(), org_id=org_id, gate_id=gate_id, destination=conn_id,
            approved_version=gate.sealed_newsletter_version_id, requested_by_member_id=owner_id,
            operation="send", content_kind="newsletter_send", status="pending",
        )
        s.add(command)
        await s.commit()
        command_id = command.id

    return engine, Session, command_id, conn_id


@pytest.mark.anyio
async def test_execution_succeeds_on_real_stibee_channel_calls_reserve_email(monkeypatch):
    """story #3813 PR5-b(페드루 PO 確定 2026-09-12) — 실 stibee 발송 착지. 실호출 0
    (reserve_email monkeypatch)이지만 채널 오케스트레이션(연결 조회·decrypt·완료
    처리·스냅샷 예약)이 실제로 그 함수까지 도달하는지 확認."""
    from app.models.publication_command import PublicationCommand
    from sqlalchemy import select

    captured = {}

    async def _fake_reserve_email(client, *, api_key, email_id, scheduled_at_utc):
        captured["api_key"] = api_key
        captured["email_id"] = email_id

    engine, Session, command_id, _conn_id = await _prep_real_stibee_send_command(
        monkeypatch, reserve_email_impl=_fake_reserve_email,
    )
    try:
        from app.services.newsletter_send_execution import process_one_newsletter_send_command

        async with Session() as s:
            command = (await s.execute(select(PublicationCommand).where(PublicationCommand.id == command_id))).scalar_one()
            await process_one_newsletter_send_command(s, command, now=datetime.now(timezone.utc))
            await s.commit()

        assert captured["api_key"] == "plain-token"
        assert captured["email_id"] == 9999

        async with Session() as s:
            command = (await s.execute(select(PublicationCommand).where(PublicationCommand.id == command_id))).scalar_one()
            assert command.status == "completed"
    finally:
        from app.main import app

        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_execution_plan_restricted_promotes_connection_last_error_code(monkeypatch):
    """story #3813 PR5-b CHANGES(페드루 PO 確定 2026-09-12) — 요금제 부족(reserve
    에도 동일 400+NeedProPlan)이면 명령은 실패하고, 연결 행에 last_error_code=
    STIBEE_PLAN_RESTRICTED가 남는다(화면이 「요금제 제한」 전용 문구를 고르는 실
    이행처)."""
    from app.models.channel_connection import ChannelConnection
    from app.models.publication_command import PublicationCommand
    from app.services.stibee_client import StibeeApiError
    from sqlalchemy import select

    async def _fake_reserve_email_plan_restricted(client, *, api_key, email_id, scheduled_at_utc):
        raise StibeeApiError("plan too low", status_code=400, provider_code="Errors.Service.NeedProPlan")

    engine, Session, command_id, conn_id = await _prep_real_stibee_send_command(
        monkeypatch, reserve_email_impl=_fake_reserve_email_plan_restricted,
    )
    try:
        from app.services.newsletter_send_execution import process_one_newsletter_send_command

        async with Session() as s:
            command = (await s.execute(select(PublicationCommand).where(PublicationCommand.id == command_id))).scalar_one()
            await process_one_newsletter_send_command(s, command, now=datetime.now(timezone.utc))
            await s.commit()

        async with Session() as s:
            command = (await s.execute(select(PublicationCommand).where(PublicationCommand.id == command_id))).scalar_one()
            assert command.status != "completed"
            conn = (await s.execute(select(ChannelConnection).where(ChannelConnection.id == conn_id))).scalar_one()
            assert conn.last_error_code == "STIBEE_PLAN_RESTRICTED"
    finally:
        from app.main import app

        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_process_due_newsletter_sends_queues_command_when_scheduled_at_reached():
    """ads_boost_execution.py::process_due_ads_boost_starts와 동형(PR6 정본) — 승인
    뒤 scheduled_at이 도래하면 자동으로 send 명령이 큐잉된다(사람이 따로 안 눌러도)."""
    from app.main import app
    from app.models.gate import Gate
    from app.models.publication_command import PublicationCommand
    from app.services.newsletter_send_execution import process_due_newsletter_sends
    from sqlalchemy import select, update

    engine, Session, org_id, project_id, owner_id, pub, _, _conn_id = await _setup(await _session_factory())
    try:
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r = await client.post(
                f"/api/v2/organizations/{org_id}/publications/{pub.id}/newsletter-sends",
                json=_send_body(hours_from_now=1),
            )
        gate_id = uuid.UUID(r.json()["gate_id"])

        async with Session() as s:
            await _approve_gate(s, gate_id, owner_id)
            # scheduled_at을 과거로 당겨 "이미 도래" 상태를 만든다(테스트가 1시간을
            # 안 기다리게, ads_boost_starts 테스트 관례와 동형).
            await s.execute(
                update(Gate).where(Gate.id == gate_id).values(
                    sealed_newsletter_scheduled_at=datetime.now(timezone.utc) - timedelta(minutes=1),
                )
            )
            await s.commit()

        async with Session() as s:
            counts = await process_due_newsletter_sends(s)
            await s.commit()
        assert counts["queued"] == 1, counts

        async with Session() as s:
            commands = (await s.execute(
                select(PublicationCommand).where(PublicationCommand.gate_id == gate_id, PublicationCommand.operation == "send")
            )).scalars().all()
            assert len(commands) == 1, commands

        # 멱등 — 두 번째 tick은 이미 큐잉된 게이트를 다시 안 집는다.
        async with Session() as s:
            counts2 = await process_due_newsletter_sends(s)
        assert counts2["queued"] == 0, counts2
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_full_round_trip_draft_publish_then_send_via_http():
    """PO 明示 라이브 회차 축소판(2026-09-12) — 연결→초안(subject 포함)→발행(캠페인
    생성)→newsletter_send 게이트→승인→발송 명령 자동 큐잉→실행 완료. `channel_
    payload`(subject)가 channel_posts.py 오케스트레이터를 거쳐 stibee_sandbox_
    publish.create_container까지 실제로 전달되는지(크래시 없이) 회귀 고정 —
    이 테스트가 없으면 subject kwarg 전달 배선이 조용히 끊겨도 아무 데도 안 걸린다."""
    from app.main import app
    from app.models.gate import Gate
    from app.models.publication_command import PublicationCommand
    from app.services.newsletter_send_execution import process_due_newsletter_sends, process_one_newsletter_send_command
    from sqlalchemy import select, update

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id = await _seed_human(s, org_id, role="owner")
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_oauth_connection(s, org_id, channel="stibee_sandbox")

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client:
            r_draft = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                json={
                    "work_item_id": str(story_id), "connection_id": str(connection_id),
                    "text": "이번 달 소식을 전해드립니다.", "channel_payload": {"subject": "9월 소식지"},
                },
            )
            assert r_draft.status_code == 201, r_draft.text
            draft_id = r_draft.json()["draft_id"]
            r_submit = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/submit", json={})
            assert r_submit.status_code == 200, r_submit.text
            gate_id = uuid.UUID(r_submit.json()["gate_id"])

        async with Session() as s:
            await _approve_gate_directly(s, gate_id)

        async with _client_for(app) as client:
            r_publish = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish")
        assert r_publish.status_code == 200, r_publish.text
        version_id = uuid.UUID(r_publish.json()["version_id"])

        from app.models.channel_publication import ChannelPublication

        async with Session() as s:
            publication = (await s.execute(
                select(ChannelPublication).where(ChannelPublication.version_id == version_id)
            )).scalar_one()
            assert publication.status == "published", publication.status
            publication_id = publication.id

        async with _client_for(app) as client:
            r_send = await client.post(
                f"/api/v2/organizations/{org_id}/publications/{publication_id}/newsletter-sends",
                json=_send_body(segment_name="9월 전체 구독자"),
            )
        assert r_send.status_code == 201, r_send.text
        send_gate_id = uuid.UUID(r_send.json()["gate_id"])

        async with Session() as s:
            await _approve_gate(s, send_gate_id, human_id)
            await s.execute(
                update(Gate).where(Gate.id == send_gate_id).values(
                    sealed_newsletter_scheduled_at=datetime.now(timezone.utc) - timedelta(minutes=1),
                )
            )
            await s.commit()
            counts = await process_due_newsletter_sends(s)
            await s.commit()
        assert counts["queued"] == 1, counts

        async with Session() as s:
            command = (await s.execute(
                select(PublicationCommand).where(PublicationCommand.gate_id == send_gate_id, PublicationCommand.operation == "send")
            )).scalar_one()
            await process_one_newsletter_send_command(s, command, now=datetime.now(timezone.utc))
            await s.commit()

        async with Session() as s:
            command = (await s.execute(select(PublicationCommand).where(PublicationCommand.gate_id == send_gate_id))).scalar_one()
            assert command.status == "completed", command.last_error
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_channel_payload_subject_actually_reaches_create_container():
    """양성대조 — channel_posts.py 오케스트레이터가 `channel_payload["subject"]`를
    stibee_sandbox_publish.create_container로 실제로 넘기는지(그냥 무시하고 안
    보내도 위 round-trip 테스트는 통과했을 것이다 — 이 테스트가 그 사각을 닫는다).
    stibee_sandbox_publish의 마커는 text·subject 어느 쪽에 있어도 잡힌다 —
    subject에만 마커를 심어 발행 실패를 유도하면, 배선이 끊겨 있을 때(subject가
    안 넘어갈 때)는 이 실패가 재현되지 않는다(뮤테이션 킬 포인트)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_default_role(s, org_id)
            human_id = await _seed_human(s, org_id, role="owner")
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_oauth_connection(s, org_id, channel="stibee_sandbox")

        _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
        async with _client_for(app) as client:
            r_draft = await client.post(
                f"/api/v2/organizations/{org_id}/channel-posts/drafts",
                json={
                    "work_item_id": str(story_id), "connection_id": str(connection_id),
                    "text": "본문에는 마커가 없습니다.",
                    "channel_payload": {"subject": "[sandbox:provider-error] 마커 있는 제목"},
                },
            )
            assert r_draft.status_code == 201, r_draft.text
            draft_id = r_draft.json()["draft_id"]
            r_submit = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/submit", json={})
            gate_id = uuid.UUID(r_submit.json()["gate_id"])

        async with Session() as s:
            await _approve_gate_directly(s, gate_id)

        async with _client_for(app) as client:
            r_publish = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish")
        # subject의 마커가 실제로 create_container에 도달했다는 증거 — 배선이
        # 끊겨 있었다면(subject 무시) text엔 마커가 없어 이 발행이 성공했을 것이다.
        assert r_publish.status_code != 200, "subject가 create_container에 전달 안 됐다(배선 끊김)"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
