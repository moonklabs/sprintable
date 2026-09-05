"""story #3547(Phase2·마케팅운영, 페드루 PO 確定 2026-09-06) — Facebook Page 피드
발행. `channel_posts.py`(story 620beefc)의 create_container→get_container_status→
publish_container 3단계 오케스트레이션은 Threads/Instagram의 "비동기 컨테이너"
API에 맞춘 계약인데, Facebook Page 피드 발행(`/{page-id}/feed`·`/{page-id}/photos`)
은 둘 다 **단일 콜·동기** 응답이다(⚠️미확認 — Meta 문서 지식, 재확認 전 라이브
금지, instagram_oauth.py 상단 딱지와 동형).

그래서 실제 POST 호출은 `create_container`가 전부 하고 `get_container_status`/
`publish_container`는 "이미 끝났다"만 알리는 얇은 계약 어댑터다 — 이러면 채널_posts.py
쪽 오케스트레이션 코드를 전혀 안 건드리고도(새 분기 0) 기존 재시도/동시성 안전망을
그대로 물려받는다: `create_container` 성공 직후 `row.external_container_id`+
`status="container_created"`가 즉시 커밋되므로(channel_posts.py:1348-1352),
재시도 시 `just_created_container`가 False가 돼 `create_container`를 다시 안 부르고
`publish_container`(no-op, 같은 id 반환)만 다시 타 — 중복 게시 0."""
from __future__ import annotations

import httpx

_GRAPH_BASE = "https://graph.facebook.com/v21.0"

_CONTAINER_STATUS_FINISHED = "FINISHED"


class FacebookPublishError(Exception):
    """threads_publish.py::ThreadsPublishError·instagram_publish.py와 동형 속성
    (.status_code) — publication_command.py/channel_posts.py의 기존 except
    ThreadsPublishError 분기가 이 예외도 그대로 처리하게, 여기서도 그 클래스를
    재사용한다(신규 예외 클래스 발명 0)."""


async def create_container(
    client: httpx.AsyncClient, *, access_token: str, threads_user_id: str, text: str,
    image_url: str | None = None,
) -> str:
    """`threads_user_id`는 기존 관례 재사용(실제로는 Page ID, channel_connection.
    account_id에 저장된 값 — 파라미터명은 dispatcher 계약을 그대로 따른다, 새 이름
    발명 0). 이미지 있으면 `/{page-id}/photos`(caption=text)·없으면 `/{page-id}/feed`
    (message=text) 단일 콜로 **이미 발행까지 끝낸다** — 반환값은 Meta가 준 실제
    post id(모듈 docstring 참고 — publish_container는 이 값을 그대로 되돌려줄 뿐
    추가 호출을 안 한다)."""
    from app.services.threads_publish import ThreadsPublishError

    if image_url:
        url = f"{_GRAPH_BASE}/{threads_user_id}/photos"
        params = {"access_token": access_token, "url": image_url, "caption": text}
    else:
        url = f"{_GRAPH_BASE}/{threads_user_id}/feed"
        params = {"access_token": access_token, "message": text}
    resp = await client.post(url, params=params)
    if resp.status_code != 200:
        raise ThreadsPublishError(
            "FACEBOOK_CREATE_POST_FAILED", resp.text[:500], status_code=resp.status_code,
        )
    body = resp.json()
    # /photos 응답은 {"id": <photo_id>, "post_id": <page_post_id>} — 페이지 피드에
    # 실제로 뜨는 건 post_id 쪽(⚠️미확認, Meta 문서 지식). /feed 응답은 {"id": <post_id>}뿐.
    post_id = body.get("post_id") or body.get("id")
    if not post_id:
        raise ThreadsPublishError(
            "FACEBOOK_CREATE_POST_MISSING_ID", "id/post_id missing in response", status_code=resp.status_code,
        )
    return str(post_id)


async def get_container_status(
    client: httpx.AsyncClient, *, access_token: str, creation_id: str,
) -> tuple[str, str | None]:
    """`create_container`가 이미 실제로 발행까지 끝냈으므로(모듈 docstring) 여기는
    항상 FINISHED — 진짜 폴링(HTTP 호출) 0건."""
    return _CONTAINER_STATUS_FINISHED, None


async def publish_container(
    client: httpx.AsyncClient, *, access_token: str, threads_user_id: str, creation_id: str,
) -> str:
    """no-op(모듈 docstring) — `creation_id`가 이미 실제 post id다. 추가 API 호출 0건
    (중복 게시 방지가 여기 있다: 재시도로 이 함수가 여러 번 불려도 새 게시물이
    안 생긴다)."""
    return creation_id


async def get_publishing_limit(
    client: httpx.AsyncClient, *, access_token: str, threads_user_id: str,
) -> tuple[int, int, int]:
    """⚠️미확認 — Facebook Page 피드에는 Instagram/Threads의 `content_publishing_
    limit`류 공개 조회 API가 확認되지 않는다(그라운딩 대상, PO 재확認 필요). 없는
    걸 있는 척 조회하지 않고(no-fiction) 고정된 "항상 통과" 값을 선언한다 — 실
    Meta측 한도에 걸리면 create_container 호출 자체가 4xx/429로 실패하고, 그건
    기존 ThreadsPublishError 매핑(429→CHANNEL_RATE_LIMITED)이 그대로 잡는다."""
    return 0, 1_000_000, 86400


async def delete_media(client: httpx.AsyncClient, *, access_token: str, media_id: str) -> None:
    """`DELETE /{post-id}` — Facebook Graph API 공개 문서화 삭제 엔드포인트(⚠️미확認,
    재확認 필요하나 Instagram과 달리 이 엔드포인트 자체의 존재는 Meta 문서에서
    통상적으로 다뤄지는 축이라 instagram_publish.py::delete_media의 미구현 판단과는
    다르게 구현한다 — supports_unpublish=True 선언과 짝)."""
    from app.services.threads_publish import ThreadsPublishError

    resp = await client.delete(f"{_GRAPH_BASE}/{media_id}", params={"access_token": access_token})
    if resp.status_code != 200:
        raise ThreadsPublishError(
            "FACEBOOK_DELETE_POST_FAILED", resp.text[:500], status_code=resp.status_code,
        )


async def get_permalink(client: httpx.AsyncClient, *, access_token: str, media_id: str) -> str | None:
    """`GET /{post-id}?fields=permalink_url` — threads_publish.py와 동형(값 없으면
    None, 예외로 승격 안 함)."""
    resp = await client.get(
        f"{_GRAPH_BASE}/{media_id}", params={"fields": "permalink_url", "access_token": access_token},
    )
    if resp.status_code != 200:
        return None
    return resp.json().get("permalink_url")
