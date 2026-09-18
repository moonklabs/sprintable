"""story e4fc29fa(Phase1·마케팅운영, 페드루 PO 確定 2026-09-04, 조각④) —
`webhook_publish.py`(BlogDestinationAdapter 3호 구현체) 직접 단위 테스트.

DB 불요 — `httpx.MockTransport`로 수신측 응답을 흉내낸다. https:// 경로는 `dns_stub`
(tests/conftest.py)로 실 DNS 없이 결정적으로 통제한다(destination_url_safety.py가
실 DNS 해석을 하므로)."""
from __future__ import annotations

import hashlib
import hmac
import json

import httpx
import pytest

from app.services.webhook_publish import (
    WebhookPublishError,
    WebhookTargetURLInsecureError,
    publish,
    unpublish,
)


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _transport(handler):
    return httpx.MockTransport(handler)


@pytest.mark.anyio
async def test_publish_sends_signed_request_with_three_headers(dns_stub):
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["method"] = request.method
        captured["url"] = str(request.url)
        captured["signature"] = request.headers.get("x-sprintable-signature")
        captured["timestamp"] = request.headers.get("x-sprintable-timestamp")
        captured["nonce"] = request.headers.get("x-sprintable-nonce")
        captured["body"] = request.content
        return httpx.Response(200, json={"external_id": "wh-1", "url": "https://customer.example.com/posts/1"})

    async with httpx.AsyncClient(transport=_transport(handler)) as client:
        external_id, permalink = await publish(
            client, target_url="https://customer-target.example.com/hook", secret="shared-secret",
            title="제목", body_md="본문", summary="요약", tags=["a"], slug="my-slug",
        )

    assert external_id == "wh-1"
    assert permalink == "https://customer.example.com/posts/1"
    assert captured["method"] == "POST"
    assert captured["url"] == "https://customer-target.example.com/hook"
    assert captured["signature"] is not None and captured["signature"].startswith("sha256=")
    assert captured["timestamp"] is not None and captured["timestamp"].isdigit()
    assert captured["nonce"] is not None

    # 카디르 QA 블로커(2026-09-04, 정본 §4 재확定) — 서명 대상은 body 단독이 아니라
    # timestamp·nonce까지 포함(webhook_publish.py::_signed_payload와 동일 구성).
    signed_payload = f"{captured['timestamp']}.{captured['nonce']}.".encode() + captured["body"]
    expected_sig = "sha256=" + hmac.new(b"shared-secret", signed_payload, hashlib.sha256).hexdigest()
    assert captured["signature"] == expected_sig

    body_json = json.loads(captured["body"])
    assert body_json["event"] == "publish"
    assert body_json["title"] == "제목"
    assert body_json["slug"] == "my-slug"


@pytest.mark.anyio
async def test_publish_falls_back_to_slug_when_response_has_no_external_id(dns_stub):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={})

    async with httpx.AsyncClient(transport=_transport(handler)) as client:
        external_id, permalink = await publish(
            client, target_url="https://customer-target.example.com/hook", secret="s",
            title="t", body_md="b", summary="s", tags=[], slug="fallback-slug",
        )
    assert external_id == "fallback-slug"
    assert permalink is None


@pytest.mark.anyio
async def test_publish_non_2xx_raises_webhook_publish_error(dns_stub):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="upstream error")

    async with httpx.AsyncClient(transport=_transport(handler)) as client:
        with pytest.raises(WebhookPublishError) as exc_info:
            await publish(
                client, target_url="https://customer-target.example.com/hook", secret="s",
                title="t", body_md="b", summary="s", tags=[], slug="slug",
            )
    assert exc_info.value.status_code == 500


@pytest.mark.anyio
async def test_publish_error_body_is_truncated(dns_stub):
    """페드루 기록(③c PO 確定) — 응답 본문이 통지 payload에 그대로 실리면 사이트
    HTML 전문이 딸려 나올 수 있어 앞부분만 자른다. 뮤테이션 대상: 컷을 지우면 이
    assert가 RED(과도하게 긴 body)."""
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="x" * 5000)

    async with httpx.AsyncClient(transport=_transport(handler)) as client:
        with pytest.raises(WebhookPublishError) as exc_info:
            await publish(
                client, target_url="https://customer-target.example.com/hook", secret="s",
                title="t", body_md="b", summary="s", tags=[], slug="slug",
            )
    assert len(exc_info.value.body) <= 500


@pytest.mark.anyio
async def test_publish_rejects_http_scheme(dns_stub):
    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("HTTPS 미강제 — http://로 실제 요청이 나갔다")

    async with httpx.AsyncClient(transport=_transport(handler)) as client:
        with pytest.raises(WebhookTargetURLInsecureError):
            await publish(
                client, target_url="http://customer-target.example.com/hook", secret="s",
                title="t", body_md="b", summary="s", tags=[], slug="slug",
            )


@pytest.mark.anyio
async def test_publish_rejects_domain_resolving_to_private_ip(dns_stub):
    dns_stub.map("attacker.example.com", "10.0.0.5")

    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("사설 IP로 해석되는 도메인인데 실제 요청이 나갔다")

    async with httpx.AsyncClient(transport=_transport(handler)) as client:
        with pytest.raises(WebhookTargetURLInsecureError):
            await publish(
                client, target_url="https://attacker.example.com/hook", secret="s",
                title="t", body_md="b", summary="s", tags=[], slug="slug",
            )


@pytest.mark.anyio
async def test_unpublish_sends_unpublish_event(dns_stub):
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={})

    async with httpx.AsyncClient(transport=_transport(handler)) as client:
        await unpublish(
            client, target_url="https://customer-target.example.com/hook", secret="s", external_id="wh-1",
        )
    assert captured["body"] == {"event": "unpublish", "external_id": "wh-1"}


@pytest.mark.anyio
async def test_unpublish_non_2xx_raises(dns_stub):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, text="unavailable")

    async with httpx.AsyncClient(transport=_transport(handler)) as client:
        with pytest.raises(WebhookPublishError) as exc_info:
            await unpublish(
                client, target_url="https://customer-target.example.com/hook", secret="s", external_id="wh-1",
            )
    assert exc_info.value.status_code == 503
