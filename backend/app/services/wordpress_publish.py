"""story e4fc29fa(Phase1·마케팅운영, 페드루 PO 確定 2026-09-04, 조각③b) — `wordpress`
(CHANNEL_ADAPTERS 등재, kind="blog") BlogDestinationAdapter 2호 구현체. `hosted_site_
publish.py`(조각②)와 같은 이름(publish/unpublish)의 모듈 — `blog_destinations.py::
BlogDestinationModule` Protocol의 두 번째 실체.

**self-hosted Application Password 경로만**(스토리 경계 明示) — WordPress.com OAuth2는
credential_kind 선언만 하고 이 모듈은 안 다룬다(사람 의존 앱 등록이 필요해 후속).

인증: WordPress 5.6+ Application Password(HTTPS Basic, RFC 7617) — `username`+
`app_password`를 그대로 `httpx.BasicAuth`에 넘긴다(OAuth 토큰류가 아니라 재사용 가능한
비밀번호 자체라 refresh 개념이 없다 — connection.refresh_mode="manual"과 부합).
`site_url`은 `destination_url_safety.py`(조각④, 공용 SSRF 방지 헬퍼 — webhook_publish.py
도 같은 헬퍼를 쓴다)로 검증한다: HTTPS 강제 + host를 실제로 DNS 해석해 모든 결과 IP가
사설/loopback/link-local(클라우드 메타데이터 포함)이 아님을 확인("해석 시점" 검사 —
문자열 프리픽스만 보던 조각③b/③c 구현은 도메인이 나중에 내부 IP로 rebind되는 공격을
못 잡았다). loopback(`http://127.0.0.1`·`http://localhost`) 예외는 `WORDPRESS_TEST_
STUB_ENABLED` 플래그가 켜졌을 때만(페드루 리뷰 B1, 2026-09-04) — prod cloudbuild.yaml
이 이 키를 안 실어 prod에서는 예외 자체가 죽어 있다. 조각③c의 dev_wordpress_stub.py
(실 uvicorn, TLS 없음)가 유일한 실사용처.

`tags`는 이번 조각 스코프 밖 — WordPress REST API는 태그를 이름이 아니라 term ID
배열로 요구해(taxonomy 조회/생성 API 별도 호출 필요) 지금 페이로드엔 안 싣는다
(스모크 스코프 明示, AC 본문 "제목/본문/요약/slug" 중심 — 조각③b 결정, 후속에서
필요하면 taxonomy 매핑을 별도로 추가)."""
from __future__ import annotations

import os

import httpx

from app.services.destination_url_safety import DestinationURLUnsafeError, assert_destination_url_safe

_POSTS_PATH = "/wp-json/wp/v2/posts"


def wordpress_stub_enabled() -> bool:
    """story e4fc29fa(조각③c, 페드루 리뷰 B1) — sandbox_publish.py의 SANDBOX_CHANNEL_
    ENABLED와 동형 env 게이트. 여기(서비스 계층)에 두고 `dev_wordpress_stub.py`(라우터
    계층)가 이 함수를 가져다 쓴다 — 서비스가 라우터를 import하는 역방향 계층 위반을
    피한다."""
    return os.environ.get("WORDPRESS_TEST_STUB_ENABLED", "").strip().lower() == "true"


class WordPressSiteURLInsecureError(ValueError):
    """site_url이 https://로 시작하지 않음 — Application Password는 HTTPS Basic이라
    http://로 보내면 자격이 평문 노출된다(AC2 「HTTPS 강제」明示). fail-closed."""

    def __init__(self, *, site_url: str):
        self.site_url = site_url
        super().__init__(f"WordPress site_url은 https://여야 합니다: {site_url!r}")


class WordPressPublishError(Exception):
    """WordPress REST API가 2xx 밖 응답을 줌 — status_code·응답 본문(에러 메시지)을
    실어 호출자가 failure_kind(transient/needs_check) 분류에 쓸 수 있게 한다
    (threads_publish.py::ThreadsPublishError와 동형 사상 — 이 조각은 분류 자체는
    안 한다, 오케스트레이션 배선은 후속)."""

    def __init__(self, *, status_code: int, body: str):
        self.status_code = status_code
        self.body = body
        super().__init__(f"WordPress REST API 오류(status={status_code}): {body}")


async def _validate_https(site_url: str) -> str:
    """story e4fc29fa(조각④) — 공용 헬퍼(destination_url_safety.py)에 위임하고
    `DestinationURLUnsafeError`를 이 모듈의 기존 공개 예외(`WordPressSiteURLInsecureError`
    — 호출자 계약 무변경)로 다시 감싼다. `allow_loopback=wordpress_stub_enabled()` —
    페드루 리뷰 B1의 플래그 게이트 그대로(뮤테이션 대상: 이 인자를 지우면 prod에서도
    loopback이 통과해야 하는데, 실은 통과하면 안 된다는 게 이 가드의 존재 이유)."""
    try:
        return await assert_destination_url_safe(site_url, allow_loopback=wordpress_stub_enabled())
    except DestinationURLUnsafeError as exc:
        raise WordPressSiteURLInsecureError(site_url=site_url) from exc


async def publish(
    client: httpx.AsyncClient,
    *,
    site_url: str,
    username: str,
    app_password: str,
    title: str,
    body_md: str,
    summary: str,
    slug: str,
    external_id: str | None = None,
) -> tuple[str, str]:
    """external_id가 없으면 `/wp/v2/posts`에 생성(POST), 있으면 `/wp/v2/posts/{id}`로
    갱신(WordPress REST는 갱신도 POST) — hosted_site_publish.publish()의 upsert
    사상과 동형(재발행이 새 글을 또 안 만든다). 반환은 (external_id, permalink) —
    응답 JSON의 `id`(정수, 문자열로 캐스팅)·`link`."""
    base = await _validate_https(site_url)
    path = f"{_POSTS_PATH}/{external_id}" if external_id else _POSTS_PATH
    payload = {"title": title, "content": body_md, "excerpt": summary, "slug": slug, "status": "publish"}
    resp = await client.post(
        f"{base}{path}", json=payload, auth=httpx.BasicAuth(username, app_password), timeout=20,
    )
    if resp.status_code not in (200, 201):
        raise WordPressPublishError(status_code=resp.status_code, body=resp.text)
    data = resp.json()
    return str(data["id"]), data["link"]


async def unpublish(
    client: httpx.AsyncClient, *, site_url: str, username: str, app_password: str, external_id: str,
) -> None:
    """行 삭제가 아니라 status=draft 전환(AC2가 명시한 두 선택지 중 이쪽 — hosted_site_
    publish.unpublish()가 행을 안 지우고 unpublished_at만 세우는 것과 같은 비파괴
    사상). WordPress가 draft 글도 REST 조회 대상에 남기므로 재발행(publish() 재호출)
    으로 되돌릴 수 있다."""
    base = await _validate_https(site_url)
    resp = await client.post(
        f"{base}{_POSTS_PATH}/{external_id}",
        json={"status": "draft"},
        auth=httpx.BasicAuth(username, app_password),
        timeout=20,
    )
    if resp.status_code not in (200, 201):
        raise WordPressPublishError(status_code=resp.status_code, body=resp.text)
