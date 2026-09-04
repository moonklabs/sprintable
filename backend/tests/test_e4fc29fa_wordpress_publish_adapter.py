"""story e4fc29fa(Phase1·마케팅운영, 페드루 PO 確定 2026-09-04, 조각③b) —
`wordpress_publish.py`(BlogDestinationAdapter 2호 구현체) 직접 단위 테스트.

DB 불요(모듈 자체가 순수 httpx 클라이언트 — hosted_site_publish.py와 달리 site_posts
테이블에 안 쓴다) — `httpx.MockTransport`로 WordPress REST API 응답을 흉내낸다.

story e4fc29fa(조각④) — `_validate_https`가 이제 destination_url_safety.py로 실
DNS 해석까지 한다(SSRF 「해석 시점」검사) — https:// 경로를 타는 테스트는 `dns_stub`
(tests/conftest.py, socket.getaddrinfo 결정적 스텁)이 필요하다."""
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
async def test_publish_creates_post_returns_external_id_and_permalink(dns_stub):
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
async def test_publish_with_external_id_updates_existing_post(dns_stub):
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
async def test_publish_non_2xx_raises_wordpress_publish_error(dns_stub):
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
async def test_publish_allows_loopback_http_site_url_when_stub_flag_on(monkeypatch):
    """조각③c — dev_wordpress_stub.py(실 uvicorn, TLS 없음) 대상 AC7 실왕복 테스트가
    걸리지 않도록 http://127.0.0.1·http://localhost는 WORDPRESS_TEST_STUB_ENABLED=true
    일 때만 HTTPS 강제 예외(RFC 8252 §7.3 동형 사상, 페드루 리뷰 B1로 플래그 게이트
    추가). 뮤테이션 대상: 이 예외를 지우면 loopback 왕복 테스트가 전부 RED."""
    monkeypatch.setenv("WORDPRESS_TEST_STUB_ENABLED", "true")

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(201, json={"id": 1, "link": "http://127.0.0.1:9/post-1/"})

    async with httpx.AsyncClient(transport=_transport(handler)) as client:
        external_id, _ = await publish(
            client, site_url="http://127.0.0.1:9", username="editor",
            app_password="pw", title="제목", body_md="본문", summary="요약", slug="slug",
        )
    assert external_id == "1"


@pytest.mark.anyio
async def test_publish_rejects_loopback_http_site_url_when_stub_flag_off(monkeypatch):
    """조각③c(페드루 리뷰 B1, 2026-09-04) — SSRF 방지: prod처럼 플래그가 꺼진 상태에서는
    loopback도 예외 없이 거부한다. 뮤테이션 대상: 플래그 게이트(`and wordpress_stub_
    enabled()`)를 지우면 prod에서도 site_url=http://127.0.0.1:.../가 통과해 워커가
    우리 컨테이너 자신의 loopback에 Basic auth를 실어 진짜로 친다(SSRF)."""
    monkeypatch.delenv("WORDPRESS_TEST_STUB_ENABLED", raising=False)

    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("플래그 off인데 loopback으로 실제 요청이 나갔다")

    async with httpx.AsyncClient(transport=_transport(handler)) as client:
        with pytest.raises(WordPressSiteURLInsecureError):
            await publish(
                client, site_url="http://127.0.0.1:9", username="editor",
                app_password="pw", title="제목", body_md="본문", summary="요약", slug="slug",
            )


@pytest.mark.anyio
async def test_unpublish_sets_status_draft(dns_stub):
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
async def test_publish_rejects_domain_that_resolves_to_private_ip(dns_stub):
    """story e4fc29fa(조각④) — DNS rebinding류 SSRF: 문자열은 https://평범한-도메인
    이어도 실제 해석된 IP가 사설 대역이면 거부한다("해석 시점" 검사, 문자열 프리픽스
    검사만으론 이걸 못 잡는다). 뮤테이션 대상: destination_url_safety.py의 DNS 해석
    단계를 지우면(스킴만 검사) 이 assert가 RED."""
    dns_stub.map("attacker-controlled.example.com", "10.0.0.5")

    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("사설 IP로 해석되는 도메인인데 실제 요청이 나갔다")

    async with httpx.AsyncClient(transport=_transport(handler)) as client:
        with pytest.raises(WordPressSiteURLInsecureError):
            await publish(
                client, site_url="https://attacker-controlled.example.com", username="editor",
                app_password="pw", title="제목", body_md="본문", summary="요약", slug="slug",
            )


@pytest.mark.anyio
async def test_unpublish_non_2xx_raises(dns_stub):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="internal error")

    async with httpx.AsyncClient(transport=_transport(handler)) as client:
        with pytest.raises(WordPressPublishError) as exc_info:
            await unpublish(
                client, site_url="https://customer-blog.example.com", username="editor",
                app_password="pw", external_id="42",
            )

    assert exc_info.value.status_code == 500
