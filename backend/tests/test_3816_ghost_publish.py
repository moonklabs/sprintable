"""story #3816(Phase3·3-6 PR2, 페드루 PO 確定 2026-09-12) — `ghost_publish.py` 직접
단위 테스트. DB 불요 — `httpx.MockTransport`로 Ghost Admin API 응답을 흉내낸다
(test_3816_ghost_client.py와 동형 관례)."""
from __future__ import annotations

from datetime import datetime, timezone

import httpx
import pytest

from app.services.ghost_publish import (
    GhostPublishError,
    GhostSiteURLInsecureError,
    publish,
    unpublish,
)

_FAKE_ADMIN_KEY = "64f1a2b3c4d5e6f7a8b9c0d1:0123456789abcdef0123456789abcdef"


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _transport(handler):
    return httpx.MockTransport(handler)


@pytest.mark.anyio
async def test_publish_create_sends_html_converted_body_and_source_html_query(dns_stub):
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["method"] = request.method
        captured["url"] = str(request.url)
        captured["body"] = request.content
        return httpx.Response(201, json={"posts": [{"id": "42", "url": "https://blog.example.com/p/42/"}]})

    async with httpx.AsyncClient(transport=_transport(handler)) as client:
        external_id, permalink = await publish(
            client, site_url="https://blog.example.com", admin_api_key=_FAKE_ADMIN_KEY,
            title="제목", body_md="# 제목\n\n본문입니다.", summary="요약", tags=["a", "b"], slug="my-post",
        )

    assert captured["method"] == "POST"
    assert captured["url"] == "https://blog.example.com/ghost/api/admin/posts/?source=html"
    import json as _json
    body = _json.loads(captured["body"])
    post = body["posts"][0]
    assert "<h1>제목</h1>" in post["html"]
    assert post["status"] == "published"
    assert post["tags"] == [{"name": "a"}, {"name": "b"}]
    assert external_id == "42"
    assert permalink == "https://blog.example.com/p/42/"


@pytest.mark.anyio
async def test_publish_with_scheduled_at_sets_scheduled_status_and_published_at(dns_stub):
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = request.content
        return httpx.Response(201, json={"posts": [{"id": "1", "url": None}]})

    async with httpx.AsyncClient(transport=_transport(handler)) as client:
        await publish(
            client, site_url="https://blog.example.com", admin_api_key=_FAKE_ADMIN_KEY,
            title="t", body_md="b", summary="s", tags=[], slug="slug-1",
            scheduled_at=datetime(2026, 12, 25, 9, 0, 0, tzinfo=timezone.utc),
        )

    import json as _json
    post = _json.loads(captured["body"])["posts"][0]
    assert post["status"] == "scheduled"
    assert post["published_at"] == "2026-12-25T09:00:00Z"


@pytest.mark.anyio
async def test_publish_update_reads_current_updated_at_then_puts_with_it(dns_stub):
    """story #3816 — Ghost 갱신은 낙관적 잠금 계약(현재 updated_at을 그대로
    되돌려 보내야 함). GET(조회)→PUT(갱신) 순서를 뮤테이션 대상으로 고정한다."""
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.method)
        if request.method == "GET":
            assert str(request.url) == "https://blog.example.com/ghost/api/admin/posts/existing-42/"
            return httpx.Response(200, json={"posts": [{"id": "existing-42", "updated_at": "2026-09-01T00:00:00.000Z"}]})
        assert str(request.url) == "https://blog.example.com/ghost/api/admin/posts/existing-42/?source=html"
        import json as _json
        body = _json.loads(request.content)
        assert body["posts"][0]["updated_at"] == "2026-09-01T00:00:00.000Z"
        return httpx.Response(200, json={"posts": [{"id": "existing-42", "url": "https://blog.example.com/p/x/"}]})

    async with httpx.AsyncClient(transport=_transport(handler)) as client:
        external_id, permalink = await publish(
            client, site_url="https://blog.example.com", admin_api_key=_FAKE_ADMIN_KEY,
            title="t", body_md="b", summary="s", tags=[], slug="slug-1", external_id="existing-42",
        )

    assert calls == ["GET", "PUT"]
    assert external_id == "existing-42"
    assert permalink == "https://blog.example.com/p/x/"


@pytest.mark.anyio
async def test_publish_retries_once_on_401_then_succeeds(dns_stub):
    """뮤테이션 대상(스토리 본문 明示) — 재서명 1회 재시도 분기를 지우면 이
    테스트가 RED여야 한다(첫 401에서 바로 실패로 끝난다)."""
    attempts = {"count": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        attempts["count"] += 1
        if attempts["count"] == 1:
            return httpx.Response(401, json={"errors": [{"message": "token expired"}]})
        return httpx.Response(201, json={"posts": [{"id": "1", "url": None}]})

    async with httpx.AsyncClient(transport=_transport(handler)) as client:
        external_id, _ = await publish(
            client, site_url="https://blog.example.com", admin_api_key=_FAKE_ADMIN_KEY,
            title="t", body_md="b", summary="s", tags=[], slug="slug-1",
        )

    assert attempts["count"] == 2
    assert external_id == "1"


@pytest.mark.anyio
async def test_publish_raises_ghost_publish_error_401_after_retry_exhausted(dns_stub):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"errors": [{"message": "invalid"}]})

    async with httpx.AsyncClient(transport=_transport(handler)) as client:
        with pytest.raises(GhostPublishError) as exc_info:
            await publish(
                client, site_url="https://blog.example.com", admin_api_key=_FAKE_ADMIN_KEY,
                title="t", body_md="b", summary="s", tags=[], slug="slug-1",
            )

    assert exc_info.value.status_code == 401


@pytest.mark.anyio
async def test_publish_raises_ghost_publish_error_on_5xx(dns_stub):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="internal error")

    async with httpx.AsyncClient(transport=_transport(handler)) as client:
        with pytest.raises(GhostPublishError) as exc_info:
            await publish(
                client, site_url="https://blog.example.com", admin_api_key=_FAKE_ADMIN_KEY,
                title="t", body_md="b", summary="s", tags=[], slug="slug-1",
            )

    assert exc_info.value.status_code == 500


@pytest.mark.anyio
async def test_publish_rejects_insecure_site_url():
    async with httpx.AsyncClient(transport=_transport(lambda r: httpx.Response(200))) as client:
        with pytest.raises(GhostSiteURLInsecureError):
            await publish(
                client, site_url="http://blog.example.com", admin_api_key=_FAKE_ADMIN_KEY,
                title="t", body_md="b", summary="s", tags=[], slug="slug-1",
            )


@pytest.mark.anyio
async def test_unpublish_reads_updated_at_then_sets_status_draft(dns_stub):
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.method)
        if request.method == "GET":
            return httpx.Response(200, json={"posts": [{"id": "42", "updated_at": "2026-09-01T00:00:00.000Z"}]})
        import json as _json
        body = _json.loads(request.content)
        assert body["posts"][0]["status"] == "draft"
        assert body["posts"][0]["updated_at"] == "2026-09-01T00:00:00.000Z"
        return httpx.Response(200, json={"posts": [{"id": "42"}]})

    async with httpx.AsyncClient(transport=_transport(handler)) as client:
        await unpublish(client, site_url="https://blog.example.com", admin_api_key=_FAKE_ADMIN_KEY, external_id="42")

    assert calls == ["GET", "PUT"]
