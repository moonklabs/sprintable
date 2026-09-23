"""story #4214(E-RECIPE-2 P4b · 4192에서 분리) — 뉴스레터 크론 발송 실행이 성공으로 끝나면, 레시피 회차에서 온 발송이면
레시피 다음 단계(뉴스레터 프리셋은 «발송 결과 확인» send_checked) 이벤트를 정확히 1회. 예전엔 activity log만 남겨
레시피가 발송 완료를 자동으로 몰랐다(4191 그라운딩).

- AC1: 레시피 발송 게이트 → 사람 승인 → 크론(process_due_newsletter_sends) → 워커(process_due_publication_commands)
  발송 성공 → 다음 단계 이벤트 1 · 발송 실패 0 · 게이트가 픽업 전에 다시 열리면 0 · 틱이 겹치거나 발행부가 다시 불려도 1.
- AC2: 레시피 아닌 발송(neutral_facts에 레시피 표지 없음)은 이벤트 0·발송 성공 그대로.

레시피 정의는 test_4191 하네스의 픽스처(write → send → check, send에 newsletter_send 게이트) — 4554(실 뉴스레터 프리셋
시드) 착지 뒤 AC3에서 실제 시드로 한 번 더."""
from __future__ import annotations

import os
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select, text

from tests.test_3806_ads_boost_gate import _approve_gate
from tests.test_4093_scheduled_publish_event_realdb import (
    _seed_system_publisher_teammember_shim,
)
from tests.test_4191_recipe_newsletter_send_realdb import (
    _newsletter_gates,
    _publish,
    _send_payload,
    _setup,
)
from tests.test_e4fc29fa_site_post_orchestration import _session_factory

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
    from cryptography.fernet import Fernet

    import app.core.config as config_module
    from app.services.channel_credential_crypto import _get_multi_fernet

    monkeypatch.setattr(config_module.settings, "channel_credential_encryption_key", Fernet.generate_key().decode())
    _get_multi_fernet.cache_clear()
    yield
    _get_multi_fernet.cache_clear()


async def _stage_event_count(Session, ctx, stage: str) -> int:
    async with Session() as s:
        return (await s.execute(text(
            "SELECT count(*) FROM conversation_messages m JOIN conversations c ON c.id = m.conversation_id "
            "WHERE c.org_id = :org AND m.metadata->'event'->>'event_key' = :key "
            "AND m.metadata->'event'->'payload'->>'stage' = :stage "
            "AND m.metadata->'event'->'payload'->>'work_item_id' = :wi"
        ), {"org": ctx["org_id"], "key": ctx["definition_key"], "stage": stage, "wi": str(ctx["story_id"])})).scalar_one()


async def _approve_and_queue(Session, ctx, *, segment_name: str = "테스트 수신 목록"):
    """발송 단계 이벤트 → 게이트 → 사람 승인 → 크론이 발송 명령. (gate, scheduled_at) 반환."""
    from app.services.newsletter_send_execution import process_due_newsletter_sends

    # create_all 하네스는 team_members VIEW를 못 만든다 — 시스템 발행자(다음 단계 이벤트 발신자)가 resolve_member에서
    # 보이도록 test_4093과 같은 shim을 심는다(실 alembic 스키마에선 VIEW가 투영, 이 shim 불요).
    async with Session() as s:
        await _seed_system_publisher_teammember_shim(s, ctx["org_id"], ctx["project_id"])

    scheduled_at = datetime.now(UTC) + timedelta(hours=2)
    await _publish(Session, ctx, _send_payload(ctx, scheduled_at=scheduled_at.isoformat(), segment_name=segment_name))
    gate = (await _newsletter_gates(Session, ctx))[0]
    async with Session() as s:
        await _approve_gate(s, gate.id, ctx["owner_member_id"])
    async with Session() as s:
        counts = await process_due_newsletter_sends(s, now=scheduled_at + timedelta(minutes=1))
    assert counts.get("queued") == 1, counts
    return gate, scheduled_at


