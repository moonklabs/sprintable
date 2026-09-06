"""story #3320(Phase2·마케팅운영, 페드루 PO 確定 2026-09-05) — Instagram Graph API 발행
클라이언트. `threads_publish.py`(story #f8f7cb0f)와 정확히 같은 함수 시그니처(같은
파라미터 이름 `threads_user_id`도 그대로 — `channel_posts.py` 오케스트레이션이 어느
모듈이 골렸는지 몰라도 되게, sandbox_publish.py의 기존 관례와 동형).

**예외는 `threads_publish.py::ThreadsPublishError`를 그대로 재사용한다**(신규 클래스
0) — `channel_posts.py` 오케스트레이션의 8개 `except ThreadsPublishError` 지점·
`_classify_threads_error`(코드+status_code만 읽는 순수 함수)가 IG 예외도 그대로
분류하게 하기 위함이다. sandbox_publish.py가 "sandbox는 진짜 provider가 아니라서"
재사용한 것과 이유는 다르지만(IG는 진짜 별도 provider) — 결론(신규 판정 로직 0,
기존 재시도/failure_kind/dead_letter 배선 무변경)은 같다. 새 예외 클래스를 만들면
그 8곳 전부를 다시 열어 `except (ThreadsPublishError, InstagramPublishError)`로
넓혀야 하는데, `.code`/`.message`/`.status_code` 3속성만 쓰는 이 클래스를 새로
쪼갤 실익이 없다(클래스 이름이 "Threads"인 것은 역사적 유산일 뿐 — 이 파일이 두
번째 진짜 예임).

이 모듈도 순수 API 클라이언트로만 남는다 — 게이트 재검증·멱등·UTM·HTTP status 판단은
호출부(`channel_posts.py`) 몫(threads_publish.py와 동일 분리).

⚠️미확認 — 컨테이너 생성/상태 폴링/publish/한도조회/permalink의 파라미터·필드명은
IG Graph API 지식 컷오프 기준 최선 추정이다(threads_publish.py 최초 작성 시와
동일 상태). OAuth·comments 엔드포인트만 페드루 PO가 2026-09-06 Meta 공식 문서로
재확認했다(`instagram_oauth.py` 참고) — 파라미터/필드명은 아직 그 재확認을 못
받았다. sandbox까지가 이 조각 라이브 범위(App Review 뒤 실계정 왕복 시점에
재확認 필요).

**호스트 정정(페드루 PO REQUIRED, 2026-09-06, #3872 PASS 철회 뒤 재확認)**: Meta
공식 문서(developers.facebook.com/docs/instagram-platform/instagram-graph-api/
get-started · content-publishing, 조회일 2026-09-06, 예시 URL 전부
`https://graph.instagram.com/v25.0/<IG_ID>/...`) — Instagram Login(Business
Login for Instagram) 발급 토큰은 **`graph.instagram.com`** 전용이지 Facebook
Login 경유의 `graph.facebook.com`이 아니다. 최초 작성 시 threads_publish.py의
`graph.facebook.com` 호스트를 그대로 베꼈던 게 오류(sandbox는 이 URL을 실제로
안 쳐서 통과했고 실계정 첫 호출에서만 드러나는 클래스) — `instagram_oauth.py`
의 토큰 교환 엔드포인트들과 같은 호스트로 통일한다."""
from __future__ import annotations

import httpx

from app.services.threads_publish import ThreadsPublishError

_GRAPH_BASE = "https://graph.instagram.com/v25.0"
_MEDIA_CONTAINER_URL_TMPL = _GRAPH_BASE + "/{ig_user_id}/media"
_MEDIA_PUBLISH_URL_TMPL = _GRAPH_BASE + "/{ig_user_id}/media_publish"
_PUBLISHING_LIMIT_URL_TMPL = _GRAPH_BASE + "/{ig_user_id}/content_publishing_limit"
_MEDIA_URL_TMPL = _GRAPH_BASE + "/{media_id}"
_COMMENTS_URL_TMPL = _GRAPH_BASE + "/{media_id}/comments"
_COMMENT_REPLIES_URL_TMPL = _GRAPH_BASE + "/{comment_id}/replies"


