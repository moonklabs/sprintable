"""story #3808(Phase3·3-3 PR2, 페드루 PO 確定 2026-09-11) — X(트위터) 발행 API 클라이언트.

**예외는 `threads_publish.py::ThreadsPublishError`를 그대로 재사용한다**(신규 클래스
0 — instagram_publish.py 선례와 동형: `channel_posts.py` 오케스트레이션의 모든
`except ThreadsPublishError` 지점·error_code 매핑(`_classify_threads_error` →
`graph_api_errors.classify_graph_error_code`)을 그대로 물려받는다). X는 Meta Graph
OAuth 오류 taxonomy(code=190 등)가 아니라 순수 HTTP status 기반이라 `.provider_
error_*` 3필드는 항상 None으로 둔다 — `classify_graph_error_code`의 "파서가 관할
밖이면 401/403/429 상태코드 휴리스틱으로 폴백" 경로(비-Meta 오류 대비로 이미 설계된
자리, graph_api_errors.py:134 주석)가 정확히 이 경우를 위한 것이다.

## `create_container`/`get_container_status`/`publish_container` 매핑(⚠️X 실 API와
다른 자리 — threads/instagram/facebook의 Meta 2-호출 컨테이너 개념이 X엔 없다)
X의 `POST /2/tweets`는 단일 원자적 호출(컨테이너 개념 0)이고, 미디어만 진짜 3단계
비동기(INIT/APPEND/FINALIZE(+STATUS 폴링, 영상/GIF만 실제로 걸림)) — Threads의
"게시물 전체가 컨테이너"와 반대로 **미디어만 컨테이너**다. 기존 오케스트레이션(`has_
async_media` 게이트) 그대로 재사용하려고 이렇게 매핑한다(신규 함수 0, `channel_
posts.py` 무변경 — 이 파일이 그 구조에 맞춰 스스로를 접는다):
- 이미지 없음: `create_container`가 **그 자리에서 실제로 발행**(publish_x_thread
  단일 세그먼트)하고 완결 tweet id를 `"posted:{id}"`로 감싸 돌려준다 — `has_async_
  media=False`라 오케스트레이션이 곧바로 `publish_container`를 이어 부르므로,
  그쪽은 접두만 벗겨 그대로 반환(신규 HTTP 호출 0).
- 이미지 있음: `create_container`가 미디어 업로드(INIT/APPEND/FINALIZE)만 하고
  `"media-ready:{id}"`(FINALIZE 응답에 processing_info 없음 — 즉시 사용 가능) 또는
  `"media-pending:{id}"`(processing_info 있음 — 실제 STATUS 폴링 필요)로 감싼다.
  `get_container_status`가 접두로 갈라 pending만 실제 STATUS를 부른다.
  `publish_container`가 media_id를 꺼내 이제 실제로 `POST /2/tweets`(media 첨부)를
  낸다 — 이 시점이 X 기준 "진짜 게시" 순간.

## `publish_x_thread` — 스레드 N세그먼트 프리미티브(카드 PR2 조각, 페드루 PO 決定
2026-09-11 20:09Z)
`create_container`(단일 세그먼트, image_url 유무 무관)는 이 함수를 texts=[text]
하나로 호출한다(N=1, 기존 단일-발행 경로). N≥2(진짜 스레드)는 story #3808
PR5b-1(`channel_posts.py::_publish_x_thread_draft`)부터 실 호출부가 생겼다 —
`channel_post_versions.channel_payload.thread`(story #3813 공유 슬롯)가 텍스트
출처. 반환 `[{sequence, external_id, permalink}, ...]`
(1-indexed, 헤드=1) — 두 번째부터 `in_reply_to_tweet_id`로 직전 세그먼트를 참조해
실제 reply 체인을 만든다(X 스레드의 진짜 메커니즘 — 전용 "스레드" API는 없다).

⚠️미확認(threads_oauth.py/x_oauth.py 상단 딱지와 동형 원칙, 착수 시 재확認 필요) —
아래 엔드포인트 호스트(upload.twitter.com 유지 여부, x.com 이관 시점 혼용 가능)·
미디어 업로드 파라미터명은 지식 컷오프(2026-01) 기준 최선 추정이다. 실 앱 왕복
전까지 "코드는 정확한 형태로 존재하되 라이브 미검증" 상태로 남는다.

`get_publishing_limit`은 X에 사전조회 가능한 quota 엔드포인트가 없어(실 rate limit
은 실 호출 응답 헤더로만 드러난다) 항상 여유 있는 고정값을 돌려준다 — 사전 차단은
이 함수가 못 하고, 실 429는 `create_container`/`publish_container`(post_tweet/
upload_media 내부)가 직접 겪어 `ThreadsPublishError(status_code=429)`로 던진다
(facebook_sandbox_publish.py의 "429는 create_container 단계"와 같은 축, story
5b27b32f 선례)."""
from __future__ import annotations

