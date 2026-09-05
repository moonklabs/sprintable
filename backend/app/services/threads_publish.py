"""story #f8f7cb0f(Phase1·마케팅운영, 페드루 PO 확定 2026-09-03) — Threads 발행 API
클라이언트. `sprintable-agent-plugins/plugins/sprintable/connectors/threads.ts`(story
#3311)의 2-호출(컨테이너 생성→publish)·한도 조회·permalink 조회를 Python으로 그대로
포팅한다 — `threads_oauth.py`(story #3373)와 동일 관례(httpx.AsyncClient는 호출자가
구성해 넘긴다, 에러는 코드+메시지 예외 하나로 통일, `resp.text[:500]`로 provider 원문
절단 보존).

이 모듈은 순수 API 클라이언트로만 남는다 — 게이트 재검증·멱등·UTM·HTTP status 판단은
호출부(channel_posts.py의 오케스트레이션 함수) 몫이다(threads_oauth.py가 OAuth 교환
로직만 갖고 인증 라우팅은 안 하는 것과 동형 분리).

⚠️미확認(그라운딩 상속, threads_oauth.py와 동일 딱지) — 엔드포인트·파라미터명은 Meta
Threads API 공개 문서(지식 컷오프 2026-01) 기준 최선 추정이다. 실 앱 왕복(dev 배선 후)
전에는 "코드는 정확한 형태로 존재하되 라이브 미검증" 상태다."""
from __future__ import annotations

import httpx

_CONTAINER_URL_TMPL = "https://graph.threads.net/v1.0/{user_id}/threads"
_PUBLISH_URL_TMPL = "https://graph.threads.net/v1.0/{user_id}/threads_publish"
_LIMIT_URL_TMPL = "https://graph.threads.net/v1.0/{user_id}/threads_publishing_limit"
_MEDIA_URL_TMPL = "https://graph.threads.net/v1.0/{media_id}"


class ThreadsPublishError(Exception):
    """컨테이너 생성/publish/한도 조회/permalink 조회 실패. `.code`/`.message`가 그대로
    호출부(라우터)의 에러 매핑 축이 된다. `.status_code`는 provider가 준 HTTP status —
    401/403이면 호출부가 CHANNEL_TOKEN_EXPIRED로, 그 외는 CHANNEL_PUBLISH_PROVIDER_ERROR
    (502)로 매핑한다(story 본문 에러코드표)."""

    def __init__(self, code: str, message: str, *, status_code: int):
        self.code = code
        self.message = message
        self.status_code = status_code
        super().__init__(message)


async def create_container(
    client: httpx.AsyncClient, *, access_token: str, threads_user_id: str, text: str,
    image_url: str | None = None,
) -> str:
    """게시물 컨테이너 생성 → creation_id(부분 성공 재시도의 키, channel_publications.
    external_container_id에 저장). `image_url` 생략(기본, 기존 호출부 전량)이면
    media_type=TEXT(기존 동작 완전 그대로) — 있으면 media_type=IMAGE로 전환하고
    `text`는 캡션이 된다(story 620beefc, 그라운딩 §② 실측: image_url은 공개
    접근 가능해야 하며 Threads가 서버 인증 없이 직접 cURL한다)."""
    params = {"access_token": access_token}
    if image_url is not None:
        params["media_type"] = "IMAGE"
        params["image_url"] = image_url
        if text:
            params["text"] = text
    else:
        params["media_type"] = "TEXT"
        params["text"] = text
    resp = await client.post(_CONTAINER_URL_TMPL.format(user_id=threads_user_id), params=params)
    if resp.status_code != 200:
        raise ThreadsPublishError(
            "THREADS_CREATE_CONTAINER_FAILED", resp.text[:500], status_code=resp.status_code,
        )
    body = resp.json()
    creation_id = body.get("id")
    if not creation_id:
        raise ThreadsPublishError(
            "THREADS_CREATE_CONTAINER_MISSING_ID", "id missing in response", status_code=resp.status_code,
        )
    return str(creation_id)


# story 620beefc(그라운딩 §②, developers.facebook.com/docs/threads/troubleshooting,
# 조회일 2026-09-04) — IMAGE 컨테이너는 비동기 처리. 완료 전 publish 호출은 실패한다.
_CONTAINER_STATUS_FINISHED = "FINISHED"
_CONTAINER_STATUS_IN_PROGRESS = "IN_PROGRESS"
_CONTAINER_STATUS_ERROR = "ERROR"
_CONTAINER_STATUS_EXPIRED = "EXPIRED"
_CONTAINER_STATUS_PUBLISHED = "PUBLISHED"