async def create_container(
    client: httpx.AsyncClient, *, access_token: str, threads_user_id: str, text: str,
    image_url: str | None = None,
) -> str:
    """미디어 컨테이너 생성 → creation_id(이미지 1장 전용, 단일-이미지 피드). 캐러셀
    (2장 이상)은 `create_carousel_container`(아래, story #3550) — 릴스는 여전히
    스코프 밖. `image_url`이 None이면(Threads의 TEXT-only 경로와 달리) 호출부가
    이미지 없는 초안을 여기까지 보내면 안 된다는 뜻이라 즉시 거부한다(사일런트
    미디어 없는 컨테이너를 만들지 않는다). `text`는 캡션(`caption` 파라미터명 —
    Threads의 `text`와 다름, IG 실 파라미터명)."""
    if image_url is None:
        raise ThreadsPublishError(
            "INSTAGRAM_IMAGE_REQUIRED", "Instagram 발행은 이미지가 필수입니다(피드 이미지 1장)", status_code=422,
        )
    params = {"access_token": access_token, "image_url": image_url}
    if text:
        params["caption"] = text
    resp = await client.post(_MEDIA_CONTAINER_URL_TMPL.format(ig_user_id=threads_user_id), params=params)
    if resp.status_code != 200:
        raise ThreadsPublishError(
            "INSTAGRAM_CREATE_CONTAINER_FAILED", resp.text[:500], status_code=resp.status_code,
        )
    body = resp.json()
    creation_id = body.get("id")
    if not creation_id:
        raise ThreadsPublishError(
            "INSTAGRAM_CREATE_CONTAINER_MISSING_ID", "id missing in response", status_code=resp.status_code,
        )
    return str(creation_id)


async def create_carousel_container(
    client: httpx.AsyncClient, *, access_token: str, threads_user_id: str, text: str, image_urls: list[str],
) -> str:
    """story #3550(Phase2, 페드루 PO 確定 2026-09-06 ④) — 캐러셀(2장 이상) 발행.
    자식 컨테이너 N개(각 `is_carousel_item=true`)를 순서대로 먼저 만들고, 부모
    컨테이너 1개(`media_type=CAROUSEL`, `children=`자식id 콤마join)를 만들어 그
    creation_id를 반환한다 — 오케스트레이션(channel_posts.py)은 이 반환값을 기존
    단일-이미지 creation_id와 완전히 동일하게 취급한다(get_container_status·
    publish_container 무변경, 부모 id 하나만 알면 되는 계약이라).

    **원자성**(그라운딩 §·PO 明示) — 자식 하나라도 실패하면 그 자리에서 즉시 예외를
    던진다(부모 컨테이너를 아예 안 만든다). 호출부의 기존 실패 처리(row.status=
    "failed", 재시도 큐)가 그대로 "부분 발행 0"을 보장한다 — 이 함수 안에 별도
    롤백 로직 불요(부모가 없으면 그 자식들은 Meta 쪽에도 고아 컨테이너로만 남고
    피드에 절대 안 뜬다, 발행이 아니라 준비 단계라 사용자에게 보이는 결과 없음).

    ⚠️미확認(instagram_publish.py 상단 딱지와 동형 — 컨테이너 파라미터명은 Meta
    문서 지식, 재확認 전 라이브 왕복 금지)."""
    child_ids: list[str] = []
    for image_url in image_urls:
        resp = await client.post(
            _MEDIA_CONTAINER_URL_TMPL.format(ig_user_id=threads_user_id),
            params={"access_token": access_token, "image_url": image_url, "is_carousel_item": "true"},
        )
        if resp.status_code != 200:
            raise ThreadsPublishError(
                "INSTAGRAM_CREATE_CAROUSEL_CHILD_FAILED", resp.text[:500], status_code=resp.status_code,
            )
        child_body = resp.json()
        child_id = child_body.get("id")
        if not child_id:
            raise ThreadsPublishError(
                "INSTAGRAM_CREATE_CAROUSEL_CHILD_MISSING_ID", "id missing in response", status_code=resp.status_code,
            )
        child_ids.append(str(child_id))

    params = {"access_token": access_token, "media_type": "CAROUSEL", "children": ",".join(child_ids)}
    if text:
        params["caption"] = text
    resp = await client.post(_MEDIA_CONTAINER_URL_TMPL.format(ig_user_id=threads_user_id), params=params)
    if resp.status_code != 200:
        raise ThreadsPublishError(
            "INSTAGRAM_CREATE_CAROUSEL_PARENT_FAILED", resp.text[:500], status_code=resp.status_code,
        )
    body = resp.json()
    creation_id = body.get("id")
    if not creation_id:
        raise ThreadsPublishError(
            "INSTAGRAM_CREATE_CAROUSEL_PARENT_MISSING_ID", "id missing in response", status_code=resp.status_code,
        )
    return str(creation_id)


_CONTAINER_STATUS_FINISHED = "FINISHED"
_CONTAINER_STATUS_IN_PROGRESS = "IN_PROGRESS"
_CONTAINER_STATUS_ERROR = "ERROR"
_CONTAINER_STATUS_EXPIRED = "EXPIRED"
_CONTAINER_STATUS_PUBLISHED = "PUBLISHED"


