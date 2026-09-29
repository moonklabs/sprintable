"""story #3806(Phase3·3-2 PR4, 페드루 PO 確定 2026-09-11) — ads_boost paid 지출 수집
(+1d/+7d 스케줄링·source="paid" 분리·승인예산 대비 지출 API) 회귀. 세팅 헬퍼는
test_3806_ads_boost_execution.py/test_3806_ads_boost_worker.py 재사용(중복 재발명
금지) — 새 마이그 0건(InsightSnapshot 테이블 그대로 재사용, source는 원래도 free
Text라 스키마 변경 불요)."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from tests.test_3806_ads_boost_execution import _setup_approved_gate, _mark_command_status

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


async def _start_boost(session_maker, org_id, gate_id, owner_id):
    from app.services.ads_boost_execution import request_ads_boost_start
    from app.services.publication_command import process_due_publication_commands

    async with session_maker() as s:
        await request_ads_boost_start(s, org_id=org_id, gate_id=gate_id, requester_member_id=owner_id, initiated_by="human")
    async with session_maker() as s:
        counts = await process_due_publication_commands(s)
    assert counts["completed"] == 1, counts


async def _make_spend_snapshots_due(session, org_id, gate_id):
    """UNIQUE(publication_id, due_at) 위반 없이 두 행을 각자 다른 과거 시각으로
    민다(한 값으로 일괄 UPDATE하면 둘이 같은 due_at을 가져 그 제약을 위반한다)."""
    rows = await _get_spend_snapshots(session, org_id, gate_id)
    now = datetime.now(timezone.utc)
    for i, row in enumerate(rows):
        row.due_at = now - timedelta(minutes=len(rows) - i)
    await session.commit()


async def _get_spend_snapshots(session, org_id, gate_id):
    from app.models.gate import Gate
    from app.models.insight_snapshot import InsightSnapshot
    from sqlalchemy import select

    gate = (await session.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()
    rows = (await session.execute(
        select(InsightSnapshot).where(
            InsightSnapshot.publication_id == uuid.UUID(gate.scope_key),
            InsightSnapshot.channel == "ads_sandbox",
        ).order_by(InsightSnapshot.due_at.asc())
    )).scalars().all()
    return rows


@pytest.mark.anyio
async def test_boost_start_schedules_one_initial_spend_snapshot():
    """story #3809(Phase3·3-7 PR 4a, 페드루 PO 確定 2026-09-11 21:16Z) — 원래
    +1d·+7d 고정 2개(PR6)이던 최초 예약이 이제 **1개**(anchor+1d)뿐이다. 이후
    매 24h 반복은 캡처마다 `process_due_ads_spend_snapshots`가 스스로 이어
    예약한다(아래 테스트들)."""
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    engine, Session, org_id, project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    try:
        before = datetime.now(timezone.utc)
        await _start_boost(Session, org_id, gate_id, owner_id)

        async with Session() as s:
            rows = await _get_spend_snapshots(s, org_id, gate_id)
        assert len(rows) == 1, rows
        assert rows[0].status == "pending"
        # anchor(≈ 이 테스트 실행 시각)+1d — 정밀 초 단위는 비관심사, 대략
        # 22~26시간 범위로만 pin(테스트 실행 지연 여유).
        delta = rows[0].due_at - before
        assert timedelta(hours=22) < delta < timedelta(hours=26), delta
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_schedule_ads_spend_snapshots_is_idempotent():
    """멱등 — 같은 `anchor_at`으로 두 번 불러도(예: 겹친 tick·재시도) 행이
    1개만 남는다. 최초 예약·매 24h 반복 예약 둘 다 같은 ON CONFLICT DO
    NOTHING(uq_insight_snapshots_publication_due_at) 패턴을 공유하므로, 이
    최초 예약 하나로 그 공유 기전 자체를 검증한다."""
    from app.services.ads_spend_snapshots import schedule_ads_spend_snapshots
    from app.models.gate import Gate
    from sqlalchemy import select
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    engine, Session, org_id, project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    try:
        async with Session() as s:
            gate = (await s.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()
            publication_id = uuid.UUID(gate.scope_key)
            work_item_id = gate.work_item_id
        anchor_at = datetime.now(timezone.utc)

        async with Session() as s:
            await schedule_ads_spend_snapshots(
                s, org_id=org_id, work_item_id=work_item_id, publication_id=publication_id,
                channel="ads_sandbox", anchor_at=anchor_at,
            )
            await s.commit()
        async with Session() as s:
            await schedule_ads_spend_snapshots(
                s, org_id=org_id, work_item_id=work_item_id, publication_id=publication_id,
                channel="ads_sandbox", anchor_at=anchor_at,
            )
            await s.commit()

        async with Session() as s:
            rows = await _get_spend_snapshots(s, org_id, gate_id)
        assert len(rows) == 1, rows
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_process_due_ads_spend_snapshots_captures_with_source_paid():
    from app.services.ads_spend_snapshots import process_due_ads_spend_snapshots
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    engine, Session, org_id, project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    try:
        await _start_boost(Session, org_id, gate_id, owner_id)

        async with Session() as s:
            await _make_spend_snapshots_due(s, org_id, gate_id)

        async with Session() as s:
            counts = await process_due_ads_spend_snapshots(s)
        assert counts["captured"] == 1, counts

        async with Session() as s:
            rows = await _get_spend_snapshots(s, org_id, gate_id)
        captured = [r for r in rows if r.status == "captured"]
        pending = [r for r in rows if r.status == "pending"]
        assert len(captured) == 1, rows
        assert captured[0].source == "paid"
        assert captured[0].normalized["spend"] == 12_345
        assert captured[0].normalized["impressions"] is None, "organic 지표는 미선언과 같은 null이어야 한다"
        # story #3809(PR 4a) — 예산 안 넘었고(기본 100,000) boost가 계속 running·
        # 종료일(+7일) 전이라 다음 캡처(+24h)가 그 자리서 이어 예약돼야 한다.
        assert len(pending) == 1, rows
        assert pending[0].due_at - captured[0].due_at == timedelta(hours=24)
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_capture_exceeding_budget_auto_pauses_and_stamps_cap_reached_at():
    """story #3806(Phase3·3-2 PR 11, 페드루 PO 確定 2026-09-11 16:20Z) — 「상한 내
    실행」의 실물. budget_minor=10_000(<sandbox 고정 12,345/스냅샷)로 봉인해 첫
    캡처만으로 이미 초과 — 그 tick 안에서 즉시 자동 중지 명령(scheduler 귀속)이
    나가고 `AdsBoostRun.cap_reached_at`이 찍히는지 확認.

    story #3809(PR 4a 정정) — 최초 예약이 이제 1개뿐이라(위 테스트들) "두 스냅샷이
    같은 tick에서 처리돼도"는 더 이상 이 시나리오의 재현 경로가 아니다 — 첫 캡처
    «하나»만으로 이미 상한을 넘긴다. 대신 이 PR의 새 불변식을 함께 pin한다: 상한
    도달(cap_reached_at 설정) 후엔 다음 캡처를 이어 예약하지 않는다(멈출 boost를
    위해 미래 캡처를 만드는 건 낭비 — PO "중지 뒤 예약 0").
    뮤테이션 대상: `process_due_ads_spend_snapshots`가 캡처 후 `_enforce_spend_cap`을
    안 부르면(또는 그 함수가 `run.cap_reached_at`을 안 찍으면) 아래 단언들이 실패한다."""
    from app.models.ads_boost_run import AdsBoostRun
    from app.models.publication_command import PublicationCommand
    from app.services.ads_boost_execution import OP_PAUSE
    from app.services.ads_spend_snapshots import process_due_ads_spend_snapshots
    from sqlalchemy import select
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    engine, Session, org_id, project_id, owner_id, gate_id = await _setup_approved_gate(
        await _session_factory(), budget_minor=10_000,
    )
    try:
        await _start_boost(Session, org_id, gate_id, owner_id)

        async with Session() as s:
            await _make_spend_snapshots_due(s, org_id, gate_id)

        async with Session() as s:
            counts = await process_due_ads_spend_snapshots(s)
        assert counts["captured"] == 1, counts
        assert counts["capped"] == 1, counts

        async with Session() as s:
            run = (await s.execute(select(AdsBoostRun).where(AdsBoostRun.gate_id == gate_id))).scalar_one()
            assert run.cap_reached_at is not None

            pause_cmd = (await s.execute(
                select(PublicationCommand).where(
                    PublicationCommand.gate_id == gate_id, PublicationCommand.operation == OP_PAUSE,
                )
            )).scalar_one_or_none()
        assert pause_cmd is not None, "상한 도달 시 자동 중지 명령이 생성돼야 한다"
        assert pause_cmd.initiated_by == "scheduler"

        async with Session() as s:
            rows = await _get_spend_snapshots(s, org_id, gate_id)
        assert len(rows) == 1, "상한 도달 뒤엔 다음 캡처를 이어 예약하지 않아야 한다(PO: 중지 뒤 예약 0)"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_capture_within_budget_does_not_trigger_cap():
    """budget_minor=100_000(기본, 단일 캡처 12,345 < 100,000)이면 상한 미도달 —
    cap_reached_at·자동중지 둘 다 없어야 한다(지어낸 조기종료 금지)."""
    from app.models.ads_boost_run import AdsBoostRun
    from app.models.publication_command import PublicationCommand
    from app.services.ads_boost_execution import OP_PAUSE
    from app.services.ads_spend_snapshots import process_due_ads_spend_snapshots
    from sqlalchemy import select
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    engine, Session, org_id, project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    try:
        await _start_boost(Session, org_id, gate_id, owner_id)

        async with Session() as s:
            await _make_spend_snapshots_due(s, org_id, gate_id)

        async with Session() as s:
            counts = await process_due_ads_spend_snapshots(s)
        assert counts["captured"] == 1, counts
        assert counts["capped"] == 0, counts

        async with Session() as s:
            run = (await s.execute(select(AdsBoostRun).where(AdsBoostRun.gate_id == gate_id))).scalar_one()
            assert run.cap_reached_at is None

            pause_cmd = (await s.execute(
                select(PublicationCommand).where(
                    PublicationCommand.gate_id == gate_id, PublicationCommand.operation == OP_PAUSE,
                )
            )).scalar_one_or_none()
        assert pause_cmd is None
    finally:
        await engine.dispose()


def _spy_notifications(monkeypatch):
    """story #4417 — the «boost paused» notices, as the dispatch receives them."""
    import app.services.notification_dispatch as nd

    sent: list[dict] = []

    async def spy(db, **kwargs):
        if kwargs.get("event_type") == "ads_boost_spend_unreadable":  # not the gate's own approval notices
            sent.append(kwargs)
        return len(kwargs.get("target_member_ids") or [])  # like the real dispatch: how many got a notice

    monkeypatch.setattr(nd, "dispatch_notification", spy)
    return sent


