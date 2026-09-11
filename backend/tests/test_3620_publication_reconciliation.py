"""story #3620(Phase2·BE+FE·실측·4열, 페드루 PO 確定 2026-09-07) — 「채널 원본
지표와 evidence 대조」 서비스 회귀. `publication_reconciliation.py::reconcile_
publication` 자체(정의 1·2·3) + `measured_metrics.py`의 확장 2키(coverage·
mismatch rate)를 고정한다.

세팅 헬퍼는 test_e4fc29fa_site_post_orchestration.py·test_3497_insight_snapshots.py
재사용(중복 재발명 금지, test_3618_phase2_metrics.py와 동일 관례)."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from tests.test_e4fc29fa_site_post_orchestration import _seed_org, _session_factory
from tests.test_3497_insight_snapshots import (
    _enable_sandbox_adapter,
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


async def _seed_sandbox_publication_with_version_text(
    session, *, org_id, connection_id, publication_id, text: str, published_at: datetime,
):
    """story #3620(페드루 지시 2026-09-10) — `[sandbox:insight-drift]` 마커 재현 전용.
    `_seed_channel_publication`(test_3497)과 달리 version_id를 무작위 UUID로 두지
    않고 실 `ChannelPostVersion`(+그 FK가 요구하는 `ChannelPostDraft`)을 심어
    `_fetch_sandbox`가 실제로 그 text를 읽게 한다."""
    from app.models.channel_post_draft import ChannelPostDraft
    from app.models.channel_post_version import ChannelPostVersion
    from app.models.channel_publication import ChannelPublication

    draft = ChannelPostDraft(
        id=uuid.uuid4(), org_id=org_id, work_item_id=uuid.uuid4(), channel="sandbox", connection_id=connection_id,
    )
    session.add(draft)
    await session.commit()

    version = ChannelPostVersion(
        id=uuid.uuid4(), draft_id=draft.id, version=1, text=text, body_sha256="deadbeef",
        author_member_id=uuid.uuid4(), author_kind="human",
    )
    session.add(version)
    await session.commit()

    pub = ChannelPublication(
        id=publication_id, org_id=org_id, gate_id=uuid.uuid4(), version_id=version.id,
        connection_id=connection_id, channel="sandbox", status="published",
        external_id="sandbox-media-1", published_at=published_at,
    )
    session.add(pub)
    await session.commit()
    return pub


async def _seed_captured_snapshot(session, *, org_id, publication_id, channel, normalized: dict):
    from app.models.insight_snapshot import InsightSnapshot

    now = datetime.now(timezone.utc)
    snapshot = InsightSnapshot(
        id=uuid.uuid4(), org_id=org_id, publication_id=publication_id, publication_kind="channel_publication",
        work_item_id=uuid.uuid4(), channel=channel, due_at=now, captured_at=now, status="captured",
        normalized=normalized,
    )
    session.add(snapshot)
    await session.commit()
    return snapshot


# ─── 정의 1 — 지표별 판정(단조 5종 match/mismatch·정확값 2종·미측정) ──────────


@pytest.mark.anyio
async def test_reconcile_no_prior_snapshot_all_metrics_unmeasured(monkeypatch):
    """비교할 저장값 자체가 없으면 7개 전부 unmeasured — 실패가 아니라 정직한 기록."""
    from app.services.publication_reconciliation import reconcile_publication
    import app.services.publication_reconciliation as recon_module

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            conn = await _seed_channel_connection(s, org_id, channel="threads")
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=conn.id, channel="threads", external_id="m1")
            member_id = uuid.uuid4()

            live_values = {"impressions": 100, "reach": 80, "views": 60, "engagements": 10, "clicks": 5, "spend": 0, "conversions": 1}

            async def _fake_fetch(db, snapshot, **_kwargs):
                return {"raw": live_values, "values": live_values}

            monkeypatch.setattr(recon_module, "_fetch_for_snapshot", _fake_fetch)
            record = await reconcile_publication(s, org_id=org_id, publication_id=pub.id, requested_by_member_id=member_id)

            assert record.snapshot_id is None
            assert record.has_mismatch is False
            for key in ("impressions", "reach", "views", "engagements", "clicks", "spend", "conversions"):
                assert record.verdicts[key] == "unmeasured"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_reconcile_monotonic_metric_stored_greater_than_live_is_mismatch(monkeypatch):
    """단조증가 지표는 저장값이 원본(live)보다 크면 mismatch(실측치는 줄 수 없다).
    threads가 실제 선언한 지표(views·engagements)로 종단 검증(그라운딩 —
    CHANNEL_ADAPTERS['threads'].insight_metrics=('views','engagements'), 선언 밖
    키는 _normalize가 걸러 unmeasured로 떨어진다)."""
    from app.services.publication_reconciliation import reconcile_publication
    import app.services.publication_reconciliation as recon_module

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            conn = await _seed_channel_connection(s, org_id, channel="threads")
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=conn.id, channel="threads", external_id="m1")
            await _seed_captured_snapshot(
                s, org_id=org_id, publication_id=pub.id, channel="threads",
                normalized={"impressions": None, "reach": None, "views": 500, "engagements": 80, "clicks": None, "spend": None, "conversions": None},
            )
            member_id = uuid.uuid4()
            # 채널 원본(live)이 views=100인데 저장은 500 — 실측치가 줄 수 없으니 저장이 틀림.
            live_values = {"views": 100, "engagements": 90}

            async def _fake_fetch(db, snapshot, **_kwargs):
                return {"raw": live_values, "values": live_values}

            monkeypatch.setattr(recon_module, "_fetch_for_snapshot", _fake_fetch)
            record = await reconcile_publication(s, org_id=org_id, publication_id=pub.id, requested_by_member_id=member_id)

            assert record.verdicts["views"] == "mismatch"
            assert record.verdicts["engagements"] == "match"  # 80<=90
            assert record.has_mismatch is True
    finally:
        await engine.dispose()


# ─── 정의 1 부속 — 지표별 판정 함수 자체(단위, 채널 선언 축과 분리) ────────────
# spend/conversions는 현재 어떤 CHANNEL_ADAPTERS도 insight_metrics로 선언 안 함
# (그라운딩 확인 — 미래 채널 대비 방어 코드, 지금은 실 채널 종단으로 못 닿는다).
# _verdict_for_metric을 직접 단위 테스트해 이 두 값의 판정 로직 자체는 고정한다.


def test_verdict_for_metric_equality_keys_exact_match_required():
    from app.services.publication_reconciliation import _verdict_for_metric

    assert _verdict_for_metric(stored=100, live=100, monotonic=False) == "match"
    assert _verdict_for_metric(stored=100, live=101, monotonic=False) == "mismatch"
    assert _verdict_for_metric(stored=101, live=100, monotonic=False) == "mismatch"
    assert _verdict_for_metric(stored=None, live=100, monotonic=False) == "unmeasured"
    assert _verdict_for_metric(stored=100, live=None, monotonic=False) == "unmeasured"


def test_verdict_for_metric_monotonic_keys_stored_gt_live_is_mismatch():
    from app.services.publication_reconciliation import _verdict_for_metric

    assert _verdict_for_metric(stored=80, live=100, monotonic=True) == "match"
    assert _verdict_for_metric(stored=100, live=100, monotonic=True) == "match"
    assert _verdict_for_metric(stored=101, live=100, monotonic=True) == "mismatch"


# ─── 정의 2 — 선검사 실패는 새 증거가 아님(승격·기록 대상 0) ─────────────────


@pytest.mark.anyio
async def test_reconcile_connection_inactive_propagates_without_recording():
    from app.services.insight_snapshots import InsightFetchError
    from app.services.publication_reconciliation import reconcile_publication
    from app.models.channel_publication_reconciliation import ChannelPublicationReconciliation
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            conn = await _seed_channel_connection(s, org_id, channel="threads", status="revoked")
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=conn.id, channel="threads", external_id="m1")
            member_id = uuid.uuid4()

            with pytest.raises(InsightFetchError) as exc_info:
                await reconcile_publication(s, org_id=org_id, publication_id=pub.id, requested_by_member_id=member_id)
            assert exc_info.value.error_code == "CHANNEL_CONNECTION_NOT_ACTIVE"

            # #3612 원칙 — 선검사 실패는 새 증거가 아니라 승격도 기록도 없다.
            rows = (await s.execute(
                select(ChannelPublicationReconciliation).where(ChannelPublicationReconciliation.publication_id == pub.id)
            )).scalars().all()
            assert rows == []
            await s.refresh(conn)
            assert conn.status == "revoked"  # 승격이 일어났다면 status가 바뀌었을 것.
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_reconcile_publication_not_found_raises():
    from app.services.insight_snapshots import InsightFetchError
    from app.services.publication_reconciliation import reconcile_publication

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            member_id = uuid.uuid4()
            with pytest.raises(InsightFetchError) as exc_info:
                await reconcile_publication(s, org_id=org_id, publication_id=uuid.uuid4(), requested_by_member_id=member_id)
            assert exc_info.value.error_code == "INSIGHT_PUBLICATION_NOT_FOUND"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_reconcile_channel_not_implemented_raises():
    from app.services.insight_snapshots import InsightFetchError
    from app.services.publication_reconciliation import reconcile_publication

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            conn = await _seed_channel_connection(s, org_id, channel="wordpress")
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=conn.id, channel="wordpress", external_id="p1")
            member_id = uuid.uuid4()
            with pytest.raises(InsightFetchError) as exc_info:
                await reconcile_publication(s, org_id=org_id, publication_id=pub.id, requested_by_member_id=member_id)
            assert exc_info.value.error_code == "INSIGHT_CHANNEL_NOT_IMPLEMENTED"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_reconcile_real_channel_failure_promotes_connection_status(monkeypatch):
    """선검사가 아니라 실제로 채널을 부른 뒤 받은 실패(예: 토큰 만료)는 새 증거 —
    #3612와 반대로 승격된다(기존 스케줄 tick과 동형)."""
    from app.services.insight_snapshots import InsightFetchError
    from app.services.publication_reconciliation import reconcile_publication
    import app.services.publication_reconciliation as recon_module

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            conn = await _seed_channel_connection(s, org_id, channel="threads", status="active")
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=conn.id, channel="threads", external_id="m1")
            member_id = uuid.uuid4()

            async def _fake_fetch(db, snapshot, **_kwargs):
                raise InsightFetchError(error_code="CHANNEL_TOKEN_EXPIRED", message="token expired")

            monkeypatch.setattr(recon_module, "_fetch_for_snapshot", _fake_fetch)
            with pytest.raises(InsightFetchError) as exc_info:
                await reconcile_publication(s, org_id=org_id, publication_id=pub.id, requested_by_member_id=member_id)
            assert exc_info.value.error_code == "CHANNEL_TOKEN_EXPIRED"

            await s.refresh(conn)
            assert conn.status != "active"
    finally:
        await engine.dispose()


