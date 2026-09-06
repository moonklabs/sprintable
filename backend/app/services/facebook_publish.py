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


async def create_carousel_container(
    client: httpx.AsyncClient, *, access_token: str, threads_user_id: str, text: str, image_urls: list[str],
) -> str:
    """story #3567(Phase2·BE, 페드루 PO 確定 2026-09-06①) — Page 다중 사진(2장 이상).
    `create_container`의 "단일 콜=이미 발행까지 끝남" 계약(모듈 docstring) 안에서
    구현한다: N회 `/{page-id}/photos?published=false`(각각 미발행 photo id 반환)
    → 1회 `/{page-id}/feed?attached_media=[{media_fbid:id},...]`(**이 호출이 실제
    발행** — instagram_publish.py::create_carousel_container의 "부모 컨테이너"와
    달리, 여기선 부모=진짜 최종 게시물이라 반환값도 곧 최종 post id다). 자식 하나
    라도 실패하면 그 자리에서 즉시 예외(부모/`/feed` 호출 자체를 안 만든다 —
    instagram_publish.py와 동일 원자성 원칙, 「부분 발행 0」).

    ⚠️미확認(facebook_publish.py 상단 딱지와 동형 — `attached_media` 파라미터
    shape·`published=false`가 실제로 동작하는지는 Meta 문서 지식, 재확認 전
    라이브 왕복 금지)."""
    from app.services.threads_publish import ThreadsPublishError

    photo_ids: list[str] = []
    for image_url in image_urls:
        resp = await client.post(
            f"{_GRAPH_BASE}/{threads_user_id}/photos",
            params={"access_token": access_token, "url": image_url, "published": "false"},
        )
        if resp.status_code != 200:
            raise ThreadsPublishError(
                "FACEBOOK_CREATE_CAROUSEL_CHILD_FAILED", resp.text[:500], status_code=resp.status_code,
            )
        photo_id = resp.json().get("id")
        if not photo_id:
            raise ThreadsPublishError(
                "FACEBOOK_CREATE_CAROUSEL_CHILD_MISSING_ID", "id missing in response", status_code=resp.status_code,
            )
        photo_ids.append(str(photo_id))

    import json as _json
    params = {
        "access_token": access_token,
        "attached_media": _json.dumps([{"media_fbid": pid} for pid in photo_ids]),
    }
    if text:
        params["message"] = text
    resp = await client.post(f"{_GRAPH_BASE}/{threads_user_id}/feed", params=params)
    if resp.status_code != 200:
        raise ThreadsPublishError(
            "FACEBOOK_CREATE_CAROUSEL_PARENT_FAILED", resp.text[:500], status_code=resp.status_code,
        )
    body = resp.json()
    post_id = body.get("post_id") or body.get("id")
    if not post_id:
        raise ThreadsPublishError(
            "FACEBOOK_CREATE_CAROUSEL_PARENT_MISSING_ID", "id/post_id missing in response", status_code=resp.status_code,
        )
    return str(post_id)


# story #3567(Phase2·BE, 페드루 PO 確定 2026-09-06②) — Page 릴스는 이 파일에서
# 유일하게 **진짜 비동기**인 경로(사진/피드는 전부 "단일 콜=이미 끝남"). `/video_
# reels`는 start(업로드 세션 발급)→upload(바이너리 or 호스팅 URL)→finish(발행
# 등록) 3단 + 진짜 status 폴링이 필요(⚠️미확認, Meta 문서 지식). `create_reels_
# container`가 반환하는 creation_id=Meta의 video_id — `get_container_status`가
# 이 id로만 진짜 폴링하고, 사진/피드 post id는(그 자리에서 이미 발행 완료라) 계속
# 즉시 FINISHED로 남는다(media_type을 별도 파라미터로 안 받고, 실 API 응답에
# `status` 필드가 있는지로 구분 — channel_posts.py는 무변경, 이 파일 안에서만
# 분간).
_REELS_UPLOAD_PHASE_START = "start"
_REELS_UPLOAD_PHASE_FINISH = "finish"


