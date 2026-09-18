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
from tests.test_3808_x_publish_budget import _put_rules, _seed_cost_evidence
from tests.test_3497_insight_snapshots import _seed_channel_connection
from tests.test_3806_ads_boost_execution import _setup_approved_gate
from tests.test_3806_ads_boost_gate import _approve_gate, _boost_body, _seed_publication
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
            "approved_boost_count": 0, "sealed_ads_currency": None,
            "sealed_budget_minor": 0, "captured_spend_minor": 0,
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
        # story #3809(PR 4a) — 최초 예약은 1건뿐(anchor+1d)이라 이 tick 1회로는
        # 캡처도 1건(다음 캡처는 그 자리서 이어 예약될 뿐 이 tick엔 아직 안 due).
        assert summary["captured_spend_minor"] == 12_345
        assert summary["remaining_minor"] == 100_000 - 12_345
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


async def _add_second_approved_gate(Session, *, org_id, owner_id, budget_minor, currency):
    """`_setup_approved_gate`는 매번 새 org를 만들어 「같은 org 안에 승인된
    boost 게이트 2개」를 세팅할 수 없다 — 이미 있는 org에 발행물+ads_sandbox
    채널연결을 새로 하나 더 심고 PR 2 API로 두 번째 게이트를 만들어 승인까지
    전이시킨다(PR 2b 통화 혼재 대조군 전용)."""
    from app.main import app

    async with Session() as s:
        conn = await _seed_channel_connection(s, org_id, channel="threads")
        ad_conn = await _seed_channel_connection(s, org_id, channel="ads_sandbox")
        pub, _ = await _seed_publication(s, org_id=org_id, connection_id=conn.id)

    _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)
    async with _client_for(app) as client:
        r = await client.post(
            f"/api/v2/organizations/{org_id}/publications/{pub.id}/boosts",
            json=_boost_body(ad_connection_id=ad_conn.id, budget_minor=budget_minor, currency=currency),
        )
    assert r.status_code == 201, r.text
    gate_id = uuid.UUID(r.json()["gate_id"])
    app.dependency_overrides.clear()

    async with Session() as s:
        await _approve_gate(s, gate_id, owner_id)

    return gate_id