# ─── measured_metrics 확장 2키 — coverage·mismatch rate ──────────────────


@pytest.mark.anyio
async def test_reconciliation_coverage_rate_no_snapshots_is_not_measured():
    from app.services.measured_metrics import compute_measured_metrics

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            result = await compute_measured_metrics(s, org_id=org_id, days=7)
            metric = result["reconciliation_coverage_rate"]
            assert metric["value"] is None
            assert metric["reason_code"] == "NO_SNAPSHOTS"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_reconciliation_coverage_rate_and_mismatch_count_normal_values():
    from app.models.channel_publication_reconciliation import ChannelPublicationReconciliation
    from app.services.measured_metrics import compute_measured_metrics

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            conn = await _seed_channel_connection(s, org_id, channel="threads")
            pub1 = await _seed_channel_publication(s, org_id=org_id, connection_id=conn.id, channel="threads", external_id="m1")
            pub2 = await _seed_channel_publication(s, org_id=org_id, connection_id=conn.id, channel="threads", external_id="m2")
            now = datetime.now(timezone.utc)
            await _seed_captured_snapshot(s, org_id=org_id, publication_id=pub1.id, channel="threads", normalized={})
            await _seed_captured_snapshot(s, org_id=org_id, publication_id=pub2.id, channel="threads", normalized={})

            # pub1만 대조 기록 있음(불일치 1건) — coverage=1/2, mismatch_count=1건
            # (story #3620 CHANGES 2026-09-07 — 「불일치 수」는 정의 3 그대로 수,
            # 비율로 안 지어낸다).
            s.add(ChannelPublicationReconciliation(
                id=uuid.uuid4(), org_id=org_id, publication_id=pub1.id, snapshot_id=None,
                live_raw={"impressions": 10}, verdicts={"impressions": "mismatch"}, has_mismatch=True,
                requested_by_member_id=uuid.uuid4(), created_at=now,
            ))
            await s.commit()

            result = await compute_measured_metrics(s, org_id=org_id, days=7)
            coverage = result["reconciliation_coverage_rate"]
            mismatch = result["reconciliation_mismatch_count"]
            assert coverage["numerator"] == 1
            assert coverage["denominator"] == 2
            assert coverage["value"] == pytest.approx(0.5)
            assert mismatch["reason_code"] is None
            assert mismatch["value"] == 1
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_reconciliation_mismatch_count_all_match_is_real_zero_not_dash():
    """대조 기록은 있는데 전부 일치면 「—」가 아니라 진짜 0건(측정은 됐다)."""
    from app.models.channel_publication_reconciliation import ChannelPublicationReconciliation
    from app.services.measured_metrics import compute_measured_metrics

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            conn = await _seed_channel_connection(s, org_id, channel="threads")
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=conn.id, channel="threads", external_id="m1")
            now = datetime.now(timezone.utc)
            await _seed_captured_snapshot(s, org_id=org_id, publication_id=pub.id, channel="threads", normalized={})
            s.add(ChannelPublicationReconciliation(
                id=uuid.uuid4(), org_id=org_id, publication_id=pub.id, snapshot_id=None,
                live_raw={"impressions": 10}, verdicts={"impressions": "match"}, has_mismatch=False,
                requested_by_member_id=uuid.uuid4(), created_at=now,
            ))
            await s.commit()

            result = await compute_measured_metrics(s, org_id=org_id, days=7)
            metric = result["reconciliation_mismatch_count"]
            assert metric["reason_code"] is None
            assert metric["value"] == 0
            assert metric["value"] is not None  # 「—」(None)와 0 혼동 방지 — 측정은 됐다.
            assert metric["value"] == pytest.approx(0.0)
    finally:
        await engine.dispose()


