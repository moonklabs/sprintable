"""story #2728(P0·과금) — platform_settings 싱글턴 실 Postgres 검증.

핵심 검증축(선생님 결정② 집행): ①마이그 시드가 정확히 1행·둘 다 false로 시작 ②GET
/api/v2/platform-settings가 그 값을 그대로 반환 ③checkout/pack-purchase가 off일 때
서버측에서 무조건 403(FE 숨김에 기대지 않음) ④DB에서 직접 값을 true로 바꾸면(어드민
mutation의 대역 — 실제 internal-api PATCH는 별도 레포) 즉시 게이트가 열림(polling 없이
매 요청 재조회하는지 확認 — 캐시돼서 재배포 전엔 안 바뀌는 클래스가 아닌지)."""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요 — alembic upgrade heads 적용된 DB"),
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
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    engine = create_async_engine(_async_url())
    return engine, async_sessionmaker(engine, expire_on_commit=False)


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def _auth_override(member_id, org_id):
    async def _auth():
        from app.dependencies.auth import AuthContext
        return AuthContext(
            user_id=str(member_id), email="agent@test",
            claims={"app_metadata": {"org_id": str(org_id), "api_key_id": "test-key"}},
        )
    return _auth


async def _setup_app(app, Session, member_id, org_id):
    from app.dependencies.auth import get_current_user, get_verified_org_id, get_verified_org_id_no_project_gate
    from tests.conftest import override_db_and_read

    async def _db():
        async with Session() as s:
            yield s

    async def _org():
        return org_id

    override_db_and_read(app, _db)
    app.dependency_overrides[get_current_user] = _auth_override(member_id, org_id)
    app.dependency_overrides[get_verified_org_id] = _org
    app.dependency_overrides[get_verified_org_id_no_project_gate] = _org


@pytest.mark.anyio
async def test_migration_seeds_exactly_one_row_both_false():
    from app.models.platform_setting import PlatformSetting
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            rows = (await s.execute(select(PlatformSetting))).scalars().all()
            assert len(rows) == 1, "platform_settings는 싱글턴 — 정확히 1행이어야 한다"
            assert rows[0].billing_price_public is False
            assert rows[0].billing_checkout_enabled is False
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_get_endpoint_returns_seed_values():
    from app.main import app
    from app.models.member import Member
    from app.models.organization import Organization

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = Organization(id=uuid.uuid4(), name="2728 Org", slug=f"s2728-{uuid.uuid4().hex[:8]}")
            s.add(org)
            await s.commit()
            member = Member(id=uuid.uuid4(), org_id=org.id, type="agent", name="A", is_active=True)
            s.add(member)
            await s.commit()
            org_id, member_id = org.id, member.id

        await _setup_app(app, Session, member_id, org_id)
        client = _client_for(app)
        try:
            resp = await client.get("/api/v2/platform-settings")
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["billing_price_public"] is False
            assert body["billing_checkout_enabled"] is False
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_checkout_rejected_403_when_disabled_real_db():
    """FE 숨김이 아니라 서버가 직접 거부 — auth_key가 가짜라도(=결제 로직 자체엔 절대
    안 들어감을 증명), 게이트가 그 前에 막아 403으로 끝난다."""
    from app.main import app
    from app.models.member import Member
    from app.models.organization import Organization
    from app.models.project import OrgMember

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = Organization(id=uuid.uuid4(), name="2728 Org2", slug=f"s2728b-{uuid.uuid4().hex[:8]}")
            s.add(org)
            await s.commit()
            member = Member(id=uuid.uuid4(), org_id=org.id, type="human", name="Owner", is_active=True)
            s.add(member)
            await s.commit()
            s.add(OrgMember(org_id=org.id, user_id=member.id, role="owner"))
            await s.commit()
            org_id, member_id = org.id, member.id

        await _setup_app(app, Session, member_id, org_id)
        client = _client_for(app)
        try:
            resp = await client.post(
                "/api/v2/org-subscriptions/checkout",
                json={"auth_key": "fake-not-a-real-toss-key", "tier": "team", "billing_cycle": "monthly"},
            )
            assert resp.status_code == 403, resp.text
            assert "not yet enabled" in resp.text
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_toggling_row_directly_takes_effect_next_request_no_cache():
    """③④ 통합 — off→confirmed 403 재현 後, 같은 행을 true로 바꾸고(어드민 PATCH의
    대역 — 실제 mutation은 sprintable-admin/internal-api 전용) 다음 요청에서 즉시
    게이트가 열리는지(요청마다 재조회하는지, 캐시/재시작 필요 없는지) 확認."""
    from app.main import app
    from app.models.member import Member
    from app.models.organization import Organization
    from app.models.platform_setting import PlatformSetting
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = Organization(id=uuid.uuid4(), name="2728 Org3", slug=f"s2728c-{uuid.uuid4().hex[:8]}")
            s.add(org)
            await s.commit()
            member = Member(id=uuid.uuid4(), org_id=org.id, type="agent", name="A", is_active=True)
            s.add(member)
            await s.commit()
            org_id, member_id = org.id, member.id

        await _setup_app(app, Session, member_id, org_id)
        client = _client_for(app)
        try:
            resp1 = await client.get("/api/v2/platform-settings")
            assert resp1.json()["billing_checkout_enabled"] is False

            async with Session() as s:
                row = (await s.execute(select(PlatformSetting))).scalars().one()
                row.billing_checkout_enabled = True
                await s.commit()

            resp2 = await client.get("/api/v2/platform-settings")
            assert resp2.json()["billing_checkout_enabled"] is True, (
                "toggle이 다음 요청에서 즉시 반영돼야 한다(캐시/재시작 불요)"
            )
        finally:
            await client.aclose()
            # 다른 테스트(싱글턴 시드값 가정)에 영향 안 주도록 원복.
            async with Session() as s:
                row = (await s.execute(select(PlatformSetting))).scalars().one()
                row.billing_checkout_enabled = False
                await s.commit()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()
