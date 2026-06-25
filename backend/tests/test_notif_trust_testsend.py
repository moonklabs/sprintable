"""0a6487c6-BE: 알림 목적지 trust-surface BE — test-send 엔드포인트 + deliver_test_webhook.

AC2 합성 'TEST' 1발·AC3 계약 {ok, reached, reason?, ts}·SSRF 재검증·Discord 정규화(c60dd33c)·
anti-IDOR(repo.get org-scope). AC1(in-app opt-out 디폴트)은 notification_dispatch 기존 거동(surface-only).
"""
from __future__ import annotations

import json
import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from app.routers.webhooks import test_send_webhook_config as _send_test  # 별칭(pytest 수집 회피)
from app.services.webhook_dispatch import deliver_test_webhook


@pytest.fixture
def anyio_backend():
    return "asyncio"


class _Resp:
    def __init__(self, status_code: int):
        self.status_code = status_code


def _client_cm(post_mock):
    client = AsyncMock()
    client.post = post_mock
    cm = AsyncMock()
    cm.__aenter__ = AsyncMock(return_value=client)
    cm.__aexit__ = AsyncMock(return_value=False)
    return cm


# ─── deliver_test_webhook ─────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_reached_on_2xx():
    with patch("app.services.webhook_dispatch.validate_webhook_url_async", new=AsyncMock()), \
         patch("app.services.webhook_dispatch.httpx.AsyncClient",
               return_value=_client_cm(AsyncMock(return_value=_Resp(204)))):
        reached, reason = await deliver_test_webhook("https://example.com/hook", None)
    assert reached is True and reason is None


@pytest.mark.anyio
async def test_not_reached_on_non_2xx_has_reason():
    with patch("app.services.webhook_dispatch.validate_webhook_url_async", new=AsyncMock()), \
         patch("app.services.webhook_dispatch.httpx.AsyncClient",
               return_value=_client_cm(AsyncMock(return_value=_Resp(500)))):
        reached, reason = await deliver_test_webhook("https://example.com/hook", None)
    assert reached is False and "500" in reason


@pytest.mark.anyio
async def test_ssrf_rejected_before_post():
    """사용자 URL → SSRF 재검증 실패 시 post 미발사·미도달(내부망 차단)."""
    posted = AsyncMock()
    with patch("app.services.webhook_dispatch.validate_webhook_url_async",
               new=AsyncMock(side_effect=ValueError("blocked"))), \
         patch("app.services.webhook_dispatch.httpx.AsyncClient", return_value=_client_cm(posted)):
        reached, reason = await deliver_test_webhook("http://169.254.169.254/", None)
    assert reached is False and "url" in reason
    posted.assert_not_called()


@pytest.mark.anyio
async def test_discord_url_normalized_payload_no_signature():
    """Discord URL은 {content|embeds}로 정규화(c60dd33c·아니면 400)·TEST 라벨 포함."""
    captured: dict = {}

    async def _post(url, content=None, headers=None):
        captured["content"] = content
        captured["headers"] = headers
        return _Resp(204)

    with patch("app.services.webhook_dispatch.validate_webhook_url_async", new=AsyncMock()), \
         patch("app.services.webhook_dispatch.httpx.AsyncClient", return_value=_client_cm(_post)):
        reached, _ = await deliver_test_webhook(
            "https://discord.com/api/webhooks/1/abc", None
        )
    assert reached is True
    body = json.loads(captured["content"])
    assert "content" in body or "embeds" in body  # Discord 형식
    assert "TEST" in captured["content"]


# ─── POST /config/{id}/test-send (계약 lock) ──────────────────────────────────

@pytest.mark.anyio
async def test_endpoint_404_when_config_missing_or_cross_org():
    """repo.get org-scope → 타 org/없는 id면 None → 404(anti-IDOR)."""
    from fastapi import HTTPException
    repo = AsyncMock()
    repo.get = AsyncMock(return_value=None)
    with pytest.raises(HTTPException) as ei:
        await _send_test(uuid.uuid4(), repo=repo)
    assert ei.value.status_code == 404


@pytest.mark.anyio
async def test_endpoint_contract_reached_omits_reason():
    repo = AsyncMock()
    repo.get = AsyncMock(return_value=SimpleNamespace(url="https://x/h", secret=None))
    with patch("app.services.webhook_dispatch.deliver_test_webhook",
               new=AsyncMock(return_value=(True, None))):
        out = await _send_test(uuid.uuid4(), repo=repo)
    assert out["ok"] is True and out["reached"] is True and "ts" in out
    assert "reason" not in out  # 도달 시 reason 생략(계약)


@pytest.mark.anyio
async def test_endpoint_contract_not_reached_includes_reason():
    repo = AsyncMock()
    repo.get = AsyncMock(return_value=SimpleNamespace(url="https://x/h", secret=None))
    with patch("app.services.webhook_dispatch.deliver_test_webhook",
               new=AsyncMock(return_value=(False, "HTTP 502"))):
        out = await _send_test(uuid.uuid4(), repo=repo)
    assert out["ok"] is True and out["reached"] is False and out["reason"] == "HTTP 502"
