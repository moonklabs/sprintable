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
# #2478(B): _verify_polar_signature는 PolarAdapter.verify_webhook으로 무회귀 이관됐다
# (동일 로직) — patch 대상도 새 모듈의 settings import로 옮긴다.

def test_verify_signature_correct():
    """올바른 HMAC-SHA256 signature → True."""
    from app.services.payment.polar_adapter import PolarAdapter
    secret = "test_secret"
    body = b'{"type":"checkout.completed"}'
    sig = "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    from unittest.mock import patch
    with patch("app.services.payment.polar_adapter.settings") as mock_settings:
        mock_settings.polar_webhook_secret = secret
        assert PolarAdapter().verify_webhook(body, sig) is True


def test_verify_signature_wrong():
    """잘못된 signature → False."""
    from app.services.payment.polar_adapter import PolarAdapter
    from unittest.mock import patch
    with patch("app.services.payment.polar_adapter.settings") as mock_settings:
        mock_settings.polar_webhook_secret = "secret"
        assert PolarAdapter().verify_webhook(b"body", "sha256=wrongsig") is False


def test_verify_signature_no_secret_skips():
    """POLAR_WEBHOOK_SECRET 미설정 → 검증 스킵 (dev)."""
    from app.services.payment.polar_adapter import PolarAdapter
    from unittest.mock import patch
    with patch("app.services.payment.polar_adapter.settings") as mock_settings:
        mock_settings.polar_webhook_secret = ""
        assert PolarAdapter().verify_webhook(b"any", None) is True


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


# ─── 까심 QA: fire-and-forget 백그라운드 태스크 조용한 실패 봉쇄 ──────────────
# (0148 org_subscriptions.org_id UNIQUE 부재 버그가 이 경로 때문에 아무도 못 잡았음 —
# webhook이 background_tasks.add_task로 fire-and-forget 호출해 Polar엔 이미 {ok:true}
# ACK가 나간 뒤라 실패해도 전파할 곳이 없었다. 여기서는 최소한 로그로는 남아야 한다.)

@pytest.mark.anyio
async def test_update_subscription_logs_error_and_reraises_on_db_failure(caplog):
    import logging
    from unittest.mock import AsyncMock

    from ee.routers import billing

    org_id = uuid.uuid4()
    session = AsyncMock()
    session.execute = AsyncMock(side_effect=RuntimeError("boom"))

    with caplog.at_level(logging.ERROR, logger="ee.routers.billing"):
        with pytest.raises(RuntimeError, match="boom"):
            await billing._update_subscription(
                session, org_id, "team", "monthly", "cus_x", "sub_x", "active"
            )

    assert any(str(org_id) in record.message for record in caplog.records)
    assert any(record.levelno == logging.ERROR for record in caplog.records)


# ─── story #2411: pricing_versions 빈 조회가 예외가 아니라 조용히 NULL로 통과하던 것 ──
# (org_subscriptions.pricing_version_id가 nullable이라 위 실패-로깅 try/except에 안 걸림 —
# prod 실측 2026-08-01: #2397/0222로 테이블만 생기고 아직 시드가 없어 매번 이 분기를 탐)

@pytest.mark.anyio
async def test_update_subscription_warns_when_no_pricing_version_matches(caplog):
    import logging
    from unittest.mock import AsyncMock, MagicMock

    from ee.routers import billing

    org_id = uuid.uuid4()
    session = AsyncMock()
    empty_lookup = MagicMock()
    empty_lookup.scalar_one_or_none.return_value = None
    session.execute = AsyncMock(side_effect=[empty_lookup, MagicMock()])

    with caplog.at_level(logging.WARNING, logger="ee.routers.billing"):
        await billing._update_subscription(
            session, org_id, "team", "monthly", "cus_x", "sub_x", "active"
        )

    assert any(
        "pricing_version_id 미배정" in record.message and str(org_id) in record.message
        for record in caplog.records
    )
    assert any(record.levelno == logging.WARNING for record in caplog.records)


@pytest.mark.anyio
async def test_update_subscription_no_warning_when_pricing_version_matches(caplog):
    import logging
    import uuid as uuid_mod
    from unittest.mock import AsyncMock, MagicMock

    from ee.routers import billing

    org_id = uuid.uuid4()
    session = AsyncMock()
    found_lookup = MagicMock()
    found_lookup.scalar_one_or_none.return_value = uuid_mod.uuid4()
    session.execute = AsyncMock(side_effect=[found_lookup, MagicMock()])

    with caplog.at_level(logging.WARNING, logger="ee.routers.billing"):
        await billing._update_subscription(
            session, org_id, "team", "monthly", "cus_x", "sub_x", "active"
        )

    assert not any("pricing_version_id 미배정" in record.message for record in caplog.records)


@pytest.fixture
def anyio_backend():
    return "asyncio"