async def _run_worker(Session, now):
    from app.services.publication_command import process_due_publication_commands

    async with Session() as s:
        return await process_due_publication_commands(s, now=now)


async def _command_status(Session, gate_id):
    from app.models.publication_command import PublicationCommand

    async with Session() as s:
        return (await s.execute(select(PublicationCommand.status).where(PublicationCommand.gate_id == gate_id))).scalar_one()


@pytest.mark.anyio
async def test_recipe_send_success_emits_next_stage_exactly_once_even_on_overlapping_ticks():
    """⭐AC1 — 성공 → 다음 단계(check) 이벤트 1 · 틱 겹침·발행부 재호출에도 1."""
    from app.models.gate import Gate
    from app.models.publication_command import PublicationCommand
    from app.services.newsletter_send_execution import (
        _emit_recipe_next_stage_after_send,
    )

    engine, Session = await _session_factory()
    try:
        ctx = await _setup(Session)
        gate, scheduled_at = await _approve_and_queue(Session, ctx)
        assert await _stage_event_count(Session, ctx, "check") == 0

        await _run_worker(Session, scheduled_at + timedelta(minutes=2))
        assert await _command_status(Session, gate.id) == "completed"
        assert await _stage_event_count(Session, ctx, "check") == 1

        # 틱이 한 번 더 돌아도(이미 completed라 다시 안 집음) 1.
        await _run_worker(Session, scheduled_at + timedelta(minutes=3))
        assert await _stage_event_count(Session, ctx, "check") == 1

        # 발행부가 다시 불려도(재시도·겹친 처리) 멱등 — 1.
        async with Session() as s:
            g = (await s.execute(select(Gate).where(Gate.id == gate.id))).scalar_one()
            cmd = (await s.execute(select(PublicationCommand).where(PublicationCommand.gate_id == gate.id))).scalar_one()
            await _emit_recipe_next_stage_after_send(s, command=cmd, gate=g)
            await s.commit()
        assert await _stage_event_count(Session, ctx, "check") == 1
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_recipe_send_failure_emits_no_next_stage():
    """AC1 — 발송 실패(샌드박스 실패 마커) → 다음 단계 이벤트 0."""
    engine, Session = await _session_factory()
    try:
        ctx = await _setup(Session)
        gate, scheduled_at = await _approve_and_queue(Session, ctx, segment_name="실패 [sandbox:send-failed]")
        await _run_worker(Session, scheduled_at + timedelta(minutes=2))
        assert await _command_status(Session, gate.id) != "completed"
        assert await _stage_event_count(Session, ctx, "check") == 0
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_gate_reopened_before_pickup_sends_nothing_and_emits_nothing():
    """AC1 — 명령이 큐에 들어간 뒤 게이트가 승인 상태가 아니게 되면(재오픈·취소) 발송도 이벤트도 0."""
    from app.models.gate import Gate

    engine, Session = await _session_factory()
    try:
        ctx = await _setup(Session)
        gate, scheduled_at = await _approve_and_queue(Session, ctx)
        async with Session() as s:
            g = (await s.execute(select(Gate).where(Gate.id == gate.id))).scalar_one()
            g.status = "pending"
            await s.commit()
        await _run_worker(Session, scheduled_at + timedelta(minutes=2))
        assert await _command_status(Session, gate.id) != "completed"
        assert await _stage_event_count(Session, ctx, "check") == 0
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_non_recipe_send_success_emits_nothing_and_still_completes():
    """AC2 — 레시피 표지(neutral_facts.triggered_by_event)가 없는 발송 게이트는 성공 그대로·이벤트 0."""
    from app.models.gate import Gate

    engine, Session = await _session_factory()
    try:
        ctx = await _setup(Session)
        gate, scheduled_at = await _approve_and_queue(Session, ctx)
        async with Session() as s:
            g = (await s.execute(select(Gate).where(Gate.id == gate.id))).scalar_one()
            facts = dict(g.neutral_facts or {})
            facts.pop("triggered_by_event", None)
            g.neutral_facts = facts
            await s.commit()
        await _run_worker(Session, scheduled_at + timedelta(minutes=2))
        assert await _command_status(Session, gate.id) == "completed"
        assert await _stage_event_count(Session, ctx, "check") == 0
    finally:
        await engine.dispose()