import httpx

from app.services.threads_publish import ThreadsPublishError

_TWEETS_URL = "https://api.x.com/2/tweets"
_TWEET_DETAIL_URL_TMPL = "https://api.x.com/2/tweets/{tweet_id}"
_MEDIA_UPLOAD_URL = "https://upload.twitter.com/1.1/media/upload.json"

_GENEROUS_QUOTA_USAGE = 0
_GENEROUS_QUOTA_TOTAL = 10_000
_GENEROUS_QUOTA_DURATION_SECONDS = 86_400


def _auth_headers(access_token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {access_token}"}


def _error_from_response(code: str, resp: httpx.Response) -> ThreadsPublishError:
    """threads_publish.py::error_from_response의 X판 — Meta Graph 오류 envelope
    파싱(`parse_graph_error_envelope`) 없이 status_code+원문 절단만 싣는다(X의
    오류 envelope은 `{"errors":[...]}` 형이라 Meta 파서가 관할 밖 — provider_error_*
    3필드는 None으로 남아 위 모듈 docstring의 폴백 경로를 그대로 탄다)."""
    return ThreadsPublishError(code, resp.text[:500], status_code=resp.status_code)


async def post_tweet(
    client: httpx.AsyncClient, *, access_token: str, text: str,
    media_id: str | None = None, in_reply_to_tweet_id: str | None = None,
) -> str:
    """`POST /2/tweets` — 단일 원자적 호출(컨테이너 개념 0). 반환 tweet id."""
    body: dict = {"text": text}
    if media_id is not None:
        body["media"] = {"media_ids": [media_id]}
    if in_reply_to_tweet_id is not None:
        body["reply"] = {"in_reply_to_tweet_id": in_reply_to_tweet_id}
    resp = await client.post(_TWEETS_URL, json=body, headers=_auth_headers(access_token))
    if resp.status_code not in (200, 201):
        raise _error_from_response("X_POST_TWEET_FAILED", resp)
    tweet_id = (resp.json().get("data") or {}).get("id")
    if not tweet_id:
        raise ThreadsPublishError("X_POST_TWEET_MISSING_ID", "id missing in response", status_code=resp.status_code)
    return str(tweet_id)


async def upload_media(client: httpx.AsyncClient, *, access_token: str, image_bytes: bytes, mime_type: str) -> str:
    """미디어 업로드 3단계(INIT→APPEND→FINALIZE) — AC2 「이미지(3단계)」 그 자체.
    처리가 즉시 끝나면(`processing_info` 없음) `media-ready:{id}`, 비동기 처리가
    필요하면(`processing_info` 있음 — 영상/GIF·대용량) `media-pending:{id}`로
    감싼다(위 모듈 docstring의 create_container/get_container_status 매핑 참고).
    이미지 1장은 한 청크로 충분해(threads_publish.py류 관례와 달리 실 X 문서상
    5MB 이내 단일 APPEND 허용) segment_index=0 하나만 보낸다."""
    headers = _auth_headers(access_token)
    init_resp = await client.post(
        _MEDIA_UPLOAD_URL,
        data={"command": "INIT", "total_bytes": len(image_bytes), "media_type": mime_type},
        headers=headers,
    )
    if init_resp.status_code not in (200, 201, 202):
        raise _error_from_response("X_MEDIA_INIT_FAILED", init_resp)
    media_id = init_resp.json().get("media_id_string")
    if not media_id:
        raise ThreadsPublishError(
            "X_MEDIA_INIT_MISSING_ID", "media_id_string missing in response", status_code=init_resp.status_code,
        )

    append_resp = await client.post(
        _MEDIA_UPLOAD_URL,
        data={"command": "APPEND", "media_id": media_id, "segment_index": 0},
        files={"media": ("image", image_bytes, mime_type)},
        headers=headers,
    )
    if append_resp.status_code not in (200, 201, 202, 204):
        raise _error_from_response("X_MEDIA_APPEND_FAILED", append_resp)

    finalize_resp = await client.post(
        _MEDIA_UPLOAD_URL, data={"command": "FINALIZE", "media_id": media_id}, headers=headers,
    )
    if finalize_resp.status_code not in (200, 201):
        raise _error_from_response("X_MEDIA_FINALIZE_FAILED", finalize_resp)
    processing_info = finalize_resp.json().get("processing_info")
    return f"media-pending:{media_id}" if processing_info else f"media-ready:{media_id}"


async def get_media_upload_status(client: httpx.AsyncClient, *, access_token: str, media_id: str) -> str:
    """`GET …?command=STATUS` — processing_info.state를 threads_publish.py 어휘
    (IN_PROGRESS/FINISHED/ERROR)로 옮긴다."""
    resp = await client.get(
        _MEDIA_UPLOAD_URL, params={"command": "STATUS", "media_id": media_id}, headers=_auth_headers(access_token),
    )
    if resp.status_code != 200:
        raise _error_from_response("X_MEDIA_STATUS_FAILED", resp)
    state = ((resp.json().get("processing_info") or {}).get("state"))
    if state == "succeeded":
        return "FINISHED"
    if state == "failed":
        return "ERROR"
    return "IN_PROGRESS"


async def get_tweet_permalink(client: httpx.AsyncClient, *, access_token: str, tweet_id: str) -> str | None:
    """`GET /2/tweets/{id}?expansions=author_id&user.fields=username` — X는 Threads
    처럼 permalink 필드를 직접 안 주므로 username을 얻어 URL을 구성한다. username을
    못 얻으면(권한·필드 누락) None(threads_publish.py::get_permalink와 동형 관용 —
    발행 자체는 이미 성공했으니 예외로 승격 안 함)."""
    resp = await client.get(
        _TWEET_DETAIL_URL_TMPL.format(tweet_id=tweet_id),
        params={"expansions": "author_id", "user.fields": "username"},
        headers=_auth_headers(access_token),
    )
    if resp.status_code != 200:
        raise _error_from_response("X_GET_TWEET_DETAIL_FAILED", resp)
    body = resp.json()
    users = ((body.get("includes") or {}).get("users")) or []
    username = users[0].get("username") if users else None
    return f"https://x.com/{username}/status/{tweet_id}" if username else None


async def publish_x_thread(
    client: httpx.AsyncClient, *, access_token: str, texts: list[str], media_id: str | None = None,
    initial_reply_to_tweet_id: str | None = None,
) -> list[dict]:
    """스레드 N세그먼트 프리미티브 — 각 세그먼트를 직전 세그먼트의 reply로 순차
    발행(reply 체인). `media_id`는 **첫 세그먼트(헤드)에만** 첨부(AC2 「텍스트·
    이미지 1건」·「스레드 3건」이 별개 항목인 것과 정합 — 스레드 각 세그먼트마다
    이미지를 붙이는 경로는 이 카드 범위 밖).

    story #3808(PR5b-1, 페드루 PO 確定 2026-09-12) — `initial_reply_to_tweet_id`는
    부분 실패 재시도용(AC4③④). k번째에서 실패하면 1..k-1은 이미 발행됐고, 재시도는
    이 함수를 「남은 세그먼트만」으로 다시 부른다 — 그 첫 세그먼트가 "새 스레드의
    헤드"가 아니라 "이미 발행된 k-1번째의 reply"여야 하므로, 시작 값을 None(항상
    새 스레드) 대신 이 인자로 넘겨받는다(생략 시 기존 동작 그대로 — 회귀 0).

    실패 시 이미 발행된 앞 세그먼트는 그대로 남는다(부분 성공 — Threads 컨테이너
    부분성공과 다른 성격이지만 "이미 나간 tweet을 되돌리지 않는다"는 같은 정직성
    원칙, delete_tweet류 자동 롤백은 이 카드 범위 밖). 호출부가 이미 발행된
    세그먼트 목록(예외의 `.published_segments`)을 볼 수 있게 예외에 실어 던진다."""
    results: list[dict] = []
    prev_tweet_id: str | None = initial_reply_to_tweet_id
    for index, text in enumerate(texts):
        sequence = index + 1
        try:
            tweet_id = await post_tweet(
                client, access_token=access_token, text=text,
                media_id=media_id if index == 0 else None, in_reply_to_tweet_id=prev_tweet_id,
            )
        except ThreadsPublishError as exc:
            exc.published_segments = results  # type: ignore[attr-defined]
            raise
        permalink = await get_tweet_permalink(client, access_token=access_token, tweet_id=tweet_id)
        results.append({"sequence": sequence, "external_id": tweet_id, "permalink": permalink})
        prev_tweet_id = tweet_id
    return results


# ─── channel_posts.py 공용 오케스트레이션이 기대하는 5-함수 파사드 ────────────────

def _encode_creation_id(**payload: str) -> str:
    """`external_container_id`(TEXT 컬럼)에 임시로 실리는 봉투 — create_container가
    쥔 `text`를 publish_container 시점까지 들고 가야 하는데(threads_publish.py는
    이 문제가 없다 — Meta는 컨테이너 생성 시점에 text를 이미 provider에 넘겨 서버
    측에 보관시키지만, X는 media 업로드와 tweet 게시가 완전히 분리된 별개 호출이라
    caption을 이 쪽에서 직접 들고 다녀야 한다). JSON 봉투(구분자 충돌 회피 — text에
    콜론·개행이 있어도 안전)."""
    import json

    return json.dumps(payload)


def _decode_creation_id(creation_id: str) -> dict[str, str]:
    import json

    return json.loads(creation_id)


async def create_container(
    client: httpx.AsyncClient, *, access_token: str, threads_user_id: str, text: str,
    image_url: str | None = None,
) -> str:
    if image_url is None:
        result = await publish_x_thread(client, access_token=access_token, texts=[text])
        return _encode_creation_id(kind="posted", tweet_id=result[0]["external_id"])
    image_resp = await client.get(image_url)
    if image_resp.status_code != 200:
        raise ThreadsPublishError(
            "X_MEDIA_SOURCE_FETCH_FAILED", f"image_url fetch failed: {image_resp.status_code}",
            status_code=502,
        )
    mime_type = image_resp.headers.get("content-type", "image/jpeg")
    media_ref = await upload_media(
        client, access_token=access_token, image_bytes=image_resp.content, mime_type=mime_type,
    )
    pending = media_ref.startswith("media-pending:")
    media_id = media_ref.removeprefix("media-pending:").removeprefix("media-ready:")
    return _encode_creation_id(kind="media-pending" if pending else "media-ready", media_id=media_id, text=text)


async def get_container_status(
    client: httpx.AsyncClient, *, access_token: str, creation_id: str,
) -> tuple[str, str | None]:
    payload = _decode_creation_id(creation_id)
    if payload["kind"] == "media-ready":
        return "FINISHED", None
    status = await get_media_upload_status(client, access_token=access_token, media_id=payload["media_id"])
    return status, None


async def publish_container(
    client: httpx.AsyncClient, *, access_token: str, threads_user_id: str, creation_id: str,
) -> str:
    payload = _decode_creation_id(creation_id)
    if payload["kind"] == "posted":
        return payload["tweet_id"]
    result = await publish_x_thread(
        client, access_token=access_token, texts=[payload["text"]], media_id=payload["media_id"],
    )
    return result[0]["external_id"]


async def get_permalink(client: httpx.AsyncClient, *, access_token: str, media_id: str) -> str | None:
    return await get_tweet_permalink(client, access_token=access_token, tweet_id=media_id)


async def get_publishing_limit(
    client: httpx.AsyncClient, *, access_token: str, threads_user_id: str,
) -> tuple[int, int, int]:
    return _GENEROUS_QUOTA_USAGE, _GENEROUS_QUOTA_TOTAL, _GENEROUS_QUOTA_DURATION_SECONDS
