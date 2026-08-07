"""#2506 — POST /api/v2/org-subscriptions/checkout 엔드포인트. 인증/권한/에러매핑."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient


def _auth_ctx(user_id):
    ctx = MagicMock()
    ctx.user_id = str(user_id)
    return ctx


def _sub(*, org_id, status="active"):
    s = MagicMock()
    s.org_id = org_id
    s.tier = "team"
    s.billing_cycle = "monthly"
    s.status = status
    s.current_period_start = datetime(2026, 8, 7, tzinfo=timezone.utc)
    s.current_period_end = datetime(2026, 9, 7, tzinfo=timezone.utc)
    return s


@pytest.fixture
def _app_client():
    from app.main import app
    from app.dependencies.auth import get_current_user, get_verified_org_id_no_project_gate
    from app.dependencies.database import get_db
    from tests.conftest import override_db_and_read

    org_id = uuid.uuid4()
    user_id = uuid.uuid4()

    async def _override_get_db():
        yield AsyncMock()

    override_db_and_read(app, _override_get_db)
    app.dependency_overrides[get_current_user] = lambda: _auth_ctx(user_id)
    app.dependency_overrides[get_verified_org_id_no_project_gate] = lambda: org_id
    try:
        yield TestClient(app), org_id
    finally:
        app.dependency_overrides.clear()


def test_checkout_returns_403_when_not_org_admin(_app_client):
    client, org_id = _app_client
    with patch("app.services.project_auth.is_org_owner_or_admin", new=AsyncMock(return_value=False)):
        resp = client.post(
            "/api/v2/org-subscriptions/checkout",
            json={"auth_key": "ak", "tier": "team", "billing_cycle": "monthly"},
        )
    assert resp.status_code == 403


def test_checkout_returns_200_active_on_success(_app_client):
    client, org_id = _app_client
    active_sub = _sub(org_id=org_id, status="active")
    with patch("app.services.project_auth.is_org_owner_or_admin", new=AsyncMock(return_value=True)), \
         patch("app.routers.org_subscription_checkout.checkout_subscription", new=AsyncMock(return_value=active_sub)):
        resp = client.post(
            "/api/v2/org-subscriptions/checkout",
            json={"auth_key": "ak", "tier": "team", "billing_cycle": "monthly"},
        )
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "active"
    assert body["tier"] == "team"


def test_checkout_returns_200_pending_with_declined_reason_on_card_decline(_app_client):
    from app.services.org_subscription_checkout import CheckoutDeclined

    client, org_id = _app_client
    pending_sub = _sub(org_id=org_id, status="pending")
    with patch("app.services.project_auth.is_org_owner_or_admin", new=AsyncMock(return_value=True)), \
         patch(
             "app.routers.org_subscription_checkout.checkout_subscription",
             new=AsyncMock(side_effect=CheckoutDeclined("카드 거절", subscription=pending_sub)),
         ):
        resp = client.post(
            "/api/v2/org-subscriptions/checkout",
            json={"auth_key": "ak", "tier": "team", "billing_cycle": "monthly"},
        )
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "pending"
    assert body["declined_reason"] == "카드 거절"


def test_checkout_returns_502_on_toss_unreachable(_app_client):
    client, org_id = _app_client
    with patch("app.services.project_auth.is_org_owner_or_admin", new=AsyncMock(return_value=True)), \
         patch(
             "app.routers.org_subscription_checkout.checkout_subscription",
             new=AsyncMock(side_effect=RuntimeError("Cannot reach Toss API")),
         ):
        resp = client.post(
            "/api/v2/org-subscriptions/checkout",
            json={"auth_key": "ak", "tier": "team", "billing_cycle": "monthly"},
        )
    assert resp.status_code == 502


def test_checkout_returns_500_on_internal_catalog_gap(_app_client):
    from app.services.org_subscription_checkout import CheckoutError

    client, org_id = _app_client
    with patch("app.services.project_auth.is_org_owner_or_admin", new=AsyncMock(return_value=True)), \
         patch(
             "app.routers.org_subscription_checkout.checkout_subscription",
             new=AsyncMock(side_effect=CheckoutError("offering_version not found")),
         ):
        resp = client.post(
            "/api/v2/org-subscriptions/checkout",
            json={"auth_key": "ak", "tier": "team", "billing_cycle": "monthly"},
        )
    assert resp.status_code == 500


def test_checkout_rejects_invalid_tier_with_422(_app_client):
    """free 등 Literal 밖 값 — pydantic이 서비스 계층 도달 前에 이미 거른다."""
    client, org_id = _app_client
    resp = client.post(
        "/api/v2/org-subscriptions/checkout",
        json={"auth_key": "ak", "tier": "free", "billing_cycle": "monthly"},
    )
    assert resp.status_code == 422


def test_checkout_requires_auth():
    from app.main import app

    with TestClient(app) as client:
        resp = client.post(
            "/api/v2/org-subscriptions/checkout",
            json={"auth_key": "ak", "tier": "team", "billing_cycle": "monthly"},
        )
    assert resp.status_code == 401
