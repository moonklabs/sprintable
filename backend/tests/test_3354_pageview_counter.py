"""story #3354(마케팅자동화·측정, 페드루 PO 확定 2026-09-03) — 자체 조회수 카운터.

GA4 속성을 우리 계정이 못 읽어(담롱·PO 실측) 자사 서버가 직접 세는 수단. AC 그대로:
beacon 1회 → 집계 1 증가[관측]·GET 반영·같은 UA 1분 내 재요청 억제.

seed 하네스는 test_139d2405_slug_infra_realdb.py 패턴(httpx ASGITransport+override_db_and_read
+claims에 org_id 직접 주입해 get_verified_org_id의 X-Org-Id membership DB 왕복을 우회)을
따른다 — 공개 beacon 라우트는 인증 자체가 없어 이 패턴이 불필요, org-scoped 라우트에만 적용."""
from __future__ import annotations

import os
import uuid

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

    org = Organization(id=uuid.uuid4(), name="Pageview Test Org", slug=slug or f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    return org.id


async def _seed_owner(session, org_id):
    from app.models.project import OrgMember
    from app.models.user import User

    user_id = uuid.uuid4()
    session.add(User(id=user_id, email=f"owner-{user_id.hex[:8]}@test.com", hashed_password="x"))
    await session.commit()
    session.add(OrgMember(id=uuid.uuid4(), org_id=org_id, user_id=user_id, role="owner"))
    await session.commit()
    return user_id


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def _setup_org_scoped_app(app, Session, org_id, *, user_id=None):
    """org-scoped 라우트(GET/POST metering-key·pageviews)용 — public beacon엔 인증이 없어
    이 오버라이드가 불필요(별도 client로 호출). user_id 미지정 시 owner/admin write가
    필요한 엔드포인트(rotate)는 403 — read 전용 테스트는 그래도 무방(랜덤 user_id로 충분,
    get_verified_org_id는 claims의 org_id로 membership DB 왕복 자체를 생략한다)."""
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
            user_id=str(user_id or uuid.uuid4()), email="caller@test",
            claims={"app_metadata": {"org_id": str(org_id)}},
        )

    from tests.conftest import override_db_and_read
    override_db_and_read(app, _db)
    app.dependency_overrides[get_current_user] = _auth


def _setup_public_app(app, Session):
    """공개 beacon 라우트 — 인증 오버라이드 없이 get_db만."""
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