# ─── [sandbox:insight-drift] 마커(story #3620, 페드루 지시 2026-09-10 — AC5 갭 처방,
# 2차 CHANGES 2026-09-11) — `_fetch_sandbox`가 publication_id만으로 결정되는
# 순수함수라 "예약 캡처"와 "reconcile 재조회"가 항상 같은 값을 내던(라이브에서
# 불일치 재현 불가) 갭의 처방을 종단 검증 — `_fetch_for_snapshot`을 몽키패치하지
# 않고 실제 sandbox 경로(schedule_insight_snapshots→process_due_insight_snapshots
# 캡처 축·reconcile_publication 축)를 그대로 태운다. 1차 처방(발행 후 경과시간
# 임계값)은 예약 캡처 자체가 도달까지 최소 1일(_SNAPSHOT_OFFSETS) 걸려 라이브에서
# 절대 stored>live를 못 만드는 결함이 있어 기각됐다(페드루 CHANGES) — 지금은 호출
# 갈래(live=False 캡처 / live=True reconcile)로만 가른다, 시간 축 0.
#
# publication_id는 매번 새로 뽑는다(이 파일의 다른 테스트들과 같은 DB를 공유·행이
# 테스트 사이에 안 비워지는 관례 — 고정 id는 재실행 시 PK 충돌) · baseline views는
# 그 id로부터 실제 프로덕션 공식(seed=int(hex[:8],16)%500)을 그대로 재계산해 고정값을
# 하드코딩하지 않는다 — drift 50을 뺀 뒤에도 0 밑으로 안 내려가도록 baseline>100만 채택.