async def get_container_status(
    client: httpx.AsyncClient, *, access_token: str, creation_id: str,
) -> tuple[str, str | None]:
    """(status, error_message) — status ∈ {IN_PROGRESS, FINISHED, PUBLISHED, ERROR,
    EXPIRED}(threads_publish.py와 같은 값 집합으로 최선 추정 — IG 필드명은 `status_
    code`(Threads의 `status`와 다름, ⚠️미확認)). `GET /{ig-container-id}?fields=
    status_code`."""
    resp = await client.get(
        _MEDIA_URL_TMPL.format(media_id=creation_id),
        params={"fields": "status_code", "access_token": access_token},
    )
    if resp.status_code != 200:
        raise ThreadsPublishError(
            "INSTAGRAM_CONTAINER_STATUS_FAILED", resp.text[:500], status_code=resp.status_code,
        )
    body = resp.json()
    status = body.get("status_code")
    if not status:
        raise ThreadsPublishError(
            "INSTAGRAM_CONTAINER_STATUS_MISSING_FIELD", "status_code missing in response",
            status_code=resp.status_code,
        )
    return str(status), None


async def publish_container(
    client: httpx.AsyncClient, *, access_token: str, threads_user_id: str, creation_id: str,
) -> str:
    """컨테이너를 실제로 게시 → media id."""
    resp = await client.post(
        _MEDIA_PUBLISH_URL_TMPL.format(ig_user_id=threads_user_id),
        params={"creation_id": creation_id, "access_token": access_token},
    )
    if resp.status_code != 200:
        raise ThreadsPublishError(
            "INSTAGRAM_PUBLISH_CONTAINER_FAILED", resp.text[:500], status_code=resp.status_code,
        )
    body = resp.json()
    media_id = body.get("id")
    if not media_id:
        raise ThreadsPublishError(
            "INSTAGRAM_PUBLISH_CONTAINER_MISSING_ID", "id missing in response", status_code=resp.status_code,
        )
    return str(media_id)


async def get_publishing_limit(
    client: httpx.AsyncClient, *, access_token: str, threads_user_id: str,
) -> tuple[int, int, int]:
    """(quota_usage, quota_total, quota_duration_seconds) — threads_publish.py의
    `get_publishing_limit`과 동일 파싱 shape으로 최선 추정(`content_publishing_
    limit` 엔드포인트, 그라운딩③·스토리 본문 명시 — 문서 간 24h 50/100건 불일치라
    이 실시간 조회가 유일한 신뢰 소스, PO 明示). `GET …/content_publishing_limit`."""
    resp = await client.get(
        _PUBLISHING_LIMIT_URL_TMPL.format(ig_user_id=threads_user_id),
        params={"fields": "quota_usage,config", "access_token": access_token},
    )
    if resp.status_code != 200:
        raise ThreadsPublishError(
            "INSTAGRAM_PUBLISHING_LIMIT_FAILED", resp.text[:500], status_code=resp.status_code,
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
            "INSTAGRAM_PUBLISHING_LIMIT_MISSING_FIELDS",
            "quota_usage/config.quota_total/config.quota_duration missing",
            status_code=resp.status_code,
        )
    return int(quota_usage), int(quota_total), int(quota_duration)


async def delete_media(client: httpx.AsyncClient, *, access_token: str, media_id: str) -> None:
    """story #3320 — Instagram Graph API는 (그라운딩 시점 기준) Threads의 `DELETE
    /{media-id}`류 공개 삭제 API가 확認되지 않는다 — `ChannelAdapterConfig`의
    instagram 항목이 `supports_unpublish`를 선언 안 해(기본 False) 이 함수는
    오케스트레이션에서 호출될 경로 자체가 없다(unpublish 엔드포인트가 그 플래그를
    먼저 검사). 그래도 실수로 호출되면 조용히 성공한 척하지 않고 명시 예외로
    막는다(no-fiction — 안 되는 걸 된 것처럼 지어내지 않는다)."""
    raise ThreadsPublishError(
        "INSTAGRAM_DELETE_MEDIA_NOT_IMPLEMENTED",
        "Instagram 미디어 삭제 API는 아직 확認되지 않아 구현하지 않았습니다", status_code=501,
    )


async def get_permalink(client: httpx.AsyncClient, *, access_token: str, media_id: str) -> str | None:
    """`GET /{media-id}?fields=permalink` — threads_publish.py와 동형(값 없으면
    None, 예외로 승격 안 함)."""
    resp = await client.get(
        _MEDIA_URL_TMPL.format(media_id=media_id),
        params={"fields": "permalink", "access_token": access_token},
    )
    if resp.status_code != 200:
        raise ThreadsPublishError(
            "INSTAGRAM_GET_PERMALINK_FAILED", resp.text[:500], status_code=resp.status_code,
        )
    body = resp.json()
    permalink = body.get("permalink")
    return str(permalink) if permalink else None


