"""story #3583-BE(Phase2·마케팅운영, 페드루 PO 確定 2026-09-06) — GA4 «고객 소유»
측정 연결. 이 파일은 `insight_snapshots.py::_maybe_enrich_with_ga4_inflow`(DB
왕복 필요) 전용 — 순수 `_fetch_ga4_inflow`/`ga4_oauth.py` 단위는
`test_3583_ga4_oauth_unit.py`(non-destructive), 라우터 왕복은
`test_3583_ga4_measurement_connection_router.py`로 분리했다(원래 28건 단일
파일이 story #3579 60초 가드 경계대역 추정이라 처음부터 3-way로 쪼갠다).

세팅 헬퍼는 test_e4fc29fa_site_post_orchestration.py·test_3497_insight_
snapshots.py·test_3583_ga4_measurement_connection_router.py 재사용(중복
재발명 금지)."""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest

from tests.test_e4fc29fa_site_post_orchestration import _seed_org, _session_factory
from tests.test_3497_insight_snapshots import _seed_channel_connection, _seed_channel_publication
from tests.test_3583_ga4_measurement_connection_router import (
    _patch_transport,
    _seed_channel_post_version,
    _seed_ga4_connection,
)

_REAL_DB_URL = __import__("os").getenv("PARITY_TEST_DATABASE_URL") or __import__("os").getenv("ALEMBIC_DATABASE_URL")

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


@pytest.mark.anyio
async def test_enrich_skips_hosted_site_publication():
    """그라운딩③ PO 確定 — hosted_site는 그 글이 UTM 링크의 목적지지 발신지가
    아니므로 inflow 부착 스코프 밖."""
    from app.models.insight_snapshot import InsightSnapshot
    from app.services.insight_snapshots import _maybe_enrich_with_ga4_inflow

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_ga4_connection(s, org_id, status="connected", property_id="1", property_name="p")
            snap = InsightSnapshot(
                id=uuid.uuid4(), org_id=org_id, publication_id=uuid.uuid4(), publication_kind="site_post",
                work_item_id=uuid.uuid4(), channel="hosted_site", due_at=datetime.now(timezone.utc),
                normalized={"inflow_sessions": None, "inflow_users": None, "inflow_conversions": None},
            )
            s.add(snap)
            await s.commit()

            await _maybe_enrich_with_ga4_inflow(s, snap)
            assert snap.normalized["inflow_sessions"] is None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_enrich_skips_when_ga4_not_connected():
    from app.models.insight_snapshot import InsightSnapshot
    from app.services.insight_snapshots import _maybe_enrich_with_ga4_inflow

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            conn = await _seed_channel_connection(s, org_id, channel="threads")
            pub = await _seed_channel_publication(s, org_id=org_id, connection_id=conn.id, channel="threads")
            snap = InsightSnapshot(
                id=uuid.uuid4(), org_id=org_id, publication_id=pub.id, publication_kind="channel_publication",
                work_item_id=uuid.uuid4(), channel="threads", due_at=datetime.now(timezone.utc),
                normalized={"inflow_sessions": None},
            )
            s.add(snap)
            await s.commit()

            await _maybe_enrich_with_ga4_inflow(s, snap)  # GA4Connection 행 자체가 없음.
            assert snap.normalized["inflow_sessions"] is None
    finally:
        await engine.dispose()


# story #3684(3682 그라운딩 확定, PO 確定 2026-09-07) — KST 00:30 발행(=UTC 전날
# 15:30) 표본. org tz=Asia/Seoul이면 GA4에 보내는 날짜창이 "발행 org-일"(09-08)로
# 잡혀야 한다(발행 前날 09-07이 1일 성과에 섞이던 3682 실측 결함의 처방).
async def _seed_org_with_timezone(session, *, timezone: str | None):
    org_id, project_id = await _seed_org(session)
    if timezone is not None:
        from sqlalchemy import update as sa_update
        from app.models.organization import Organization
        await session.execute(sa_update(Organization).where(Organization.id == org_id).values(timezone=timezone))
        await session.commit()
    return org_id, project_id


