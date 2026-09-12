"""story #3815(Phase3·3-5 PR3, 페드루 PO 決定) — YouTube 헤드 영상 1d/7d 인사이트
스냅샷(organic) + quota evidence(list=1). `test_3808_x_insights.py`와 동형 구조 —
①실 youtube 200(views·engagements=likeCount+commentCount 합산)②401 승격
③quota evidence 멱등(1d·7d 각자 별도 event)④youtube_sandbox 양성대조(declared
2키만)⑤1d/7d 예약 동형.

세팅 헬퍼는 test_3497_insight_snapshots.py(_patch_threads_transport는 httpx.
AsyncClient 자체를 감싸 채널 무관 재사용 가능·_seed_channel_connection·
_seed_channel_publication)·test_e4fc29fa_site_post_orchestration.py(_seed_org)
재사용(중복 재발명 금지)."""
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


# ─── ① 단위 — _fetch_youtube 정규화 ────────────────────────────────────────────

@pytest.mark.anyio
async def test_fetch_youtube_sums_like_and_comment_count_into_engagements():
    import httpx
    from app.services.insight_snapshots import _fetch_youtube

    transport = httpx.MockTransport(lambda request: httpx.Response(200, json={
        "items": [{"statistics": {"viewCount": "500", "likeCount": "10", "commentCount": "3"}}],
    }))
    async with httpx.AsyncClient(transport=transport) as client:
        result = await _fetch_youtube(client, access_token="at", video_id="v1")
    assert result["values"] == {"views": 500, "engagements": 13}


@pytest.mark.anyio
async def test_fetch_youtube_missing_statistics_leaves_values_empty():
    """items가 비어있으면(예: 삭제된 영상) 지어내지 않고 빈 values — _normalize가
    null로 채운다(이 스토리의 척추 원칙)."""
    import httpx
    from app.services.insight_snapshots import _fetch_youtube

    transport = httpx.MockTransport(lambda request: httpx.Response(200, json={"items": []}))
    async with httpx.AsyncClient(transport=transport) as client:
        result = await _fetch_youtube(client, access_token="at", video_id="v1")
    assert result["values"] == {}


# ─── ② 실 youtube 200/401 ──────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_youtube_200_captures_views_and_engagements(monkeypatch):
    import httpx

    from app.models.insight_snapshot import InsightSnapshot
    from app.services.insight_snapshots import process_due_insight_snapshots, schedule_insight_snapshots
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            connection = await _seed_channel_connection(s, org_id, channel="youtube")
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=connection.id, channel="youtube")
            work_item_id = uuid.uuid4()

            await schedule_insight_snapshots(
                s, org_id=org_id, work_item_id=work_item_id, publication_id=pub.id,
                publication_kind="channel_publication", channel="youtube", external_id=pub.external_id,
                anchor_at=datetime.now(timezone.utc) - timedelta(days=8),
            )
            await s.commit()

            _patch_threads_transport(monkeypatch, lambda request: httpx.Response(200, json={
                "items": [{"statistics": {"viewCount": "1000", "likeCount": "40", "commentCount": "5"}}],
            }))
            counts = await process_due_insight_snapshots(s)

            assert counts["captured"] == 2, counts
            snaps = (await s.execute(
                select(InsightSnapshot).where(InsightSnapshot.publication_id == pub.id)
            )).scalars().all()
            for snap in snaps:
                assert snap.normalized["views"] == 1000
                assert snap.normalized["engagements"] == 45  # 40+5
                # YouTube가 선언 안 한 5축은 null(지어내지 않는다).
                assert snap.normalized["impressions"] is None
                assert snap.normalized["reach"] is None
                assert snap.normalized["clicks"] is None
                assert snap.normalized["spend"] is None
                assert snap.normalized["conversions"] is None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_youtube_401_promotes_connection_and_marks_snapshot_failed(monkeypatch):
    import httpx

    from app.models.channel_connection import ChannelConnection
    from app.services.insight_snapshots import process_due_insight_snapshots, schedule_insight_snapshots

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            connection = await _seed_channel_connection(s, org_id, channel="youtube")
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=connection.id, channel="youtube")
            work_item_id = uuid.uuid4()

            await schedule_insight_snapshots(
                s, org_id=org_id, work_item_id=work_item_id, publication_id=pub.id,
                publication_kind="channel_publication", channel="youtube", external_id=pub.external_id,
                anchor_at=datetime.now(timezone.utc) - timedelta(days=8),
            )
            await s.commit()

            _patch_threads_transport(monkeypatch, lambda request: httpx.Response(401, json={"error": {"message": "expired"}}))
            counts = await process_due_insight_snapshots(s)

            assert counts["failed"] == 2, counts
            conn_row = await s.get(ChannelConnection, connection.id)
            assert conn_row.status != "active"
    finally:
        await engine.dispose()


# ─── ③ quota evidence(list=1) — 1d·7d 각자 별도 event, 재시도는 멱등 ───────────