@pytest.mark.anyio
async def test_org_ads_cost_summary_sums_when_same_currency():
    """PO 確定(2026-09-11 18:46Z) 양성대조 1/2 — KRW+KRW 게이트 2개는 통화가
    하나로 모이니 그대로 합산돼야 한다(None으로 숨기면 그것도 거짓)."""
    from app.services.org_cost_summary import get_org_ads_cost_summary

    engine, Session, org_id, project_id, owner_id, gate_id = await _setup_approved_gate(
        await _session_factory(), budget_minor=100_000,
    )
    try:
        await _add_second_approved_gate(Session, org_id=org_id, owner_id=owner_id, budget_minor=50_000, currency="KRW")

        async with Session() as s:
            summary = await get_org_ads_cost_summary(s, org_id=org_id)
        assert summary["approved_boost_count"] == 2
        assert summary["sealed_ads_currency"] == "KRW"
        assert summary["sealed_budget_minor"] == 150_000
        assert summary["captured_spend_minor"] == 0
        assert summary["remaining_minor"] == 150_000
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_org_ads_cost_summary_nulls_sums_when_currencies_mixed():
    """PO 確定(2026-09-11 18:46Z) 양성대조 2/2 — KRW+USD가 섞이면 통화도
    합계 3필드도 전부 None(「달러+원을 그냥 더한 숫자」를 지어내지 않는다).
    뮤테이션: 섞임 판정(`mixed_currencies`)을 걷으면 이 테스트만 RED여야 한다."""
    from app.services.org_cost_summary import get_org_ads_cost_summary

    engine, Session, org_id, project_id, owner_id, gate_id = await _setup_approved_gate(
        await _session_factory(), budget_minor=100_000,
    )
    try:
        await _add_second_approved_gate(Session, org_id=org_id, owner_id=owner_id, budget_minor=50_000, currency="USD")

        async with Session() as s:
            summary = await get_org_ads_cost_summary(s, org_id=org_id)
        assert summary["approved_boost_count"] == 2
        assert summary["sealed_ads_currency"] is None
        assert summary["sealed_budget_minor"] is None
        assert summary["captured_spend_minor"] is None
        assert summary["remaining_minor"] is None
        # 섞였어도 상한도달 카운트는 통화와 무관한 별개 축 — 지어낸 방식으로
        # 함께 숨기지 않는다.
        assert summary["cap_reached_count"] == 0
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
        # PR#3848 PO 지침② — FE가 통화를 "KRW"로 추정하지 않도록 실값을 그대로
        # 통과시켜야 한다(_put_generation_budget 기본 통화 KRW).
        assert summary["generation_currency"] == "KRW"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_generation_currency_null_when_no_rule():
    """규칙 자체가 없으면(`compute_generation_budget_status`가 None) 통화도
    지어내지 않고 None — 지출/기간 필드와 동형."""
    from app.services.org_cost_summary import get_org_cost_summary

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)

        async with Session() as s:
            summary = await get_org_cost_summary(s, org_id=org_id)
        assert summary["generation_currency"] is None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_x_cost_null_when_no_rule():
    """story #3808(PR5c, 페드루 PO 確定 2026-09-12 — 라이브 회차 결함 처방) — X
    api_usage_budget 규칙 자체가 없으면(generation_cost와 동형 「규칙 없음」 계약)
    null. 옛 「항상 null」 전제(그라운딩②)는 이 PR로 정정됨 — PR3부터 X 비용
    원장이 실제로 있다(evidence.payload.kind=api_usage_cost), 이 함수가 그 사실을
    반영 안 해 실 지출이 있어도 하드코딩 None을 찍던 것이 결함이었다."""
    from app.services.org_cost_summary import get_org_cost_summary

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)

        async with Session() as s:
            summary = await get_org_cost_summary(s, org_id=org_id)
        assert summary["x_cost_spent_minor"] is None
        assert summary["x_cost_period_start"] is None
        assert summary["x_cost_period_end"] is None
        assert summary["x_currency"] is None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_x_cost_reflects_evidence_sum():
    """⭐결함 재현·처방 확認 — 라이브 회차 실측 그대로(evidence 300원치, 편집기
    GET .../api-usage-budget과 이 함수가 같은 값을 봐야 한다)."""
    from app.services.org_cost_summary import get_org_cost_summary

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            await _put_rules(s, org_id=org_id, rules={
                "api_usage_budget": {"limit_minor": 100_000, "currency": "KRW", "period": "month"},
            })
            await _seed_cost_evidence(s, org_id=org_id, work_item_id=uuid.uuid4(), kind="api_usage_cost", cost_minor=300)

        async with Session() as s:
            summary = await get_org_cost_summary(s, org_id=org_id)
        assert summary["x_cost_spent_minor"] == 300
        assert summary["x_currency"] == "KRW"
        assert summary["x_cost_period_start"] is not None
        assert summary["x_cost_period_end"] is not None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_generation_and_x_cost_are_isolated_in_the_same_summary():
    """양성대조 — 두 축(생성 비용·X 비용)이 같은 요약 응답 안에서도 서로 안
    갉아먹는다(PR3의 「다른 지갑」 격리를 이 조회 함수 레벨에서도 재확認)."""
    from app.services.org_cost_summary import get_org_cost_summary

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            await _put_rules(s, org_id=org_id, rules={
                "generation_budget": {"limit_minor": 100_000, "currency": "KRW", "period": "month"},
                "api_usage_budget": {"limit_minor": 50_000, "currency": "KRW", "period": "month"},
            })
            await _seed_generation_cost_evidence(
                s, org_id=org_id, work_item_id=uuid.uuid4(), cost_minor=1_000, created_by=uuid.uuid4(),
            )
            await _seed_cost_evidence(s, org_id=org_id, work_item_id=uuid.uuid4(), kind="api_usage_cost", cost_minor=300)

        async with Session() as s:
            summary = await get_org_cost_summary(s, org_id=org_id)
        assert summary["generation_cost_spent_minor"] == 1_000
        assert summary["x_cost_spent_minor"] == 300
    finally:
        await engine.dispose()




