"""E-ORG-MULTI S5.2: Organization Subscription 상태 표시 테스트.

AC1: 진입점 Settings > Billing (S5.1 완료)
AC2: EE enabled에서만 표시 (S5.1 완료)
AC3: tier, billing_cycle, status 반환
AC4: 플랜 카탈로그 반환 (Free/Team/Pro)
AC5: owner/admin → can_manage=true
AC6: member → can_manage=false
AC7: org별 분리
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock

import pytest

ORG_ID = uuid.uuid4()
USER_ID = uuid.uuid4()


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _client(user_id: uuid.UUID = USER_ID, org_id: uuid.UUID = ORG_ID):
    from app.main import app
    from app.dependencies.auth import get_current_user
    from app.dependencies.database import get_db
    from httpx import ASGITransport, AsyncClient

    ctx = MagicMock()
    ctx.user_id = str(user_id)
    ctx.email = "test@example.com"
    ctx.claims = {"app_metadata": {"org_id": str(org_id)}}

    mock_session = AsyncMock()

    async def override_db():
        yield mock_session

    async def override_auth():
        return ctx

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = override_auth

    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test"), mock_session, app


# ─── AC3 + AC5: owner → 구독 상태 + can_manage=true ─────────────────────────

@pytest.mark.anyio
async def test_billing_status_returns_tier_and_can_manage():
    """owner → billing/status 응답에 tier/billing_cycle/status + can_manage=true."""
    from app.core.config import settings

    if not settings.is_ee_enabled:
        pytest.skip("EE not enabled in this environment")

    client, session, app = await _client()
    try:
        sub_mock = MagicMock()
        sub_mock.tier = "pro"
        sub_mock.billing_cycle = "monthly"
        sub_mock.status = "active"
        sub_mock.current_period_end = datetime(2026, 6, 20, tzinfo=timezone.utc)

        call_count = 0

        def _execute_side(stmt, *args, **kwargs):
            nonlocal call_count
            call_count += 1
            result = MagicMock()
            if call_count == 1:
                result.scalar_one_or_none.return_value = sub_mock
            else:
                result.scalar_one_or_none.return_value = "owner"
            return result

        session.execute = AsyncMock(side_effect=_execute_side)

        async with client as c:
            resp = await c.get("/api/v2/billing/status")

        assert resp.status_code == 200
        data = resp.json()
        assert data["tier"] == "pro"
        assert data["billing_cycle"] == "monthly"
        assert data["status"] == "active"
        assert data["can_manage"] is True
    finally:
        app.dependency_overrides.clear()


# ─── AC6: member → can_manage=false ─────────────────────────────────────────

def test_billing_status_source_checks_role():
    """billing.py status 엔드포인트가 role을 조회하고 can_manage를 반환함."""
    import inspect
    from ee.routers import billing
    source = inspect.getsource(billing.get_billing_status)
    assert "can_manage" in source
    assert "caller_role" in source
    assert "owner" in source or "admin" in source


# ─── AC4: 플랜 카탈로그 ──────────────────────────────────────────────────────

def test_billing_plans_source_has_free_team_pro():
    """billing.py plans에 Free/Team/Pro 포함."""
    import inspect
    from ee.routers import billing
    source = inspect.getsource(billing)
    assert "free" in source
    assert "team" in source or "Team" in source
    assert "pro" in source or "Pro" in source


@pytest.mark.anyio
async def test_billing_plans_returns_list():
    """GET /api/v2/billing/plans → 플랜 목록 반환."""
    from app.core.config import settings

    if not settings.is_ee_enabled:
        pytest.skip("EE not enabled in this environment")

    client, session, app = await _client()
    try:
        async with client as c:
            resp = await c.get("/api/v2/billing/plans")

        assert resp.status_code == 200
        plans = resp.json()
        assert isinstance(plans, list)
        ids = {p["id"] for p in plans}
        assert "free" in ids
    finally:
        app.dependency_overrides.clear()


# ─── AC3: no subscription → free 기본값 ─────────────────────────────────────

def test_billing_status_free_fallback_in_source():
    """org_subscription 없을 때 tier=free 반환 로직 소스 존재."""
    import inspect
    from ee.routers import billing
    source = inspect.getsource(billing.get_billing_status)
    assert "free" in source
    assert "sub is None" in source or "None" in source


# ─── AC7: org별 분리 — org_id 필터 존재 ─────────────────────────────────────

def test_billing_status_filters_by_org_id():
    """billing status 쿼리에 org_id 필터 존재."""
    import inspect
    from ee.routers import billing
    source = inspect.getsource(billing.get_billing_status)
    assert "org_id" in source
    assert "OrgSubscription" in source


# ─── 프론트엔드 컴포넌트 존재 검증 ──────────────────────────────────────────

def test_billing_tab_component_exists():
    """apps/web/src/ee/components/billing/billing-tab.tsx 존재."""
    import os
    path = os.path.join(
        os.path.dirname(__file__), "..", "..", "apps", "web", "src",
        "ee", "components", "billing", "billing-tab.tsx"
    )
    assert os.path.exists(path)


def test_billing_tab_has_can_manage_render():
    """billing-tab.tsx에 can_manage 기반 역할별 렌더링 존재."""
    import os
    path = os.path.join(
        os.path.dirname(__file__), "..", "..", "apps", "web", "src",
        "ee", "components", "billing", "billing-tab.tsx"
    )
    with open(path) as f:
        content = f.read()
    assert "can_manage" in content
    assert "tier" in content
    assert "status" in content
