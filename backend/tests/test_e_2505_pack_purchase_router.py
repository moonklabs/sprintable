"""#2505 — POST /api/v2/org-subscriptions/packs 엔드포인트."""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient


def _auth_ctx(user_id):
    ctx = MagicMock()
    ctx.user_id = str(user_id)
    return ctx


def _order(*, org_id, status="confirmed"):
    o = MagicMock()
    o.org_id = org_id
    o.status = status
    return o


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


def test_purchase_pack_returns_403_when_not_org_admin(_app_client):
    client, org_id = _app_client
    with patch("app.services.project_auth.is_org_owner_or_admin", new=AsyncMock(return_value=False)):
        resp = client.post(
            "/api/v2/org-subscriptions/packs",
            json={"resource": "au", "quantity": 1, "idempotency_key": "k1"},
        )
    assert resp.status_code == 403


def test_purchase_pack_returns_200_confirmed_on_success(_app_client):
    client, org_id = _app_client
    order = _order(org_id=org_id, status="confirmed")
    with patch("app.services.project_auth.is_org_owner_or_admin", new=AsyncMock(return_value=True)), \
         patch("app.routers.billing_packs.purchase_packs", new=AsyncMock(return_value=order)):
        resp = client.post(
            "/api/v2/org-subscriptions/packs",
            json={"resource": "au", "quantity": 2, "idempotency_key": "k1"},
        )
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "confirmed"
    assert body["resource"] == "au"
    assert body["quantity"] == 2


def test_purchase_pack_returns_200_with_declined_reason_on_card_decline(_app_client):
    from app.services.billing_pack import PackPurchaseDeclined

    client, org_id = _app_client
    failed_order = _order(org_id=org_id, status="failed")
    with patch("app.services.project_auth.is_org_owner_or_admin", new=AsyncMock(return_value=True)), \
         patch(
             "app.routers.billing_packs.purchase_packs",
             new=AsyncMock(side_effect=PackPurchaseDeclined("카드 거절", order=failed_order)),
         ):
        resp = client.post(
            "/api/v2/org-subscriptions/packs",
            json={"resource": "au", "quantity": 1, "idempotency_key": "k1"},
        )
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "failed"
    assert body["declined_reason"] == "카드 거절"


def test_purchase_pack_returns_422_on_precondition_error(_app_client):
    from app.services.billing_pack import PackPurchaseError

    client, org_id = _app_client
    with patch("app.services.project_auth.is_org_owner_or_admin", new=AsyncMock(return_value=True)), \
         patch(
             "app.routers.billing_packs.purchase_packs",
             new=AsyncMock(side_effect=PackPurchaseError("no active subscription")),
         ):
        resp = client.post(
            "/api/v2/org-subscriptions/packs",
            json={"resource": "au", "quantity": 1, "idempotency_key": "k1"},
        )
    assert resp.status_code == 422


def test_purchase_pack_returns_502_on_toss_unreachable(_app_client):
    client, org_id = _app_client
    with patch("app.services.project_auth.is_org_owner_or_admin", new=AsyncMock(return_value=True)), \
         patch(
             "app.routers.billing_packs.purchase_packs",
             new=AsyncMock(side_effect=RuntimeError("Cannot reach Toss API")),
         ):
        resp = client.post(
            "/api/v2/org-subscriptions/packs",
            json={"resource": "au", "quantity": 1, "idempotency_key": "k1"},
        )
    assert resp.status_code == 502


def test_purchase_pack_rejects_zero_quantity_with_422(_app_client):
    client, org_id = _app_client
    resp = client.post(
        "/api/v2/org-subscriptions/packs",
        json={"resource": "au", "quantity": 0, "idempotency_key": "k1"},
    )
    assert resp.status_code == 422


def test_purchase_pack_requires_auth():
    from app.main import app

    with TestClient(app) as client:
        resp = client.post(
            "/api/v2/org-subscriptions/packs",
            json={"resource": "au", "quantity": 1, "idempotency_key": "k1"},
        )
    assert resp.status_code == 401