async def get_container_status(
    client: httpx.AsyncClient, *, access_token: str, creation_id: str,
) -> tuple[str, str | None]:
    """(status, error_message) — status ∈ {IN_PROGRESS, FINISHED, PUBLISHED, ERROR,
    EXPIRED}(실측 그대로). `GET /{creation-id}?fields=status,error_message`."""
    resp = await client.get(
        _MEDIA_URL_TMPL.format(media_id=creation_id),
        params={"fields": "status,error_message", "access_token": access_token},
    )
    if resp.status_code != 200:
        raise ThreadsPublishError(
            "THREADS_CONTAINER_STATUS_FAILED", resp.text[:500], status_code=resp.status_code,
        )
    body = resp.json()
    status = body.get("status")
    if not status:
        raise ThreadsPublishError(
            "THREADS_CONTAINER_STATUS_MISSING_FIELD", "status missing in response", status_code=resp.status_code,
        )
    return str(status), body.get("error_message")


async def publish_container(
    client: httpx.AsyncClient, *, access_token: str, threads_user_id: str, creation_id: str,
) -> str:
    """컨테이너를 실제로 게시 → media id(channel_publications.external_id에 저장)."""
    resp = await client.post(
        _PUBLISH_URL_TMPL.format(user_id=threads_user_id),
        params={"creation_id": creation_id, "access_token": access_token},
    )
    if resp.status_code != 200:
        raise ThreadsPublishError(
            "THREADS_PUBLISH_CONTAINER_FAILED", resp.text[:500], status_code=resp.status_code,
        )
    body = resp.json()
    media_id = body.get("id")
    if not media_id:
        raise ThreadsPublishError(
            "THREADS_PUBLISH_CONTAINER_MISSING_ID", "id missing in response", status_code=resp.status_code,
        )
    return str(media_id)


async def get_publishing_limit(
    client: httpx.AsyncClient, *, access_token: str, threads_user_id: str,
) -> tuple[int, int, int]:
    """(quota_usage, quota_total, quota_duration_seconds) — 잔량 = quota_total -
    quota_usage. `quota_duration`은 창(window) 길이(초) — Meta API가 명시적 reset
    타임스탬프를 주지 않아(그라운딩 미확認), 호출부가 `now + quota_duration`으로
    근사 reset 시각을 계산한다(story AC "reset 시각 포함"의 유일한 재료).

    `GET …/channel-connections/{id}/publishing-limit`(휴먼, UI 표시용)와 발행 직전
    내부 재조회 둘 다 이 함수를 쓴다(단일 조회 경로, 신규 코드 0)."""
    resp = await client.get(
        _LIMIT_URL_TMPL.format(user_id=threads_user_id),
        params={"fields": "quota_usage,config", "access_token": access_token},
    )
    if resp.status_code != 200:
        raise ThreadsPublishError(
            "THREADS_PUBLISHING_LIMIT_FAILED", resp.text[:500], status_code=resp.status_code,
        )
    body = resp.json()
    data = body.get("data") or [{}]
    row = data[0] if data else {}
    quota_usage = row.get("quota_usage")
    config = row.get("config") or {}
    quota_total = config.get("quota_total")
    quota_duration = config.get("quota_duration")
    if quota_usage is None or quota_total is None or quota_duration is None:
        raise ThreadsPublishError(
            "THREADS_PUBLISHING_LIMIT_MISSING_FIELDS",
            "quota_usage/config.quota_total/config.quota_duration missing",
            status_code=resp.status_code,
        )
    return int(quota_usage), int(quota_total), int(quota_duration)


async def delete_media(client: httpx.AsyncClient, *, access_token: str, media_id: str) -> None:
    """story #3419 — 발행된 글 회수(공식 삭제 API, 실측 2026-09-04·출처
    developers.facebook.com/docs/threads/posts/delete-posts/): `DELETE
    /v1.0/{threads-media-id}` — 스코프 `threads_basic`+`threads_delete` 필요, 한도
    100건/일/계정(rate limit 자체는 이 클라이언트가 사전 조회하지 않는다 — get_
    publishing_limit과 달리 삭제 잔량 조회 API가 별도로 없음, 초과 시 provider가 직접
    거부). 성공 응답은 `{"success": true, "deleted_id": ...}` — success가 false거나
    없으면 실패로 취급(호출부가 "회수됐다"고 잘못 믿지 않게)."""
    resp = await client.delete(
        _MEDIA_URL_TMPL.format(media_id=media_id), params={"access_token": access_token},
    )
    if resp.status_code != 200:
        raise ThreadsPublishError(
            "THREADS_DELETE_MEDIA_FAILED", resp.text[:500], status_code=resp.status_code,
        )
    body = resp.json()
    if not body.get("success"):
        raise ThreadsPublishError(
            "THREADS_DELETE_MEDIA_FAILED", f"success=false in response: {resp.text[:500]}",
            status_code=resp.status_code,
        )


async def get_permalink(client: httpx.AsyncClient, *, access_token: str, media_id: str) -> str | None:
    """PO 결정① — `GET /{media-id}?fields=permalink`. 값이 없으면(provider가 아직 못
    붙였을 가능성) None — 호출부가 "발행은 됐는데 permalink만 비었다"로 받아들일 수
    있게 예외로 승격하지 않는다(성공 판정은 publish_container의 media id로 이미 끝났다)."""
    resp = await client.get(
        _MEDIA_URL_TMPL.format(media_id=media_id),
        params={"fields": "permalink", "access_token": access_token},
    )
    if resp.status_code != 200:
        raise ThreadsPublishError(
            "THREADS_GET_PERMALINK_FAILED", resp.text[:500], status_code=resp.status_code,
        )
    body = resp.json()
    permalink = body.get("permalink")
    return str(permalink) if permalink else None


