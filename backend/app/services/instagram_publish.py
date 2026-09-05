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

⚠️미확認 — 컨테이너 생성/상태 폴링/publish/한도조회/permalink 엔드포인트는 IG Graph
API 지식 컷오프 기준 최선 추정이다(threads_publish.py 최초 작성 시와 동일 상태).
OAuth·comments 엔드포인트만 페드루 PO가 2026-09-06 Meta 공식 문서로 재확認했다
(`instagram_oauth.py` 참고) — 이 파일은 아직 그 재확認을 못 받았다. sandbox까지가
이 조각 라이브 범위(App Review 뒤 실계정 왕복 시점에 재확認 필요)."""
from __future__ import annotations

import httpx

from app.services.threads_publish import ThreadsPublishError

_MEDIA_CONTAINER_URL_TMPL = "https://graph.facebook.com/v21.0/{ig_user_id}/media"
_MEDIA_PUBLISH_URL_TMPL = "https://graph.facebook.com/v21.0/{ig_user_id}/media_publish"
_PUBLISHING_LIMIT_URL_TMPL = "https://graph.facebook.com/v21.0/{ig_user_id}/content_publishing_limit"
_MEDIA_URL_TMPL = "https://graph.facebook.com/v21.0/{media_id}"


async def create_container(
    client: httpx.AsyncClient, *, access_token: str, threads_user_id: str, text: str,
    image_url: str | None = None,
) -> str:
    """미디어 컨테이너 생성 → creation_id. IG는 이미지 필수(피드 이미지 1장, 캐러셀/
    릴스는 조각① 스코프 밖 — 그라운딩 확認) — `image_url`이 None이면(Threads의
    TEXT-only 경로와 달리) 호출부가 이미지 없는 초안을 여기까지 보내면 안 된다는
    뜻이라 즉시 거부한다(사일런트 미디어 없는 컨테이너를 만들지 않는다). `text`는
    캡션(`caption` 파라미터명 — Threads의 `text`와 다름, IG 실 파라미터명)."""
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
