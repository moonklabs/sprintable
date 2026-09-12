"""story #3808(Phase3·3-3 PR4, 페드루 PO 確定 2026-09-11) — X 헤드 트윗 1d/7d 인사이트
스냅샷(organic) + read 호출 종량(추가 決定). PR4 슬라이스는 갭②만: `_fetch_for_snapshot`
x/x_sandbox 분기·`CHANNEL_ADAPTERS` insight_metrics 선언(둘 다 channel_adapters.py/
insight_snapshots.py에서 완료) + 이 파일의 계약 테스트.

세팅 헬퍼는 test_3497_insight_snapshots.py(연결·발행물 시딩·httpx mock 패치)·
test_e4fc29fa_site_post_orchestration.py(_seed_org)를 그대로 재사용(중복 재발명 금지)."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from tests.test_e4fc29fa_site_post_orchestration import _seed_org, _session_factory
from tests.test_3497_insight_snapshots import (
    _patch_threads_transport,
    _seed_channel_connection,
    _seed_channel_publication,
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


async def _put_rules(session, *, org_id, rules: dict):
    from app.services.content_rules import put_org_content_rules

    return await put_org_content_rules(
        session, org_id=org_id, rules=rules, updated_by_member_id=uuid.uuid4(), expected_version=0,
    )


async def _seed_cost_evidence(session, *, org_id, work_item_id, kind, cost_minor, **extra_payload):
    from app.models.evidence import Evidence

    ev = Evidence(
        id=uuid.uuid4(), org_id=org_id, work_item_id=work_item_id, work_item_type="story",
        type="metric", ref="test-seed", source="platform",
        payload={"kind": kind, "cost_minor": cost_minor, **extra_payload},
    )
    session.add(ev)
    await session.commit()
    return ev.id


# ─── ① 단가 규칙값 우선/코드 기본값 폴백 ───────────────────────────────────────

def test_get_x_insights_read_unit_cost_minor_prefers_rule_value_over_default():
    from app.services.x_publish_budget import get_x_insights_read_unit_cost_minor

    assert get_x_insights_read_unit_cost_minor({"api_usage_budget": {"insights_read_unit_cost_minor": 77}}) == 77


def test_get_x_insights_read_unit_cost_minor_falls_back_to_code_default_when_absent():
    from app.services.x_publish_budget import _DEFAULT_INSIGHTS_READ_UNIT_COST_MINOR, get_x_insights_read_unit_cost_minor

    assert get_x_insights_read_unit_cost_minor(None) == _DEFAULT_INSIGHTS_READ_UNIT_COST_MINOR
    assert get_x_insights_read_unit_cost_minor({}) == _DEFAULT_INSIGHTS_READ_UNIT_COST_MINOR
    assert get_x_insights_read_unit_cost_minor({"api_usage_budget": {}}) == _DEFAULT_INSIGHTS_READ_UNIT_COST_MINOR


def test_get_x_insights_read_unit_cost_minor_zero_turns_axis_off():
    """페드루 PO 追加 決定 — 「과금 아님이 확認되면 rule 값 0으로 끄는 자리」."""
    from app.services.x_publish_budget import get_x_insights_read_unit_cost_minor

    assert get_x_insights_read_unit_cost_minor({"api_usage_budget": {"insights_read_unit_cost_minor": 0}}) == 0


# ─── ② 하나의 통합 지갑 — 발행 비용(sequence)과 read 비용(snapshot_kind)이 같은 월합산에 ──

@pytest.mark.anyio
async def test_publish_and_insights_read_costs_share_the_same_monthly_wallet():
    """PR3의 «다른 지갑»(generation vs api_usage) 정정은 지갑 사이 얘기지, 같은
    api_usage_budget 지갑 안의 두 비용 발생원(발행 vs read)까지 가르라는 뜻이 아니다
    — AC3 "월 API 지출 상한"은 하나의 통합 한도. 이 테스트가 그 설계 결정을 고정한다."""
    from app.services.generation_budget import GenerationBudgetExceededError
    from app.services.x_publish_budget import API_USAGE_COST_KIND, check_api_usage_budget_or_raise

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            work_item_id = uuid.uuid4()
            await _put_rules(s, org_id=org_id, rules={
                "api_usage_budget": {"limit_minor": 100, "currency": "KRW", "period": "month"},
            })
            # 발행 비용(sequence 축) 60 + read 비용(snapshot_kind 축) 30 = 90 소진.
            await _seed_cost_evidence(
                s, org_id=org_id, work_item_id=work_item_id, kind=API_USAGE_COST_KIND, cost_minor=60,
                publication_id=str(uuid.uuid4()), sequence=1,
            )
            await _seed_cost_evidence(
                s, org_id=org_id, work_item_id=work_item_id, kind=API_USAGE_COST_KIND, cost_minor=30,
                event="x_insights_read", publication_id=str(uuid.uuid4()), snapshot_kind="1d",
            )

        async with Session() as s:
            # 잔량 10 — 15 요청은 거부돼야 한다(두 발생원이 같은 지갑에 합산됐다는 증거).
            with pytest.raises(GenerationBudgetExceededError):
                await check_api_usage_budget_or_raise(s, org_id=org_id, estimated_cost_minor=15)
        async with Session() as s:
            await check_api_usage_budget_or_raise(s, org_id=org_id, estimated_cost_minor=10)
    finally:
        await engine.dispose()


# ─── ③ evidence 멱등(publication_id+snapshot_kind) ────────────────────────────

@pytest.mark.anyio
async def test_record_x_insights_read_cost_evidence_idempotent_by_publication_and_snapshot_kind():
    from sqlalchemy import select
    from app.models.evidence import Evidence
    from app.services.x_publish_budget import API_USAGE_COST_KIND, record_x_insights_read_cost_evidence

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
        work_item_id = uuid.uuid4()
        publication_id = uuid.uuid4()

        async with Session() as s:
            await record_x_insights_read_cost_evidence(
                s, org_id=org_id, work_item_id=work_item_id, publication_id=publication_id,
                snapshot_kind="1d", cost_minor=5,
            )
            await s.commit()
        async with Session() as s:
            # ⭐재시도 시나리오 — 같은 (publication_id, snapshot_kind)로 다시 호출.
            await record_x_insights_read_cost_evidence(
                s, org_id=org_id, work_item_id=work_item_id, publication_id=publication_id,
                snapshot_kind="1d", cost_minor=5,
            )
            await s.commit()

        async with Session() as s:
            rows = (await s.execute(
                select(Evidence).where(
                    Evidence.org_id == org_id, Evidence.payload["kind"].astext == API_USAGE_COST_KIND,
                    Evidence.payload["event"].astext == "x_insights_read",
                )
            )).scalars().all()
        assert len(rows) == 1, f"멱등이어야 하는데 {len(rows)}건 기록됨"

        # 양성대조 — 7d는 별개 행으로 남아야 한다(과소계상 방지).
        async with Session() as s:
            await record_x_insights_read_cost_evidence(
                s, org_id=org_id, work_item_id=work_item_id, publication_id=publication_id,
                snapshot_kind="7d", cost_minor=5,
            )
            await s.commit()
        async with Session() as s:
            rows = (await s.execute(
                select(Evidence).where(
                    Evidence.org_id == org_id, Evidence.payload["kind"].astext == API_USAGE_COST_KIND,
                    Evidence.payload["event"].astext == "x_insights_read",
                )
            )).scalars().all()
        assert len(rows) == 2
    finally:
        await engine.dispose()


# ─── ④ 실 x — 200 응답이 public_metrics를 impressions/engagements로 매핑 ──────────

@pytest.mark.anyio
async def test_x_200_captures_impressions_and_engagements(monkeypatch):
    import httpx

    from app.models.insight_snapshot import InsightSnapshot
    from app.services.insight_snapshots import process_due_insight_snapshots, schedule_insight_snapshots
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            connection = await _seed_channel_connection(s, org_id, channel="x")
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=connection.id, channel="x")
            work_item_id = uuid.uuid4()

            await schedule_insight_snapshots(
                s, org_id=org_id, work_item_id=work_item_id, publication_id=pub.id,
                publication_kind="channel_publication", channel="x", external_id=pub.external_id,
                anchor_at=datetime.now(timezone.utc) - timedelta(days=8),
            )
            await s.commit()

            _patch_threads_transport(monkeypatch, lambda request: httpx.Response(200, json={"data": {
                "id": "tweet-1",
                "public_metrics": {
                    "impression_count": 500, "like_count": 10, "retweet_count": 3,
                    "reply_count": 2, "quote_count": 1,
                },
            }}))
            counts = await process_due_insight_snapshots(s)

            assert counts["captured"] == 2, counts
            snap = (await s.execute(
                select(InsightSnapshot).where(InsightSnapshot.publication_id == pub.id)
            )).scalars().first()
            assert snap.normalized["impressions"] == 500
            assert snap.normalized["engagements"] == 16  # 10+3+2+1
            # X가 선언 안 한 5축은 null(0으로 지어내지 않는다 — 이 스토리의 척추).
            assert snap.normalized["reach"] is None
            assert snap.normalized["views"] is None
            assert snap.normalized["clicks"] is None
            assert snap.normalized["spend"] is None
            assert snap.normalized["conversions"] is None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_x_401_promotes_connection_and_marks_snapshot_failed(monkeypatch):
    import httpx

    from app.models.channel_connection import ChannelConnection
    from app.models.insight_snapshot import InsightSnapshot
    from app.services.insight_snapshots import process_due_insight_snapshots, schedule_insight_snapshots
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            connection = await _seed_channel_connection(s, org_id, channel="x")
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=connection.id, channel="x")
            work_item_id = uuid.uuid4()

            await schedule_insight_snapshots(
                s, org_id=org_id, work_item_id=work_item_id, publication_id=pub.id,
                publication_kind="channel_publication", channel="x", external_id=pub.external_id,
                anchor_at=datetime.now(timezone.utc) - timedelta(days=8),
            )
            await s.commit()

            _patch_threads_transport(monkeypatch, lambda request: httpx.Response(401, json={"errors": [{"message": "expired"}]}))
            counts = await process_due_insight_snapshots(s)

            assert counts["failed"] == 2, counts
            conn_row = await s.get(ChannelConnection, connection.id)
            assert conn_row.status != "active"
    finally:
        await engine.dispose()


# ─── ⑤ 양성대조 — x_sandbox 고정값이 NORMALIZED_KEYS 7키에 정확히 매핑 ────────────

@pytest.mark.anyio
async def test_x_sandbox_captures_only_declared_two_keys():
    from app.models.insight_snapshot import InsightSnapshot
    from app.services.insight_snapshots import process_due_insight_snapshots, schedule_insight_snapshots
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            connection = await _seed_channel_connection(s, org_id, channel="x_sandbox")
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=connection.id, channel="x_sandbox")
            work_item_id = uuid.uuid4()

            await schedule_insight_snapshots(
                s, org_id=org_id, work_item_id=work_item_id, publication_id=pub.id,
                publication_kind="channel_publication", channel="x_sandbox", external_id=pub.external_id,
                anchor_at=datetime.now(timezone.utc) - timedelta(days=8),
            )
            await s.commit()

            counts = await process_due_insight_snapshots(s)

            assert counts["captured"] == 2, counts
            snaps = (await s.execute(
                select(InsightSnapshot).where(InsightSnapshot.publication_id == pub.id)
            )).scalars().all()
            for snap in snaps:
                # x_sandbox는 impressions/engagements만 declare — 나머지 5키는 null
                # (제네릭 _fetch_sandbox가 7키 다 채워도, declared_metrics 필터가 여기서 걸러야 한다).
                assert snap.normalized["impressions"] is not None
                assert snap.normalized["engagements"] is not None
                assert snap.normalized["reach"] is None
                assert snap.normalized["views"] is None
                assert snap.normalized["clicks"] is None
                assert snap.normalized["spend"] is None
                assert snap.normalized["conversions"] is None
    finally:
        await engine.dispose()


# ─── ⑥ 1d/7d 예약 동형 — x/x_sandbox도 발행 뒤 +1d/+7d 두 행이 열린다 ─────────────

@pytest.mark.anyio
async def test_x_sandbox_schedules_both_1d_and_7d_rows():
    from app.models.insight_snapshot import InsightSnapshot
    from app.services.insight_snapshots import schedule_insight_snapshots
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            connection = await _seed_channel_connection(s, org_id, channel="x_sandbox")
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=connection.id, channel="x_sandbox")
            work_item_id = uuid.uuid4()
            published_at = datetime.now(timezone.utc)

            await schedule_insight_snapshots(
                s, org_id=org_id, work_item_id=work_item_id, publication_id=pub.id,
                publication_kind="channel_publication", channel="x_sandbox", external_id=pub.external_id,
                anchor_at=published_at,
            )
            await s.commit()

            rows = (await s.execute(
                select(InsightSnapshot).where(InsightSnapshot.publication_id == pub.id).order_by(InsightSnapshot.due_at)
            )).scalars().all()
        assert len(rows) == 2
        assert rows[0].due_at - published_at == timedelta(days=1)
        assert rows[1].due_at - published_at == timedelta(days=7)
        assert all(r.status == "pending" for r in rows)
    finally:
        await engine.dispose()


# ─── ⑦ 상한 도달 시 건너뜀(«수집 안 됨≠0») — 뮤테이션 RED 대상 핵심 계약 ───────────

@pytest.mark.anyio
async def test_x_sandbox_skipped_when_api_usage_budget_exceeded(monkeypatch):
    from sqlalchemy import select
    from app.models.evidence import Evidence
    from app.models.insight_snapshot import InsightSnapshot
    from app.services.insight_snapshots import process_due_insight_snapshots, schedule_insight_snapshots
    from app.services.x_publish_budget import API_USAGE_COST_KIND

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            connection = await _seed_channel_connection(s, org_id, channel="x_sandbox")
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=connection.id, channel="x_sandbox")
            work_item_id = uuid.uuid4()

            # 한도(0)가 기본 read 단가(5)보다 작아 항상 거부되게.
            await _put_rules(s, org_id=org_id, rules={
                "api_usage_budget": {"limit_minor": 0, "currency": "KRW", "period": "month"},
            })
            await schedule_insight_snapshots(
                s, org_id=org_id, work_item_id=work_item_id, publication_id=pub.id,
                publication_kind="channel_publication", channel="x_sandbox", external_id=pub.external_id,
                anchor_at=datetime.now(timezone.utc) - timedelta(days=8),
            )
            await s.commit()

            counts = await process_due_insight_snapshots(s)

            assert counts["skipped"] == 2, counts
            assert counts["captured"] == 0, counts
            snaps = (await s.execute(
                select(InsightSnapshot).where(InsightSnapshot.publication_id == pub.id)
            )).scalars().all()
            for snap in snaps:
                assert snap.status == "skipped"
                assert snap.error_code == "API_USAGE_BUDGET_EXCEEDED"
                # 「수집 안 됨≠0」 — normalized 자체가 None이어야 한다(0으로 지어내지 않는다).
                assert snap.normalized is None

            ev_rows = (await s.execute(
                select(Evidence).where(
                    Evidence.org_id == org_id, Evidence.payload["kind"].astext == API_USAGE_COST_KIND,
                    Evidence.payload["event"].astext == "x_insights_read",
                )
            )).scalars().all()
            assert len(ev_rows) == 0, "예산 초과로 건너뛴 read는 evidence를 남기면 안 된다(과금 없음)"
    finally:
        await engine.dispose()
