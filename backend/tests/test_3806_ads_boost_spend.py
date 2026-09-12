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