@pytest.mark.anyio
async def test_paid_spend_daily_series_aggregates_by_captured_date():
    """양성대조① — 단일 통화(이 헬퍼는 게이트 하나뿐이라 두 캡처 다 같은
    `sealed_ads_currency`(기본 KRW), 날짜별 합산이 통화를 그대로 실어야 한다."""
    from app.models.insight_snapshot import InsightSnapshot
    from app.services.ads_spend_snapshots import process_due_ads_spend_snapshots
    from app.services.org_cost_summary import get_org_paid_spend_daily_series
    from sqlalchemy import select, update

    engine, Session, org_id, project_id, owner_id, gate_id = await _setup_approved_gate(await _session_factory())
    try:
        await _start_boost(Session, org_id, gate_id, owner_id)
        # story #3809(PR 4a) — 최초 예약은 1건뿐이라(anchor+1d) 캡처 2건을 만들려면
        # (due시킴→처리→다음 예약이 그 자리서 생김) 그 사이클을 두 번 돈다.
        for _ in range(2):
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
        assert all(point["currency"] == "KRW" for point in series), series
        assert all(point["source"] == "paid" for point in series), series
        assert series[0]["date"] < series[1]["date"], "오름차순 정렬이어야 한다"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_paid_spend_daily_series_nulls_amount_when_currencies_mixed_same_day():
    """양성대조② — PR2b와 동형 규율: 같은 날짜에 서로 다른 통화(KRW·USD)로 캡처된
    두 게이트가 섞이면 그 날짜 포인트는 `currency`·`spend_minor` 둘 다 null이어야
    한다(서로 다른 통화를 그냥 더한 지어낸 숫자를 내지 않는다). `_add_second_
    approved_gate`(PR2b 통화 혼재 대조군 헬퍼) 그대로 재사용."""
    from app.services.ads_spend_snapshots import process_due_ads_spend_snapshots
    from app.services.org_cost_summary import get_org_paid_spend_daily_series

    engine, Session, org_id, project_id, owner_id, gate_id_krw = await _setup_approved_gate(await _session_factory())
    try:
        gate_id_usd = await _add_second_approved_gate(Session, org_id=org_id, owner_id=owner_id, budget_minor=200_00, currency="USD")

        await _start_boost(Session, org_id, gate_id_krw, owner_id)
        await _start_boost(Session, org_id, gate_id_usd, owner_id)

        async with Session() as s:
            await _make_spend_snapshots_due(s, org_id, gate_id_krw)
        async with Session() as s:
            await _make_spend_snapshots_due(s, org_id, gate_id_usd)
        async with Session() as s:
            counts = await process_due_ads_spend_snapshots(s)
        assert counts["captured"] == 2, counts

        async with Session() as s:
            series = await get_org_paid_spend_daily_series(s, org_id=org_id)
        # 둘 다 같은 tick으로 캡처돼 같은 날짜 하나뿐 — 섞인 통화라 그 날짜는 null.
        assert len(series) == 1, series
        assert series[0]["spend_minor"] is None, series
        assert series[0]["currency"] is None, series
        assert series[0]["source"] == "paid", series
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
            "generation_cost_period_end", "generation_currency", "x_cost_spent_minor",
            "x_cost_period_start", "x_cost_period_end", "x_currency",
            "paid_spend_daily_series",
        }
        assert set(body["ads"].keys()) == {
            "approved_boost_count", "sealed_ads_currency", "sealed_budget_minor",
            "captured_spend_minor", "remaining_minor", "cap_reached_count",
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