@pytest.mark.anyio
async def test_youtube_insight_fetch_records_one_list_unit_evidence_per_snapshot(monkeypatch):
    import httpx
    from sqlalchemy import select
    from app.models.evidence import Evidence
    from app.services.insight_snapshots import process_due_insight_snapshots, schedule_insight_snapshots
    from app.services.youtube_quota import YOUTUBE_QUOTA_KIND

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            connection = await _seed_channel_connection(s, org_id, channel="youtube")
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=connection.id, channel="youtube")
            work_item_id = uuid.uuid4()

            await schedule_insight_snapshots(
                s, org_id=org_id, work_item_id=work_item_id, publication_id=pub.id,
                publication_kind="channel_publication", channel="youtube", external_id=pub.external_id,
                anchor_at=datetime.now(timezone.utc) - timedelta(days=8),
            )
            await s.commit()

            _patch_threads_transport(monkeypatch, lambda request: httpx.Response(200, json={
                "items": [{"statistics": {"viewCount": "1", "likeCount": "1", "commentCount": "0"}}],
            }))
            counts = await process_due_insight_snapshots(s)
            assert counts["captured"] == 2, counts

            rows = (await s.execute(
                select(Evidence).where(
                    Evidence.org_id == org_id, Evidence.payload["kind"].astext == YOUTUBE_QUOTA_KIND,
                )
            )).scalars().all()
            # 1d·7d 두 스냅샷 각자 1 unit — 합쳐서 2건(같은 publication이어도
            # snapshot.id가 달라 서로 안 겹친다).
            assert len(rows) == 2, [r.payload for r in rows]
            assert all(r.payload["units"] == 1 for r in rows)
    finally:
        await engine.dispose()


# ─── ④ youtube_sandbox 양성대조 — declared 2키만 ──────────────────────────────

@pytest.mark.anyio
async def test_youtube_sandbox_captures_only_declared_two_keys():
    from app.models.insight_snapshot import InsightSnapshot
    from app.services.insight_snapshots import process_due_insight_snapshots, schedule_insight_snapshots
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            connection = await _seed_channel_connection(s, org_id, channel="youtube_sandbox")
            pub = await _seed_channel_publication(
                s, org_id=org_id, connection_id=connection.id, channel="youtube_sandbox",
            )
            work_item_id = uuid.uuid4()

            await schedule_insight_snapshots(
                s, org_id=org_id, work_item_id=work_item_id, publication_id=pub.id,
                publication_kind="channel_publication", channel="youtube_sandbox", external_id=pub.external_id,
                anchor_at=datetime.now(timezone.utc) - timedelta(days=8),
            )
            await s.commit()

            counts = await process_due_insight_snapshots(s)

            assert counts["captured"] == 2, counts
            snaps = (await s.execute(
                select(InsightSnapshot).where(InsightSnapshot.publication_id == pub.id)
            )).scalars().all()
            for snap in snaps:
                assert snap.normalized["views"] is not None
                assert snap.normalized["engagements"] is not None
                assert snap.normalized["impressions"] is None
                assert snap.normalized["reach"] is None
                assert snap.normalized["clicks"] is None
                assert snap.normalized["spend"] is None
                assert snap.normalized["conversions"] is None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_youtube_sandbox_records_no_quota_evidence():
    """sandbox는 실 API 호출이 없다(제네릭 _fetch_sandbox, DB 접근 0) — quota
    evidence를 기록하면 실제로 쓰지도 않은 quota를 소비한 것처럼 거짓 기록하는
    셈이라 반드시 0건이어야 한다."""
    from sqlalchemy import select
    from app.models.evidence import Evidence
    from app.services.insight_snapshots import process_due_insight_snapshots, schedule_insight_snapshots
    from app.services.youtube_quota import YOUTUBE_QUOTA_KIND

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            connection = await _seed_channel_connection(s, org_id, channel="youtube_sandbox")
            pub = await _seed_channel_publication(
                s, org_id=org_id, connection_id=connection.id, channel="youtube_sandbox",
            )
            work_item_id = uuid.uuid4()

            await schedule_insight_snapshots(
                s, org_id=org_id, work_item_id=work_item_id, publication_id=pub.id,
                publication_kind="channel_publication", channel="youtube_sandbox", external_id=pub.external_id,
                anchor_at=datetime.now(timezone.utc) - timedelta(days=8),
            )
            await s.commit()
            await process_due_insight_snapshots(s)

            rows = (await s.execute(
                select(Evidence).where(
                    Evidence.org_id == org_id, Evidence.payload["kind"].astext == YOUTUBE_QUOTA_KIND,
                )
            )).scalars().all()
            assert rows == []
    finally:
        await engine.dispose()


# ─── ⑤ 1d/7d 예약 동형 ─────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_youtube_schedules_both_1d_and_7d_rows():
    from app.models.insight_snapshot import InsightSnapshot
    from app.services.insight_snapshots import schedule_insight_snapshots
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            connection = await _seed_channel_connection(s, org_id, channel="youtube")
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=connection.id, channel="youtube")
            work_item_id = uuid.uuid4()

            await schedule_insight_snapshots(
                s, org_id=org_id, work_item_id=work_item_id, publication_id=pub.id,
                publication_kind="channel_publication", channel="youtube", external_id=pub.external_id,
                anchor_at=datetime.now(timezone.utc),
            )
            await s.commit()

            rows = (await s.execute(
                select(InsightSnapshot).where(InsightSnapshot.publication_id == pub.id).order_by(InsightSnapshot.due_at)
            )).scalars().all()
        assert len(rows) == 2
        assert (rows[1].due_at - rows[0].due_at) == timedelta(days=6)
    finally:
        await engine.dispose()


# ─── ⑥ 어댑터·드리프트 가드 등록 확認 ───────────────────────────────────────────

def test_youtube_adapters_declare_views_and_engagements():
    from app.services.channel_adapters import CHANNEL_ADAPTERS

    for channel in ("youtube", "youtube_sandbox"):
        assert CHANNEL_ADAPTERS[channel].insight_metrics == ("views", "engagements")