async def _switch_to_real_stibee(Session, ctx, monkeypatch, *, fail: bool):
    """실 스티비 분기(_process_real_send)로 — 연결 채널을 stibee로, 발행물 id를 정수(스티비 email id)로 바꾸고
    reserve_email만 가짜로(실 네트워크 0, test_3813_newsletter_send_gate의 PR5-b 하네스와 같은 축)."""
    import app.services.stibee_client as stibee_client_module
    from app.models.channel_connection import ChannelConnection
    from app.models.channel_publication import ChannelPublication

    async def _ok(*_a, **_k):
        return {"ok": True}

    async def _fail(*_a, **_k):
        raise stibee_client_module.StibeeApiError("provider down", status_code=500, provider_code="X")

    monkeypatch.setattr(stibee_client_module, "reserve_email", _fail if fail else _ok)
    async with Session() as s:
        pub = (await s.execute(select(ChannelPublication).where(ChannelPublication.id == ctx["pub"].id))).scalar_one()
        pub.external_id = "9999"
        conn = (await s.execute(select(ChannelConnection).where(ChannelConnection.id == pub.connection_id))).scalar_one()
        conn.channel = "stibee"
        await s.commit()


@pytest.mark.anyio
@pytest.mark.parametrize("fail, expected_events", [(False, 1), (True, 0)], ids=["예약 성공", "예약 실패"])
async def test_real_stibee_branch_emits_on_success_only(monkeypatch, fail, expected_events):
    """AC1 — 실 스티비 분기(reserve_email)도 성공이면 다음 단계 이벤트 1, 실패면 0."""
    engine, Session = await _session_factory()
    try:
        ctx = await _setup(Session)
        gate, scheduled_at = await _approve_and_queue(Session, ctx)
        await _switch_to_real_stibee(Session, ctx, monkeypatch, fail=fail)
        await _run_worker(Session, scheduled_at + timedelta(minutes=2))
        assert (await _command_status(Session, gate.id) == "completed") is (not fail)
        assert await _stage_event_count(Session, ctx, "check") == expected_events
    finally:
        await engine.dispose()


