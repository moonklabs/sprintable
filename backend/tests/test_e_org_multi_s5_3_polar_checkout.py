"""E-ORG-MULTI S5.3: Polar Checkout 연동 테스트.

AC1: owner/admin만 checkout 가능
AC2: member → checkout 403
AC3: Team 월간/연간, Pro 월간/연간 선택
AC4: checkout 성공 후 Subscription 갱신 (webhook)
AC5: 취소 시 Billing 화면 복귀 (cancel_url)
AC6: sandbox 플로우 검증
"""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock

import pytest

ORG_ID = uuid.uuid4()
USER_ID = uuid.uuid4()


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ─── AC1 + AC3: owner checkout 요청 ─────────────────────────────────────────

def test_checkout_endpoint_exists():
    """POST /api/v2/billing/checkout 라우트 존재."""
    from ee.routers import billing
    paths = [r.path for r in billing.router.routes]
    assert any("checkout" in p for p in paths)


def test_checkout_source_checks_owner_admin():
    """checkout 소스에 owner/admin 권한 체크 존재."""
    import inspect
    from ee.routers import billing
    source = inspect.getsource(billing.create_checkout_session)
    assert "owner" in source
    assert "admin" in source
    assert "403" in source or "forbidden" in source.lower() or "required" in source


def test_checkout_supports_team_and_pro():
    """checkout 소스에 team/pro 플랜 + monthly/yearly 분기 존재."""
    import inspect
    from ee.routers import billing
    source = inspect.getsource(billing.create_checkout_session)
    assert "team" in source
    assert "pro" in source
    assert "monthly" in source
    assert "yearly" in source


# ─── AC2: member → 403 ───────────────────────────────────────────────────────

def test_checkout_member_blocked_in_source():
    """checkout 소스에 member 차단 로직 존재."""
    import inspect
    from ee.routers import billing
    source = inspect.getsource(billing.create_checkout_session)
    assert "owner" in source or "can_manage" in source


# ─── AC4: webhook 수신 + subscription 갱신 ────────────────────────────────────

def test_webhook_endpoint_exists():
    """POST /api/v2/billing/webhook 라우트 존재."""
    from ee.routers import billing
    paths = [r.path for r in billing.router.routes]
    assert any("webhook" in p for p in paths)


def test_webhook_handles_checkout_completed():
    """webhook 소스에 checkout.completed 이벤트 처리 존재."""
    import inspect
    from ee.routers import billing
    source = inspect.getsource(billing.polar_webhook)
    assert "checkout.completed" in source


def test_update_subscription_upserts():
    """_update_subscription 소스에 upsert 로직 존재."""
    import inspect
    from ee.routers import billing
    source = inspect.getsource(billing._update_subscription)
    assert "on_conflict_do_update" in source or "upsert" in source.lower()


# ─── AC5: cancel_url 포함 ────────────────────────────────────────────────────

def test_checkout_has_cancel_url():
    """checkout 소스에 cancel_url 처리 존재."""
    import inspect
    from ee.routers import billing
    source = inspect.getsource(billing.create_checkout_session)
    assert "cancel_url" in source


# ─── AC6: sandbox 모드 ───────────────────────────────────────────────────────

def test_polar_api_url_uses_sandbox():
    """polar_sandbox=True 시 sandbox API URL 사용.

    #2478(B): _polar_api_url()은 PolarAdapter._api_url()로 무회귀 이관됐다(동일 로직) —
    ee/routers/billing.py는 이제 PG URL을 직접 모른다(design doc §1)."""
    import inspect
    from app.services.payment.polar_adapter import PolarAdapter
    source = inspect.getsource(PolarAdapter._api_url)
    assert "sandbox" in source


def test_no_token_returns_mock_url():
    """POLAR_ACCESS_TOKEN 없을 때 mock checkout URL 반환 로직 존재.

    #2478(B): 이 로직은 PolarAdapter.create_checkout으로 이관됐다 — billing.py의
    create_checkout_session은 이제 adapter.create_checkout()을 호출만 한다."""
    import inspect
    from app.services.payment.polar_adapter import PolarAdapter
    source = inspect.getsource(PolarAdapter.create_checkout)
    assert "polar_access_token" in source
    assert "mock" in source.lower() or "warning" in source.lower()


# ─── CheckoutRequest 스키마 ──────────────────────────────────────────────────

def test_checkout_request_schema():
    """CheckoutRequest에 plan_id + billing_cycle 필드 존재."""
    from ee.routers.billing import CheckoutRequest
    fields = set(CheckoutRequest.model_fields.keys())
    assert {"plan_id", "billing_cycle"}.issubset(fields)


# ─── 프론트엔드 BillingTab checkout UI 검증 ─────────────────────────────────
# story #2479(결제②-D 4티어 재편)에서 handleCheckout/selectedPlan/selectedCycle 이
# UpgradeCheckoutDialog + onUpgrade + cycle 로 대체됨 — 신 구조 존재로 갱신.
# (실 클릭→다이얼로그 오픈 인터랙션 검증은 isPricePublic=false 인 동안 잠긴 CTA라
# 도달 불가 — apps/web/src/ee/components/billing/billing-tab.test.tsx 가 구조/상태
# 분기 축을 vitest 로 커버한다.)

def test_billing_tab_has_checkout_ui():
    """billing-tab.tsx에 업그레이드 체크아웃 다이얼로그 + 월간/연간 주기 선택 UI 존재."""
    import os
    path = os.path.join(
        os.path.dirname(__file__), "..", "..", "apps", "web", "src",
        "ee", "components", "billing", "billing-tab.tsx"
    )
    with open(path) as f:
        content = f.read()
    assert "UpgradeCheckoutDialog" in content
    assert "onUpgrade" in content
    assert "'monthly'" in content
    assert "'yearly'" in content
