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
        await request_ads_boost_start(s, org_id=org_id, gate_id=gate_id, requester_member_id=owner_id)
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
async def test_boost_start_schedules_two_spend_snapshots():
    from tests.test_e4fc29fa_site_post_orchestration import _session_factory

    engine, Session, org_id, project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    try:
        await _start_boost(Session, org_id, gate_id, owner_id)

        async with Session() as s:
            rows = await _get_spend_snapshots(s, org_id, gate_id)
        assert len(rows) == 2, rows
        assert all(r.status == "pending" for r in rows)
        # +1d·+7d 두 행 — 정확한 오프셋보다 "짧은 것 하나·긴 것 하나"만 pin(6일差
        # 이상이면 1d/7d 조합이 맞다는 뜻, anchor_at 자체의 정밀 초 단위는 비관심사).
        assert (rows[1].due_at - rows[0].due_at) > timedelta(days=5)
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
        assert counts["captured"] == 2, counts

        async with Session() as s:
            rows = await _get_spend_snapshots(s, org_id, gate_id)
        assert all(r.status == "captured" for r in rows)
        assert all(r.source == "paid" for r in rows), [r.source for r in rows]
        assert all(r.normalized["spend"] == 12_345 for r in rows), [r.normalized for r in rows]
        assert all(r.normalized["impressions"] is None for r in rows), "organic 지표는 미선언과 같은 null이어야 한다"
    finally:
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
        assert counts == {"captured": 0, "unsupported": 0, "failed": 0, "pending_retry": 0, "error": 0}, counts

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
        assert body["captured_spend_minor"] == 12_345 * 2
        assert body["remaining_minor"] == 100_000 - 12_345 * 2
        assert len(body["snapshots"]) == 2
        assert all(s["spend_minor"] == 12_345 for s in body["snapshots"])
        # story #3806(PR5, 3자기점검) — pause/resume UI가 「실행 중」을 그릴 근거.
        assert body["run_status"] == "running"
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
