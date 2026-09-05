"""story #3540(Phase1·마케팅운영, 페드루 PO 確定 2026-09-06) — 연결 화면 「성과 수집」
섹션 상태 API. beacon 세 세계(아직 안 씀/기록 없음/마지막 기록)·UTM 세 세계(off/
manual/auto). ⛔핵심 방벽 — 상태 조회가 metering key를 발급하지 않는다(관측이 상태를
바꾸는 함정, `get_or_create_active_key`와 다른 경로).

세팅 헬퍼는 test_3354_pageview_counter.py와 동형(중복 재발명 금지)."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

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


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _session_factory():
    from sqlalchemy import text as sa_text
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from app.core.database import Base
    import app.models  # noqa: F401

    engine = create_async_engine(_async_url())
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await conn.execute(sa_text(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_members_org_system_publisher "
            "ON members (org_id) WHERE (runtime_type = 'system-publisher' AND type = 'agent')"
        ))
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_org(session, *, slug=None):
    from app.models.organization import Organization

    org = Organization(id=uuid.uuid4(), name="Measurement Test Org", slug=slug or f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    return org.id


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def _setup_org_scoped_app(app, Session, org_id):
    from app.dependencies.auth import AuthContext, get_current_user

    async def _db():
        async with Session() as s:
            try:
                yield s
                await s.commit()
            except Exception:
                await s.rollback()
                raise

    async def _auth():
        return AuthContext(
            user_id=str(uuid.uuid4()), email="caller@test",
            claims={"app_metadata": {"org_id": str(org_id)}},
        )

    from tests.conftest import override_db_and_read
    override_db_and_read(app, _db)
    app.dependency_overrides[get_current_user] = _auth


def _setup_public_app(app, Session):
    async def _db():
        async with Session() as s:
            try:
                yield s
                await s.commit()
            except Exception:
                await s.rollback()
                raise

    from tests.conftest import override_db_and_read
    override_db_and_read(app, _db)


async def _count_metering_key_rows(session, org_id) -> int:
    from app.models.org_metering_key import OrgMeteringKey
    from sqlalchemy import func, select

    return (await session.execute(
        select(func.count()).select_from(OrgMeteringKey).where(OrgMeteringKey.org_id == org_id)
    )).scalar_one()


@pytest.mark.anyio
async def test_beacon_not_started_and_no_key_row_created_by_repeated_status_reads():
    """⛔핵심 방벽 — 키가 없을 때 상태 조회를 여러 번 불러도 org_metering_keys 행이
    0 그대로다(되돌리면(get_beacon_status 대신 get_or_create_active_key로 바꾸면)
    호출 1회 만에 행 1개가 생겨 RED)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id = await _seed_org(s)

        _setup_org_scoped_app(app, Session, org_id)
        async with _client_for(app) as client:
            for _ in range(3):
                r = await client.get(f"/api/v2/organizations/{org_id}/measurement-connections")
                assert r.status_code == 200, r.text
                body = r.json()
                beacon = next(item for item in body if item["key"] == "beacon")
                assert beacon["status"] == "not_started"
                assert beacon["last_seen_at"] is None
                assert beacon["count_7d"] is None

        async with Session() as s:
            assert await _count_metering_key_rows(s, org_id) == 0, "상태 조회만으로 키가 발급됐다(관측이 상태를 바꿈)"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_beacon_no_data_yet_when_key_issued_but_zero_pageviews():
    from app.main import app
    from app.services.pageview_counter import get_or_create_active_key

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id = await _seed_org(s)
            await get_or_create_active_key(s, org_id=org_id)

        _setup_org_scoped_app(app, Session, org_id)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_id}/measurement-connections")
        body = r.json()
        beacon = next(item for item in body if item["key"] == "beacon")
        assert beacon["status"] == "no_data_yet"
        assert beacon["last_seen_at"] is None
        # 키가 있으면 count_7d는 항상 실수(0 포함) — null은 "키 자체가 없어 측정
        # 개념이 안 선다"는 뜻으로만 쓴다(not_started 전용, null≠0 원칙).
        assert beacon["count_7d"] == 0
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_beacon_has_data_after_real_pageview_hit_reports_last_seen_and_count_7d():
    from app.main import app
    from app.services.pageview_counter import get_or_create_active_key

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id = await _seed_org(s)
            public_key = await get_or_create_active_key(s, org_id=org_id)

        _setup_public_app(app, Session)
        async with _client_for(app) as public_client:
            r_beacon = await public_client.post(
                "/api/v2/public/pageview",
                json={"public_key": public_key, "path": "/ko/blog/hello-world"},
                headers={"user-agent": "Mozilla/5.0 test-browser-measurement"},
            )
        assert r_beacon.status_code == 204

        _setup_org_scoped_app(app, Session, org_id)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_id}/measurement-connections")
        body = r.json()
        beacon = next(item for item in body if item["key"] == "beacon")
        assert beacon["status"] == "has_data"
        assert beacon["last_seen_at"] is not None
        assert beacon["count_7d"] == 1
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_beacon_count_7d_excludes_hits_older_than_7_days():
    """7일 밖 히트는 count_7d에서 빠진다(경계 검증) — last_seen_at은 org_pageview_daily
    전체에서 가장 최근 updated_at이라 오래된 행이어도 여전히 잡힌다(그 값 자체는
    유효한 사실)."""
    from app.main import app
    from app.models.org_pageview_daily import OrgPageviewDaily
    from app.services.pageview_counter import get_or_create_active_key

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id = await _seed_org(s)
            await get_or_create_active_key(s, org_id=org_id)
            old_day = (datetime.now(timezone.utc) - timedelta(days=30)).date()
            s.add(OrgPageviewDaily(
                id=uuid.uuid4(), org_id=org_id, path="/old-post", day=old_day, count=5,
            ))
            await s.commit()

        _setup_org_scoped_app(app, Session, org_id)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_id}/measurement-connections")
        body = r.json()
        beacon = next(item for item in body if item["key"] == "beacon")
        assert beacon["status"] == "has_data"
        assert beacon["count_7d"] == 0, "30일 전 히트가 7일 집계에 잘못 들어감"
        assert beacon["last_seen_at"] is not None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_beacon_count_7d_boundary_is_today_inclusive_6_days_back():
    """페드루 PO REQUIRED(2026-09-06, #3895 리뷰) — 「최근 7일」=오늘 포함 7일(오늘·
    어제·…·6일 전). 정확히 6일 전 히트는 포함되고 7일 전 히트는 빠진다(되돌리면
    timedelta(days=7)이 돼 8일 창이 되는 off-by-one, 7일 전 카운트가 섞여 RED)."""
    from app.main import app
    from app.models.org_pageview_daily import OrgPageviewDaily
    from app.services.pageview_counter import get_or_create_active_key

    engine, Session = await _session_factory()
    try:
        now = datetime.now(timezone.utc)
        async with Session() as s:
            org_id = await _seed_org(s)
            await get_or_create_active_key(s, org_id=org_id)
            s.add(OrgPageviewDaily(
                id=uuid.uuid4(), org_id=org_id, path="/exactly-6-days-ago",
                day=(now - timedelta(days=6)).date(), count=3,
            ))
            s.add(OrgPageviewDaily(
                id=uuid.uuid4(), org_id=org_id, path="/exactly-7-days-ago",
                day=(now - timedelta(days=7)).date(), count=100,
            ))
            await s.commit()

        _setup_org_scoped_app(app, Session, org_id)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_id}/measurement-connections")
        body = r.json()
        beacon = next(item for item in body if item["key"] == "beacon")
        assert beacon["count_7d"] == 3, "6일 전 히트가 빠졌거나 7일 전 히트가 섞였다"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_utm_status_off_when_no_content_rules_row():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id = await _seed_org(s)

        _setup_org_scoped_app(app, Session, org_id)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_id}/measurement-connections")
        body = r.json()
        utm = next(item for item in body if item["key"] == "utm")
        assert utm["status"] == "off"
        assert utm["settings_path"] == "/organization/content-rules"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_utm_status_manual_when_require_utm_true_but_utm_rules_disabled():
    from app.main import app
    from app.models.org_content_rule import OrgContentRule

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id = await _seed_org(s)
            s.add(OrgContentRule(
                id=uuid.uuid4(), org_id=org_id, rules={"require_utm": True}, version=1,
            ))
            await s.commit()

        _setup_org_scoped_app(app, Session, org_id)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_id}/measurement-connections")
        body = r.json()
        utm = next(item for item in body if item["key"] == "utm")
        assert utm["status"] == "manual"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_utm_status_auto_when_utm_rules_enabled():
    from app.main import app
    from app.models.org_content_rule import OrgContentRule

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id = await _seed_org(s)
            s.add(OrgContentRule(
                id=uuid.uuid4(), org_id=org_id,
                rules={"require_utm": False, "utm_rules": {"enabled": True}}, version=1,
            ))
            await s.commit()

        _setup_org_scoped_app(app, Session, org_id)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_id}/measurement-connections")
        body = r.json()
        utm = next(item for item in body if item["key"] == "utm")
        assert utm["status"] == "auto"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_org_isolation_beacon_and_utm_status_scoped_to_caller_org():
    from app.main import app
    from app.models.org_content_rule import OrgContentRule
    from app.services.pageview_counter import get_or_create_active_key

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_a = await _seed_org(s)
            org_b = await _seed_org(s)
            await get_or_create_active_key(s, org_id=org_a)
            s.add(OrgContentRule(
                id=uuid.uuid4(), org_id=org_a,
                rules={"require_utm": False, "utm_rules": {"enabled": True}}, version=1,
            ))
            await s.commit()

        _setup_org_scoped_app(app, Session, org_b)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_b}/measurement-connections")
        body = r.json()
        beacon = next(item for item in body if item["key"] == "beacon")
        utm = next(item for item in body if item["key"] == "utm")
        assert beacon["status"] == "not_started", "org_a의 키가 org_b에 새는 격리 결함"
        assert utm["status"] == "off", "org_a의 utm_rules가 org_b에 새는 격리 결함"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