# ─── story #3320 조각③ — 댓글 수집+답변 ───────────────────────────────────────
# 페드루 PO가 2026-09-06 Meta 공식 문서로 재확認한 엔드포인트(instagram_oauth.py
# 헤더와 동일 신뢰도 — 이 파일 상단 발행 엔드포인트류의 "⚠️미확認"과 다름):
# `GET /{ig-media-id}/comments`·`GET|POST /{ig-comment-id}/replies`, 필드
# `id,text,timestamp,from{id,username}`, 스코프 instagram_business_basic+
# instagram_business_manage_comments.

_COMMENTS_FIELDS = "id,text,timestamp,from{id,username}"
_REPLIES_MAX_PAGES = 10  # threads_publish.py::fetch_replies와 동일 상한·동일 사유


async def fetch_replies(client: httpx.AsyncClient, *, access_token: str, media_id: str) -> tuple[list[dict], bool]:
    """이 media의 댓글 목록 + 완전 수집 여부(threads_publish.py::fetch_replies와
    동형 커서 상한 방어 — PR#3865 리뷰에서 나온 "첫 페이지만 보고 리컨실하면
    뒷페이지가 오삭제되는" 결함 클래스를 여기서도 똑같이 막는다).

    `channel_post_comments.py::collect_comments_for_publication`은 각 항목의
    `raw.get("username")`을 top-level에서 읽는다(sandbox/threads raw 모양과
    동일 계약) — IG는 실제로 `from.username`에 있어(threads의 top-level
    `username`과 다른 응답 모양) 여기서 `username`/`from_id`를 top-level로
    끌어올려 얹는다(원본 `from` 필드도 raw에 그대로 보존, 유실 없음)."""
    items: list[dict] = []
    after_cursor: str | None = None
    for _ in range(_REPLIES_MAX_PAGES):
        params = {"fields": _COMMENTS_FIELDS, "access_token": access_token}
        if after_cursor:
            params["after"] = after_cursor
        resp = await client.get(_COMMENTS_URL_TMPL.format(media_id=media_id), params=params)
        if resp.status_code != 200:
            raise ThreadsPublishError(
                "INSTAGRAM_FETCH_REPLIES_FAILED", resp.text[:500], status_code=resp.status_code,
            )
        body = resp.json()
        for raw in body.get("data") or []:
            frm = raw.get("from") or {}
            item = dict(raw)
            item["username"] = frm.get("username")
            item["from_id"] = frm.get("id")
            items.append(item)
        after_cursor = ((body.get("paging") or {}).get("cursors") or {}).get("after")
        if not after_cursor:
            return items, True
    return items, False


async def reply(
    client: httpx.AsyncClient, *, access_token: str, threads_user_id: str, reply_to_id: str, text: str,
) -> tuple[str, str | None]:
    """댓글에 답변 — `POST /{ig-comment-id}/replies`(전용 엔드포인트, Threads의
    "미확認 2-step 추정"과 달리 Meta 문서로 확認됨). `reply_to_id`=대상 댓글의
    external_comment_id. `threads_user_id`는 이 호출엔 안 쓴다(대상이 댓글
    id라 유저/미디어 id가 URL에 안 들어감) — 시그니처는 dispatch 통일을 위해
    그대로 유지(sandbox_publish.py·threads_publish.py와 동일 관례).

    페드루 PO가 2026-09-06 Meta comment-moderation 문서로 POST 파라미터명
    (`message`)·응답 필드(`{id}`)·요구 스코프(`instagram_business_manage_
    comments`)까지 재확認했다 — 이 함수는 이제 미확認 딱지 0(OAuth·GET 댓글
    엔드포인트와 같은 신뢰도). 응답엔 permalink 개념이 없어(댓글은 media가
    아님) 두 번째 반환값은 항상 None."""
    resp = await client.post(
        _COMMENT_REPLIES_URL_TMPL.format(comment_id=reply_to_id),
        params={"message": text, "access_token": access_token},
    )
    if resp.status_code != 200:
        raise ThreadsPublishError(
            "INSTAGRAM_REPLY_FAILED", resp.text[:500], status_code=resp.status_code,
        )
    body = resp.json()
    external_reply_id = body.get("id")
    if not external_reply_id:
        raise ThreadsPublishError(
            "INSTAGRAM_REPLY_MISSING_ID", "id missing in response", status_code=resp.status_code,
        )
    return str(external_reply_id), None