_REPLIES_URL_TMPL = "https://graph.threads.net/v1.0/{media_id}/pending_replies"
# story #3516(Phase2·마케팅운영, 페드루 PO 確定 2026-09-05) — ⚠️미확認(그라운딩①,
# threads_publish.py 상단 딱지와 동형): 실 fetch(2026-09-05, developers.facebook.com/
# docs/threads/reply-management)로 이 엔드포인트·필드·커서 페이지네이션(before/after)은
# 확認했으나, 그 문서 자체가 "moderation pending queue" 프레이밍이라 "소유 게시물의
# 모든 댓글"과 정확히 같은 것인지는 라이브 왕복 전엔 확실하지 않다. sandbox까지가 이
# 스토리 라이브 범위(PO 明示) — Threads 실계정 시점에 재확認 필요.
_REPLIES_FIELDS = "id,text,username,timestamp,has_replies,is_reply,hide_status,reply_approval_status"
# 페드루 PO REQUIRED(2026-09-05, PR#3865 리뷰) — 이 media의 댓글이 한 페이지를
# 넘으면 첫 페이지만 보고 "응답에 없다=삭제됐다"로 리컨실하는 순간 2페이지 이후
# 댓글이 매 수집마다 조용히 소프트 삭제되는 결함이 있었다(sandbox=항상 2건 고정
# 이라 테스트가 못 잡던 자리). 이 상한(10페이지)까지 커서를 따라가고, 그 안에서
# 끝(after 커서 소진)에 닿으면 complete=True, 상한에 걸리면 False — "지속
# 폴링/커서는 후속"이라는 PO 決定은 유지하되(한도 밖은 다음 due 창이 또 시도),
# "이번 한 번의 수집이 완전한가"만 이 반환값으로 호출부(리컨실 여부 판단)에 알린다.
_REPLIES_MAX_PAGES = 10


async def fetch_replies(client: httpx.AsyncClient, *, access_token: str, media_id: str) -> tuple[list[dict], bool]:
    """이 media의 댓글 목록 + 완전 수집 여부. `paging.cursors.after`로 최대
    `_REPLIES_MAX_PAGES`페이지까지 따라간다 — 더 볼 커서가 없으면 (items, True),
    상한에 걸려 아직 더 남았으면 (items, False)(그 페이지들은 유실이 아니라 다음
    due 창에 다시 시도)."""
    items: list[dict] = []
    after_cursor: str | None = None
    for _ in range(_REPLIES_MAX_PAGES):
        params = {"fields": _REPLIES_FIELDS, "access_token": access_token}
        if after_cursor:
            params["after"] = after_cursor
        resp = await client.get(_REPLIES_URL_TMPL.format(media_id=media_id), params=params)
        if resp.status_code != 200:
            raise ThreadsPublishError(
                "THREADS_FETCH_REPLIES_FAILED", resp.text[:500], status_code=resp.status_code,
            )
        body = resp.json()
        items.extend(body.get("data") or [])
        after_cursor = ((body.get("paging") or {}).get("cursors") or {}).get("after")
        if not after_cursor:
            return items, True
    return items, False


async def reply(
    client: httpx.AsyncClient, *, access_token: str, threads_user_id: str, reply_to_id: str, text: str,
) -> tuple[str, str | None]:
    """댓글에 답변 — ⚠️미확認(그라운딩①): 전용 reply 엔드포인트를 문서에서 못 찾아
    일반 게시물 2-step(컨테이너 생성→publish)에 `reply_to_id`를 얹는 형태로 최선
    추정한다(Instagram Graph API의 댓글 구조와 동형 관례를 참고한 추정 — Meta
    공식 문서로 확認된 값 아님). 라이브 왕복 전 미검증 상태 그대로 둔다(create_
    container/publish_container를 그대로 재사용해 신규 HTTP 로직을 새로 안 짠다)."""
    params = {"access_token": access_token, "media_type": "TEXT", "text": text, "reply_to_id": reply_to_id}
    resp = await client.post(_CONTAINER_URL_TMPL.format(user_id=threads_user_id), params=params)
    if resp.status_code != 200:
        raise ThreadsPublishError(
            "THREADS_REPLY_CREATE_CONTAINER_FAILED", resp.text[:500], status_code=resp.status_code,
        )
    creation_id = resp.json().get("id")
    if not creation_id:
        raise ThreadsPublishError(
            "THREADS_REPLY_CREATE_CONTAINER_MISSING_ID", "id missing in response", status_code=resp.status_code,
        )
    external_reply_id = await publish_container(
        client, access_token=access_token, threads_user_id=threads_user_id, creation_id=str(creation_id),
    )
    permalink = await get_permalink(client, access_token=access_token, media_id=external_reply_id)
    return external_reply_id, permalink
