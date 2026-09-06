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
from datetime import datetime, timezone

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
                    "metricHeaders": [{"name": "sessions"}, {"name": "totalUsers"}, {"name": "conversions"}],
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
