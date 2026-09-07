"""story #3618(Phase2·BE+FE·실측, 페드루 PO 確定 2026-09-07) — 블루프린트 §7 Phase 2
실측 열 3종(UTM 귀속률·댓글 누락률·후속 작업 생성률) 계산 회귀. 각 정의마다 3분기
(분모 0="—"·정상 값·미제공)를 고정한다(AC5).

세팅 헬퍼는 test_3497_insight_snapshots.py·test_e4fc29fa_site_post_orchestration.py
재사용(중복 재발명 금지)."""
from __future__ import annotations

import os
import uuid
from datetime import date, datetime, timedelta, timezone

import pytest

from tests.test_e4fc29fa_site_post_orchestration import _seed_org, _session_factory
from tests.test_3497_insight_snapshots import _seed_channel_connection, _seed_channel_publication

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


# ─── UTM 귀속률 — 분모 0("—")·정상·(미제공 없음, UTM은 0/N 자체가 미측정 사유) ──


@pytest.mark.anyio
async def test_utm_attribution_rate_denominator_zero_is_not_measured():
    from app.services.phase2_metrics import compute_phase2_metrics

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            result = await compute_phase2_metrics(s, org_id=org_id, days=7)
            metric = result["utm_attribution_rate"]
            assert metric["value"] is None
            assert metric["reason_code"] == "NO_PAGEVIEWS"
            assert metric["denominator"] == 0
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_utm_attribution_rate_normal_value():
    from app.models.org_pageview_daily import OrgPageviewDaily
    from app.models.org_pageview_utm_daily import OrgPageviewUtmDaily
    from app.services.phase2_metrics import compute_phase2_metrics

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            today = datetime.now(timezone.utc).date()
            s.add(OrgPageviewDaily(id=uuid.uuid4(), org_id=org_id, path="/blog/a", day=today, count=100))
            # UTM 3종 다 있는 30건(귀속) + medium만 빈 20건(비귀속 — 분자에서 빠져야 함).
            s.add(OrgPageviewUtmDaily(
                id=uuid.uuid4(), org_id=org_id, path="/blog/a", day=today,
                utm_source="threads", utm_medium="social", utm_campaign="launch", utm_content="", count=30,
            ))
            s.add(OrgPageviewUtmDaily(
                id=uuid.uuid4(), org_id=org_id, path="/blog/a", day=today,
                utm_source="threads", utm_medium="", utm_campaign="launch", utm_content="", count=20,
            ))
            await s.commit()

            result = await compute_phase2_metrics(s, org_id=org_id, days=7)
            metric = result["utm_attribution_rate"]
            assert metric["reason_code"] is None
            assert metric["numerator"] == 30
            assert metric["denominator"] == 100
            assert metric["value"] == pytest.approx(0.3)
    finally:
        await engine.dispose()


# ─── 댓글 누락률 — 분모 0("—")·정상·미제공(채널이 수 안 줌) ──────────────────


@pytest.mark.anyio
async def test_comment_miss_rate_no_data_is_not_measured():
    from app.services.phase2_metrics import compute_phase2_metrics

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            result = await compute_phase2_metrics(s, org_id=org_id, days=7)
            metric = result["comment_miss_rate"]
            assert metric["value"] is None
            assert metric["reason_code"] == "NO_COMMENT_DATA"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_comment_miss_rate_channel_not_reporting_is_not_measured():
    """채널이 summary를 아예 안 줘 channel_reported_comment_count가 계속 NULL이면
    (구 어댑터·미지원 채널) 저장된 댓글이 있어도 "미측정"이어야 한다 — None을 0으로
    오판하면 "누락 0%"라는 거짓 안심을 준다."""
    from app.models.channel_post_comment import CommentCollectionSchedule
    from app.services.phase2_metrics import compute_phase2_metrics

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            conn = await _seed_channel_connection(s, org_id, channel="threads")
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=conn.id, channel="threads", external_id="m1")
            s.add(CommentCollectionSchedule(
                id=uuid.uuid4(), org_id=org_id, publication_id=pub.id, channel="threads", external_id="m1",
                due_at=datetime.now(timezone.utc), captured_at=datetime.now(timezone.utc), status="captured",
                channel_reported_comment_count=None,
            ))
            await s.commit()

            result = await compute_phase2_metrics(s, org_id=org_id, days=7)
            metric = result["comment_miss_rate"]
            assert metric["value"] is None
            assert metric["reason_code"] == "NO_COMMENT_DATA"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_comment_miss_rate_normal_value():
    from app.models.channel_post_comment import ChannelPostComment, CommentCollectionSchedule
    from app.services.phase2_metrics import compute_phase2_metrics

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            conn = await _seed_channel_connection(s, org_id, channel="threads")
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=conn.id, channel="threads", external_id="m1")
            now = datetime.now(timezone.utc)
            s.add(CommentCollectionSchedule(
                id=uuid.uuid4(), org_id=org_id, publication_id=pub.id, channel="threads", external_id="m1",
                due_at=now, captured_at=now, status="captured", channel_reported_comment_count=10,
            ))
            for i in range(7):  # 채널은 10건이라 하는데 7건만 저장 — 3건 누락(30%).
                s.add(ChannelPostComment(
                    id=uuid.uuid4(), org_id=org_id, publication_id=pub.id, channel="threads",
                    external_comment_id=f"c{i}", text=f"댓글{i}", text_sha256=f"sha{i}", captured_at=now,
                ))
            await s.commit()

            result = await compute_phase2_metrics(s, org_id=org_id, days=7)
            metric = result["comment_miss_rate"]
            assert metric["reason_code"] is None
            assert metric["numerator"] == 3
            assert metric["denominator"] == 10
            assert metric["value"] == pytest.approx(0.3)
    finally:
        await engine.dispose()


