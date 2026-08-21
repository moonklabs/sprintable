"""story #2892(P0, 실사고 2026-08-21) — `ee/routers/billing.py::get_billing_status`(FE
`/api/billing/status` → `/api/v2/billing/status`, dev 실측: LICENSE_CONSENT=agreed로
EE 모드 라이브)가 `org_subscriptions.status`를 안 보고 `tier`를 무조건 반환하던 결함.

`org_subscription_checkout.py`의 상태기계는 "청구 성공 時에만 status='active' 전이"를
이미 명시 계약으로 지키는데(모듈 docstring §4), 이 GET 엔드포인트가 그 계약을 무시해
status='pending'(charge 실패·진행중)인 subscription도 tier를 그대로 노출했다 — 실사고:
Decimal TypeError로 charge_org가 Toss 호출 前에 죽어 status='pending'인 채 tier='starter'
가 org_subscriptions에 남았는데, 이 엔드포인트가 그걸 그대로 "지금 tier=starter"로
보여줬다(재로그인해도 재현 — 이 GET이 그 소스, "결제 완료 화면 안 보이는데 요금제는
적용된 것처럼 보인다"는 사용자 관측의 실제 원인)."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
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
def _enable_ee(monkeypatch):
    """dev 실측(2026-08-21, gcloud services describe) — LICENSE_CONSENT=agreed라 이
    엔드포인트가 실제로 라이브다. 이 테스트는 그 상태를 그대로 재현(license_consent
    문자열을 직접 patch — is_ee_enabled는 property라 이 값에서 파생)."""
    from app.core.config import settings
    monkeypatch.setattr(settings, "license_consent", "agreed")


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


async def _seed_org_with_member(session, *, sub_status: str, tier: str = "starter"):
    from app.models.organization import Organization
    from app.models.user import User
    from app.models.project import OrgMember
    from app.models.org_subscription import OrgSubscription

    org = Organization(id=uuid.uuid4(), name="Org2892Status", slug=f"org2892s-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.flush()

    user = User(id=uuid.uuid4(), email=f"u2892-{uuid.uuid4().hex[:8]}@test.local", hashed_password="x")
    session.add(user)
    await session.flush()
    session.add(OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=user.id, role="owner"))

    now = datetime.now(timezone.utc)
    session.add(OrgSubscription(
        id=uuid.uuid4(), org_id=org.id, tier=tier, billing_cycle="monthly",
        status=sub_status, provider="toss", currency="krw",
        current_period_start=now, current_period_end=now + timedelta(days=30),
    ))
    await session.commit()
    return org.id, user.id


def _auth(user_id: uuid.UUID):
    from app.dependencies.auth import AuthContext
    return AuthContext(user_id=str(user_id), email=None, claims={})


@pytest.mark.asyncio
async def test_pending_subscription_reports_free_tier_not_the_unconfirmed_tier():
    """#2892 실사고 정확 재현 — status='pending'인 채 tier='starter'가 앉아 있는 행."""
    from ee.routers.billing import get_billing_status

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, user_id = await _seed_org_with_member(s, sub_status="pending", tier="starter")

        async with Session() as s:
            resp = await get_billing_status(
                org_id=org_id, auth=_auth(user_id), session=s, _ee=None,
            )
            assert resp["tier"] == "free", (
                f"status=pending인데 tier={resp['tier']!r}를 노출 — #2892 실사고 재현. "
                f"청구 미확定 상태를 유료 tier로 보여주면 안 됨."
            )
            assert resp["status"] == "pending"
            assert resp["billing_cycle"] is None
            assert resp["current_period_end"] is None
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_active_subscription_reports_its_real_tier():
    from ee.routers.billing import get_billing_status

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, user_id = await _seed_org_with_member(s, sub_status="active", tier="team")

        async with Session() as s:
            resp = await get_billing_status(
                org_id=org_id, auth=_auth(user_id), session=s, _ee=None,
            )
            assert resp["tier"] == "team"
            assert resp["status"] == "active"
            assert resp["billing_cycle"] == "monthly"
            assert resp["current_period_end"] is not None
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_downgraded_subscription_also_reports_free_not_stale_tier():
    """dunning 8일차 강제하향 후(billing_scheduler.py::downgrade_to_free)도 같은 원칙."""
    from ee.routers.billing import get_billing_status

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, user_id = await _seed_org_with_member(s, sub_status="downgraded", tier="starter")

        async with Session() as s:
            resp = await get_billing_status(
                org_id=org_id, auth=_auth(user_id), session=s, _ee=None,
            )
            assert resp["tier"] == "free"
            assert resp["status"] == "downgraded"
    finally:
        await engine.dispose()
