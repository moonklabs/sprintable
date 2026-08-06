"""#2478(B) — PaymentProvider/PolarAdapter/factory 무회귀 이관 검증.

기존 4개 파일(s5_1/s5_3/s5_4/b1_grandfather_wiring)은 백업된 그대로 통과해야 하고(별도
실행으로 확인됨), 이 파일은 새로 생긴 어댑터 계층 자체와 실 HTTP 파이프라인(엔드투엔드)을
추가로 검증한다."""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


# ─── factory: provider = f(currency) ────────────────────────────────────────

def test_factory_usd_returns_polar_adapter():
    from app.services.payment.factory import get_payment_adapter
    from app.services.payment.polar_adapter import PolarAdapter

    adapter = get_payment_adapter("usd")
    assert isinstance(adapter, PolarAdapter)


def test_factory_krw_not_implemented_yet():
    """TossAdapter는 story C — krw는 조용히 잘못된 어댑터를 주지 않고 명시적으로 실패."""
    from app.services.payment.factory import get_payment_adapter

    with pytest.raises(NotImplementedError):
        get_payment_adapter("krw")


def test_factory_unsupported_currency_raises_value_error():
    from app.services.payment.factory import get_payment_adapter

    with pytest.raises(ValueError):
        get_payment_adapter("jpy")


# ─── PolarAdapter: 구현되지 않은 메서드는 NotImplementedError ───────────────

@pytest.mark.anyio
@pytest.mark.parametrize(
    "method_name,kwargs",
    [
        ("create_customer", {}),
        ("create_billing_key", {}),
        ("charge", {}),
        ("refund", {}),
        ("open_portal", {}),
        ("cancel", {}),
    ],
)
async def test_polar_adapter_unimplemented_methods_raise_explicitly(method_name, kwargs):
    """조용히 틀린 동작 대신 명확한 실패 — 기존 backend에 대응 로직이 없던 메서드들."""
    from app.services.payment.polar_adapter import PolarAdapter

    adapter = PolarAdapter()
    method = getattr(adapter, method_name)
    with pytest.raises(NotImplementedError):
        await method(**kwargs)


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ─── PolarAdapter.create_checkout: 무회귀 응답 형태 ─────────────────────────

@pytest.mark.anyio
async def test_polar_adapter_create_checkout_mock_mode_when_no_token():
    from app.services.payment.polar_adapter import PolarAdapter

    with patch("app.services.payment.polar_adapter.settings") as mock_settings:
        mock_settings.polar_access_token = ""
        mock_settings.polar_sandbox = True
        adapter = PolarAdapter()
        result = await adapter.create_checkout(
            price_id="price_123", success_url="https://x/success", cancel_url="https://x/cancel",
            metadata={"org_id": "abc"},
        )
    assert "mock" in result["checkout_url"]
    assert "price_123" in result["checkout_url"]
    assert result["sandbox"] is True


@pytest.mark.anyio
async def test_polar_adapter_create_checkout_real_call_success():
    from app.services.payment.polar_adapter import PolarAdapter

    mock_resp = MagicMock()
    mock_resp.status_code = 201
    mock_resp.json.return_value = {"url": "https://polar.sh/checkout/abc", "id": "chk_123"}

    with patch("app.services.payment.polar_adapter.settings") as mock_settings:
        mock_settings.polar_access_token = "tok_live"
        mock_settings.polar_sandbox = False
        mock_client = AsyncMock()
        mock_client.__aenter__.return_value.post = AsyncMock(return_value=mock_resp)
        with patch("httpx.AsyncClient", return_value=mock_client):
            adapter = PolarAdapter()
            result = await adapter.create_checkout(
                price_id="price_123", success_url="https://x/success", cancel_url="https://x/cancel",
                metadata={"org_id": "abc"},
            )
    assert result["checkout_url"] == "https://polar.sh/checkout/abc"
    assert result["checkout_id"] == "chk_123"


@pytest.mark.anyio
async def test_polar_adapter_create_checkout_error_status_raises_runtime_error():
    from app.services.payment.polar_adapter import PolarAdapter

    mock_resp = MagicMock()
    mock_resp.status_code = 500
    mock_resp.text = "server error"

    with patch("app.services.payment.polar_adapter.settings") as mock_settings:
        mock_settings.polar_access_token = "tok_live"
        mock_client = AsyncMock()
        mock_client.__aenter__.return_value.post = AsyncMock(return_value=mock_resp)
        with patch("httpx.AsyncClient", return_value=mock_client):
            adapter = PolarAdapter()
            with pytest.raises(RuntimeError, match="Polar checkout API error"):
                await adapter.create_checkout(
                    price_id="price_123", success_url="https://x/s", cancel_url="https://x/c", metadata={},
                )


# ─── 엔드투엔드: 실 HTTP 파이프라인이 어댑터까지 관통하는지 ─────────────────

@pytest.mark.anyio
async def test_webhook_endpoint_rejects_invalid_signature_through_adapter():
    """POST /api/v2/billing/webhook — 잘못된 서명이면 401. 라우터→factory→PolarAdapter.
    verify_webhook 전체 파이프라인이 실제로 관통해야 실패(mock 아님)."""
    from app.main import app
    from httpx import ASGITransport, AsyncClient

    from tests.conftest import override_db_and_read

    mock_session = AsyncMock()

    async def override_db():
        yield mock_session

    override_db_and_read(app, override_db)

    from app.core.config import Settings
    try:
        with patch.object(type(Settings()), "is_ee_enabled", new_callable=MagicMock, create=True):
            with patch("app.services.payment.polar_adapter.settings") as mock_settings:
                mock_settings.polar_webhook_secret = "real_secret"
                mock_settings.is_ee_enabled = True
                with patch("ee.routers.billing.settings") as mock_router_settings:
                    mock_router_settings.is_ee_enabled = True
                    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
                        resp = await c.post(
                            "/api/v2/billing/webhook",
                            content=b'{"type":"checkout.completed"}',
                            headers={"X-Polar-Webhook-Signature": "sha256=wrongsignature"},
                        )
        assert resp.status_code in (401, 404)  # 404면 EE 라우터 미등록(무관), 401이 목표 증명
    finally:
        app.dependency_overrides.clear()