def _random_publication_id_with_min_baseline_views(min_views: int = 100) -> uuid.UUID:
    for _ in range(200):
        candidate = uuid.uuid4()
        if int(candidate.hex[:8], 16) % 500 >= min_views:
            return candidate
    raise AssertionError("200회 시도에도 baseline views 조건을 만족하는 uuid4를 못 뽑음")


@pytest.mark.anyio
async def test_capture_path_stores_baseline_even_with_insight_drift_marker(_enable_sandbox_adapter):
    """①캡처 경로(schedule_insight_snapshots→process_due_insight_snapshots, live=False
    기본값) — 마커가 있어도 항상 원값(baseline) 그대로 저장한다. 예약 캡처는 드리프트
    시뮬레이션 대상이 아니다(뮤테이션: live 플래그를 무시하고 항상 드리프트하면 이
    테스트가 baseline-50을 보고 RED — 아래 두 테스트만으론 이 갈래를 못 잡는다)."""
    from app.models.insight_snapshot import InsightSnapshot
    from app.services.insight_snapshots import process_due_insight_snapshots, schedule_insight_snapshots
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            conn = await _seed_channel_connection(s, org_id, channel="sandbox")
            publication_id = _random_publication_id_with_min_baseline_views()
            baseline_views = int(publication_id.hex[:8], 16) % 500
            pub = await _seed_sandbox_publication_with_version_text(
                s, org_id=org_id, connection_id=conn.id, publication_id=publication_id,
                text="본문 [sandbox:insight-drift] 마커 포함", published_at=datetime.now(timezone.utc),
            )
            await schedule_insight_snapshots(
                s, org_id=org_id, work_item_id=uuid.uuid4(), publication_id=pub.id,
                publication_kind="channel_publication", channel="sandbox", external_id=None,
                anchor_at=datetime.now(timezone.utc) - timedelta(days=8),
            )
            await s.commit()
            await process_due_insight_snapshots(s)

            rows = (await s.execute(
                select(InsightSnapshot).where(InsightSnapshot.publication_id == pub.id)
            )).scalars().all()
            assert len(rows) == 2, "+1d·+7d 두 행이 스케줄됐어야 한다"
            assert all(r.status == "captured" for r in rows)
            assert all(r.normalized["views"] == baseline_views for r in rows), "캡처는 마커와 무관하게 항상 원값"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_reconcile_path_insight_drift_marker_creates_mismatch(_enable_sandbox_adapter):
    """②reconcile 경로(live=True) — 마커가 있으면 views가 고정폭(50) 감소해
    stored(캡처 시점 원값)>live(재조회 드리프트값)로 mismatch가 실제로 선다."""
    from app.services.publication_reconciliation import reconcile_publication

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            conn = await _seed_channel_connection(s, org_id, channel="sandbox")
            publication_id = _random_publication_id_with_min_baseline_views()
            baseline_views = int(publication_id.hex[:8], 16) % 500
            pub = await _seed_sandbox_publication_with_version_text(
                s, org_id=org_id, connection_id=conn.id, publication_id=publication_id,
                text="본문 [sandbox:insight-drift] 마커 포함", published_at=datetime.now(timezone.utc),
            )
            # captured 스냅샷은 캡처 경로가 실제로 내는 값(baseline, 위 테스트가 실증)과
            # 동일하게 손으로 심는다 — reconcile 자체의 관심사(live 축)만 격리 검증.
            await _seed_captured_snapshot(
                s, org_id=org_id, publication_id=pub.id, channel="sandbox",
                normalized={
                    "impressions": None, "reach": None, "views": baseline_views,
                    "engagements": None, "clicks": None, "spend": None, "conversions": None,
                },
            )
            member_id = uuid.uuid4()

            record = await reconcile_publication(s, org_id=org_id, publication_id=pub.id, requested_by_member_id=member_id)

            assert record.live_raw["views"] == baseline_views - 50
            assert record.verdicts["views"] == "mismatch"
            assert record.has_mismatch is True
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_reconcile_path_no_marker_matches_baseline(_enable_sandbox_adapter):
    """③마커가 없으면 캡처·reconcile 두 경로가 항상 같은 값(match) — 뮤테이션 가드
    (마커 검사를 빼먹으면 이 테스트가 아니라 위 두 테스트가 각각 반대로 깨진다는
    뜻이 아니라, 마커 검사 자체를 상시-True로 바꾸면 이 테스트만 정확히 RED)."""
    from app.services.publication_reconciliation import reconcile_publication

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            conn = await _seed_channel_connection(s, org_id, channel="sandbox")
            publication_id = _random_publication_id_with_min_baseline_views()
            baseline_views = int(publication_id.hex[:8], 16) % 500
            pub = await _seed_sandbox_publication_with_version_text(
                s, org_id=org_id, connection_id=conn.id, publication_id=publication_id,
                text="마커 없는 평범한 본문", published_at=datetime.now(timezone.utc),
            )
            await _seed_captured_snapshot(
                s, org_id=org_id, publication_id=pub.id, channel="sandbox",
                normalized={
                    "impressions": None, "reach": None, "views": baseline_views,
                    "engagements": None, "clicks": None, "spend": None, "conversions": None,
                },
            )
            member_id = uuid.uuid4()

            record = await reconcile_publication(s, org_id=org_id, publication_id=pub.id, requested_by_member_id=member_id)

            assert record.live_raw["views"] == baseline_views
            assert record.verdicts["views"] == "match"
    finally:
        await engine.dispose()
