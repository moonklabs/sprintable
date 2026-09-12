"""story #3816(Phase3·3-6 PR2, 페드루 PO 確定 2026-09-12) — Ghost 발행(publish)/
회수(unpublish). `blog_destinations.py::BlogDestinationModule` Protocol 구현체 —
wordpress_publish.py/webhook_publish.py와 동형(publish/unpublish 두 async
callable) — site_url+admin_api_key로 Ghost Admin API를 직접 친다.

**이미지 재업로드→URL 치환은 이 PR 범위 밖**(페드루 PO 決定 2026-09-12 12:20Z)
— `site_post_versions`에 이미지 필드 자체가 없고, body_md 안 인라인 이미지
URL은 HTML로 그대로 넘기면 Ghost가 외부 URL을 그대로 렌더해 기능 갭이 아니다.
`/images/upload/`(Ghost 내부 저장이 필요해질 때 후속, 필요성 자체가 미확認)·
`ghost-image-too-large` 마커는 지금 등재하지 않는다(적기만).

글 생성/갱신은 `?source=html`(HTML 계약) — `markdown_render.render_markdown_html`
로 body_md를 HTML로 변환해 보낸다(마크다운 문법이 그대로 노출되는 결함 처방,
PO 決定 — wordpress의 같은 클래스 잔존 결함은 이 PR에서 안 건드린다). 갱신
(external_id 있음)은 Ghost Admin API의 낙관적 잠금 계약대로 먼저 GET으로 현재
`updated_at`을 읽어 PUT 페이로드에 실어야 한다(⚠️미확認·실 사이트 왕복 前 —
공개 문서 그라운딩 그대로, stibee의 여러 self-correction 선례처럼 조정 여지).

봉인 시각(scheduled_at)이 있으면 status="scheduled"+published_at=그 시각(UTC
ISO8601), 없으면 status="published"(즉시 게시).

JWT 401은 시계 어긋남(clock skew)일 수 있어 재서명 1회만 재시도한다(같은
admin_api_key로 새 iat/exp 재발급 — `sign_admin_jwt`는 캐싱하지 않는 설계라
그냥 한 번 더 부르면 된다). 그래도 401이면 자격 자체가 틀렸다는 뜻 — 연결
「다시 연결 필요」 세계(`GhostPublishError.status_code == 401`을 site_posts.py::
_blog_publish_error_code가 `GHOST_AUTH_FAILED`로 승격, CHANNEL_PUBLISH_AUTH_
REJECTED와 다른 코드를 쓰는 이유는 저장 시 GHOST_ADMIN_KEY_INVALID와 같은
문구를 재사용해야 해서다, PO §낱말 정정 2)."""
from __future__ import annotations

from datetime import datetime, timezone

import httpx

from app.services.destination_url_safety import DestinationURLUnsafeError, assert_destination_url_safe
from app.services.ghost_client import ghost_stub_enabled, sign_admin_jwt
from app.services.markdown_render import render_markdown_html

_POSTS_PATH = "/ghost/api/admin/posts/"


class GhostSiteURLInsecureError(ValueError):
    """site_url이 안전하지 않음(destination_url_safety.py 판정 그대로 감쌈) —
    wordpress_publish.py::WordPressSiteURLInsecureError와 동형 사상. 메시지는
    영문(#3779 가드 — 이 예외는 내부 분류 전용이라 사람 화면엔 code로만 닿는다,
    최근 채널 등록의 영문 관례와 동형 — wordpress의 한글 메시지는 가드 시행 前
    baseline 잔존)."""

    def __init__(self, *, site_url: str):
        self.site_url = site_url
        super().__init__(f"Ghost site_url is not safe: {site_url!r}")


class GhostPublishError(Exception):
    """Ghost Admin API가 2xx 밖 응답을 줌 — status_code·응답 본문(길이 컷)을 실어
    failure_kind 분류에 쓴다(wordpress_publish.py::WordPressPublishError와 동형).
    `.status_code == 401`은 재서명 1회 재시도까지 실패한 뒤에만 여기 도달한다
    (site_posts.py가 이 값으로 GHOST_AUTH_FAILED를 고른다)."""

    _BODY_MAX_CHARS = 500

    def __init__(self, *, status_code: int, body: str):
        self.status_code = status_code
        self.body = body[: self._BODY_MAX_CHARS]
        super().__init__(f"Ghost Admin API error(status={status_code}): {self.body}")


async def _validate_site_url(site_url: str) -> str:
    try:
        return await assert_destination_url_safe(site_url, allow_loopback=ghost_stub_enabled())
    except DestinationURLUnsafeError as exc:
        raise GhostSiteURLInsecureError(site_url=site_url) from exc


