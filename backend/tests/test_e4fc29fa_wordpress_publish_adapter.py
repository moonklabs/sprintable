"""story e4fc29fa(Phase1·마케팅운영, 페드루 PO 確定 2026-09-04, 조각③b) —
`wordpress_publish.py`(BlogDestinationAdapter 2호 구현체) 직접 단위 테스트.

DB 불요(모듈 자체가 순수 httpx 클라이언트 — hosted_site_publish.py와 달리 site_posts
테이블에 안 쓴다) — `httpx.MockTransport`로 WordPress REST API 응답을 흉내낸다."""
from __future__ import annotations

import json

import httpx
import pytest

from app.services.wordpress_publish import (
    WordPressPublishError,
    WordPressSiteURLInsecureError,
    publish,
    unpublish,
)


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _transport(handler):
    return httpx.MockTransport(handler)


@pytest.mark.anyio
async def test_publish_creates_post_returns_external_id_and_permalink():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["method"] = request.method
        captured["url"] = str(request.url)
        captured["auth_header"] = request.headers.get("authorization")
        captured["body"] = json.loads(request.content)
        return httpx.Response(201, json={"id": 42, "link": "https://customer-blog.example.com/2026/09/my-slug/"})

    async with httpx.AsyncClient(transport=_transport(handler)) as client:
        external_id, permalink = await publish(
            client, site_url="https://customer-blog.example.com", username="editor",
            app_password="app-pw-abcd-1234", title="제목", body_md="# 본문", summary="요약",
            slug="my-slug",
        )

    assert external_id == "42"
    assert permalink == "https://customer-blog.example.com/2026/09/my-slug/"
    assert captured["method"] == "POST"
    assert captured["url"] == "https://customer-blog.example.com/wp-json/wp/v2/posts"
    assert captured["auth_header"] is not None and captured["auth_header"].startswith("Basic ")
    assert captured["body"] == {
        "title": "제목", "content": "# 본문", "excerpt": "요약", "slug": "my-slug", "status": "publish",
    }


@pytest.mark.anyio
async def test_publish_with_external_id_updates_existing_post():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        return httpx.Response(200, json={"id": 42, "link": "https://customer-blog.example.com/2026/09/my-slug/"})

    async with httpx.AsyncClient(transport=_transport(handler)) as client:
        external_id, _ = await publish(
            client, site_url="https://customer-blog.example.com", username="editor",
            app_password="app-pw", title="제목2", body_md="본문2", summary="요약2", slug="my-slug",
            external_id="42",
        )

    assert external_id == "42"
    assert captured["url"] == "https://customer-blog.example.com/wp-json/wp/v2/posts/42"


@pytest.mark.anyio
async def test_publish_non_2xx_raises_wordpress_publish_error():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, text='{"code":"rest_cannot_create","message":"Sorry, you are not allowed."}')

    async with httpx.AsyncClient(transport=_transport(handler)) as client:
        with pytest.raises(WordPressPublishError) as exc_info:
            await publish(
                client, site_url="https://customer-blog.example.com", username="editor",
                app_password="wrong-pw", title="제목", body_md="본문", summary="요약", slug="slug",
            )

    assert exc_info.value.status_code == 401


@pytest.mark.anyio
async def test_publish_rejects_http_site_url_no_call_made():
    """AC2 「HTTPS 강제」 — http://는 자격이 평문 노출되므로 호출 자체를 안 한다.
    뮤테이션 대상: 이 가드를 지우면 http:// site_url로도 실 요청이 나간다(핸들러가
    호출되면 즉시 AssertionError로 잡는다)."""
    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("HTTPS 미강제 — http://로 실제 요청이 나갔다")

    async with httpx.AsyncClient(transport=_transport(handler)) as client:
        with pytest.raises(WordPressSiteURLInsecureError):
            await publish(
                client, site_url="http://customer-blog.example.com", username="editor",
                app_password="pw", title="제목", body_md="본문", summary="요약", slug="slug",
            )


@pytest.mark.anyio
async def test_unpublish_sets_status_draft():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"id": 42, "status": "draft"})

    async with httpx.AsyncClient(transport=_transport(handler)) as client:
        await unpublish(
            client, site_url="https://customer-blog.example.com", username="editor",
            app_password="pw", external_id="42",
        )

    assert captured["url"] == "https://customer-blog.example.com/wp-json/wp/v2/posts/42"
    assert captured["body"] == {"status": "draft"}


@pytest.mark.anyio
async def test_unpublish_non_2xx_raises():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="internal error")

    async with httpx.AsyncClient(transport=_transport(handler)) as client:
        with pytest.raises(WordPressPublishError) as exc_info:
            await unpublish(
                client, site_url="https://customer-blog.example.com", username="editor",
                app_password="pw", external_id="42",
            )

    assert exc_info.value.status_code == 500
