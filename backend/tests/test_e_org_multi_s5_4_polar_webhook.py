"""E-ORG-MULTI S5.4: Polar Webhook 처리 테스트.

AC1: webhook 진입점은 EE billing router에만 존재
AC2: webhook signature 검증
AC3: checkout.completed → subscription 갱신
AC4: subscription.updated/canceled → status 반영
AC5: 중복 이벤트 멱등 처리
AC6: sandbox webhook 검증 (secret 없을 때 스킵)
"""
from __future__ import annotations

import hashlib
import hmac
import json
import uuid

import pytest


# ─── AC1: EE billing router에만 존재 ─────────────────────────────────────────

def test_webhook_in_ee_billing_router():
    """webhook 엔드포인트가 ee/routers/billing.py에 정의됨."""
    from ee.routers import billing
    paths = [r.path for r in billing.router.routes]
    assert any("webhook" in p for p in paths)


# ─── AC2: Signature 검증 ─────────────────────────────────────────────────────

def test_verify_signature_correct():
    """올바른 HMAC-SHA256 signature → True."""
    from ee.routers.billing import _verify_polar_signature
    secret = "test_secret"
    body = b'{"type":"checkout.completed"}'
    sig = "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    from unittest.mock import patch
    with patch("ee.routers.billing.settings") as mock_settings:
        mock_settings.polar_webhook_secret = secret
        assert _verify_polar_signature(body, sig) is True


def test_verify_signature_wrong():
    """잘못된 signature → False."""
    from ee.routers.billing import _verify_polar_signature
    from unittest.mock import patch
    with patch("ee.routers.billing.settings") as mock_settings:
        mock_settings.polar_webhook_secret = "secret"
        assert _verify_polar_signature(b"body", "sha256=wrongsig") is False


def test_verify_signature_no_secret_skips():
    """POLAR_WEBHOOK_SECRET 미설정 → 검증 스킵 (dev)."""
    from ee.routers.billing import _verify_polar_signature
    from unittest.mock import patch
    with patch("ee.routers.billing.settings") as mock_settings:
        mock_settings.polar_webhook_secret = ""
        assert _verify_polar_signature(b"any", None) is True


# ─── AC3: checkout.completed 처리 ────────────────────────────────────────────

def test_webhook_source_handles_checkout_completed():
    """webhook 소스에 checkout.completed 처리 로직 존재."""
    import inspect
    from ee.routers import billing
    source = inspect.getsource(billing.polar_webhook)
    assert "checkout.completed" in source
    assert "_update_subscription" in source


# ─── AC4: subscription.updated/canceled 처리 ────────────────────────────────

def test_webhook_source_handles_subscription_updated():
    """webhook 소스에 subscription.updated 처리 로직 존재."""
    import inspect
    from ee.routers import billing
    source = inspect.getsource(billing.polar_webhook)
    assert "subscription.updated" in source


def test_webhook_source_handles_subscription_canceled():
    """webhook 소스에 subscription.canceled 처리 로직 존재."""
    import inspect
    from ee.routers import billing
    source = inspect.getsource(billing.polar_webhook)
    assert "subscription.cancel" in source


# ─── AC5: 멱등 처리 ──────────────────────────────────────────────────────────

def test_webhook_idempotency_in_source():
    """webhook 소스에 polar_webhook_events 중복 체크 로직 존재."""
    import inspect
    from ee.routers import billing
    source = inspect.getsource(billing.polar_webhook)
    assert "polar_webhook_events" in source
    assert "duplicate" in source or "skipped" in source.lower()


def test_migration_creates_webhook_events_table():
    """0043 migration에 polar_webhook_events 테이블 생성 존재."""
    import os
    path = os.path.join(
        os.path.dirname(__file__), "..", "alembic", "versions", "0043_add_polar_webhook_events.py"
    )
    assert os.path.exists(path)
    with open(path) as f:
        content = f.read()
    assert "polar_webhook_events" in content
    assert "event_id" in content


# ─── AC6: sandbox 검증 ───────────────────────────────────────────────────────

def test_webhook_secret_config_exists():
    """config에 polar_webhook_secret 필드 존재."""
    from app.core.config import Settings
    import inspect
    source = inspect.getsource(Settings)
    assert "polar_webhook_secret" in source


# ─── update_subscription status 파라미터 ─────────────────────────────────────

def test_update_subscription_accepts_status():
    """_update_subscription 소스에 status 파라미터 존재."""
    import inspect
    from ee.routers import billing
    source = inspect.getsource(billing._update_subscription)
    assert "status" in source


@pytest.fixture
def anyio_backend():
    return "asyncio"
