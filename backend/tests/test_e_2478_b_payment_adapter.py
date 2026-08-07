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


def test_factory_krw_returns_toss_adapter():
    """#2492(C1)로 TossAdapter 연결됨 — krw는 이제 명시적 실패 대신 실 어댑터를 준다.
    (어댑터 자체의 미구현 메서드는 각 메서드 호출 시 NotImplementedError로 개별 실패한다,
    test_e_2492_c1_billing_key.py 참고.)"""
    from app.services.payment.factory import get_payment_adapter
    from app.services.payment.toss_adapter import TossAdapter

    adapter = get_payment_adapter("krw")
    assert isinstance(adapter, TossAdapter)


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
# #2481(B후속, 카디르 QA 거짓-green 지적): CI「Backend pytest」job env엔 LICENSE_CONSENT가
# 없다(ci.yml backend-test job) — settings.is_ee_enabled는 app.main import 시점(모듈
# 스코프 `if settings.is_ee_enabled:`)에 이미 확定돼 billing 라우터가 app.routes에 아예
# 안 실린다. 그 뒤 아무리 settings를 patch해도 이미 안 실린 라우터는 안 돌아온다 —
# 원래 테스트는 그래서 항상 404로 새고 "401 실증"이 거짓이었다(HMAC 로직 자체의 정확성은
# test_verify_signature_* 가 별도로 실증하므로 기능 갭은 없었지만, 이 테스트의 "관통"
# 주장은 공허했다). 처방: import-time 게이트를 우회해 라우터를 직접 마운트하고 진짜
# 401을 받는다 — LICENSE_CONSENT env 주입/앱 재기동보다 훨씬 결정적이고 CI job 설정을
# 안 건드린다.


def _ensure_billing_router_mounted(app) -> None:
    from ee.routers import billing as billing_module

    if not any(getattr(r, "path", "").startswith("/api/v2/billing") for r in app.routes):
        app.include_router(billing_module.router, prefix="/api/v2/billing")


async def _post_webhook_with_signature(app, signature: str | None) -> "httpx.Response":
    from httpx import ASGITransport, AsyncClient

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        headers = {"X-Polar-Webhook-Signature": signature} if signature is not None else {}
        return await c.post(
            "/api/v2/billing/webhook",
            content=b'{"type":"checkout.completed"}',
            headers=headers,
        )


@pytest.mark.anyio
async def test_webhook_endpoint_rejects_invalid_signature_through_adapter():
    """POST /api/v2/billing/webhook — 잘못된 서명이면 실제로 401. 라우터→factory→
    PolarAdapter.verify_webhook 전체 파이프라인이 관통한다(mock 아님) — 404 이스케이프
    없음(#2481)."""
    from app.main import app

    from tests.conftest import override_db_and_read

    mock_session = AsyncMock()

    async def override_db():
        yield mock_session

    override_db_and_read(app, override_db)
    _ensure_billing_router_mounted(app)

    try:
        with patch("app.services.payment.polar_adapter.settings") as mock_settings:
            mock_settings.polar_webhook_secret = "real_secret"
            with patch("ee.routers.billing.settings") as mock_router_settings:
                mock_router_settings.is_ee_enabled = True
                resp = await _post_webhook_with_signature(app, "sha256=wrongsignature")
        assert resp.status_code == 401
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_webhook_endpoint_accepts_valid_signature_positive_control():
    """양성대조 — HMAC 검증을 실제로 깨면(서명 미검증) 위 테스트가 RED 나야 한다는 것을
    증명하기 위해, 반대로 «올바른» 서명은 401 없이 통과해야 한다(#2481 AC). 이 테스트가
    통과 + 위 테스트가 wrong-signature로 401 → 둘 다 서야 "서명 검증이 실제로 갈린다"가
    증명된다(둘 다 같은 응답이면 그게 바로 거짓-green)."""
    import hashlib
    import hmac

    from app.main import app

    from tests.conftest import override_db_and_read

    mock_session = AsyncMock()

    async def override_db():
        yield mock_session

    override_db_and_read(app, override_db)
    _ensure_billing_router_mounted(app)

    secret = "real_secret"
    body = b'{"type":"checkout.completed"}'
    valid_sig = "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()

    try:
        with patch("app.services.payment.polar_adapter.settings") as mock_settings:
            mock_settings.polar_webhook_secret = secret
            with patch("ee.routers.billing.settings") as mock_router_settings:
                mock_router_settings.is_ee_enabled = True
                resp = await _post_webhook_with_signature(app, valid_sig)
        assert resp.status_code != 401  # 서명 검증은 통과 — 이후 JSON payload 처리로 진행
    finally:
        app.dependency_overrides.clear()
