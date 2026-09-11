"""story #3809(Phase3·3-7, 페드루 PO 確定 2026-09-11 17:12Z) — 「고급 보고 첫
출시」 조각 1: 공유 분류 유틸(`classify_insight_source`)·드리프트 가드·조직 단위
비용 원장 API(`GET /{org_id}/insights-board/cost-summary`) 회귀. 세팅 헬퍼는
test_3806_ads_boost_execution.py/test_3806_ads_boost_spend.py(ads 축)·
test_3471_org_content_rules_lint.py·test_3498_generation_budget_evidence_and_
config.py(생성비용 축) 재사용(중복 재발명 금지). 새 마이그 0건(신규 테이블·컬럼
0 — 기존 InsightSnapshot·Gate·AdsBoostRun·org_content_rules 조회만)."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from tests.test_3471_org_content_rules_lint import (
    _client_for,
    _seed_human,
    _seed_org,
    _session_factory,
    _setup_org_scoped_app,
)
from tests.test_3498_generation_budget_evidence_and_config import (
    _put_generation_budget,
    _seed_generation_cost_evidence,
)
from tests.test_3806_ads_boost_execution import _setup_approved_gate
from tests.test_3806_ads_boost_spend import _make_spend_snapshots_due, _start_boost

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


def test_classify_insight_source_covers_all_paid_channels_and_organic_samples():
    """드리프트 가드 — `_PAID_CHANNELS` 전부(paid)·organic 표본 6채널(실채널+3
    sandbox 미러) 전수. 뮤테이션 대상: `classify_insight_source`가 `_PAID_CHANNELS`
    대신 새 판별식(예: 리터럴 나열)을 쓰면 이 상수가 늘어나도 이 테스트가 못
    잡는다 — 반드시 `_PAID_CHANNELS`를 그대로 참조해야 이 테스트가 그 상수의
    미래 변경까지 자동으로 커버한다."""
    from app.services.ads_spend_snapshots import _PAID_CHANNELS, classify_insight_source

    for channel in _PAID_CHANNELS:
        assert classify_insight_source(channel) == "paid", channel

    for channel in ("threads", "instagram", "facebook", "sandbox", "instagram_sandbox", "facebook_sandbox"):
        assert classify_insight_source(channel) == "organic", channel


@pytest.mark.anyio
async def test_org_ads_cost_summary_zero_when_no_approved_boosts():
    from app.services.org_cost_summary import get_org_ads_cost_summary

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)

        async with Session() as s:
            summary = await get_org_ads_cost_summary(s, org_id=org_id)
        assert summary == {
            "approved_boost_count": 0, "sealed_budget_minor": 0, "captured_spend_minor": 0,
            "remaining_minor": 0, "cap_reached_count": 0,
        }
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_org_ads_cost_summary_sums_approved_boost_budget_and_captured_spend():
    from app.services.ads_spend_snapshots import process_due_ads_spend_snapshots
    from app.services.org_cost_summary import get_org_ads_cost_summary

    engine, Session, org_id, project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    try:
        await _start_boost(Session, org_id, gate_id, owner_id)
        async with Session() as s:
            await _make_spend_snapshots_due(s, org_id, gate_id)
        async with Session() as s:
            await process_due_ads_spend_snapshots(s)

        async with Session() as s:
            summary = await get_org_ads_cost_summary(s, org_id=org_id)
        assert summary["approved_boost_count"] == 1
        assert summary["sealed_budget_minor"] == 100_000
        assert summary["captured_spend_minor"] == 12_345 * 2
        assert summary["remaining_minor"] == 100_000 - 12_345 * 2
        assert summary["cap_reached_count"] == 0
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_org_ads_cost_summary_counts_cap_reached():
    from app.services.ads_spend_snapshots import process_due_ads_spend_snapshots
    from app.services.org_cost_summary import get_org_ads_cost_summary

    engine, Session, org_id, project_id, owner_id, gate_id = await _setup_approved_gate(
        await _session_factory(), budget_minor=10_000,
    )
    try:
        await _start_boost(Session, org_id, gate_id, owner_id)
        async with Session() as s:
            await _make_spend_snapshots_due(s, org_id, gate_id)
        async with Session() as s:
            await process_due_ads_spend_snapshots(s)

        async with Session() as s:
            summary = await get_org_ads_cost_summary(s, org_id=org_id)
        assert summary["cap_reached_count"] == 1
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_org_ads_cost_summary_excludes_pending_gate():
    """승인 안 된 게이트는 「승인 예산 합」에 안 잡혀야 한다 — 지어낸 낙관치 금지."""
    from app.services.org_cost_summary import get_org_ads_cost_summary

    engine, Session, org_id, project_id, owner_id, gate_id = await _setup_approved_gate(
        await _session_factory(), approve=False,
    )
    try:
        async with Session() as s:
            summary = await get_org_ads_cost_summary(s, org_id=org_id)
        assert summary["approved_boost_count"] == 0
        assert summary["sealed_budget_minor"] == 0
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_generation_cost_null_when_no_rule():
    from app.services.org_cost_summary import get_org_cost_summary

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)

        async with Session() as s:
            summary = await get_org_cost_summary(s, org_id=org_id)
        assert summary["generation_cost_spent_minor"] is None
        assert summary["generation_cost_period_start"] is None
        assert summary["generation_cost_period_end"] is None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_generation_cost_reflects_evidence_sum():
    from app.services.org_cost_summary import get_org_cost_summary

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            owner_id = await _seed_human(s, org_id, role="owner")
            await _put_generation_budget(s, org_id=org_id, limit_minor=100_000)
            await _seed_generation_cost_evidence(
                s, org_id=org_id, work_item_id=uuid.uuid4(), cost_minor=3_000, created_by=owner_id,
            )
            await _seed_generation_cost_evidence(
                s, org_id=org_id, work_item_id=uuid.uuid4(), cost_minor=2_000, created_by=owner_id,
            )

        async with Session() as s:
            summary = await get_org_cost_summary(s, org_id=org_id)
        assert summary["generation_cost_spent_minor"] == 5_000
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_x_cost_always_null():
    """story #3809 그라운딩②(2026-09-11) — X 비용 원장 자체가 이 시점 코드에
    없다(실측 확認). 다른 조건과 무관하게 항상 null이어야 한다(0으로 지어내지
    않는다)."""
    from app.services.org_cost_summary import get_org_cost_summary

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)

        async with Session() as s:
            summary = await get_org_cost_summary(s, org_id=org_id)
        assert summary["x_cost_spent_minor"] is None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_paid_spend_daily_series_aggregates_by_captured_date():
    from app.models.insight_snapshot import InsightSnapshot
    from app.services.ads_spend_snapshots import process_due_ads_spend_snapshots
    from app.services.org_cost_summary import get_org_paid_spend_daily_series
    from sqlalchemy import select, update

    engine, Session, org_id, project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    try:
        await _start_boost(Session, org_id, gate_id, owner_id)
        async with Session() as s:
            await _make_spend_snapshots_due(s, org_id, gate_id)
        async with Session() as s:
            await process_due_ads_spend_snapshots(s)

        # 두 스냅샷의 captured_at을 서로 다른 날(어제·오늘)로 갈라 그룹화가 실제로
        # 날짜 단위인지 확認(둘 다 같은 tick·같은 now로 캡처돼 원래는 같은 날이다).
        async with Session() as s:
            rows = (await s.execute(
                select(InsightSnapshot).where(
                    InsightSnapshot.org_id == org_id, InsightSnapshot.source == "paid",
                ).order_by(InsightSnapshot.due_at.asc())
            )).scalars().all()
            assert len(rows) == 2
            yesterday = datetime.now(timezone.utc) - timedelta(days=1)
            await s.execute(update(InsightSnapshot).where(InsightSnapshot.id == rows[0].id).values(captured_at=yesterday))
            await s.commit()

        async with Session() as s:
            series = await get_org_paid_spend_daily_series(s, org_id=org_id)
        assert len(series) == 2, series
        assert all(point["spend_minor"] == 12_345 for point in series), series
        assert all(point["source"] == "paid" for point in series), series
        assert series[0]["date"] < series[1]["date"], "오름차순 정렬이어야 한다"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_cost_summary_endpoint_returns_shape():
    from app.main import app

    engine, Session, org_id, project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    try:
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_id}/insights-board/cost-summary")
        assert r.status_code == 200, r.text
        body = r.json()
        assert set(body.keys()) == {
            "ads", "generation_cost_spent_minor", "generation_cost_period_start",
            "generation_cost_period_end", "x_cost_spent_minor", "paid_spend_daily_series",
        }
        assert set(body["ads"].keys()) == {
            "approved_boost_count", "sealed_budget_minor", "captured_spend_minor",
            "remaining_minor", "cap_reached_count",
        }
        assert body["ads"]["approved_boost_count"] == 1
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_cost_summary_endpoint_org_id_mismatch_403():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_a, _ = await _seed_org(s)
            owner_a = await _seed_human(s, org_a, role="owner")
            org_b, _ = await _seed_org(s)

        _setup_org_scoped_app(app, Session, org_a, user_id=owner_a)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_b}/insights-board/cost-summary")
        assert r.status_code == 403, r.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