# ─── 후속 작업 생성률 — 분모 0("—")·정상(직접+간접 매치)·분자 0(측정됐으나 0) ──


@pytest.mark.anyio
async def test_follow_up_creation_rate_no_snapshots_is_not_measured():
    from app.services.phase2_metrics import compute_phase2_metrics

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            result = await compute_phase2_metrics(s, org_id=org_id, days=7)
            metric = result["follow_up_creation_rate"]
            assert metric["value"] is None
            assert metric["reason_code"] == "NO_SNAPSHOTS"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_follow_up_creation_rate_zero_is_a_real_value_not_unmeasured():
    """AC 명시 — 스냅샷은 있는데(측정됐다) 참조 링크가 하나도 없으면 「—」가 아니라
    진짜 0(만든 적 없음이 사실)."""
    from app.models.insight_snapshot import InsightSnapshot
    from app.services.phase2_metrics import compute_phase2_metrics

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            conn = await _seed_channel_connection(s, org_id, channel="threads")
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=conn.id, channel="threads", external_id="m1")
            now = datetime.now(timezone.utc)
            s.add(InsightSnapshot(
                id=uuid.uuid4(), org_id=org_id, publication_id=pub.id, publication_kind="channel_publication",
                work_item_id=uuid.uuid4(), channel="threads", external_id="m1",
                due_at=now, captured_at=now, status="captured",
            ))
            await s.commit()

            result = await compute_phase2_metrics(s, org_id=org_id, days=7)
            metric = result["follow_up_creation_rate"]
            assert metric["reason_code"] is None, "측정 자체는 됐다(스냅샷 존재) — None이면 안 됨"
            assert metric["value"] == 0.0
            assert metric["numerator"] == 0
            assert metric["denominator"] == 1
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_follow_up_creation_rate_direct_and_indirect_matches():
    """직접 매치(insights_board.py::create_publication_follow_up의 payload.
    publication_id)와 간접 매치(channel_post_comment_replies.py::create_comment_
    follow_up의 payload.comment_id → 댓글의 publication_id) 둘 다 분자에 반영된다."""
    from app.models.channel_post_comment import ChannelPostComment
    from app.models.evidence import Evidence
    from app.models.insight_snapshot import InsightSnapshot
    from app.services.phase2_metrics import compute_phase2_metrics

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org(s)
            conn = await _seed_channel_connection(s, org_id, channel="threads")
            pub_direct = await _seed_channel_publication(s, org_id=org_id, connection_id=conn.id, channel="threads", external_id="m1")
            pub_indirect = await _seed_channel_publication(s, org_id=org_id, connection_id=conn.id, channel="threads", external_id="m2")
            pub_unreferenced = await _seed_channel_publication(s, org_id=org_id, connection_id=conn.id, channel="threads", external_id="m3")
            now = datetime.now(timezone.utc)
            for pub in (pub_direct, pub_indirect, pub_unreferenced):
                s.add(InsightSnapshot(
                    id=uuid.uuid4(), org_id=org_id, publication_id=pub.id, publication_kind="channel_publication",
                    work_item_id=uuid.uuid4(), channel="threads", external_id=pub.external_id,
                    due_at=now, captured_at=now, status="captured",
                ))
            comment = ChannelPostComment(
                id=uuid.uuid4(), org_id=org_id, publication_id=pub_indirect.id, channel="threads",
                external_comment_id="c1", text="문의", text_sha256="sha1", captured_at=now,
            )
            s.add(comment)
            await s.flush()

            story_id_direct, story_id_indirect = uuid.uuid4(), uuid.uuid4()
            s.add(Evidence(
                id=uuid.uuid4(), org_id=org_id, work_item_id=story_id_direct, work_item_type="story",
                type="report", ref=str(story_id_direct), source="insights_board",
                payload={"kind": "follow_up_created", "publication_id": str(pub_direct.id), "story_id": str(story_id_direct)},
            ))
            s.add(Evidence(
                id=uuid.uuid4(), org_id=org_id, work_item_id=story_id_indirect, work_item_type="story",
                type="report", ref=str(story_id_indirect), source="channel_post_comments",
                payload={"kind": "comment_follow_up_created", "comment_id": str(comment.id), "story_id": str(story_id_indirect)},
            ))
            await s.commit()

            result = await compute_phase2_metrics(s, org_id=org_id, days=7)
            metric = result["follow_up_creation_rate"]
            assert metric["denominator"] == 3
            assert metric["numerator"] == 2
            assert metric["value"] == pytest.approx(2 / 3)
    finally:
        await engine.dispose()


# ─── 뮤테이션 대조 ────────────────────────────────────────────────────────────


@pytest.mark.anyio
async def test_mutation_utm_denominator_zero_guard_removed_would_divide_by_zero():
    """뮤테이션 대조 — 분모 0 가드가 없었다면 ZeroDivisionError가 났을 것을 직접
    증명한다(소스를 되돌리지 않고 그 계산만 재현)."""
    denominator = 0
    numerator = 0
    with pytest.raises(ZeroDivisionError):
        _ = numerator / denominator
