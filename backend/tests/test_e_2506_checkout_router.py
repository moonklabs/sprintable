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
    # story #2881 — CheckoutResponse가 이 필드들을 읽는다(pending 하향 노출).
    s.pending_tier = None
    s.pending_offering_version_id = None
    s.pending_change_apply_at = None
    return s


def _checkout_enabled():
    """story #2728 — 이 파일의 테스트들은 org-admin/checkout_subscription 분기 자체를
    검증 대상으로 삼는다(platform_settings 게이트는 별도 test_2728 파일에서 전담 검증) —
    여기서는 게이트를 통과시켜 원래 테스트 취지를 그대로 살린다."""
    settings = MagicMock()
    settings.billing_checkout_enabled = True
    return patch(
        "app.routers.org_subscription_checkout.get_platform_settings",
        new=AsyncMock(return_value=settings),
    )


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
    with _checkout_enabled(), \
         patch("app.services.project_auth.is_org_owner_or_admin", new=AsyncMock(return_value=False)):
        resp = client.post(
            "/api/v2/org-subscriptions/checkout",
            json={"auth_key": "ak", "tier": "team", "billing_cycle": "monthly"},
        )
    assert resp.status_code == 403


def test_checkout_returns_200_active_on_success(_app_client):
    client, org_id = _app_client
    active_sub = _sub(org_id=org_id, status="active")
    with _checkout_enabled(), \
         patch("app.services.project_auth.is_org_owner_or_admin", new=AsyncMock(return_value=True)), \
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
    with _checkout_enabled(), \
         patch("app.services.project_auth.is_org_owner_or_admin", new=AsyncMock(return_value=True)), \
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


def test_checkout_returns_400_when_active_paid_subscription_exists(_app_client):
    """⛔P0(2026-08-21, story a8fec107) — 활성 유료 org의 checkout 재진입은 400·문구에
    change-tier 경로 명시(틀린 복구 행동 유도 방지)."""
    from app.services.org_subscription_checkout import ActivePaidSubscriptionExists

    client, org_id = _app_client
    with _checkout_enabled(), \
         patch("app.services.project_auth.is_org_owner_or_admin", new=AsyncMock(return_value=True)), \
         patch(
             "app.routers.org_subscription_checkout.checkout_subscription",
             new=AsyncMock(side_effect=ActivePaidSubscriptionExists(
                 f"org_id={org_id}는 이미 활성 유료 구독(tier='business')입니다 — "
                 "플랜 변경은 POST /api/v2/org-subscriptions/change-tier를 쓰세요."
             )),
         ):
        resp = client.post(
            "/api/v2/org-subscriptions/checkout",
            json={"auth_key": "ak", "tier": "team", "billing_cycle": "monthly"},
        )
    assert resp.status_code == 400
    assert "change-tier" in resp.json()["error"]["message"]


def test_checkout_returns_502_on_toss_unreachable(_app_client):
    client, org_id = _app_client
    with _checkout_enabled(), \
         patch("app.services.project_auth.is_org_owner_or_admin", new=AsyncMock(return_value=True)), \
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
    with _checkout_enabled(), \
         patch("app.services.project_auth.is_org_owner_or_admin", new=AsyncMock(return_value=True)), \
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


def test_checkout_returns_403_when_billing_checkout_disabled(_app_client):
    """story #2728(선생님 결정②) — platform_settings.billing_checkout_enabled=false면
    org-admin 권한과 무관하게 무조건 403(서버측 전면 차단, gate가 org-admin 체크보다
    먼저 — is_org_owner_or_admin이 아예 호출 안 됨을 mock 미설정으로 확認)."""
    client, org_id = _app_client
    settings = MagicMock()
    settings.billing_checkout_enabled = False
    with patch(
        "app.routers.org_subscription_checkout.get_platform_settings",
        new=AsyncMock(return_value=settings),
    ):
        resp = client.post(
            "/api/v2/org-subscriptions/checkout",
            json={"auth_key": "ak", "tier": "team", "billing_cycle": "monthly"},
        )
    assert resp.status_code == 403


def test_checkout_requires_auth():
    from app.main import app

    with TestClient(app) as client:
        resp = client.post(
            "/api/v2/org-subscriptions/checkout",
            json={"auth_key": "ak", "tier": "team", "billing_cycle": "monthly"},
        )
    assert resp.status_code == 401
