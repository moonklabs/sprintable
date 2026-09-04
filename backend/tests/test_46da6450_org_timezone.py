"""story 46da6450(Phase1·BE·소형, 페드루 PO 確定 2026-09-04) — organizations.timezone.

캘린더(#3422)·예약 시각 표기(§11-2)의 tz 정본. 서버 시각 처리는 그대로 UTC-explicit
ISO(scheduled_at 검증기·next_retry_at 무변경) — 이 스토리는 「정본 값 저장·노출」만
다룬다(그라운딩 결론, 스토리 description 참고).

AC 커버: 유효 IANA 저장·무효 IANA 422(ORG_TIMEZONE_INVALID)·null로 해제·member 403·
단건/내 조직 목록 양쪽 응답 노출. 마이그레이션 up/down/up은 별도로 실 PG against
story46da6450_scratch DB로 수동 검증 완료(멱등 재확인 — 컬럼 생성/제거/재생성 확인,
PR 본문에 기록)."""
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


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _session_factory():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from app.core.database import Base
    import app.models  # noqa: F401

    engine = create_async_engine(_async_url())
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_org(session, *, slug=None):
    from app.models.organization import Organization

    org = Organization(id=uuid.uuid4(), name="46da6450 Timezone Test Org", slug=slug or f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    return org.id


async def _seed_human(session, org_id, *, role="owner"):
    from app.models.project import OrgMember
    from app.models.user import User

    user = User(id=uuid.uuid4(), email=f"human-{uuid.uuid4().hex[:8]}@test.dev", hashed_password="x")
    session.add(user)
    await session.commit()
    om = OrgMember(id=uuid.uuid4(), org_id=org_id, user_id=user.id, role=role)
    session.add(om)
    await session.commit()
    return user.id


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def _setup_app(app, Session, *, user_id):
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
        return AuthContext(user_id=str(user_id), email="caller@test", claims={"app_metadata": {}})

    from tests.conftest import override_db_and_read
    override_db_and_read(app, _db)
    app.dependency_overrides[get_current_user] = _auth


@pytest.mark.anyio
async def test_owner_sets_valid_iana_timezone():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id = await _seed_org(s)
            owner_id = await _seed_human(s, org_id, role="owner")

        _setup_app(app, Session, user_id=owner_id)
        async with _client_for(app) as client:
            r = await client.patch(
                f"/api/v2/organizations/{org_id}", json={"timezone": "Asia/Seoul"},
            )
        assert r.status_code == 200, r.text
        assert r.json()["timezone"] == "Asia/Seoul"

        async with Session() as s:
            from app.models.organization import Organization
            org = await s.get(Organization, org_id)
            assert org.timezone == "Asia/Seoul"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_invalid_timezone_returns_422_org_timezone_invalid():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id = await _seed_org(s)
            owner_id = await _seed_human(s, org_id, role="owner")

        _setup_app(app, Session, user_id=owner_id)
        async with _client_for(app) as client:
            r = await client.patch(
                f"/api/v2/organizations/{org_id}", json={"timezone": "Not/AZone"},
            )
        assert r.status_code == 422, r.text
        # app/main.py::http_exception_handler — dict detail은 {"error":{code,message,...}}로
        # 패스스루(구조화 에러 계약, story #2003/#3410 선례).
        error = r.json()["error"]
        assert error["code"] == "ORG_TIMEZONE_INVALID"
        assert "Not/AZone" in error["message"]

        async with Session() as s:
            from app.models.organization import Organization
            org = await s.get(Organization, org_id)
            assert org.timezone is None, "422로 거부됐으면 컬럼이 그대로 null이어야 한다(부분쓰기 없음)"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_explicit_null_clears_timezone():
    """페드루 PO AC2 — "null로 해제 허용". name/slug 패턴(`is not None`이면 스킵)을
    그대로 재사용하면 null 전송이 "무변경"으로 조용히 씹혀 해제가 영원히 불가능해진다
    (그라운딩에서 지적한 정확한 함정) — model_fields_set 분기가 이 케이스를 실제로
    구별하는지 여기서 고정."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id = await _seed_org(s)
            owner_id = await _seed_human(s, org_id, role="owner")
            from app.models.organization import Organization
            org = await s.get(Organization, org_id)
            org.timezone = "Asia/Seoul"
            await s.commit()

        _setup_app(app, Session, user_id=owner_id)
        async with _client_for(app) as client:
            r = await client.patch(
                f"/api/v2/organizations/{org_id}", json={"timezone": None},
            )
        assert r.status_code == 200, r.text
        assert r.json()["timezone"] is None

        async with Session() as s:
            from app.models.organization import Organization
            org = await s.get(Organization, org_id)
            assert org.timezone is None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_omitted_timezone_field_leaves_value_unchanged():
    """해제(explicit null)와 대칭 — 필드 자체를 아예 안 보내면(다른 필드만 PATCH) 기존
    timezone은 그대로 남아야 한다. model_fields_set 분기가 "생략"과 "null 전송"을
    실제로 다르게 취급하는지 이 테스트가 그 반대쪽 절반을 고정한다."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id = await _seed_org(s)
            owner_id = await _seed_human(s, org_id, role="owner")
            from app.models.organization import Organization
            org = await s.get(Organization, org_id)
            org.timezone = "Asia/Seoul"
            await s.commit()

        _setup_app(app, Session, user_id=owner_id)
        async with _client_for(app) as client:
            r = await client.patch(
                f"/api/v2/organizations/{org_id}", json={"name": "Renamed Org"},
            )
        assert r.status_code == 200, r.text
        assert r.json()["timezone"] == "Asia/Seoul"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_member_role_gets_403_setting_timezone():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id = await _seed_org(s)
            member_id = await _seed_human(s, org_id, role="member")

        _setup_app(app, Session, user_id=member_id)
        async with _client_for(app) as client:
            r = await client.patch(
                f"/api/v2/organizations/{org_id}", json={"timezone": "Asia/Seoul"},
            )
        assert r.status_code == 403, r.text
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_admin_role_can_set_timezone():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id = await _seed_org(s)
            admin_id = await _seed_human(s, org_id, role="admin")

        _setup_app(app, Session, user_id=admin_id)
        async with _client_for(app) as client:
            r = await client.patch(
                f"/api/v2/organizations/{org_id}", json={"timezone": "America/New_York"},
            )
        assert r.status_code == 200, r.text
        assert r.json()["timezone"] == "America/New_York"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_single_org_get_exposes_timezone():
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id = await _seed_org(s)
            owner_id = await _seed_human(s, org_id, role="owner")
            from app.models.organization import Organization
            org = await s.get(Organization, org_id)
            org.timezone = "Europe/London"
            await s.commit()

        _setup_app(app, Session, user_id=owner_id)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_id}")
        assert r.status_code == 200, r.text
        assert r.json()["timezone"] == "Europe/London"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_my_organizations_list_exposes_timezone():
    """AC3 — "내 조직 목록"(GET /organizations, 에이전트가 org 컨텍스트를 보는 자리)도
    같은 필드를 노출해야 한다 — OrganizationWithRole/list_for_user 별도 경로가 놓치기
    쉬운 지점(단건 응답과 다른 select문)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id = await _seed_org(s)
            owner_id = await _seed_human(s, org_id, role="owner")
            from app.models.organization import Organization
            org = await s.get(Organization, org_id)
            org.timezone = "Asia/Tokyo"
            await s.commit()

        _setup_app(app, Session, user_id=owner_id)
        async with _client_for(app) as client:
            r = await client.get("/api/v2/organizations")
        assert r.status_code == 200, r.text
        rows = [row for row in r.json() if row["id"] == str(org_id)]
        assert len(rows) == 1
        assert rows[0]["timezone"] == "Asia/Tokyo"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_resolve_by_slug_exposes_timezone():
    """발견 즉시 수정 — `GET /organizations/resolve?slug=`(story 139d2405)도
    MyOrganizationResponse를 쓰는 별도 구성 지점인데 timezone 인자가 누락돼 있었다
    (org 객체엔 실제 값이 있는데도 항상 null로 나갔을 결함, 코드 리딩 중 발견해 즉시
    fix). 목록 API와 같은 필드를 노출하는지 여기서 고정."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id = await _seed_org(s, slug="resolve-tz-test")
            owner_id = await _seed_human(s, org_id, role="owner")
            from app.models.organization import Organization
            org = await s.get(Organization, org_id)
            org.timezone = "Australia/Sydney"
            await s.commit()

        _setup_app(app, Session, user_id=owner_id)
        async with _client_for(app) as client:
            r = await client.get("/api/v2/organizations/resolve", params={"slug": "resolve-tz-test"})
        assert r.status_code == 200, r.text
        assert r.json()["timezone"] == "Australia/Sydney"
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_null_timezone_org_exposed_as_null_not_omitted():
    """null=「미설정」— FE가 브라우저 tz 폴백을 계속 쓰도록, 값이 없으면 명시적으로
    null이어야 한다(필드 자체가 응답에서 빠지면 FE가 다르게 처리할 여지가 생김)."""
    from app.main import app

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id = await _seed_org(s)
            owner_id = await _seed_human(s, org_id, role="owner")

        _setup_app(app, Session, user_id=owner_id)
        async with _client_for(app) as client:
            r = await client.get(f"/api/v2/organizations/{org_id}")
        assert r.status_code == 200, r.text
        body = r.json()
        assert "timezone" in body
        assert body["timezone"] is None
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
