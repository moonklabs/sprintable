"""story #3813(Phase3·3-4 PR5-b, 페드루 PO 確定 2026-09-12) — `stibee_publish.py`
(실 발행 5-함수 파사드) 직접 단위 테스트. DB 불요 — `httpx.MockTransport`로
api.stibee.com 응답을 흉내낸다(test_e4fc29fa_webhook_publish_adapter.py와 동형)."""
from __future__ import annotations

import httpx
import pytest

from app.services.stibee_publish import (
    create_container,
    get_container_status,
    get_permalink,
    get_publishing_limit,
    publish_container,
)
from app.services.threads_publish import ThreadsPublishError


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _transport(handler):
    return httpx.MockTransport(handler)


@pytest.mark.anyio
async def test_create_container_calls_create_email_then_set_content_in_order():
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        if request.url.path == "/v2/emails":
            return httpx.Response(200, json={"id": 555})
        if request.url.path == "/v2/emails/555/content":
            assert request.headers.get("Content-Type") == "text/html; charset=utf-8"
            assert request.content == b"<html><body>hi</body></html>"
            return httpx.Response(200, json={})
        raise AssertionError(f"unexpected path: {request.url.path}")

    async with httpx.AsyncClient(transport=_transport(handler)) as client:
        creation_id = await create_container(
            client, access_token="real-key", threads_user_id="default", text="hi",
            subject="제목", list_id="777", sender_email="a@b.com", sender_name="발신자",
        )

    assert creation_id == "555"
    assert calls == ["/v2/emails", "/v2/emails/555/content"]


@pytest.mark.anyio
async def test_create_container_escapes_html_and_preserves_linebreaks():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v2/emails":
            return httpx.Response(200, json={"id": 1})
        captured["body"] = request.content.decode("utf-8")
        return httpx.Response(200, json={})

    async with httpx.AsyncClient(transport=_transport(handler)) as client:
        await create_container(
            client, access_token="k", threads_user_id="default", text="line1\nline2 <b>&",
            subject="s", list_id="1", sender_email="a@b.com", sender_name="n",
        )

    assert captured["body"] == "<html><body>line1<br>line2 &lt;b&gt;&amp;</body></html>"


@pytest.mark.anyio
async def test_create_container_missing_stibee_fields_fails_closed_without_http():
    called = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        called["n"] += 1
        return httpx.Response(200, json={"id": 1})

    async with httpx.AsyncClient(transport=_transport(handler)) as client:
        with pytest.raises(ThreadsPublishError) as exc_info:
            await create_container(
                client, access_token="k", threads_user_id="default", text="hi",
                subject=None, list_id="1", sender_email="a@b.com", sender_name="n",
            )

    assert exc_info.value.code == "STIBEE_CONNECTION_INCOMPLETE"
    assert called["n"] == 0, "필드 미비면 스티비에 아예 안 나가야 한다(422 fail-closed)"


@pytest.mark.anyio
async def test_create_container_wraps_plan_restricted():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, json={"code": "Errors.Service.NeedProPlan", "message": "..."})

    async with httpx.AsyncClient(transport=_transport(handler)) as client:
        with pytest.raises(ThreadsPublishError) as exc_info:
            await create_container(
                client, access_token="k", threads_user_id="default", text="hi",
                subject="s", list_id="1", sender_email="a@b.com", sender_name="n",
            )

    assert exc_info.value.code == "STIBEE_PLAN_RESTRICTED"


@pytest.mark.anyio
async def test_create_container_wraps_sender_not_verified():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, json={"code": "Errors.Authorization.PermissionDenied", "message": "..."})

    async with httpx.AsyncClient(transport=_transport(handler)) as client:
        with pytest.raises(ThreadsPublishError) as exc_info:
            await create_container(
                client, access_token="k", threads_user_id="default", text="hi",
                subject="s", list_id="1", sender_email="unverified@b.com", sender_name="n",
            )

    assert exc_info.value.code == "STIBEE_SENDER_NOT_VERIFIED"


@pytest.mark.anyio
async def test_get_container_status_always_finished():
    async with httpx.AsyncClient(transport=_transport(lambda r: httpx.Response(200))) as client:
        status, error = await get_container_status(client, access_token="k", creation_id="1")
    assert status == "FINISHED"
    assert error is None


@pytest.mark.anyio
async def test_publish_container_is_noop_returns_same_id():
    async with httpx.AsyncClient(transport=_transport(lambda r: httpx.Response(200))) as client:
        result = await publish_container(client, access_token="k", threads_user_id="default", creation_id="555")
    assert result == "555"


@pytest.mark.anyio
async def test_get_permalink_returns_none_unconfirmed():
    async with httpx.AsyncClient(transport=_transport(lambda r: httpx.Response(200))) as client:
        result = await get_permalink(client, access_token="k", media_id="555")
    assert result is None


@pytest.mark.anyio
async def test_get_publishing_limit_never_blocks():
    async with httpx.AsyncClient(transport=_transport(lambda r: httpx.Response(200))) as client:
        usage, total, duration = await get_publishing_limit(client, access_token="k", threads_user_id="default")
    assert usage < total
