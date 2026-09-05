"""story #3506(Phase2·마케팅운영, 페드루 PO 確定 2026-09-05) — UTM 귀속 조각②(beacon
4필드 기록 + `org_pageview_utm_daily` 일별 집계). 세팅 헬퍼는 test_3354_pageview_
counter.py와 동형(중복 재발명 금지) — beacon 인프라(org_metering_keys·rate limiter)는
그대로 재사용, 이 스토리 전용(utm_* 4필드+신규 집계 테이블)만 새로 추가한다."""
from __future__ import annotations

import os
import uuid

import pytest

from tests.test_3354_pageview_counter import (
    _client_for,
    _seed_org,
    _session_factory,
    _setup_public_app,
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


async def _get_utm_rows(session, org_id, path):
    from sqlalchemy import select
    from app.models.org_pageview_utm_daily import OrgPageviewUtmDaily

    rows = (await session.execute(
        select(OrgPageviewUtmDaily).where(OrgPageviewUtmDaily.org_id == org_id, OrgPageviewUtmDaily.path == path)
    )).scalars().all()
    return rows


@pytest.mark.anyio
async def test_beacon_with_utm_records_aggregate_row():
    from app.main import app
    from app.services.pageview_counter import get_or_create_active_key

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id = await _seed_org(s)
            public_key = await get_or_create_active_key(s, org_id=org_id)

        _setup_public_app(app, Session)
        async with _client_for(app) as public_client:
            r = await public_client.post(
                "/api/v2/public/pageview",
                json={
                    "public_key": public_key, "path": "/ko/blog/utm-post",
                    "utm_source": "Newsletter", "utm_medium": "Email",
                    "utm_campaign": "Launch", "utm_content": "draft-abc",
                },
                headers={"user-agent": "Mozilla/5.0 test-utm-A"},
            )
        assert r.status_code == 204

        async with Session() as s:
            rows = await _get_utm_rows(s, org_id, "/ko/blog/utm-post")
        assert len(rows) == 1
        row = rows[0]
        assert row.count == 1
        # 소문자+trim 정규화(대소문자만 다른 같은 캠페인이 다른 그룹으로 안 쪼개지게).
        assert row.utm_source == "newsletter"
        assert row.utm_medium == "email"
        assert row.utm_campaign == "launch"
        assert row.utm_content == "draft-abc"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_beacon_without_utm_does_not_write_utm_table():
    """PO 決定(d) — utm_* 4개가 전부 없으면(순수 pageview) 이 테이블엔 아예 안 쓴다
    (org_pageview_daily만 늘어난다, 회귀 0)."""
    from app.main import app
    from app.services.pageview_counter import get_or_create_active_key

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id = await _seed_org(s)
            public_key = await get_or_create_active_key(s, org_id=org_id)

        _setup_public_app(app, Session)
        async with _client_for(app) as public_client:
            r = await public_client.post(
                "/api/v2/public/pageview",
                json={"public_key": public_key, "path": "/ko/blog/plain-post"},
                headers={"user-agent": "Mozilla/5.0 test-utm-B"},
            )
        assert r.status_code == 204

        async with Session() as s:
            rows = await _get_utm_rows(s, org_id, "/ko/blog/plain-post")
        assert rows == [], "utm_* 없는 순수 pageview가 UTM 집계 테이블에 행을 만들었다"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_beacon_utm_upsert_increments_same_grouping():
    """같은 (org, path, day, 4키) 조합으로 2번 beacon → count=2(다른 UA로 dedup 우회)."""
    from app.main import app
    from app.services.pageview_counter import get_or_create_active_key

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id = await _seed_org(s)
            public_key = await get_or_create_active_key(s, org_id=org_id)

        body = {
            "public_key": public_key, "path": "/ko/blog/utm-repeat",
            "utm_source": "twitter", "utm_medium": "social",
            "utm_campaign": "launch", "utm_content": "draft-xyz",
        }
        _setup_public_app(app, Session)
        async with _client_for(app) as public_client:
            r1 = await public_client.post(
                "/api/v2/public/pageview", json=body, headers={"user-agent": "Mozilla/5.0 test-utm-C1"},
            )
            r2 = await public_client.post(
                "/api/v2/public/pageview", json=body, headers={"user-agent": "Mozilla/5.0 test-utm-C2"},
            )
        assert r1.status_code == 204 and r2.status_code == 204

        async with Session() as s:
            rows = await _get_utm_rows(s, org_id, "/ko/blog/utm-repeat")
        assert len(rows) == 1, "같은 그룹핑 키인데 행이 갈라졌다(UNIQUE 제약/upsert 결함)"
        assert rows[0].count == 2
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_beacon_utm_different_campaign_same_path_separate_rows():
    """같은 path·다른 campaign은 별도 행(그룹핑 축이 utm_campaign도 포함한다는 확인)."""
    from app.main import app
    from app.services.pageview_counter import get_or_create_active_key

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id = await _seed_org(s)
            public_key = await get_or_create_active_key(s, org_id=org_id)

        _setup_public_app(app, Session)
        async with _client_for(app) as public_client:
            await public_client.post(
                "/api/v2/public/pageview",
                json={
                    "public_key": public_key, "path": "/ko/blog/multi-campaign",
                    "utm_source": "twitter", "utm_medium": "social", "utm_campaign": "spring",
                },
                headers={"user-agent": "Mozilla/5.0 test-utm-D1"},
            )
            await public_client.post(
                "/api/v2/public/pageview",
                json={
                    "public_key": public_key, "path": "/ko/blog/multi-campaign",
                    "utm_source": "twitter", "utm_medium": "social", "utm_campaign": "summer",
                },
                headers={"user-agent": "Mozilla/5.0 test-utm-D2"},
            )

        async with Session() as s:
            rows = await _get_utm_rows(s, org_id, "/ko/blog/multi-campaign")
        campaigns = sorted(r.utm_campaign for r in rows)
        assert campaigns == ["spring", "summer"]
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_beacon_utm_partial_fields_missing_ones_are_empty_string_not_null():
    """utm_content만 없으면(source/medium/campaign만) 그 컬럼은 빈 문자열(NOT NULL) —
    NULL이면 UNIQUE 제약이 매번 새 행을 만든다(마이그 docstring이 경고하는 그 함정)."""
    from app.main import app
    from app.services.pageview_counter import get_or_create_active_key

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id = await _seed_org(s)
            public_key = await get_or_create_active_key(s, org_id=org_id)

        _setup_public_app(app, Session)
        async with _client_for(app) as public_client:
            await public_client.post(
                "/api/v2/public/pageview",
                json={
                    "public_key": public_key, "path": "/ko/blog/partial-utm",
                    "utm_source": "twitter", "utm_medium": "social", "utm_campaign": "x",
                },
                headers={"user-agent": "Mozilla/5.0 test-utm-E"},
            )

        async with Session() as s:
            rows = await _get_utm_rows(s, org_id, "/ko/blog/partial-utm")
        assert len(rows) == 1
        assert rows[0].utm_content == ""
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


def test_normalize_utm_lowercases_trims_and_caps_length():
    from app.routers.public_pageview import _normalize_utm, _UTM_MAX_LEN

    assert _normalize_utm(None) is None
    assert _normalize_utm("  ") is None
    assert _normalize_utm("  Newsletter  ") == "newsletter"
    long_value = "x" * (_UTM_MAX_LEN + 50)
    result = _normalize_utm(long_value)
    assert result is not None and len(result) == _UTM_MAX_LEN