@pytest.mark.anyio
async def test_metering_key_lazy_issue_is_idempotent():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id = await _seed_org(s)
        _setup_org_scoped_app(app, Session, org_id)

        async with _client_for(app) as client:
            r1 = await client.get(f"/api/v2/organizations/{org_id}/metering-key")
            r2 = await client.get(f"/api/v2/organizations/{org_id}/metering-key")
        assert r1.status_code == 200, r1.text
        assert r1.json()["public_key"] == r2.json()["public_key"]
        assert len(r1.json()["public_key"]) > 20
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_rotate_invalidates_old_key():
    from app.main import app
    from app.services.pageview_counter import resolve_org_by_public_key

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id = await _seed_org(s)
            owner_id = await _seed_owner(s, org_id)
        _setup_org_scoped_app(app, Session, org_id, user_id=owner_id)

        async with _client_for(app) as client:
            r1 = await client.get(f"/api/v2/organizations/{org_id}/metering-key")
            old_key = r1.json()["public_key"]
            r2 = await client.post(f"/api/v2/organizations/{org_id}/metering-key/rotate")
            assert r2.status_code == 200, r2.text
            new_key = r2.json()["public_key"]

        assert new_key != old_key
        async with Session() as s:
            assert await resolve_org_by_public_key(s, old_key) is None, "회전된 옛 키가 여전히 org를 해소한다(회귀)"
            assert await resolve_org_by_public_key(s, new_key) == org_id
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_rotate_requires_org_owner_or_admin():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id = await _seed_org(s)
        _setup_org_scoped_app(app, Session, org_id)  # 랜덤 user_id — org 멤버조차 아님

        async with _client_for(app) as client:
            r = await client.post(f"/api/v2/organizations/{org_id}/metering-key/rotate")
        assert r.status_code == 403, "owner/admin 아닌데 rotate가 허용됐다(권한 가드 회귀)"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_beacon_once_increments_and_get_reflects():
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
                json={"public_key": public_key, "path": "/ko/blog/hello-world"},
                headers={"user-agent": "Mozilla/5.0 test-browser-A"},
            )
        assert r.status_code == 204

        _setup_org_scoped_app(app, Session, org_id)
        async with _client_for(app) as client:
            r2 = await client.get(f"/api/v2/organizations/{org_id}/pageviews", params={"path": "/ko/blog/hello-world"})
        rows = r2.json()
        assert len(rows) == 1, rows
        assert rows[0]["count"] == 1, "beacon 1회인데 집계가 1이 아니다(AC 실패)"
        assert rows[0]["path"] == "/ko/blog/hello-world"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_same_ua_within_one_minute_is_suppressed():
    from app.main import app
    from app.services.pageview_counter import get_or_create_active_key

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id = await _seed_org(s)
            public_key = await get_or_create_active_key(s, org_id=org_id)

        _setup_public_app(app, Session)
        ua = {"user-agent": "Mozilla/5.0 test-browser-B"}
        async with _client_for(app) as public_client:
            r1 = await public_client.post(
                "/api/v2/public/pageview", json={"public_key": public_key, "path": "/ko/blog/dup-test"}, headers=ua,
            )
            r2 = await public_client.post(
                "/api/v2/public/pageview", json={"public_key": public_key, "path": "/ko/blog/dup-test"}, headers=ua,
            )
        assert r1.status_code == 204 and r2.status_code == 204

        _setup_org_scoped_app(app, Session, org_id)
        async with _client_for(app) as client:
            r3 = await client.get(f"/api/v2/organizations/{org_id}/pageviews", params={"path": "/ko/blog/dup-test"})
        rows = r3.json()
        assert len(rows) == 1
        assert rows[0]["count"] == 1, "같은 UA 1분 내 재요청인데 집계가 늘었다(AC 실패 — dedup 미작동)"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_different_ua_each_counts_independently():
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
                "/api/v2/public/pageview", json={"public_key": public_key, "path": "/ko/blog/multi-visitor"},
                headers={"user-agent": "Mozilla/5.0 visitor-1"},
            )
            await public_client.post(
                "/api/v2/public/pageview", json={"public_key": public_key, "path": "/ko/blog/multi-visitor"},
                headers={"user-agent": "Mozilla/5.0 visitor-2"},
            )

        _setup_org_scoped_app(app, Session, org_id)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_id}/pageviews", params={"path": "/ko/blog/multi-visitor"})
        rows = r.json()
        assert rows[0]["count"] == 2, "dedup이 UA별이 아니라 path 전체를 막았다(과잉적용 회귀)"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_unknown_public_key_is_silent_noop():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id = await _seed_org(s)

        _setup_public_app(app, Session)
        async with _client_for(app) as public_client:
            r = await public_client.post(
                "/api/v2/public/pageview",
                json={"public_key": "not-a-real-key", "path": "/ko/blog/hello-world"},
                headers={"user-agent": "Mozilla/5.0 test-browser-C"},
            )
        assert r.status_code == 204, "모르는 public_key가 침묵 204가 아니라 에러/다른 코드를 냈다(존재 유출 위험)"

        _setup_org_scoped_app(app, Session, org_id)
        async with _client_for(app) as client:
            r2 = await client.get(f"/api/v2/organizations/{org_id}/pageviews")
        assert r2.json() == [], "모르는 키의 beacon이 실제로 어느 org에 집계됐다(회귀)"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_bot_ua_is_filtered_out():
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
                "/api/v2/public/pageview", json={"public_key": public_key, "path": "/ko/blog/bot-hit"},
                headers={"user-agent": "Googlebot/2.1 (+http://www.google.com/bot.html)"},
            )
        assert r.status_code == 204

        _setup_org_scoped_app(app, Session, org_id)
        async with _client_for(app) as client:
            r2 = await client.get(f"/api/v2/organizations/{org_id}/pageviews", params={"path": "/ko/blog/bot-hit"})
        assert r2.json() == [], "봇 UA인데 집계가 잡혔다(최소 봇 필터 미작동)"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_beacon_route_cors_preflight_open():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        _setup_public_app(app, Session)
        async with _client_for(app) as client:
            r = await client.options(
                "/api/v2/public/pageview",
                headers={"Origin": "https://sprintable.ai", "Access-Control-Request-Method": "POST"},
            )
        assert r.status_code == 204
        assert r.headers.get("access-control-allow-origin") == "*", "beacon 라우트 preflight가 개방 CORS가 아니다"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ── story #3674 CHANGES(페드루 PO, 2026-09-07) — count_7d 창이 org 시간대로 ────