async def create_reels_container(
    client: httpx.AsyncClient, *, access_token: str, threads_user_id: str, text: str,
    video_url: str | None, cover_url: str | None = None,
) -> str:
    """instagram_publish.py::create_reels_container와 동형 시그니처. start가
    `video_id`+`upload_url`을 발급하면, 이 함수가 그 `upload_url`에 실 업로드를
    요청한다(⚠️미확認 — 바이트를 직접 재전송하는지, `file_url` 헤더로 Meta가
    `video_url`을 직접 fetch하게 위임할 수 있는지 재확認 필요·여기선 후자로 구현
    — 이 코드베이스의 다른 모든 업로드가 "URL을 주면 Meta/provider가 직접 가져간다"
    관례를 따르므로, 우리가 바이트를 다시 내려받아 재전송하는 방식보다 이 관례가
    더 낫다는 판단). finish가 `video_state=PUBLISHED`로 발행을 등록한다 — 이후
    `get_container_status`의 실 폴링이 처리 완료를 확認한다. 커버(`cover_url`)는
    finish 파라미터로 실어 보낸다(⚠️미확認 — 파라미터명 `thumb`/`cover_url` 어느
    쪽인지 재확認 필요)."""
    from app.services.threads_publish import ThreadsPublishError

    if video_url is None:
        raise ThreadsPublishError(
            "FACEBOOK_REELS_VIDEO_REQUIRED", "릴스 발행은 영상이 필수입니다", status_code=422,
        )
    resp_start = await client.post(
        f"{_GRAPH_BASE}/{threads_user_id}/video_reels",
        params={"access_token": access_token, "upload_phase": _REELS_UPLOAD_PHASE_START},
    )
    if resp_start.status_code != 200:
        raise ThreadsPublishError(
            "FACEBOOK_REELS_START_FAILED", resp_start.text[:500], status_code=resp_start.status_code,
        )
    start_body = resp_start.json()
    video_id = start_body.get("video_id")
    upload_url = start_body.get("upload_url")
    if not video_id or not upload_url:
        raise ThreadsPublishError(
            "FACEBOOK_REELS_START_MISSING_FIELDS", "video_id/upload_url missing in response",
            status_code=resp_start.status_code,
        )

    resp_upload = await client.post(
        upload_url,
        headers={"Authorization": f"OAuth {access_token}", "file_url": video_url},
    )
    if resp_upload.status_code != 200:
        raise ThreadsPublishError(
            "FACEBOOK_REELS_UPLOAD_FAILED", resp_upload.text[:500], status_code=resp_upload.status_code,
        )

    finish_params = {
        "access_token": access_token, "upload_phase": _REELS_UPLOAD_PHASE_FINISH,
        "video_id": video_id, "video_state": "PUBLISHED",
    }
    if cover_url:
        finish_params["thumb"] = cover_url
    if text:
        finish_params["description"] = text
    resp_finish = await client.post(f"{_GRAPH_BASE}/{threads_user_id}/video_reels", params=finish_params)
    if resp_finish.status_code != 200:
        raise ThreadsPublishError(
            "FACEBOOK_REELS_FINISH_FAILED", resp_finish.text[:500], status_code=resp_finish.status_code,
        )
    return str(video_id)


async def get_container_status(
    client: httpx.AsyncClient, *, access_token: str, creation_id: str,
) -> tuple[str, str | None]:
    """사진/피드는 `create_container`가 이미 발행까지 끝냈으므로(모듈 docstring)
    항상 FINISHED. 릴스(video_id)만 진짜 비동기라 실 폴링이 필요한데, 이 함수는
    media_type을 인자로 안 받는다(channel_posts.py 오케스트레이션 계약 무변경,
    story #3567 確定②) — `GET /{creation_id}?fields=status`를 항상 시도해 응답에
    `status`가 있으면(릴스 처리 상태) 그 값을 실제로 매핑하고, 없으면(사진/피드
    post는 이 필드 자체가 없다) 기존처럼 FINISHED로 간주한다. ⚠️미확認 — `status`
    필드 shape·값 어휘(processing/ready/error 등)는 Meta 문서 지식, 재확認 전
    라이브 왕복 금지."""
    resp = await client.get(
        f"{_GRAPH_BASE}/{creation_id}", params={"fields": "status", "access_token": access_token},
    )
    if resp.status_code != 200:
        return _CONTAINER_STATUS_FINISHED, None
    body = resp.json()
    status = body.get("status")
    if not status:
        return _CONTAINER_STATUS_FINISHED, None
    video_status = status.get("video_status") if isinstance(status, dict) else status
    if video_status in ("ready", "published"):
        return _CONTAINER_STATUS_FINISHED, None
    if video_status == "processing":
        return "IN_PROGRESS", None
    if video_status == "error":
        return "ERROR", (status.get("uploading_phase") or {}).get("errors") if isinstance(status, dict) else None
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