def _load_0398_seed():
    """AC3 — 실 뉴스레터 프리셋 시드(0398 마이그레이션 모듈의 상수) 그대로. 파일 이름이 숫자로 시작해 import 문 대신
    spec 로드 — 시드 문안·스키마를 이 테스트에 복사하지 않는다(시드가 바뀌면 이 테스트도 그 값으로 돈다)."""
    import importlib.util
    from pathlib import Path

    path = next((Path(__file__).resolve().parents[1] / "alembic" / "versions").glob("0398_*.py"))
    spec = importlib.util.spec_from_file_location("_seed_0398", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.anyio
async def test_real_newsletter_preset_seed_send_requested_to_send_checked_once():
    """⭐AC3 — 실제 뉴스레터 프리셋 시드(preset.marketing.newsletter, 0398): 발송 요청(send_requested) 게이트 → 사람 승인 →
    크론 → 워커 발송 성공 → «발송 결과 확인»(send_checked) 이벤트 정확히 1 · 겹친 틱에도 1."""
    import uuid

    from app.models.event_definition import EventDefinition

    seed = _load_0398_seed()
    engine, Session = await _session_factory()
    try:
        ctx = await _setup(Session)
        async with Session() as s:
            if (await s.execute(select(EventDefinition).where(EventDefinition.key == seed._KEY))).scalars().first() is None:
                s.add(EventDefinition(
                    id=uuid.uuid4(), key=seed._KEY, org_id=None, name=seed._NAME, description=seed._DESCRIPTION,
                    payload_schema=seed._PAYLOAD_SCHEMA, routing=seed._ROUTING, block_template=seed._BLOCK_TEMPLATE,
                    stage_metadata=seed._STAGE_METADATA, role_actor_kinds=seed._ROLE_ACTOR_KINDS, enabled=True, version=1,
                ))
                await s.commit()
        ctx = {**ctx, "definition_key": seed._KEY}
        assert seed._STAGE_SLUGS[-2:] == ["send_requested", "send_checked"]

        scheduled_at = datetime.now(UTC) + timedelta(hours=2)
        payload = {**_send_payload(ctx, scheduled_at=scheduled_at.isoformat()), "stage": "send_requested"}
        async with Session() as s:
            await _seed_system_publisher_teammember_shim(s, ctx["org_id"], ctx["project_id"])
        await _publish(Session, ctx, payload)
        gate = (await _newsletter_gates(Session, ctx))[0]
        assert gate.neutral_facts["triggered_by_event"] == seed._KEY
        assert gate.neutral_facts["stage"] == "send_requested"

        from app.services.newsletter_send_execution import process_due_newsletter_sends

        async with Session() as s:
            await _approve_gate(s, gate.id, ctx["owner_member_id"])
        async with Session() as s:
            assert (await process_due_newsletter_sends(s, now=scheduled_at + timedelta(minutes=1))).get("queued") == 1

        await _run_worker(Session, scheduled_at + timedelta(minutes=2))
        await _run_worker(Session, scheduled_at + timedelta(minutes=3))
        assert await _command_status(Session, gate.id) == "completed"
        assert await _stage_event_count(Session, ctx, "send_checked") == 1
    finally:
        await engine.dispose()


def _count_sends(monkeypatch) -> list[str]:
    import app.services.stibee_sandbox_campaign as sandbox_module

    sends: list[str] = []
    real_send = sandbox_module.send_campaign

    async def _counting_send(**kwargs):
        sends.append(kwargs["campaign_id"])
        return await real_send(**kwargs)

    monkeypatch.setattr(sandbox_module, "send_campaign", _counting_send)
    return sends


def _emit_raises_sql_error_for(monkeypatch, failing_org_ids: set):
    """레시피 이벤트 발행부가 **실제 SQL 오류를 그대로 던진다**(삼키지 않음) — 지정 org만. 나머지는 실 발행부.

    story #4192(통합 · 4573 병합 뒤) — 뉴스레터 경로는 이제 입구 `emit_recipe_published_stage_event`를 **워커 세션을 넘겨** 직접
    부르고, 격리 세션은 그 입구가 연다(호출자 세션엔 쓰지 않는 계약 — test_4192 `test_emit_never_touches_the_callers_session`).
    그래서 오류는 입구 **안쪽**, 격리 세션에서 레시피 단계 이벤트를 쓰는 자리(`_emit_recipe_published_stage_event_locked` —
    레시피 단계 이벤트만 지나는 곳, 셋업의 일반 발행은 안 지난다)에 넣는다. 예전 대역처럼 입구 바깥에서 넘겨받은 세션에 SQL을
    치면, 운영 코드가 하지 않는 «워커 세션 오염»을 대역이 스스로 만든다."""
    import app.services.channel_posts as channel_posts_module

    real_locked = channel_posts_module._emit_recipe_published_stage_event_locked

    async def _locked(event_db, **kwargs):
        if kwargs["org_id"] in failing_org_ids:
            await event_db.execute(text("SELECT * FROM no_such_table_4214"))
        return await real_locked(event_db, **kwargs)

    monkeypatch.setattr(channel_posts_module, "_emit_recipe_published_stage_event_locked", _locked)


@pytest.mark.anyio
async def test_event_raising_sql_error_keeps_send_record_worker_finishes_and_next_tick_does_not_resend(monkeypatch):
    """⭐PR #4573 PO 수정 ① — 이벤트 발행부가 실제 SQL 오류를 **던져도**: 워커는 정상 종료(예외 밖으로 0) · 틱 뒤 **새 세션
    재조회** command=completed · 이어지는 두 틱에서 발송 호출 총 1(수신자 이중 발송 0) · 이벤트 0."""
    sends = _count_sends(monkeypatch)
    engine, Session = await _session_factory()
    try:
        ctx = await _setup(Session)
        _emit_raises_sql_error_for(monkeypatch, {ctx["org_id"]})
        gate, scheduled_at = await _approve_and_queue(Session, ctx)
        counts = await _run_worker(Session, scheduled_at + timedelta(minutes=2))
        assert counts["completed"] == 1 and counts["error"] == 0, counts
        assert await _command_status(Session, gate.id) == "completed"  # 새 세션 재조회
        await _run_worker(Session, scheduled_at + timedelta(minutes=3))
        await _run_worker(Session, scheduled_at + timedelta(minutes=10))
        assert len(sends) == 1, sends
        assert await _stage_event_count(Session, ctx, "check") == 0
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_first_commands_event_failure_does_not_strand_the_rest_of_the_batch(monkeypatch):
    """⭐PR #4573 PO 수정 ② — 한 배치에 명령 2개, 첫 번째의 이벤트가 SQL 오류로 실패해도 두 번째 명령도 completed · 두 번째의
    이벤트 1 · 워커 결과 카운트 {completed 2 · error 0}. 이벤트를 워커 세션에서 돌리면(롤백이 워커 ORM 객체를 만료) 두 번째가
    in_progress로 영구 정체 — 이 테스트가 RED."""
    sends = _count_sends(monkeypatch)
    engine, Session = await _session_factory()
    try:
        ctx_fail = await _setup(Session)
        ctx_ok = await _setup(Session)
        _emit_raises_sql_error_for(monkeypatch, {ctx_fail["org_id"]})
        gate_fail, at_fail = await _approve_and_queue(Session, ctx_fail)
        gate_ok, at_ok = await _approve_and_queue(Session, ctx_ok)
        # story #4192(PO 13:29Z) — 실패하는 명령이 배치의 **첫째**여야 «둘째가 멈추지 않는다»를 잰다. 워커는 명령을
        # `created_at` 순으로 집는다(publication_command.process_due_publication_commands) — 그 순서를 전제로 박는다.
        async with Session() as s:
            from app.models.publication_command import PublicationCommand

            created = dict((await s.execute(
                select(PublicationCommand.gate_id, PublicationCommand.created_at)
                .where(PublicationCommand.gate_id.in_([gate_fail.id, gate_ok.id]))
            )).all())
        assert created[gate_fail.id] < created[gate_ok.id], created
        counts = await _run_worker(Session, max(at_fail, at_ok) + timedelta(minutes=2))
        assert counts["completed"] == 2 and counts["error"] == 0, counts
        assert await _command_status(Session, gate_fail.id) == "completed"
        assert await _command_status(Session, gate_ok.id) == "completed"
        assert await _stage_event_count(Session, ctx_fail, "check") == 0
        assert await _stage_event_count(Session, ctx_ok, "check") == 1
        assert len(sends) == 2, sends
        # 다음 틱 — 첫째의 발송 기록이 completed로 남았으니 재발송 0(새 세션 재조회로 확인).
        await _run_worker(Session, max(at_fail, at_ok) + timedelta(minutes=10))
        assert len(sends) == 2, sends
        assert await _command_status(Session, gate_fail.id) == "completed"
        assert await _command_status(Session, gate_ok.id) == "completed"
    finally:
        await engine.dispose()