async def _request_with_retry(
    client: httpx.AsyncClient, method: str, url: str, *, admin_api_key: str, json_body: dict | None = None,
) -> httpx.Response:
    """JWT 401 재서명 1회 재시도(모듈 docstring 그대로) — 이 모듈의 모든 Admin API
    호출(GET·POST·PUT)이 이 헬퍼 하나를 거친다(재시도 로직 중복 0)."""
    token = sign_admin_jwt(admin_api_key)
    resp = await client.request(method, url, headers={"Authorization": f"Ghost {token}"}, json=json_body, timeout=20)
    if resp.status_code == 401:
        token = sign_admin_jwt(admin_api_key)
        resp = await client.request(method, url, headers={"Authorization": f"Ghost {token}"}, json=json_body, timeout=20)
    return resp


def _post_status_and_published_at(scheduled_at: datetime | None) -> dict:
    if scheduled_at is None:
        return {"status": "published"}
    at = scheduled_at if scheduled_at.tzinfo else scheduled_at.replace(tzinfo=timezone.utc)
    return {"status": "scheduled", "published_at": at.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")}


async def publish(
    client: httpx.AsyncClient,
    *,
    site_url: str,
    admin_api_key: str,
    title: str,
    body_md: str,
    summary: str,
    tags: list,
    slug: str,
    external_id: str | None = None,
    scheduled_at: datetime | None = None,
) -> tuple[str, str | None]:
    """external_id가 없으면 생성(POST), 있으면 갱신(PUT) — wordpress_publish.py의
    upsert 사상과 동형(재발행이 새 글을 또 안 만든다). 반환은 (external_id,
    permalink) — 응답 JSON의 `posts[0].id`(문자열)·`posts[0].url`."""
    base = await _validate_site_url(site_url)
    html = render_markdown_html(body_md)
    post_fields: dict = {
        "title": title, "html": html, "custom_excerpt": summary, "slug": slug,
        "tags": [{"name": tag} for tag in tags],
        **_post_status_and_published_at(scheduled_at),
    }

    if external_id is None:
        url = f"{base}{_POSTS_PATH}?source=html"
        resp = await _request_with_retry(
            client, "POST", url, admin_api_key=admin_api_key, json_body={"posts": [post_fields]},
        )
    else:
        # Ghost Admin API 갱신은 낙관적 잠금(현재 updated_at을 그대로 되돌려 보내야
        # 함) — 먼저 GET으로 그 값을 읽는다(⚠️미확認, 공개 문서 그라운딩).
        get_resp = await _request_with_retry(
            client, "GET", f"{base}{_POSTS_PATH}{external_id}/", admin_api_key=admin_api_key,
        )
        if get_resp.status_code // 100 != 2:
            raise GhostPublishError(status_code=get_resp.status_code, body=get_resp.text)
        current_updated_at = get_resp.json()["posts"][0]["updated_at"]
        post_fields["updated_at"] = current_updated_at
        url = f"{base}{_POSTS_PATH}{external_id}/?source=html"
        resp = await _request_with_retry(
            client, "PUT", url, admin_api_key=admin_api_key, json_body={"posts": [post_fields]},
        )

    if resp.status_code // 100 != 2:
        raise GhostPublishError(status_code=resp.status_code, body=resp.text)
    post = resp.json()["posts"][0]
    return str(post["id"]), post.get("url")


async def unpublish(
    client: httpx.AsyncClient, *, site_url: str, admin_api_key: str, external_id: str,
) -> None:
    """行 삭제가 아니라 status=draft 전환(wordpress_publish.unpublish()와 동형
    비파괴 사상) — 재발행(publish() 재호출)으로 되돌릴 수 있다."""
    base = await _validate_site_url(site_url)
    get_resp = await _request_with_retry(
        client, "GET", f"{base}{_POSTS_PATH}{external_id}/", admin_api_key=admin_api_key,
    )
    if get_resp.status_code // 100 != 2:
        raise GhostPublishError(status_code=get_resp.status_code, body=get_resp.text)
    current_updated_at = get_resp.json()["posts"][0]["updated_at"]
    resp = await _request_with_retry(
        client, "PUT", f"{base}{_POSTS_PATH}{external_id}/?source=html", admin_api_key=admin_api_key,
        json_body={"posts": [{"status": "draft", "updated_at": current_updated_at}]},
    )
    if resp.status_code // 100 != 2:
        raise GhostPublishError(status_code=resp.status_code, body=resp.text)
