"""story #4191(E-RECIPE-2 P3, PO 결정 2026-09-23 02:52Z) — 레시피 발송 단계 이벤트가 뉴스레터
발송 *요청*(`newsletter_send` 게이트 · 세그먼트·예약 시각 봉인)을 만들고, 승인은 지금처럼 사람만.

- AC1: 발송 단계 이벤트 → 게이트 1건(봉인 3열·지정 승인자) · 에이전트 키 승인 403 · 사람 승인 →
  기존 크론(process_due_newsletter_sends)이 발송 명령을 만든다 · 봉인 필드가 빠지면 게이트 0건.
- 레시피 경로만의 두 규칙: 다른 work item의 발행물이면 거부 · admin이 무효화한 게이트는 안 연다.
- 「변경=재승인」: 승인된 뒤 다른 값으로 다시 발행하면 pending + reapproval_required.

세팅은 test_3813_newsletter_send_gate.py(발행물 실 체인)·test_3312_approve_stage_gate_auto_creation.py
(레시피 정의·이벤트 발행) 하네스를 그대로 쓴다."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import BackgroundTasks, HTTPException
from sqlalchemy import select

from tests.test_3312_approve_stage_gate_auto_creation import _auth, _fake_request, _seed_story
from tests.test_3475_publishing_metrics import _client_for, _seed_human, _setup_org_scoped_app
from tests.test_3497_insight_snapshots import _seed_channel_connection
from tests.test_3806_ads_boost_gate import _approve_gate, _seed_publication
from tests.test_e4fc29fa_site_post_orchestration import _seed_agent, _seed_default_role, _seed_org, _session_factory

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
    # 채널 연결 시드가 자격증명을 암호화한다. reload 대신 settings 패치 + 캐시 비우기(모듈 reload는
    # 예외 클래스 정체성을 깨뜨린다).
    from cryptography.fernet import Fernet

    import app.core.config as config_module
    from app.services.channel_credential_crypto import _get_multi_fernet

    monkeypatch.setattr(config_module.settings, "channel_credential_encryption_key", Fernet.generate_key().decode())
    _get_multi_fernet.cache_clear()
    yield
    _get_multi_fernet.cache_clear()


_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": ["stage", "work_item_type", "work_item_id"],
    "properties": {
        "stage": {"type": "string", "enum": ["write", "send", "check"]},
        "work_item_type": {"type": "string"},
        "work_item_id": {"type": "string", "format": "uuid"},
        "publication_id": {"type": "string"},
        "segment_name": {"type": "string"},
        "scheduled_at": {"type": "string"},
    },
}
_ROUTING = {
    "escalation": {"kind": "server_derived", "target": "none"},
    "broadcast": {"kind": "server_derived", "target": "none"},
}
_STAGE_METADATA = {
    "write": {"role": "Creator", "action": "뉴스레터 작성"},
    "send": {"role": "Publisher", "action": "발송 요청", "gate": {"type": "newsletter_send", "approver": "org_owner"}},
    "check": {"role": "Publisher", "action": "발송 결과 확인"},
}


async def _setup(Session):
    from app.models.event_definition import EventDefinition
    from app.models.project import OrgMember

    async with Session() as s:
        org_id, project_id = await _seed_org(s)
        owner_user_id = await _seed_human(s, org_id, role="owner")
        owner_member_id = (await s.execute(
            select(OrgMember.id).where(OrgMember.org_id == org_id, OrgMember.user_id == owner_user_id)
        )).scalar_one()
        await _seed_default_role(s, org_id)
        agent_id = await _seed_agent(s, org_id, project_id)
        story_id = await _seed_story(s, org_id, project_id)
        conn = await _seed_channel_connection(s, org_id, channel="stibee_sandbox")
        pub, _ = await _seed_publication(
            s, org_id=org_id, connection_id=conn.id, work_item_id=story_id, channel="stibee_sandbox",
        )
        definition = EventDefinition(
            id=uuid.uuid4(), key=f"org.r4191{uuid.uuid4().hex[:6]}.newsletter_cycle", org_id=org_id,
            name="뉴스레터 레시피", payload_schema=_SCHEMA, routing=_ROUTING, stage_metadata=_STAGE_METADATA,
        )
        s.add(definition)
        await s.commit()
    return {
        "org_id": org_id, "project_id": project_id, "owner_user_id": owner_user_id,
        "owner_member_id": owner_member_id, "agent_id": agent_id, "story_id": story_id, "pub": pub,
        "definition_key": definition.key,
    }


def _send_payload(ctx, **overrides):
    payload = {
        "stage": "send", "work_item_type": "story", "work_item_id": str(ctx["story_id"]),
        "publication_id": str(ctx["pub"].id), "segment_name": "테스트 수신 목록",
        "scheduled_at": (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat(),
    }
    payload.update(overrides)
    return {k: v for k, v in payload.items() if v is not None}


async def _publish(Session, ctx, payload):
    from app.routers.events import EventPublishRequest, publish_registry_event

    async with Session() as s:
        await publish_registry_event(
            EventPublishRequest(definition_key=ctx["definition_key"], payload=payload),
            BackgroundTasks(), _fake_request(), db=s, auth=_auth(ctx["agent_id"], ctx["org_id"]), org_id=ctx["org_id"],
        )
        await s.commit()


async def _newsletter_gates(Session, ctx):
    from app.models.gate import Gate

    async with Session() as s:
        return (await s.execute(
            select(Gate).where(Gate.org_id == ctx["org_id"], Gate.gate_type == "newsletter_send")
        )).scalars().all()


@pytest.mark.anyio
async def test_send_stage_event_opens_one_sealed_gate_agent_cannot_approve_human_approval_reaches_cron():
    """⭐AC1 — 발송 단계 이벤트 → 봉인된 게이트 1건 → 에이전트 승인 403 → 사람 승인 → 기존 크론이 발송 명령."""
    from app.main import app
    from app.models.publication_command import PublicationCommand
    from app.services.newsletter_send_execution import process_due_newsletter_sends

    engine, Session = await _session_factory()
    try:
        ctx = await _setup(Session)
        scheduled_at = datetime.now(timezone.utc) + timedelta(hours=2)
        await _publish(Session, ctx, _send_payload(ctx, scheduled_at=scheduled_at.isoformat()))

        gates = await _newsletter_gates(Session, ctx)
        assert len(gates) == 1
        gate = gates[0]
        assert gate.status == "pending" and gate.requires_human is True
        assert gate.work_item_id == ctx["story_id"]
        assert gate.scope_key == str(ctx["pub"].id)
        assert gate.sealed_newsletter_segment_name == "테스트 수신 목록"
        assert gate.sealed_newsletter_scheduled_at == scheduled_at
        assert gate.sealed_newsletter_version_id is not None
        assert gate.designated_approver_id == ctx["owner_member_id"]
        assert gate.neutral_facts["stage"] == "send"
        assert gate.neutral_facts["stage_role"] == "Publisher"

        # 에이전트 키로 승인 시도 → 403(모든 게이트 승인은 휴먼 전용, 이 PR이 안 건드린 규칙).
        _setup_org_scoped_app(app, Session, ctx["org_id"], user_id=ctx["agent_id"], agent=True)
        try:
            async with _client_for(app) as client:
                r = await client.post(
                    f"/api/v2/gates/{gate.id}/transition",
                    json={"status": "approved", "note": "에이전트 승인 시도", "evidence_viewed": True},
                )
            assert r.status_code == 403, r.text
        finally:
            app.dependency_overrides.clear()
        assert (await _newsletter_gates(Session, ctx))[0].status == "pending"

        # 사람 승인 → 예약 시각 도래 → 기존 크론 경로가 봉인된 버전으로 발송 명령을 만든다.
        async with Session() as s:
            await _approve_gate(s, gate.id, ctx["owner_member_id"])
        async with Session() as s:
            counts = await process_due_newsletter_sends(s, now=scheduled_at + timedelta(minutes=1))
        assert counts.get("queued") == 1, counts
        async with Session() as s:
            commands = (await s.execute(
                select(PublicationCommand).where(PublicationCommand.gate_id == gate.id)
            )).scalars().all()
        assert len(commands) == 1
        assert commands[0].content_kind == "newsletter_send"
        assert commands[0].approved_version == gate.sealed_newsletter_version_id
        assert commands[0].scheduled_at == scheduled_at
    finally:
        await engine.dispose()


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("overrides", "missing"),
    [
        ({"publication_id": None}, "publication_id"),
        ({"publication_id": "not-a-uuid"}, "publication_id"),
        ({"segment_name": None}, "segment_name"),
        ({"segment_name": "   "}, "segment_name"),
        ({"scheduled_at": None}, "scheduled_at"),
        ({"scheduled_at": "2026-10-01T09:00:00"}, "scheduled_at"),  # 시간대 없음
        ({"scheduled_at": "다음 주 월요일"}, "scheduled_at"),
    ],
)
async def test_missing_or_invalid_sealed_field_opens_no_gate(overrides, missing):
    """⭐AC1 뮤테이션 대상 — 봉인 값(누구에게·언제·무엇을)이 비면 게이트 자체를 안 만든다(422)."""
    engine, Session = await _session_factory()
    try:
        ctx = await _setup(Session)
        with pytest.raises(HTTPException) as exc:
            await _publish(Session, ctx, _send_payload(ctx, **overrides))
        assert exc.value.status_code == 422
        assert exc.value.detail["code"] == "GATE_SEALED_FIELD_MISSING"
        assert exc.value.detail["gate_type"] == "newsletter_send"
        assert missing in exc.value.detail["missing_fields"]
        assert await _newsletter_gates(Session, ctx) == []
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_publication_of_another_work_item_is_rejected_like_not_found():
    """레시피 경로 전용 — 다른 스토리의 발행물로는 발송 게이트를 못 연다(존재 비노출 404)."""
    engine, Session = await _session_factory()
    try:
        ctx = await _setup(Session)
        async with Session() as s:
            other_story_id = await _seed_story(s, ctx["org_id"], ctx["project_id"])
        with pytest.raises(HTTPException) as exc:
            await _publish(Session, ctx, _send_payload(ctx, work_item_id=str(other_story_id)))
        assert exc.value.status_code == 404
        assert exc.value.detail["code"] == "NEWSLETTER_SEND_PUBLICATION_NOT_FOUND"
        assert await _newsletter_gates(Session, ctx) == []
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_non_newsletter_publication_rejected_with_human_api_code():
    """사람 API와 같은 거부 코드 — 뉴스레터 채널이 아닌 발행물이면 422 NEWSLETTER_SEND_INVALID_CHANNEL."""
    engine, Session = await _session_factory()
    try:
        ctx = await _setup(Session)
        async with Session() as s:
            threads_conn = await _seed_channel_connection(s, ctx["org_id"], channel="threads")
            threads_pub, _ = await _seed_publication(
                s, org_id=ctx["org_id"], connection_id=threads_conn.id, work_item_id=ctx["story_id"], channel="threads",
            )
        with pytest.raises(HTTPException) as exc:
            await _publish(Session, ctx, _send_payload(ctx, publication_id=str(threads_pub.id)))
        assert exc.value.status_code == 422
        assert exc.value.detail["code"] == "NEWSLETTER_SEND_INVALID_CHANNEL"
        assert await _newsletter_gates(Session, ctx) == []
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_republish_after_approval_with_new_segment_requires_reapproval():
    """「변경=재승인」이 레시피 경로에도 그대로 — 승인 뒤 다른 세그먼트로 다시 발행하면 pending으로 재오픈."""
    engine, Session = await _session_factory()
    try:
        ctx = await _setup(Session)
        await _publish(Session, ctx, _send_payload(ctx))
        gate = (await _newsletter_gates(Session, ctx))[0]
        first_version = gate.sealed_newsletter_version_id
        async with Session() as s:
            await _approve_gate(s, gate.id, ctx["owner_member_id"])

        await _publish(Session, ctx, _send_payload(ctx, segment_name="전체 구독자"))
        gates = await _newsletter_gates(Session, ctx)
        assert len(gates) == 1
        assert gates[0].status == "pending"
        assert gates[0].reapproval_required is True
        assert gates[0].sealed_newsletter_segment_name == "전체 구독자"
        assert gates[0].sealed_newsletter_version_id != first_version
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_voided_gate_is_not_reopened_by_recipe():
    """admin이 무효화한 게이트는 레시피 재발행으로 다시 열리지 않는다(범용 레시피 게이트와 같은 원칙)."""
    from app.models.gate import Gate, set_gate_status

    engine, Session = await _session_factory()
    try:
        ctx = await _setup(Session)
        await _publish(Session, ctx, _send_payload(ctx))
        gate_id = (await _newsletter_gates(Session, ctx))[0].id
        async with Session() as s:
            g = (await s.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()
            set_gate_status(g, "voided", now=datetime.now(timezone.utc))
            await s.commit()

        await _publish(Session, ctx, _send_payload(ctx, segment_name="전체 구독자"))
        gates = await _newsletter_gates(Session, ctx)
        assert len(gates) == 1
        assert gates[0].status == "voided"
        assert gates[0].sealed_newsletter_segment_name == "테스트 수신 목록"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_human_send_request_api_unchanged_by_recipe_path():
    """AC2 — 사람 발송 요청 API는 그대로: 사람은 201(지정 승인자 없음 — 기존 모양), 에이전트 키는 403."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        ctx = await _setup(Session)
        body = {"segment_name": "전체 구독자", "scheduled_at": (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()}
        url = f"/api/v2/organizations/{ctx['org_id']}/publications/{ctx['pub'].id}/newsletter-sends"

        _setup_org_scoped_app(app, Session, ctx["org_id"], user_id=ctx["agent_id"], agent=True)
        try:
            async with _client_for(app) as client:
                r = await client.post(url, json=body)
            assert r.status_code == 403, r.text
            assert r.json()["error"]["code"] == "NEWSLETTER_SEND_CREATE_HUMAN_ONLY"
        finally:
            app.dependency_overrides.clear()

        _setup_org_scoped_app(app, Session, ctx["org_id"], user_id=ctx["owner_user_id"])
        try:
            async with _client_for(app) as client:
                r = await client.post(url, json=body)
            assert r.status_code == 201, r.text
        finally:
            app.dependency_overrides.clear()
        gates = await _newsletter_gates(Session, ctx)
        assert len(gates) == 1
        assert gates[0].designated_approver_id is None
    finally:
        await engine.dispose()


async def _seed_pending_command(Session, ctx, gate):
    from app.models.publication_command import PublicationCommand

    async with Session() as s:
        cmd = PublicationCommand(
            id=uuid.uuid4(), org_id=ctx["org_id"], gate_id=gate.id, destination=ctx["pub"].connection_id,
            approved_version=gate.sealed_newsletter_version_id, requested_by_member_id=ctx["owner_member_id"],
            operation="send", content_kind="newsletter_send", status="pending",
        )
        s.add(cmd)
        await s.commit()
        return cmd.id


async def _command_status(Session, cmd_id):
    from app.models.publication_command import PublicationCommand

    async with Session() as s:
        return (await s.execute(select(PublicationCommand.status).where(PublicationCommand.id == cmd_id))).scalar_one()


@pytest.mark.anyio
async def test_same_values_republish_after_approval_is_noop_keeps_scheduled_send():
    """PR #4550 까디르 P2 — 승인 뒤 같은 값으로 다시 발행(재시도·중복)하면 아무것도 안 바뀐다:
    승인 유지 · 재승인 표시 없음 · 버전 그대로 · 대기 중 발송 명령 유지."""
    engine, Session = await _session_factory()
    try:
        ctx = await _setup(Session)
        scheduled_at = (datetime.now(timezone.utc) + timedelta(hours=3)).isoformat()
        payload = _send_payload(ctx, scheduled_at=scheduled_at)
        await _publish(Session, ctx, payload)
        gate = (await _newsletter_gates(Session, ctx))[0]
        async with Session() as s:
            await _approve_gate(s, gate.id, ctx["owner_member_id"])
        cmd_id = await _seed_pending_command(Session, ctx, gate)

        await _publish(Session, ctx, payload)

        after = (await _newsletter_gates(Session, ctx))[0]
        assert after.status == "approved"
        assert after.reapproval_required is False
        assert after.sealed_newsletter_version_id == gate.sealed_newsletter_version_id
        assert await _command_status(Session, cmd_id) == "pending"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_changed_time_after_approval_reopens_and_voids_command():
    """대조 — 값 하나(예약 시각)만 바뀌어도 기존 「변경=재승인」: pending + 재승인 + 명령 무효화."""
    engine, Session = await _session_factory()
    try:
        ctx = await _setup(Session)
        await _publish(Session, ctx, _send_payload(ctx, scheduled_at=(datetime.now(timezone.utc) + timedelta(hours=3)).isoformat()))
        gate = (await _newsletter_gates(Session, ctx))[0]
        async with Session() as s:
            await _approve_gate(s, gate.id, ctx["owner_member_id"])
        cmd_id = await _seed_pending_command(Session, ctx, gate)

        await _publish(Session, ctx, _send_payload(ctx, scheduled_at=(datetime.now(timezone.utc) + timedelta(hours=5)).isoformat()))

        after = (await _newsletter_gates(Session, ctx))[0]
        assert after.status == "pending"
        assert after.reapproval_required is True
        assert await _command_status(Session, cmd_id) == "voided"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_human_api_same_values_after_approval_is_noop_too():
    """같은 규칙이 사람 API에도 — 승인된 발송을 같은 값으로 다시 요청해도 취소되지 않는다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        ctx = await _setup(Session)
        body = {"segment_name": "전체 구독자", "scheduled_at": (datetime.now(timezone.utc) + timedelta(hours=3)).isoformat()}
        url = f"/api/v2/organizations/{ctx['org_id']}/publications/{ctx['pub'].id}/newsletter-sends"
        _setup_org_scoped_app(app, Session, ctx["org_id"], user_id=ctx["owner_user_id"])
        try:
            async with _client_for(app) as client:
                r1 = await client.post(url, json=body)
            gate = (await _newsletter_gates(Session, ctx))[0]
            async with Session() as s:
                await _approve_gate(s, gate.id, ctx["owner_member_id"])
            cmd_id = await _seed_pending_command(Session, ctx, gate)
            async with _client_for(app) as client:
                r2 = await client.post(url, json=body)
        finally:
            app.dependency_overrides.clear()
        assert r1.status_code == 201 and r2.status_code == 201, (r1.text, r2.text)
        assert r2.json()["status"] == "approved"
        assert r2.json()["reapproval_required"] is False
        assert await _command_status(Session, cmd_id) == "pending"
    finally:
        await engine.dispose()