async def _pause_commands(Session, gate_id):
    from app.models.publication_command import PublicationCommand
    from app.services.ads_boost_execution import OP_PAUSE
    from sqlalchemy import select

    async with Session() as s:
        return (await s.execute(
            select(PublicationCommand).where(PublicationCommand.gate_id == gate_id, PublicationCommand.operation == OP_PAUSE)
        )).scalars().all()


async def _run_row(Session, gate_id):
    from app.models.ads_boost_run import AdsBoostRun
    from sqlalchemy import select

    async with Session() as s:
        return (await s.execute(select(AdsBoostRun).where(AdsBoostRun.gate_id == gate_id))).scalar_one()


@pytest.mark.anyio
async def test_a_spend_in_a_currency_we_cannot_convert_stops_the_boost_and_says_why(monkeypatch):
    """story #4417 (Qadir 01a0eb3b ① · PO 03:49Z) — a sealed currency outside the table (a row sealed before the request refused
    it): the spend can't be checked against the budget. The capture fails with the code, the run is marked
    (`spend_blocked_*`), the scheduler pauses it (like the cap), the people on the boost are told once, no capture is scheduled
    again — and resuming is refused (it would spend with no cap). The budget (10,000 < the sandbox's 12,345) is not what
    stops it: no `cap_reached_at`."""
    from app.models.gate import Gate
    from app.services.ads_boost_execution import AdsBoostSpendBlockedError, request_ads_boost_resume
    from app.services.ads_spend_snapshots import process_due_ads_spend_snapshots
    from sqlalchemy import select
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    sent = _spy_notifications(monkeypatch)
    engine, Session, org_id, project_id, owner_id, gate_id = await _setup_approved_gate(
        await _session_factory(), budget_minor=10_000,
    )
    try:
        await _start_boost(Session, org_id, gate_id, owner_id)
        async with Session() as s:
            gate = (await s.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()
            gate.sealed_ads_currency = "JPY"
            await s.commit()
        async with Session() as s:
            await _make_spend_snapshots_due(s, org_id, gate_id)

        async with Session() as s:
            counts = await process_due_ads_spend_snapshots(s)
        assert counts["failed"] == 1 and counts["captured"] == 0 and counts["capped"] == 0, counts

        async with Session() as s:
            rows = await _get_spend_snapshots(s, org_id, gate_id)
        # no spend read again — only one follow-up capture that makes sure the pause takes effect (Qadir 01a0eb71 B)
        assert [(r.status, r.error_code) for r in rows] == [("failed", "META_ADS_SPEND_UNKNOWN_CURRENCY"), ("pending", None)]
        run = await _run_row(Session, gate_id)
        assert run.spend_blocked_at is not None and run.spend_blocked_code == "META_ADS_SPEND_UNKNOWN_CURRENCY"
        assert run.cap_reached_at is None
        pauses = await _pause_commands(Session, gate_id)
        assert [(c.initiated_by, c.status) for c in pauses] == [("scheduler", "pending")]
        assert [(n["event_type"], n["reference_type"], n["reference_id"]) for n in sent] == [
            ("ads_boost_spend_unreadable", "gate", gate_id),
        ]
        assert owner_id in sent[0]["target_member_ids"]
        # the pause is requested, not in effect yet: the notice says «pausing», never «paused» (Yuna 5884175792)
        assert "멈췄어요" not in sent[0]["title"] + sent[0]["body"]
        assert "멈추고 있어요" in sent[0]["body"]

        # the same capture again (a second worker tick) marks nothing twice and notifies once
        async with Session() as s:
            assert (await process_due_ads_spend_snapshots(s))["failed"] == 0

        from app.services.publication_command import process_due_publication_commands

        async with Session() as s:
            await process_due_publication_commands(s)  # the scheduler's pause runs
        async with Session() as s:
            with pytest.raises(AdsBoostSpendBlockedError):
                await request_ads_boost_resume(s, org_id=org_id, gate_id=gate_id, requester_member_id=owner_id)
        assert len(sent) == 1
    finally:
        await engine.dispose()


async def _failing_read(monkeypatch, exc):
    import app.services.ads_sandbox_campaign as sandbox

    async def fail(client, **kwargs):
        raise exc

    monkeypatch.setattr(sandbox, "get_campaign_spend_minor", fail)


@pytest.mark.anyio
@pytest.mark.parametrize("error", ["provider", "unexpected"])
async def test_a_failed_spend_read_closes_the_capture_and_tries_again_later(monkeypatch, error):
    """story #4417 (Qadir 01a0eb3b ③) — before: the capture stayed in_progress and nothing was scheduled again, so the cap was
    never checked for this boost again. Now the capture is closed (failed, with the code) and a retry is scheduled (1h); the
    boost keeps running (one failed read is not a stop)."""
    from app.services.ads_spend_snapshots import process_due_ads_spend_snapshots
    from app.services.meta_ads_campaign import MetaAdsCampaignError
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    sent = _spy_notifications(monkeypatch)
    engine, Session, org_id, project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    try:
        await _start_boost(Session, org_id, gate_id, owner_id)
        async with Session() as s:
            await _make_spend_snapshots_due(s, org_id, gate_id)
        await _failing_read(
            monkeypatch,
            MetaAdsCampaignError("META_ADS_SPEND_FETCH_FAILED", "503") if error == "provider" else RuntimeError("boom"),
        )
        before = datetime.now(timezone.utc)
        async with Session() as s:
            await process_due_ads_spend_snapshots(s)

        async with Session() as s:
            rows = await _get_spend_snapshots(s, org_id, gate_id)
        code = "META_ADS_SPEND_FETCH_FAILED" if error == "provider" else "ADS_SPEND_CAPTURE_ERROR"
        assert [(r.status, r.error_code) for r in rows] == [("failed", code), ("pending", None)]
        assert timedelta(minutes=55) < rows[1].due_at - before < timedelta(minutes=65)
        run = await _run_row(Session, gate_id)
        assert run.spend_blocked_at is None and run.status == "running"
        assert await _pause_commands(Session, gate_id) == [] and sent == []
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_three_failed_spend_reads_in_a_row_stop_the_boost(monkeypatch):
    """story #4417 (Qadir 01a0eb3b ③) — the retries don't go on forever with no cap: the third failure in a row stops the boost
    like an unreadable currency (scheduler pause · marked · notified)."""
    from app.services.ads_spend_snapshots import (
        SPEND_READ_FAILED_REPEATEDLY_CODE,
        SPEND_READ_FAILURES_BEFORE_STOP,
        process_due_ads_spend_snapshots,
    )
    from app.services.meta_ads_campaign import MetaAdsCampaignError
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    sent = _spy_notifications(monkeypatch)
    engine, Session, org_id, project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    try:
        await _start_boost(Session, org_id, gate_id, owner_id)
        await _failing_read(monkeypatch, MetaAdsCampaignError("META_ADS_SPEND_FETCH_FAILED", "503"))
        for round_ in range(SPEND_READ_FAILURES_BEFORE_STOP):
            async with Session() as s:
                pending = [r for r in await _get_spend_snapshots(s, org_id, gate_id) if r.status == "pending"]
                assert len(pending) == 1, (round_, pending)
                pending[0].due_at = datetime.now(timezone.utc) - timedelta(minutes=1)
                await s.commit()
            async with Session() as s:
                await process_due_ads_spend_snapshots(s)
            blocked = (await _run_row(Session, gate_id)).spend_blocked_at is not None
            assert blocked == (round_ == SPEND_READ_FAILURES_BEFORE_STOP - 1), round_

        run = await _run_row(Session, gate_id)
        assert run.spend_blocked_code == SPEND_READ_FAILED_REPEATEDLY_CODE
        async with Session() as s:
            rows = await _get_spend_snapshots(s, org_id, gate_id)
        # no read after the stop — one follow-up capture until the pause is in effect (Qadir 01a0eb71 B)
        assert [r.status for r in rows] == ["failed"] * SPEND_READ_FAILURES_BEFORE_STOP + ["pending"]
        assert [(c.initiated_by, c.status) for c in await _pause_commands(Session, gate_id)] == [("scheduler", "pending")]
        assert [n["event_type"] for n in sent] == ["ads_boost_spend_unreadable"]
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_a_person_s_refresh_that_reads_another_currency_stops_the_boost_too(monkeypatch):
    """story #4417 — «collect again» takes the same stop as the worker when the spend is in a currency it can't convert."""
    from app.models.gate import Gate
    from app.services.ads_spend_snapshots import refresh_ads_boost_spend_now
    from app.services.meta_ads_campaign import MetaAdsCampaignError
    from sqlalchemy import select
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    sent = _spy_notifications(monkeypatch)
    engine, Session, org_id, project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    try:
        await _start_boost(Session, org_id, gate_id, owner_id)
        async with Session() as s:
            gate = (await s.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()
            gate.sealed_ads_currency = "JPY"
            await s.commit()
        async with Session() as s:
            with pytest.raises(MetaAdsCampaignError):
                await refresh_ads_boost_spend_now(s, org_id=org_id, gate_id=gate_id, requester_member_id=owner_id)
        run = await _run_row(Session, gate_id)
        assert run.spend_blocked_code == "META_ADS_SPEND_UNKNOWN_CURRENCY"
        assert [(c.initiated_by, c.status) for c in await _pause_commands(Session, gate_id)] == [("scheduler", "pending")]
        assert len(sent) == 1
    finally:
        await engine.dispose()


async def _pending_count(Session, org_id, gate_id):
    async with Session() as s:
        return len([r for r in await _get_spend_snapshots(s, org_id, gate_id) if r.status == "pending"])


async def _break(Session, gate_id, how, monkeypatch):
    """Put the boost in one of the worker's failure branches (story #4417 · Qadir 01a0eb71)."""
    from app.models.ads_boost_run import AdsBoostRun
    from app.models.gate import Gate
    from app.services.meta_ads_campaign import MetaAdsCampaignError
    from sqlalchemy import select

    async with Session() as s:
        gate = (await s.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()
        run = (await s.execute(select(AdsBoostRun).where(AdsBoostRun.gate_id == gate_id))).scalar_one()
        if how == "currency":
            gate.sealed_ads_currency = "JPY"
        elif how == "not_started":
            run.campaign_id = None
        elif how == "connection_missing":
            gate.sealed_ads_connection_id = uuid.uuid4()
        await s.commit()
    if how == "provider_error":
        await _failing_read(monkeypatch, MetaAdsCampaignError("META_ADS_SPEND_FETCH_FAILED", "503"))
    elif how == "unexpected":
        await _failing_read(monkeypatch, RuntimeError("boom"))


@pytest.mark.anyio
@pytest.mark.parametrize("how", ["currency", "provider_error", "unexpected", "not_started", "connection_missing"])
async def test_every_failure_branch_of_the_worker_either_retries_or_blocks_and_tells(monkeypatch, how):
    """story #4417 (Qadir 01a0eb71 A · PO) — the class: whatever branch a capture fails in, afterwards there is a capture
    scheduled again, or the run is marked and the people on it were told. A new branch that does neither turns this red."""
    from app.services.ads_spend_snapshots import process_due_ads_spend_snapshots
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    sent = _spy_notifications(monkeypatch)
    engine, Session, org_id, project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    try:
        await _start_boost(Session, org_id, gate_id, owner_id)
        async with Session() as s:
            await _make_spend_snapshots_due(s, org_id, gate_id)
        await _break(Session, gate_id, how, monkeypatch)
        async with Session() as s:
            await process_due_ads_spend_snapshots(s)

        run = await _run_row(Session, gate_id)
        retried = await _pending_count(Session, org_id, gate_id) > 0
        blocked_and_told = run.spend_blocked_at is not None and run.spend_blocked_notified_at is not None and len(sent) == 1
        assert retried or blocked_and_told, (how, run.spend_blocked_code, sent)
        if how == "connection_missing":
            assert run.spend_blocked_code == "ADS_SPEND_CONTEXT_LOST"
            assert "광고 관리자에서 직접 멈춰" in sent[0]["body"]  # we can't pause it ourselves
            assert sent[0]["title"] == "광고 관리자에서 홍보를 직접 멈춰 주세요"  # not «we paused it» (Yuna 5884175792)
            assert "광고비가 계속 나갈 수 있어요" in sent[0]["body"]
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_a_capture_whose_gate_is_gone_is_logged_as_the_one_orphan_branch(monkeypatch, caplog):
    """story #4417 — the only branch with nothing to retry or block: the gate behind the capture no longer exists (no boost to
    pause or show). It is closed and logged as an orphan, not silent."""
    import logging

    from app.models.gate import Gate
    from app.services.ads_spend_snapshots import process_due_ads_spend_snapshots
    from sqlalchemy import select
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    engine, Session, org_id, project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    try:
        await _start_boost(Session, org_id, gate_id, owner_id)
        async with Session() as s:
            await _make_spend_snapshots_due(s, org_id, gate_id)
            gate = (await s.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()
            real_scope = gate.scope_key
            gate.scope_key = str(uuid.uuid4())
            await s.commit()
        caplog.set_level(logging.ERROR, logger="app.services.ads_spend_snapshots")
        async with Session() as s:
            counts = await process_due_ads_spend_snapshots(s)
        assert counts["failed"] == 1
        assert [r for r in caplog.records if "ads_spend_capture_orphan" in r.getMessage()]
        async with Session() as s:
            gate = (await s.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()
            gate.scope_key = real_scope
            await s.commit()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_a_pause_or_notice_that_failed_is_tried_again_on_the_next_tick_and_the_notice_goes_once(monkeypatch):
    """story #4417 (Qadir 01a0eb71 B) — before: the mark was committed, a failed pause was swallowed and the next capture
    returned early. Now a follow-up capture retries whatever is still owed: the pause, and a notice that failed."""
    import app.services.ads_boost_execution as execution
    import app.services.notification_dispatch as nd
    from app.services.ads_spend_snapshots import process_due_ads_spend_snapshots
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    sent: list[dict] = []
    attempts = {"pause": 0, "notice": 0}

    async def notice(db, **kwargs):
        if kwargs.get("event_type") != "ads_boost_spend_unreadable":
            return
        attempts["notice"] += 1
        if attempts["notice"] == 1:
            raise RuntimeError("push down")
        sent.append(kwargs)
        return 1

    monkeypatch.setattr(nd, "dispatch_notification", notice)
    real_pause = execution.request_ads_boost_pause

    async def flaky_pause(*args, **kwargs):
        attempts["pause"] += 1
        if attempts["pause"] == 1:
            raise RuntimeError("db hiccup")
        return await real_pause(*args, **kwargs)

    monkeypatch.setattr(execution, "request_ads_boost_pause", flaky_pause)
    engine, Session, org_id, project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    try:
        await _start_boost(Session, org_id, gate_id, owner_id)
        async with Session() as s:
            await _make_spend_snapshots_due(s, org_id, gate_id)
        await _break(Session, gate_id, "currency", monkeypatch)
        async with Session() as s:
            await process_due_ads_spend_snapshots(s)
        run = await _run_row(Session, gate_id)
        assert run.spend_blocked_at is not None and run.spend_blocked_notified_at is None
        assert await _pause_commands(Session, gate_id) == [] and sent == []
        assert await _pending_count(Session, org_id, gate_id) == 1  # the follow-up

        async with Session() as s:  # the follow-up is due
            pending = [r for r in await _get_spend_snapshots(s, org_id, gate_id) if r.status == "pending"][0]
            pending.due_at = datetime.now(timezone.utc) - timedelta(minutes=1)
            await s.commit()
        async with Session() as s:
            await process_due_ads_spend_snapshots(s)
        assert [(c.initiated_by, c.status) for c in await _pause_commands(Session, gate_id)] == [("scheduler", "pending")]
        assert len(sent) == 1
        assert (await _run_row(Session, gate_id)).spend_blocked_notified_at is not None

        # the pause is queued but not in effect yet: the next follow-up checks again — and does not tell anyone twice
        async with Session() as s:
            pending = [r for r in await _get_spend_snapshots(s, org_id, gate_id) if r.status == "pending"]
            assert len(pending) == 1
            pending[0].due_at = datetime.now(timezone.utc) - timedelta(minutes=1)
            await s.commit()
        async with Session() as s:
            await process_due_ads_spend_snapshots(s)
        assert len(sent) == 1
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_a_resume_queued_before_the_block_is_refused_when_it_runs(monkeypatch):
    """story #4417 (Qadir 01a0eb71 C) — the request-time check can't see a block that came later: the worker checks again."""
    from app.models.ads_boost_run import AdsBoostRun
    from app.models.publication_command import PublicationCommand
    from app.services.ads_boost_execution import OP_RESUME, request_ads_boost_pause, request_ads_boost_resume
    from app.services.publication_command import process_due_publication_commands
    from sqlalchemy import select
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    _spy_notifications(monkeypatch)
    engine, Session, org_id, project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    try:
        await _start_boost(Session, org_id, gate_id, owner_id)
        async with Session() as s:
            await request_ads_boost_pause(s, org_id=org_id, gate_id=gate_id, requester_member_id=owner_id)
        async with Session() as s:
            await process_due_publication_commands(s)
        async with Session() as s:
            await request_ads_boost_resume(s, org_id=org_id, gate_id=gate_id, requester_member_id=owner_id)
        async with Session() as s:  # the block lands while the resume waits in the queue
            run = (await s.execute(select(AdsBoostRun).where(AdsBoostRun.gate_id == gate_id))).scalar_one()
            run.spend_blocked_at = datetime.now(timezone.utc)
            run.spend_blocked_code = "META_ADS_SPEND_CURRENCY_MISMATCH"
            await s.commit()
        async with Session() as s:
            await process_due_publication_commands(s)
        async with Session() as s:
            resume = (await s.execute(select(PublicationCommand).where(
                PublicationCommand.gate_id == gate_id, PublicationCommand.operation == OP_RESUME,
            ))).scalar_one()
        assert (resume.status, resume.reason_code) == ("dead_letter", "ADS_BOOST_SPEND_BLOCKED")
        assert (await _run_row(Session, gate_id)).status == "paused"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_the_notice_says_paused_only_when_the_run_is_paused(monkeypatch):
    """story #4417 (Yuna 5884175792) — the notice's words follow the run's real state at the time it is sent."""
    from app.models.gate import Gate
    from app.services.ads_spend_snapshots import _notify_spend_blocked
    from sqlalchemy import select
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    sent = _spy_notifications(monkeypatch)
    engine, Session, org_id, project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    try:
        async with Session() as s:
            gate = (await s.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()
            for status in ("paused", "pause_pending", "running"):
                assert await _notify_spend_blocked(s, gate=gate, code="META_ADS_SPEND_CURRENCY_MISMATCH", run_status=status)
        said_paused = ["멈췄어요" in n["title"] + n["body"] for n in sent]
        assert said_paused == [True, False, False]
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_a_pause_that_ended_without_taking_effect_can_be_asked_again(monkeypatch):
    """story #4417 (Qadir 01a0eba4 ①) — a dead-lettered pause is not «already paused»: the scheduler's retry and a person's
    second press make a new command. A completed pause still is «already paused»."""
    from app.services.ads_boost_execution import AdsBoostAlreadyInStateError, OP_PAUSE, request_ads_boost_pause
    from app.services.publication_command import process_due_publication_commands
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    engine, Session, org_id, project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    try:
        await _start_boost(Session, org_id, gate_id, owner_id)
        async with Session() as s:
            first = await request_ads_boost_pause(s, org_id=org_id, gate_id=gate_id, requester_member_id=owner_id)
        async with Session() as s:
            await _mark_command_status(s, first.id, "dead_letter")  # Meta did not take the pause
        async with Session() as s:
            again = await request_ads_boost_pause(s, org_id=org_id, gate_id=gate_id, requester_member_id=owner_id)
        assert again.id != first.id and again.toggle_seq == first.toggle_seq + 1
        async with Session() as s:
            await process_due_publication_commands(s)  # this one lands
        async with Session() as s:
            with pytest.raises(AdsBoostAlreadyInStateError):
                await request_ads_boost_pause(s, org_id=org_id, gate_id=gate_id, requester_member_id=owner_id)
        assert [c.operation for c in await _pause_commands(Session, gate_id)] == [OP_PAUSE, OP_PAUSE]
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_a_cap_pause_that_failed_is_tried_again_on_a_follow_up_capture(monkeypatch):
    """story #4417 (Qadir 01a0eba4 ②) — the cap path takes the same «try again» as the block: before, the cap was stamped, the
    failed pause swallowed, and no capture followed."""
    import app.services.ads_boost_execution as execution
    from app.services.ads_spend_snapshots import process_due_ads_spend_snapshots
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    real_pause = execution.request_ads_boost_pause
    calls = {"n": 0}

    async def flaky_pause(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("db hiccup")
        return await real_pause(*args, **kwargs)

    monkeypatch.setattr(execution, "request_ads_boost_pause", flaky_pause)
    engine, Session, org_id, project_id, owner_id, gate_id = await _setup_approved_gate(
        await _session_factory(), budget_minor=10_000,  # below the sandbox's 12,345: the first capture reaches the cap
    )
    try:
        await _start_boost(Session, org_id, gate_id, owner_id)
        async with Session() as s:
            await _make_spend_snapshots_due(s, org_id, gate_id)
        async with Session() as s:
            await process_due_ads_spend_snapshots(s)
        assert (await _run_row(Session, gate_id)).cap_reached_at is not None
        assert await _pause_commands(Session, gate_id) == []
        assert await _pending_count(Session, org_id, gate_id) == 1  # the follow-up

        async with Session() as s:
            pending = [r for r in await _get_spend_snapshots(s, org_id, gate_id) if r.status == "pending"][0]
            pending.due_at = datetime.now(timezone.utc) - timedelta(minutes=1)
            await s.commit()
        async with Session() as s:
            await process_due_ads_spend_snapshots(s)
        assert [(c.initiated_by, c.status) for c in await _pause_commands(Session, gate_id)] == [("scheduler", "pending")]
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_the_notice_is_marked_sent_only_when_a_notice_was_created(monkeypatch):
    """story #4417 (Qadir 01a0eba4 ③) — the dispatch returns normally even when nobody got anything; «notified» is marked only
    when it created at least one notice, otherwise the next follow-up tries again."""
    import app.services.notification_dispatch as nd
    from app.services.ads_spend_snapshots import process_due_ads_spend_snapshots
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    created = {"n": 0}

    async def dispatch(db, **kwargs):
        if kwargs.get("event_type") != "ads_boost_spend_unreadable":
            return len(kwargs.get("target_member_ids") or [])
        created["n"] += 1
        return 0 if created["n"] == 1 else 1  # the first one reached nobody

    monkeypatch.setattr(nd, "dispatch_notification", dispatch)
    engine, Session, org_id, project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    try:
        await _start_boost(Session, org_id, gate_id, owner_id)
        async with Session() as s:
            await _make_spend_snapshots_due(s, org_id, gate_id)
        await _break(Session, gate_id, "currency", monkeypatch)
        async with Session() as s:
            await process_due_ads_spend_snapshots(s)
        assert (await _run_row(Session, gate_id)).spend_blocked_notified_at is None
        async with Session() as s:
            pending = [r for r in await _get_spend_snapshots(s, org_id, gate_id) if r.status == "pending"][0]
            pending.due_at = datetime.now(timezone.utc) - timedelta(minutes=1)
            await s.commit()
        async with Session() as s:
            await process_due_ads_spend_snapshots(s)
        assert (await _run_row(Session, gate_id)).spend_blocked_notified_at is not None
        assert created["n"] == 2
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_an_agent_reading_spend_finds_the_account_and_campaign_ids_nowhere_in_the_body(monkeypatch):
    """story #4417 (PO 05:35Z) — 4416 hides the ad account and campaign ids from agents (field by field). This checks the whole
    body, so a new field that carries them in another shape (the removed `ads_manager_url` did, as a URL) turns this red."""
    import json

    from app.main import app
    from app.models.ads_boost_run import AdsBoostRun
    from sqlalchemy import select
    from tests.test_3475_publishing_metrics import _client_for, _setup_org_scoped_app
    from tests.test_4416_spend_run_ad_fields_realdb import _set_ad_connection
    from tests.test_e4fc29fa_site_post_orchestration import _seed_agent, _session_factory

    _spy_notifications(monkeypatch)
    engine, Session, org_id, project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    try:
        await _start_boost(Session, org_id, gate_id, owner_id)
        await _set_ad_connection(Session, gate_id, account_id="9876543210", channel="meta_ads")
        async with Session() as s:
            run = (await s.execute(select(AdsBoostRun).where(AdsBoostRun.gate_id == gate_id))).scalar_one()
            campaign_id = run.campaign_id
            run.spend_blocked_at = datetime.now(timezone.utc)  # a blocked boost: the card state that shows the link to people
            run.spend_blocked_code = "META_ADS_SPEND_CURRENCY_MISMATCH"
            await s.commit()
            agent_id = await _seed_agent(s, org_id, project_id)
        _setup_org_scoped_app(app, Session, org_id, user_id=agent_id, agent=True)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_id}/ads-boosts/{gate_id}/spend")
        assert r.status_code == 200, r.text
        text = json.dumps(r.json())
        assert "9876543210" not in text and campaign_id not in text
        assert "adsmanager" not in text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_the_spend_summary_says_why_the_boost_stopped(monkeypatch):
    """story #4417 — the card reads `spend_blocked_code` (and hides «resume»)."""
    from app.main import app
    from app.models.gate import Gate
    from app.services.ads_spend_snapshots import process_due_ads_spend_snapshots
    from sqlalchemy import select
    from tests.test_3475_publishing_metrics import _client_for, _setup_org_scoped_app
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    _spy_notifications(monkeypatch)
    engine, Session, org_id, project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    try:
        await _start_boost(Session, org_id, gate_id, owner_id)
        async with Session() as s:
            gate = (await s.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()
            gate.sealed_ads_currency = "JPY"
            await s.commit()
        async with Session() as s:
            await _make_spend_snapshots_due(s, org_id, gate_id)
        async with Session() as s:
            await process_due_ads_spend_snapshots(s)

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            body = (await client.get(f"/api/v2/organizations/{org_id}/ads-boosts/{gate_id}/spend")).json()
            resume = await client.post(f"/api/v2/organizations/{org_id}/ads-boosts/{gate_id}/resume")
        assert body["spend_blocked_code"] == "META_ADS_SPEND_UNKNOWN_CURRENCY" and body["spend_blocked_at"]
        assert body["account_currency"] == "KRW"  # read before the start (the sandbox answers the sealed currency then)
        assert resume.status_code == 409 and resume.json()["error"]["code"] == "ADS_BOOST_SPEND_UNREADABLE"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_recurring_capture_continues_every_24h_until_boost_ends_at():
    """story #3809(Phase3·3-7 PR 4a, 페드루 PO 確定 2026-09-11 21:16Z) — 「2일
    boost=예약 2~3개」의 실물. `sealed_ads_ends_at`을 anchor+정확히 2일로 직접
    봉인해(경계 케이스 고정 목적, `_boost_body` 기본 7일과 별개) 매 24h 이어
    예약이 실제로 도는지·정확히 그 경계(끝나는 날 포함·그 다음날 제외)에서
    멈추는지 pin: anchor+1d(1번째)→anchor+2d(==ends_at, 포함되니 2번째)→
    anchor+3d는 ends_at을 넘어 스케줄 안 됨 — 정확히 2건.
    뮤테이션 대상: `process_due_ads_spend_snapshots`가 매 캡처 뒤 다음 예약을
    이어 만드는 블록을 걷으면 2번째 캡처(및 그 뒤 rows 단언)가 RED."""
    from app.models.ads_boost_run import AdsBoostRun
    from app.models.gate import Gate
    from app.services.ads_spend_snapshots import process_due_ads_spend_snapshots
    from sqlalchemy import select, update
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    engine, Session, org_id, project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    try:
        await _start_boost(Session, org_id, gate_id, owner_id)

        async with Session() as s:
            run = (await s.execute(select(AdsBoostRun).where(AdsBoostRun.gate_id == gate_id))).scalar_one()
            anchor_at = run.started_at
        ends_at = anchor_at + timedelta(days=2)
        async with Session() as s:
            await s.execute(update(Gate).where(Gate.id == gate_id).values(sealed_ads_ends_at=ends_at))
            await s.commit()

        # `_make_spend_snapshots_due`(due_at을 "지금"으로 되민다)는 여기 안 쓴다 —
        # 그 헬퍼로 매 회 되밀면 due_at 자체가 실제 달력일과 끊어져 anchor+24h
        # 누적 주기·ends_at 경계를 못 잰다. 대신 `process_due_ads_spend_snapshots
        # (now=...)`로 "가짜 현재 시각"을 실제 캘린더에 맞춰 한 걸음씩 전진시킨다
        # — due_at 원본은 앱 코드가 스스로 계산한 그대로 둔다.
        total_captured = 0
        for day_offset in (1, 2, 3):  # anchor+1d·+2d(==ends_at)·+3d(경계 밖 확認용).
            async with Session() as s:
                counts = await process_due_ads_spend_snapshots(
                    s, now=anchor_at + timedelta(days=day_offset, minutes=1),
                )
            total_captured += counts["captured"]

        assert total_captured == 2, total_captured
        async with Session() as s:
            rows = await _get_spend_snapshots(s, org_id, gate_id)
        assert len(rows) == 2, rows
        assert all(r.status == "captured" for r in rows)
        assert rows[1].due_at - rows[0].due_at == timedelta(hours=24)
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_pause_after_capture_stops_further_scheduling():
    """PO "중지 뒤 예약 0" — 이미 예약된 다음 캡처(사람이 중지하기 전에 만들어진
    것)는 due가 되면 그대로 실행되지만(마지막 관측치는 정직하게 남긴다), 그
    실행 시점에 run이 이미 paused라면 «그 다음» 캡처는 이어 예약하지 않는다."""
    from app.models.ads_boost_run import AdsBoostRun
    from app.services.ads_boost_execution import request_ads_boost_pause
    from app.services.ads_spend_snapshots import process_due_ads_spend_snapshots
    from app.services.publication_command import process_due_publication_commands
    from sqlalchemy import select
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    engine, Session, org_id, project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    try:
        await _start_boost(Session, org_id, gate_id, owner_id)

        async with Session() as s:
            await _make_spend_snapshots_due(s, org_id, gate_id)
        async with Session() as s:
            counts = await process_due_ads_spend_snapshots(s)
        assert counts["captured"] == 1, counts

        async with Session() as s:
            rows = await _get_spend_snapshots(s, org_id, gate_id)
        assert len(rows) == 2, rows  # 1 captured + 1 pending(다음 예약).

        async with Session() as s:
            await request_ads_boost_pause(s, org_id=org_id, gate_id=gate_id, requester_member_id=owner_id)
        async with Session() as s:
            pause_counts = await process_due_publication_commands(s)
        assert pause_counts["completed"] == 1, pause_counts
        async with Session() as s:
            run = (await s.execute(select(AdsBoostRun).where(AdsBoostRun.gate_id == gate_id))).scalar_one()
            assert run.status == "paused"

        # 이미 예약돼 있던 다음 캡처(pending 1건)를 강제로 due시켜 실행 — 캡처는
        # 되지만(paused 순간까지의 마지막 관측치), 이 시점 run이 paused이므로
        # «그 다음» 캡처는 이어 예약되면 안 된다.
        async with Session() as s:
            await _make_spend_snapshots_due(s, org_id, gate_id)
        async with Session() as s:
            counts2 = await process_due_ads_spend_snapshots(s)
        assert counts2["captured"] == 1, counts2

        async with Session() as s:
            rows = await _get_spend_snapshots(s, org_id, gate_id)
        assert len(rows) == 2, "중지된 뒤엔 새 예약이 생기면 안 된다(PO: 중지 뒤 예약 0)"
        assert all(r.status == "captured" for r in rows)
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_resume_after_chain_exhausted_reschedules_next_capture():
    """story #3809(Phase3·3-7 PR 4a 정정, 카디르 QA 실측 2026-09-11 21:47Z) —
    pause로 이어 예약 체인이 소진(pending 0)된 뒤 resume해도 재예약이 영원히
    0이던 결함(schedule_ads_spend_snapshots 호출부가 boost_start 1곳뿐)의
    실물 재현+처방 확認. 위 test_pause_after_capture_stops_further_scheduling
    과 동형으로 체인을 소진시킨 뒤, resume이 재예약을 살리고, 두 번째
    pause→resume(체인이 이미 살아 있는 채)에서는 여벌을 더 얹지 않는지(정확히
    1건 유지)까지 pin.
    뮤테이션 대상: resume 분기의 재예약 호출을 걷으면 resume 뒤 pending이
    여전히 0이라 아래 첫 단언이 RED."""
    from app.models.ads_boost_run import AdsBoostRun
    from app.services.ads_boost_execution import request_ads_boost_pause, request_ads_boost_resume
    from app.services.ads_spend_snapshots import process_due_ads_spend_snapshots
    from app.services.publication_command import process_due_publication_commands
    from sqlalchemy import select
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    engine, Session, org_id, project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    try:
        await _start_boost(Session, org_id, gate_id, owner_id)

        # 체인 소진 — 1번째 캡처 처리 후 곧바로 중지, 그 다음 예약(pending 1건)도
        # 강제로 due시켜 처리해 pending을 0으로 만든다(위 테스트와 동형 절차).
        async with Session() as s:
            await _make_spend_snapshots_due(s, org_id, gate_id)
        async with Session() as s:
            await process_due_ads_spend_snapshots(s)

        async with Session() as s:
            await request_ads_boost_pause(s, org_id=org_id, gate_id=gate_id, requester_member_id=owner_id)
        async with Session() as s:
            assert (await process_due_publication_commands(s))["completed"] == 1

        async with Session() as s:
            await _make_spend_snapshots_due(s, org_id, gate_id)
        async with Session() as s:
            await process_due_ads_spend_snapshots(s)

        async with Session() as s:
            rows = await _get_spend_snapshots(s, org_id, gate_id)
        assert len(rows) == 2 and all(r.status == "captured" for r in rows), rows  # 체인 소진(pending 0) 확認.

        # resume — 소진된 체인이 다시 열려야 한다(pending 정확히 1).
        async with Session() as s:
            await request_ads_boost_resume(s, org_id=org_id, gate_id=gate_id, requester_member_id=owner_id)
        async with Session() as s:
            assert (await process_due_publication_commands(s))["completed"] == 1
        async with Session() as s:
            run = (await s.execute(select(AdsBoostRun).where(AdsBoostRun.gate_id == gate_id))).scalar_one()
            assert run.status == "running"
            rows = await _get_spend_snapshots(s, org_id, gate_id)
        pending = [r for r in rows if r.status == "pending"]
        assert len(pending) == 1, "resume 뒤 체인이 재예약돼야 한다(PO 처방)"

        # 두 번째 pause→resume 사이클 — 이번엔 체인이 이미 살아 있으므로(pending
        # 1건) resume이 여벌을 더 얹으면 안 된다(정확히 1건 유지).
        async with Session() as s:
            await request_ads_boost_pause(s, org_id=org_id, gate_id=gate_id, requester_member_id=owner_id)
        async with Session() as s:
            assert (await process_due_publication_commands(s))["completed"] == 1
        async with Session() as s:
            await request_ads_boost_resume(s, org_id=org_id, gate_id=gate_id, requester_member_id=owner_id)
        async with Session() as s:
            assert (await process_due_publication_commands(s))["completed"] == 1

        async with Session() as s:
            rows = await _get_spend_snapshots(s, org_id, gate_id)
        pending = [r for r in rows if r.status == "pending"]
        assert len(pending) == 1, "이미 pending이 있으면 resume이 여벌을 더 얹으면 안 된다"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_spend_endpoint_serializes_cap_reached_at():
    """§7 실측 열 「상한 초과 0건」의 장치 — /spend 응답 직렬화 확認(PR8이 겪은
    "컬럼은 있는데 응답엔 없다" 클래스 재발 방지, 이번엔 자체 pin)."""
    from app.main import app
    from app.services.ads_spend_snapshots import process_due_ads_spend_snapshots
    from tests.test_3475_publishing_metrics import _client_for, _setup_org_scoped_app
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    engine, Session, org_id, project_id, owner_id, gate_id = await _setup_approved_gate(
        await _session_factory(), budget_minor=10_000,
    )
    try:
        await _start_boost(Session, org_id, gate_id, owner_id)
        async with Session() as s:
            await _make_spend_snapshots_due(s, org_id, gate_id)
        async with Session() as s:
            await process_due_ads_spend_snapshots(s)

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_id}/ads-boosts/{gate_id}/spend")
        assert r.status_code == 200, r.text
        assert r.json()["cap_reached_at"] is not None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_organic_loop_skips_paid_channel_snapshots():
    """process_due_insight_snapshots(organic 루프)가 paid 채널 행을 안 건드려야
    한다 — 안 그러면 insight_metrics=() 게이트에 걸려 즉시 'unsupported'로
    오염된다(두 워커 경합 방지의 핵심 pin)."""
    from app.services.insight_snapshots import process_due_insight_snapshots
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    engine, Session, org_id, project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    try:
        await _start_boost(Session, org_id, gate_id, owner_id)

        async with Session() as s:
            await _make_spend_snapshots_due(s, org_id, gate_id)

        async with Session() as s:
            counts = await process_due_insight_snapshots(s)
        assert counts == {
            "captured": 0, "unsupported": 0, "failed": 0, "pending_retry": 0, "error": 0, "skipped": 0,
        }, counts

        async with Session() as s:
            rows = await _get_spend_snapshots(s, org_id, gate_id)
        assert all(r.status == "pending" for r in rows), "organic 루프가 paid 행을 건드리면 안 된다"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_spend_endpoint_returns_budget_and_captured_sum():
    from app.main import app
    from app.services.ads_spend_snapshots import process_due_ads_spend_snapshots
    from tests.test_3475_publishing_metrics import _client_for, _setup_org_scoped_app
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    engine, Session, org_id, project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    try:
        await _start_boost(Session, org_id, gate_id, owner_id)
        async with Session() as s:
            await _make_spend_snapshots_due(s, org_id, gate_id)
        async with Session() as s:
            await process_due_ads_spend_snapshots(s)

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_id}/ads-boosts/{gate_id}/spend")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["sealed_ads_budget_minor"] == 100_000
        assert body["captured_spend_minor"] == 12_345
        assert body["remaining_minor"] == 100_000 - 12_345
        # story #3809(PR 4a) — `snapshots`는 `source=="paid"`(캡처 성공 시에만
        # 찍히는 값, pending 행은 source 자체가 아직 null)만 걸러 낸다 — 다음
        # 예약(pending)은 애초 이 목록에 안 잡힌다(get_ads_boost_spend_summary
        # 쿼리 그대로), 그래서 캡처 1건이면 1행.
        assert len(body["snapshots"]) == 1
        assert body["snapshots"][0]["spend_minor"] == 12_345
        # story #3806(PR5, 3자기점검) — pause/resume UI가 「실행 중」을 그릴 근거.
        assert body["run_status"] == "running"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_spend_endpoint_serializes_initiated_by_scheduler():
    """story #3806(Phase3·3-2 PR 8, 페드루 PO 確定 2026-09-11) — 「게이트 상세 등
    명령을 돌려주는 GET 전부」축. scheduler 경로(`process_due_ads_boost_starts`)는
    `/start`를 절대 안 거치므로(사람 클릭 0) `CommandResponse` 직렬화만으론
    이 값을 절대 못 본다 — /spend가 이 gate의 유일한 GET 관측 자리(run_status와
    동형 판단, 이 파일 상단 서비스 docstring). 뮤테이션 대상: `get_ads_boost_
    spend_summary`가 `initiated_by` 키를 안 넣거나 `_get_ads_boost_spend_endpoint`가
    그걸 응답에 안 실으면 이 단언이 실패한다."""
    from app.main import app
    from app.services.ads_boost_execution import process_due_ads_boost_starts
    from tests.test_3475_publishing_metrics import _client_for, _setup_org_scoped_app
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    engine, Session, org_id, project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    try:
        # starts_at을 「이미 도래」로 직접 봉인해 스케줄러 픽업 대상으로 만든다
        # (test_3806_ads_boost_starts_worker.py::_setup_gate와 동형 조작 — 이
        # 파일은 그 헬퍼를 안 쓰므로 Gate 컬럼을 직접 민다).
        from datetime import datetime, timedelta, timezone

        from app.models.gate import Gate
        from sqlalchemy import update

        async with Session() as s:
            await s.execute(
                update(Gate).where(Gate.id == gate_id).values(
                    sealed_ads_starts_at=datetime.now(timezone.utc) - timedelta(hours=1),
                )
            )
            await s.commit()

        async with Session() as s:
            counts = await process_due_ads_boost_starts(s)
        assert counts["started"] == 1, counts

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_id}/ads-boosts/{gate_id}/spend")
        assert r.status_code == 200, r.text
        assert r.json()["initiated_by"] == "scheduler"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_spend_endpoint_run_status_null_before_boost_started():
    """gate는 approved인데 boost_start를 아직 요청 안 한 상태(AdsBoostRun 행 자체가
    없음) — run_status는 "미실행"을 뜻하는 None이지 "pending" 등 지어낸 값이 아니다."""
    from app.main import app
    from tests.test_3475_publishing_metrics import _client_for, _setup_org_scoped_app
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    engine, Session, org_id, project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    try:
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_id}/ads-boosts/{gate_id}/spend")
        assert r.status_code == 200, r.text
        assert r.json()["run_status"] is None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_spend_endpoint_unknown_gate_returns_404():
    from app.main import app
    from tests.test_3475_publishing_metrics import _client_for, _setup_org_scoped_app
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    engine, Session, org_id, project_id, owner_id, _gate_id = await _setup_approved_gate(await _session_factory())
    try:
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_id}/ads-boosts/{uuid.uuid4()}/spend")
        assert r.status_code == 404, r.text
        assert r.json()["error"]["code"] == "ADS_BOOST_GATE_NOT_FOUND"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_spend_fetch_fails_gracefully_without_run():
    """boost_start를 아예 안 돌린(run.campaign_id 없음) 상태에서 스냅샷이 존재하면
    (정상 흐름에선 스케줄링 자체가 boost_start 성공 뒤에만 일어나 도달 불가 — 방어
    로직 자체의 견고성만 직접 확인, 워커 테스트의 같은 클래스 방어 표본과 동형)."""
    from app.models.gate import Gate
    from app.models.insight_snapshot import InsightSnapshot
    from app.services.ads_spend_snapshots import process_due_ads_spend_snapshots
    from sqlalchemy import select
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    engine, Session, org_id, project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    try:
        async with Session() as s:
            gate = (await s.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()
            snap = InsightSnapshot(
                id=uuid.uuid4(), org_id=org_id, work_item_id=gate.work_item_id,
                publication_id=uuid.UUID(gate.scope_key), publication_kind="channel_publication",
                channel="ads_sandbox", due_at=datetime.now(timezone.utc) - timedelta(minutes=1), status="pending",
            )
            s.add(snap)
            await s.commit()

        async with Session() as s:
            counts = await process_due_ads_spend_snapshots(s)
        assert counts["failed"] == 1, counts

        async with Session() as s:
            row = (await s.execute(select(InsightSnapshot).where(InsightSnapshot.id == snap.id))).scalar_one()
            assert row.status == "failed"
            assert row.error_code == "ADS_SPEND_NOT_STARTED"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_organic_insights_list_endpoint_excludes_paid_rows():
    """페드루 PO 確定(2026-09-11, 판단 콜② 답) — 기존 GET .../insights(organic 조회
    축)가 paid 행을 섞어 돌려주면 실측 결함(offset_label이 boost 시작 시각 anchor를
    publish 시각 기준으로 잘못 대조할 수 있고, 이 엔드포인트의 계약 자체가 organic
    전용이라 paid는 GET .../ads-boosts/{gate_id}/spend가 전담해야 한다). 이 테스트가
    바로 그 「반환 0」을 실측으로 고정한다."""
    from app.main import app
    from tests.test_3475_publishing_metrics import _client_for, _setup_org_scoped_app
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    engine, Session, org_id, project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    try:
        await _start_boost(Session, org_id, gate_id, owner_id)

        from app.models.gate import Gate
        from sqlalchemy import select

        async with Session() as s:
            gate = (await s.execute(select(Gate).where(Gate.id == gate_id))).scalar_one()
            publication_id = uuid.UUID(gate.scope_key)

        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_id}/publications/{publication_id}/insights")
        assert r.status_code == 200, r.text
        channels = {row["channel"] for row in r.json()}
        assert "ads_sandbox" not in channels, f"paid 행이 organic 목록에 섞였다: {channels}"
        assert "meta_ads" not in channels
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
