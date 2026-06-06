"""96af343e: 휴먼 개인 webhook 발송 — _deliver_personal_webhooks.

dispatch_notification 이 in-app 만 보내고 개인 WebhookConfig 로 POST 안 하던 것(2겹 근본)을
옵션 C(flush 타이밍·best-effort)로 보강. agent SSE 경로(route_dispatch_event)는 미변경.
"""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.notification_dispatch import _deliver_personal_webhooks


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _cfg(url="https://hooks.example.com/x", secret="s", member_id=None):
    c = MagicMock()
    c.member_id = member_id or uuid.uuid4()
    c.url = url
    c.secret = secret
    return c


def _scalars(values):
    r = MagicMock()
    r.scalars.return_value.all.return_value = values
    return r


@pytest.mark.anyio
async def test_personal_webhook_posts_for_active_config():
    """활성 webhook 보유 휴먼 → _post_with_retry 호출 (HMAC/secret 전달)."""
    org = uuid.uuid4()
    cfg = _cfg(secret="sek")
    db = AsyncMock()
    db.execute = AsyncMock(side_effect=[_scalars([cfg]), _scalars([])])  # configs, mute=none
    with patch("app.services.dispatch_router._post_with_retry", new_callable=AsyncMock) as mpost, \
         patch("app.core.ssrf.validate_webhook_url_async", new_callable=AsyncMock):
        mpost.return_value = True
        await _deliver_personal_webhooks(db, org, [cfg.member_id], title="T", body="B", event_type="story_assigned")
    mpost.assert_awaited_once()
    args = mpost.await_args.args
    assert args[0] == cfg.url and args[2] == "sek"  # url, secret


@pytest.mark.anyio
async def test_personal_webhook_skips_muted():
    """global mute 멤버 → POST skip."""
    org = uuid.uuid4()
    cfg = _cfg()
    db = AsyncMock()
    db.execute = AsyncMock(side_effect=[_scalars([cfg]), _scalars([cfg.member_id])])  # muted
    with patch("app.services.dispatch_router._post_with_retry", new_callable=AsyncMock) as mpost, \
         patch("app.core.ssrf.validate_webhook_url_async", new_callable=AsyncMock):
        await _deliver_personal_webhooks(db, org, [cfg.member_id], title="T", body=None, event_type="e")
    mpost.assert_not_awaited()


@pytest.mark.anyio
async def test_personal_webhook_discord_format_no_secret():
    """Discord URL → {content} payload·secret None."""
    org = uuid.uuid4()
    cfg = _cfg(url="https://discord.com/api/webhooks/123/abc", secret="ignored")
    db = AsyncMock()
    db.execute = AsyncMock(side_effect=[_scalars([cfg]), _scalars([])])
    with patch("app.services.dispatch_router._post_with_retry", new_callable=AsyncMock) as mpost, \
         patch("app.core.ssrf.validate_webhook_url_async", new_callable=AsyncMock):
        await _deliver_personal_webhooks(db, org, [cfg.member_id], title="Hi", body="x", event_type="e")
    payload, secret = mpost.await_args.args[1], mpost.await_args.args[2]
    assert "content" in payload and secret is None


@pytest.mark.anyio
async def test_personal_webhook_ssrf_reject_skips():
    """SSRF 검증 실패 URL → POST skip (다른 건 영향 없음)."""
    org = uuid.uuid4()
    cfg = _cfg(url="http://169.254.169.254/x")
    db = AsyncMock()
    db.execute = AsyncMock(side_effect=[_scalars([cfg]), _scalars([])])
    with patch("app.services.dispatch_router._post_with_retry", new_callable=AsyncMock) as mpost, \
         patch("app.core.ssrf.validate_webhook_url_async", new_callable=AsyncMock, side_effect=ValueError("blocked")):
        await _deliver_personal_webhooks(db, org, [cfg.member_id], title="T", body=None, event_type="e")
    mpost.assert_not_awaited()


@pytest.mark.anyio
async def test_personal_webhook_no_config_noop():
    """활성 webhook 없음 → mute 조회조차 안 하고 즉시 return."""
    org = uuid.uuid4()
    db = AsyncMock()
    db.execute = AsyncMock(side_effect=[_scalars([])])  # no configs
    with patch("app.services.dispatch_router._post_with_retry", new_callable=AsyncMock) as mpost:
        await _deliver_personal_webhooks(db, org, [uuid.uuid4()], title="T", body=None, event_type="e")
    mpost.assert_not_awaited()
    assert db.execute.await_count == 1  # configs 조회만


@pytest.mark.anyio
async def test_personal_webhook_post_failure_swallowed():
    """_post_with_retry 예외 → swallow (호출자 무영향)."""
    org = uuid.uuid4()
    cfg = _cfg()
    db = AsyncMock()
    db.execute = AsyncMock(side_effect=[_scalars([cfg]), _scalars([])])
    with patch("app.services.dispatch_router._post_with_retry", new_callable=AsyncMock, side_effect=RuntimeError("boom")), \
         patch("app.core.ssrf.validate_webhook_url_async", new_callable=AsyncMock):
        # 예외 전파 없이 정상 반환해야 함
        await _deliver_personal_webhooks(db, org, [cfg.member_id], title="T", body=None, event_type="e")


@pytest.mark.anyio
async def test_empty_member_ids_noop():
    db = AsyncMock()
    db.execute = AsyncMock()
    await _deliver_personal_webhooks(db, uuid.uuid4(), [], title="T", body=None, event_type="e")
    db.execute.assert_not_awaited()
