"""story #2989(AC1·AC2·AC3) — 라우터 층 단위 테스트(mock_session, DB 불요). 서비스 레일
(revoke_billing_key)의 실제 동작은 test_2989_billing_key_revoke_realdb.py가 실PG로 검증;
여기서는 그 서비스가 던지는 예외가 라우터에서 올바른 HTTP 응답으로 매핑되는지만 본다
(create_billing_key_endpoint 계보의 기존 테스트 관례 그대로 — service는 monkeypatch)."""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock

import pytest


# ─── GET /api/v2/org-billing-keys ───────────────────────────────────────────

@pytest.mark.anyio
async def test_get_billing_key_endpoint_returns_none_when_no_active_card(
    test_client, mock_session, monkeypatch, org_id
):
    import app.services.project_auth as project_auth

    monkeypatch.setattr(project_auth, "is_org_owner_or_admin", AsyncMock(return_value=True))
    mock_result = MagicMock()
    mock_result.scalar_one_or_none.return_value = None
    mock_session.execute = AsyncMock(return_value=mock_result)

    resp = await test_client.get("/api/v2/org-billing-keys")
    assert resp.status_code == 200
    assert resp.json() is None


@pytest.mark.anyio
async def test_get_billing_key_endpoint_returns_card_when_active(
    test_client, mock_session, monkeypatch, org_id
):
    import app.services.project_auth as project_auth

    monkeypatch.setattr(project_auth, "is_org_owner_or_admin", AsyncMock(return_value=True))
    fake_key = MagicMock()
    fake_key.org_id = org_id
    fake_key.status = "active"
    fake_key.card_issuer_code = "61"
    fake_key.card_number_masked = "1234********5678"
    fake_key.card_type = "신용"
    mock_result = MagicMock()
    mock_result.scalar_one_or_none.return_value = fake_key
    mock_session.execute = AsyncMock(return_value=mock_result)

    resp = await test_client.get("/api/v2/org-billing-keys")
    assert resp.status_code == 200
    assert resp.json()["card_number_masked"] == "1234********5678"


# ─── DELETE /api/v2/org-billing-keys ────────────────────────────────────────

@pytest.mark.anyio
async def test_delete_billing_key_endpoint_success(test_client, mock_session, monkeypatch, org_id):
    import app.routers.billing_keys as router_module
    import app.services.project_auth as project_auth

    monkeypatch.setattr(project_auth, "is_org_owner_or_admin", AsyncMock(return_value=True))
    monkeypatch.setattr(
        router_module, "revoke_billing_key",
        AsyncMock(return_value={"deleted": True, "toss_revoked": True, "card_number_masked": "1234********5678"}),
    )

    resp = await test_client.delete("/api/v2/org-billing-keys")
    assert resp.status_code == 200
    assert resp.json()["deleted"] is True


@pytest.mark.anyio
async def test_delete_billing_key_endpoint_409_when_active_subscription_blocks(
    test_client, mock_session, monkeypatch, org_id
):
    """P3 — revoke_billing_key가 ActiveSubscriptionBlocksRevoke를 던지면 라우터가 409로
    매핑하고 FE가 분기할 code+tier+current_period_end를 싣는다(gate_head_changed 계보
    관례 재사용). PO 재지적(2026-08-24, PR#3423 리뷰) — "해지 후 다시 시도"는 해지가
    예약형이라 거짓 안내다, 대신 실 종료일을 실어야 한다."""
    import app.routers.billing_keys as router_module
    import app.services.project_auth as project_auth
    from datetime import datetime, timezone
    from app.services.org_billing_key import ActiveSubscriptionBlocksRevoke

    monkeypatch.setattr(project_auth, "is_org_owner_or_admin", AsyncMock(return_value=True))
    period_end = datetime(2026, 9, 24, tzinfo=timezone.utc)
    monkeypatch.setattr(
        router_module, "revoke_billing_key",
        AsyncMock(side_effect=ActiveSubscriptionBlocksRevoke(
            org_id=org_id, tier="starter", billing_cycle="monthly", current_period_end=period_end,
        )),
    )

    resp = await test_client.delete("/api/v2/org-billing-keys")
    assert resp.status_code == 409
    body = resp.json()["error"]
    assert body["code"] == "active_subscription_blocks_revoke"
    assert body["tier"] == "starter"
    assert body["current_period_end"] == period_end.isoformat()
    assert "해지 후 다시 시도" not in body["message"]


@pytest.mark.anyio
async def test_delete_billing_key_endpoint_403_for_non_admin(test_client, mock_session, monkeypatch):
    import app.services.project_auth as project_auth

    monkeypatch.setattr(project_auth, "is_org_owner_or_admin", AsyncMock(return_value=False))

    resp = await test_client.delete("/api/v2/org-billing-keys")
    assert resp.status_code == 403


# ─── POST /api/v2/admin/orgs/{org_id}/billing/reset-billing-key ────────────

@pytest.mark.anyio
async def test_admin_reset_billing_key_endpoint_success(test_client, mock_session, monkeypatch, org_id):
    import app.routers.admin_billing as router_module
    from app.dependencies.admin_auth import AdminOperator, require_admin_operator
    from app.main import app

    monkeypatch.setattr(
        router_module, "reset_billing_key",
        AsyncMock(return_value={"deleted": True, "toss_revoked": True, "card_number_masked": "1234********5678"}),
    )
    app.dependency_overrides[require_admin_operator] = lambda: AdminOperator(email="operator@moonklabs.com", subject="sub-123")
    try:
        resp = await test_client.post(f"/api/v2/admin/orgs/{org_id}/billing/reset-billing-key")
    finally:
        app.dependency_overrides.pop(require_admin_operator, None)

    assert resp.status_code == 200
    assert resp.json()["deleted"] is True


@pytest.mark.anyio
async def test_admin_reset_billing_key_endpoint_rejects_in_prod(test_client, mock_session, org_id):
    from app.core.config import settings
    from app.dependencies.admin_auth import AdminOperator, require_admin_operator
    from app.main import app

    orig = settings.deploy_env
    settings.deploy_env = "prod"
    app.dependency_overrides[require_admin_operator] = lambda: AdminOperator(email="operator@moonklabs.com", subject="sub-123")
    try:
        resp = await test_client.post(f"/api/v2/admin/orgs/{org_id}/billing/reset-billing-key")
        assert resp.status_code == 403
    finally:
        settings.deploy_env = orig
        app.dependency_overrides.pop(require_admin_operator, None)