@pytest.mark.anyio
async def test_enrich_ga4_date_range_uses_org_day_for_1d_snapshot_kst_midnight_sample(monkeypatch):
    """AC1 — KST 09-08 00:30 발행 표본, 1d 스냅샷(due_at=+1일) → GA4 요청 날짜창이
    startDate=endDate="2026-09-08"(발행 org-일 단 하루) — 발행 前날(09-07, UTC
    truncate 기준 옛 동작)이 안 섞인다."""
    import httpx

    from app.models.insight_snapshot import InsightSnapshot
    from app.services.insight_snapshots import _maybe_enrich_with_ga4_inflow

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_with_timezone(s, timezone="Asia/Seoul")
            await _seed_ga4_connection(s, org_id, status="connected", property_id="1", property_name="p")
            conn = await _seed_channel_connection(s, org_id, channel="threads")
            _draft, version = await _seed_channel_post_version(
                s, org_id=org_id, work_item_id=uuid.uuid4(), connection_id=conn.id, channel="threads",
                link_url="https://blog.example/ko/blog/my-post",
            )
            from app.models.channel_publication import ChannelPublication
            published_at = datetime(2026, 9, 7, 15, 30, tzinfo=timezone.utc)  # = KST 09-08 00:30
            pub = ChannelPublication(
                id=uuid.uuid4(), org_id=org_id, gate_id=uuid.uuid4(), version_id=version.id,
                connection_id=conn.id, channel="threads", status="published",
                external_id="media-1", published_at=published_at,
            )
            s.add(pub)
            await s.commit()
            snap = InsightSnapshot(
                id=uuid.uuid4(), org_id=org_id, publication_id=pub.id, publication_kind="channel_publication",
                work_item_id=uuid.uuid4(), channel="threads", due_at=published_at + timedelta(days=1),
                normalized={"inflow_sessions": None, "inflow_users": None, "inflow_conversions": None},
            )
            s.add(snap)
            await s.commit()

            captured_body: dict = {}

            def _handler(request: "httpx.Request") -> "httpx.Response":
                if request.url.path.endswith("/token"):
                    return httpx.Response(200, json={"access_token": "fresh-at", "expires_in": 3600})
                import json as _json
                captured_body.update(_json.loads(request.content))
                return httpx.Response(200, json={
                    "metricHeaders": [{"name": "sessions"}, {"name": "totalUsers"}, {"name": "keyEvents"}],
                    "rows": [{"metricValues": [{"value": "3"}, {"value": "2"}, {"value": "0"}]}],
                })

            _patch_transport(monkeypatch, _handler)
            await _maybe_enrich_with_ga4_inflow(s, snap)

            date_range = captured_body["dateRanges"][0]
            assert date_range["startDate"] == "2026-09-08"
            assert date_range["endDate"] == "2026-09-08"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_enrich_ga4_date_range_spans_7_org_days_for_7d_snapshot(monkeypatch):
    """AC1 — 같은 발행 표본의 7d 스냅샷(due_at=+7일) → startDate="2026-09-08"·
    endDate="2026-09-14"(발행 org-일부터 7 org-일, PO 確定 정의)."""
    import httpx

    from app.models.insight_snapshot import InsightSnapshot
    from app.services.insight_snapshots import _maybe_enrich_with_ga4_inflow

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_with_timezone(s, timezone="Asia/Seoul")
            await _seed_ga4_connection(s, org_id, status="connected", property_id="1", property_name="p")
            conn = await _seed_channel_connection(s, org_id, channel="threads")
            _draft, version = await _seed_channel_post_version(
                s, org_id=org_id, work_item_id=uuid.uuid4(), connection_id=conn.id, channel="threads",
                link_url="https://blog.example/ko/blog/my-post",
            )
            from app.models.channel_publication import ChannelPublication
            published_at = datetime(2026, 9, 7, 15, 30, tzinfo=timezone.utc)  # = KST 09-08 00:30
            pub = ChannelPublication(
                id=uuid.uuid4(), org_id=org_id, gate_id=uuid.uuid4(), version_id=version.id,
                connection_id=conn.id, channel="threads", status="published",
                external_id="media-1", published_at=published_at,
            )
            s.add(pub)
            await s.commit()
            snap = InsightSnapshot(
                id=uuid.uuid4(), org_id=org_id, publication_id=pub.id, publication_kind="channel_publication",
                work_item_id=uuid.uuid4(), channel="threads", due_at=published_at + timedelta(days=7),
                normalized={"inflow_sessions": None, "inflow_users": None, "inflow_conversions": None},
            )
            s.add(snap)
            await s.commit()

            captured_body: dict = {}

            def _handler(request: "httpx.Request") -> "httpx.Response":
                if request.url.path.endswith("/token"):
                    return httpx.Response(200, json={"access_token": "fresh-at", "expires_in": 3600})
                import json as _json
                captured_body.update(_json.loads(request.content))
                return httpx.Response(200, json={
                    "metricHeaders": [{"name": "sessions"}, {"name": "totalUsers"}, {"name": "keyEvents"}],
                    "rows": [{"metricValues": [{"value": "9"}, {"value": "8"}, {"value": "1"}]}],
                })

            _patch_transport(monkeypatch, _handler)
            await _maybe_enrich_with_ga4_inflow(s, snap)

            date_range = captured_body["dateRanges"][0]
            assert date_range["startDate"] == "2026-09-08"
            assert date_range["endDate"] == "2026-09-14"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_enrich_ga4_date_range_org_timezone_null_falls_back_to_utc_date_unchanged(monkeypatch):
    """AC2 — org.timezone 미설정(null)이면 옛 동작(UTC .date() 그대로)과 값이
    같다(회귀 0). 같은 발행 시각(UTC 09-07T15:30Z)이 org tz=Asia/Seoul이면
    "09-08"이 됐던 것과 대조 — org tz 없으면 "09-07"(옛 UTC truncate 값)."""
    import httpx

    from app.models.insight_snapshot import InsightSnapshot
    from app.services.insight_snapshots import _maybe_enrich_with_ga4_inflow

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_with_timezone(s, timezone=None)
            await _seed_ga4_connection(s, org_id, status="connected", property_id="1", property_name="p")
            conn = await _seed_channel_connection(s, org_id, channel="threads")
            _draft, version = await _seed_channel_post_version(
                s, org_id=org_id, work_item_id=uuid.uuid4(), connection_id=conn.id, channel="threads",
                link_url="https://blog.example/ko/blog/my-post",
            )
            from app.models.channel_publication import ChannelPublication
            published_at = datetime(2026, 9, 7, 15, 30, tzinfo=timezone.utc)
            pub = ChannelPublication(
                id=uuid.uuid4(), org_id=org_id, gate_id=uuid.uuid4(), version_id=version.id,
                connection_id=conn.id, channel="threads", status="published",
                external_id="media-1", published_at=published_at,
            )
            s.add(pub)
            await s.commit()
            snap = InsightSnapshot(
                id=uuid.uuid4(), org_id=org_id, publication_id=pub.id, publication_kind="channel_publication",
                work_item_id=uuid.uuid4(), channel="threads", due_at=published_at + timedelta(days=1),
                normalized={"inflow_sessions": None, "inflow_users": None, "inflow_conversions": None},
            )
            s.add(snap)
            await s.commit()

            captured_body: dict = {}

            def _handler(request: "httpx.Request") -> "httpx.Response":
                if request.url.path.endswith("/token"):
                    return httpx.Response(200, json={"access_token": "fresh-at", "expires_in": 3600})
                import json as _json
                captured_body.update(_json.loads(request.content))
                return httpx.Response(200, json={
                    "metricHeaders": [{"name": "sessions"}, {"name": "totalUsers"}, {"name": "keyEvents"}],
                    "rows": [{"metricValues": [{"value": "1"}, {"value": "1"}, {"value": "0"}]}],
                })

            _patch_transport(monkeypatch, _handler)
            await _maybe_enrich_with_ga4_inflow(s, snap)

            date_range = captured_body["dateRanges"][0]
            assert date_range["startDate"] == "2026-09-07"
            assert date_range["endDate"] == "2026-09-07"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_enrich_merges_inflow_keys_when_ga4_connected_and_utm_matches(monkeypatch):
    import httpx

    from app.models.insight_snapshot import InsightSnapshot
    from app.services.insight_snapshots import _maybe_enrich_with_ga4_inflow

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_ga4_connection(s, org_id, status="connected", property_id="1", property_name="p")
            conn = await _seed_channel_connection(s, org_id, channel="threads")
            _draft, version = await _seed_channel_post_version(
                s, org_id=org_id, work_item_id=uuid.uuid4(), connection_id=conn.id, channel="threads",
                link_url="https://blog.example/ko/blog/my-post",
            )
            # _seed_channel_publication은 version_id를 무작위로 채운다(FK 없음 관례) —
            # 이 테스트는 실제로 그 버전의 link_url을 읽어야 하므로 직접 구성한다.
            from app.models.channel_publication import ChannelPublication
            pub = ChannelPublication(
                id=uuid.uuid4(), org_id=org_id, gate_id=uuid.uuid4(), version_id=version.id,
                connection_id=conn.id, channel="threads", status="published",
                external_id="media-1", published_at=datetime.now(timezone.utc),
            )
            s.add(pub)
            await s.commit()
            snap = InsightSnapshot(
                id=uuid.uuid4(), org_id=org_id, publication_id=pub.id, publication_kind="channel_publication",
                work_item_id=uuid.uuid4(), channel="threads", due_at=datetime.now(timezone.utc),
                normalized={
                    "impressions": 10, "inflow_sessions": None, "inflow_users": None, "inflow_conversions": None,
                },
            )
            s.add(snap)
            await s.commit()

            def _handler(request: "httpx.Request") -> "httpx.Response":
                if request.url.path.endswith("/token"):
                    return httpx.Response(200, json={"access_token": "fresh-at", "expires_in": 3600})
                return httpx.Response(200, json={
                    "metricHeaders": [{"name": "sessions"}, {"name": "totalUsers"}, {"name": "keyEvents"}],
                    "rows": [{"metricValues": [{"value": "7"}, {"value": "5"}, {"value": "1"}]}],
                })

            _patch_transport(monkeypatch, _handler)
            await _maybe_enrich_with_ga4_inflow(s, snap)
            await s.commit()

            assert snap.normalized["inflow_sessions"] == 7
            assert snap.normalized["inflow_users"] == 5
            assert snap.normalized["inflow_conversions"] == 1
            assert snap.normalized["impressions"] == 10, "기존 채널 키는 그대로 보존"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_enrich_persistent_auth_failure_marks_needs_reauth_without_failing_snapshot(monkeypatch):
    import httpx

    from app.models.ga4_connection import GA4Connection
    from app.models.insight_snapshot import InsightSnapshot
    from app.services.insight_snapshots import _maybe_enrich_with_ga4_inflow
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            await _seed_ga4_connection(s, org_id, status="connected", property_id="1", property_name="p")
            conn = await _seed_channel_connection(s, org_id, channel="threads")
            _draft, version = await _seed_channel_post_version(
                s, org_id=org_id, work_item_id=uuid.uuid4(), connection_id=conn.id, channel="threads",
                link_url="https://blog.example/ko/blog/my-post",
            )
            from app.models.channel_publication import ChannelPublication
            pub = ChannelPublication(
                id=uuid.uuid4(), org_id=org_id, gate_id=uuid.uuid4(), version_id=version.id,
                connection_id=conn.id, channel="threads", status="published",
                external_id="media-1", published_at=datetime.now(timezone.utc),
            )
            s.add(pub)
            await s.commit()
            snap = InsightSnapshot(
                id=uuid.uuid4(), org_id=org_id, publication_id=pub.id, publication_kind="channel_publication",
                work_item_id=uuid.uuid4(), channel="threads", due_at=datetime.now(timezone.utc),
                normalized={"inflow_sessions": None},
            )
            s.add(snap)
            await s.commit()

            _patch_transport(monkeypatch, lambda request: httpx.Response(400, json={"error": "invalid_grant"}))
            await _maybe_enrich_with_ga4_inflow(s, snap)  # 예외를 던지면 안 된다(best-effort).
            await s.commit()

            assert snap.normalized["inflow_sessions"] is None, "실패했으니 미제공 그대로"
            ga4_row = (await s.execute(select(GA4Connection).where(GA4Connection.org_id == org_id))).scalar_one()
            assert ga4_row.status == "needs_reauth"
            assert ga4_row.reason == "revoked"
    finally:
        await engine.dispose()