@pytest.mark.anyio
async def test_beacon_status_count_7d_uses_org_timezone_boundary_realdb():
    """쓰기 쪽(record_pageview)이 이미 org tz로 "오늘" 버킷을 잡는데, 읽기 쪽
    (get_beacon_status의 count_7d 창)이 여전히 now.date()(UTC)면 org tz가 UTC보다
    앞선(Asia/Seoul 등) 조직은 방금 쓴 "오늘" 버킷을 7일 창 기준점이 하루 어긋나
    놓칠 수 있다 — 뮤테이션 표적: to_org_date(now, org_timezone)을 now.date()로
    되돌리면 8일 전 표본이 7일 창 밖으로 안 빠져(경계가 하루 밀림) 이 테스트가 RED.

    경계 표본: now=UTC 2026-09-07T23:30 — org tz=Asia/Seoul이면 "오늘"=09-08(7일
    창=[09-02, 09-08]) · org tz=UTC(버그)면 "오늘"=09-07(7일 창=[09-01, 09-07]).
    두 창이 갈리는 지점만 심는다: day=09-08(Seoul 창 안·UTC 창 밖 — org tz 안
    쓰면 이 값이 통째로 빠진다)·day=09-02(둘 다 안·컨트롤)·day=09-01(UTC 창
    안·Seoul 창 밖 — org tz 안 쓰면 이 값이 잘못 들어온다). 정답(Seoul)=09-08+
    09-02=4, 버그(UTC)라면=09-02+09-01=3 — 값 자체가 갈려 뮤테이션이 바로 드러난다."""
    from app.services.pageview_counter import get_beacon_status, get_or_create_active_key
    from app.models.org_pageview_daily import OrgPageviewDaily
    from datetime import date, datetime, timezone
    from sqlalchemy import text as sa_text

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id = await _seed_org(s)
            await s.execute(sa_text(
                f"UPDATE organizations SET timezone='Asia/Seoul' WHERE id='{org_id}'"
            ))
            await s.commit()
            await get_or_create_active_key(s, org_id=org_id)
            for day, count in [(date(2026, 9, 8), 3), (date(2026, 9, 2), 1), (date(2026, 9, 1), 2)]:
                s.add(OrgPageviewDaily(org_id=org_id, path="/p", day=day, count=count))
            await s.commit()

        async with Session() as s:
            beacon = await get_beacon_status(s, org_id=org_id, now=datetime(2026, 9, 7, 23, 30, tzinfo=timezone.utc))
        assert beacon["count_7d"] == 4, "09-08(3)+09-02(1)=4(Seoul 창) — 09-01(2)은 Seoul 기준 창 밖"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_beacon_write_bucket_uses_org_timezone_realdb():
    """쓰기 쪽(public_pageview.py::post_pageview → org_today(org_timezone)) 경계
    표본 — UTC 2026-09-07T23:30에 beacon이 오면 org.timezone='Asia/Seoul'인
    조직은 day='2026-09-08'(그 조직의 "오늘")로 집계돼야 한다(UTC라면 '2026-09-07'
    로 잘못 잡힘). `app.services.org_time.datetime`을 이 순간으로 고정한다.

    story #3674 CHANGES(페드루 PO) 참고 — `org_pageview_daily.day`는 사전 집계라
    org.timezone을 나중에 설정/변경하면 그 순간의 미완료 "오늘" 버킷 하나가 경계를
    한 번 옮겨 앉을 수 있다(예: UTC 버킷에 이미 쌓인 오늘 치가 org tz 전환 후엔
    다른 날짜로 갈릴 후속 hit을 받는다) — 이는 사전 집계의 구조적 성질이지 결함이
    아니다(과거 행을 소급 재계산하지 않는다, 그날 하루만 일시적으로 두 버킷에
    나뉠 수 있음 — 백필 없음 정책과 동형)."""
    from unittest.mock import patch
    from app.main import app
    from app.services.pageview_counter import get_or_create_active_key
    from app.models.org_pageview_daily import OrgPageviewDaily
    from datetime import date, datetime, timezone
    from sqlalchemy import select, text as sa_text

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id = await _seed_org(s)
            await s.execute(sa_text(f"UPDATE organizations SET timezone='Asia/Seoul' WHERE id='{org_id}'"))
            await s.commit()
            public_key = await get_or_create_active_key(s, org_id=org_id)

        _setup_public_app(app, Session)
        with patch("app.services.org_time.datetime") as mock_dt:
            mock_dt.now.return_value = datetime(2026, 9, 7, 23, 30, tzinfo=timezone.utc)
            async with _client_for(app) as public_client:
                r = await public_client.post(
                    "/api/v2/public/pageview",
                    json={"public_key": public_key, "path": "/ko/blog/tz-boundary"},
                    headers={"user-agent": "Mozilla/5.0 test-browser-tz"},
                )
        assert r.status_code == 204

        async with Session() as s:
            rows = (await s.execute(
                select(OrgPageviewDaily.day).where(
                    OrgPageviewDaily.org_id == org_id, OrgPageviewDaily.path == "/ko/blog/tz-boundary",
                )
            )).scalars().all()
        assert rows == [date(2026, 9, 8)], "org tz(Asia/Seoul) 기준 '오늘'(09-08)로 집계돼야 한다"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
