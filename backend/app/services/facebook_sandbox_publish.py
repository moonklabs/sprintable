"""story #3547(Phase2·마케팅운영, 페드루 PO 確定 2026-09-06) — dev 전용 Facebook Page
샌드박스 발행 클라이언트. `facebook_publish.py`와 정확히 같은 함수 시그니처(신규
판정 로직 0) — 결정적·상태 없음(sandbox_publish.py·instagram_sandbox_publish.py와
동형 설계 계약).

story #3571(Phase2·BE, 페드루 PO 確定 2026-09-06) — 댓글 조회/답변 추가(fetch_replies/
reply, instagram_sandbox_publish.py와 동형 결정적 표본 — 실 provider 없이 정규화
파이프라인 전체를 라이브로 실측)."""
from __future__ import annotations

import uuid

import httpx

from app.services.threads_publish import ThreadsPublishError

_MARKER_429 = "[sandbox:429]"
_MARKER_PROVIDER_ERROR = "[sandbox:provider-error]"
_MARKER_EXPIRED_TOKEN = "[sandbox:expired-token]"
# story #3567(Phase2·BE, 페드루 PO 確定 2026-09-06④) — instagram_sandbox_publish.py
# 와 **같은 마커 문자열**(PO 明示 — 새 마커 어휘 0, 에러코드 접두만 이 파일의 기존
# SANDBOX_FACEBOOK_* 관례를 따른다).
_MARKER_REELS_PROCESSING_FAILED = "[sandbox:reels-processing-failed]"
_MARKER_REELS_CODEC_REJECTED = "[sandbox:reels-codec-rejected]"
# story #3597(Phase2·BE, 페드루 PO 確定 2026-09-06) — instagram_sandbox_publish.py
# 와 같은 마커 문자열(새 마커 어휘 0) — 「발행 뒤 만료」. create_container가 이미
# 최종 media_id를 낸다는 이 파일의 계약(publish_container가 그대로 되돌림)이라
# 접미사를 여기서 바로 붙인다(별도 전달 단계 불필요, instagram과 유일한 차이).
_MARKER_EXPIRE_AFTER_PUBLISH = "[sandbox:expire-after-publish]"
_EXPIRE_AFTER_PUBLISH_SUFFIX = "-expireafterpublish"


async def create_container(
    client: httpx.AsyncClient, *, access_token: str, threads_user_id: str, text: str,
    image_url: str | None = None,
) -> str:
    if _MARKER_429 in text:
        raise ThreadsPublishError("SANDBOX_FACEBOOK_RATE_LIMITED", "sandbox: [sandbox:429] 마커 시뮬레이션", status_code=429)
    if _MARKER_PROVIDER_ERROR in text:
        raise ThreadsPublishError(
            "SANDBOX_FACEBOOK_PROVIDER_ERROR", "sandbox: [sandbox:provider-error] 마커 시뮬레이션", status_code=502,
        )
    if _MARKER_EXPIRED_TOKEN in text:
        raise ThreadsPublishError(
            "SANDBOX_FACEBOOK_TOKEN_EXPIRED", "sandbox: [sandbox:expired-token] 마커 시뮬레이션", status_code=401,
        )
    if _MARKER_EXPIRE_AFTER_PUBLISH in text:
        return f"sandbox-fb-post-{uuid.uuid4().hex}{_EXPIRE_AFTER_PUBLISH_SUFFIX}"
    return f"sandbox-fb-post-{uuid.uuid4().hex}"


async def create_carousel_container(
    client: httpx.AsyncClient, *, access_token: str, threads_user_id: str, text: str, image_urls: list[str],
) -> str:
    """facebook_publish.py::create_carousel_container·instagram_sandbox_publish.py::
    create_carousel_container와 동형 계약(결정적·상태 없음). 자식 N번째 실패
    마커(1-indexed) `[sandbox:carousel-child-{n}-failed]`로 그 번째에서 예외 —
    부모(`/feed`) 호출 자체가 안 만들어진다(원자성 재현)."""
    if _MARKER_429 in text:
        raise ThreadsPublishError("SANDBOX_FACEBOOK_RATE_LIMITED", "sandbox: [sandbox:429] 마커 시뮬레이션", status_code=429)
    if _MARKER_PROVIDER_ERROR in text:
        raise ThreadsPublishError(
            "SANDBOX_FACEBOOK_PROVIDER_ERROR", "sandbox: [sandbox:provider-error] 마커 시뮬레이션", status_code=502,
        )
    if _MARKER_EXPIRED_TOKEN in text:
        raise ThreadsPublishError(
            "SANDBOX_FACEBOOK_TOKEN_EXPIRED", "sandbox: [sandbox:expired-token] 마커 시뮬레이션", status_code=401,
        )
    for index, _image_url in enumerate(image_urls, start=1):
        marker = f"[sandbox:carousel-child-{index}-failed]"
        if marker in text:
            raise ThreadsPublishError(
                "SANDBOX_FACEBOOK_CAROUSEL_CHILD_FAILED", f"sandbox: {marker} 마커 시뮬레이션", status_code=502,
            )
    return f"sandbox-fb-carousel-{uuid.uuid4().hex}"


async def create_reels_container(
    client: httpx.AsyncClient, *, access_token: str, threads_user_id: str, text: str,
    video_url: str | None, cover_url: str | None = None,
) -> str:
    """facebook_publish.py::create_reels_container·instagram_sandbox_publish.py::
    create_reels_container와 동형 계약."""
    if _MARKER_429 in text:
        raise ThreadsPublishError("SANDBOX_FACEBOOK_RATE_LIMITED", "sandbox: [sandbox:429] 마커 시뮬레이션", status_code=429)
    if _MARKER_PROVIDER_ERROR in text:
        raise ThreadsPublishError(
            "SANDBOX_FACEBOOK_PROVIDER_ERROR", "sandbox: [sandbox:provider-error] 마커 시뮬레이션", status_code=502,
        )
    if _MARKER_EXPIRED_TOKEN in text:
        raise ThreadsPublishError(
            "SANDBOX_FACEBOOK_TOKEN_EXPIRED", "sandbox: [sandbox:expired-token] 마커 시뮬레이션", status_code=401,
        )
    if _MARKER_REELS_PROCESSING_FAILED in text:
        raise ThreadsPublishError(
            "SANDBOX_FACEBOOK_REELS_PROCESSING_FAILED",
            "sandbox: [sandbox:reels-processing-failed] 마커 시뮬레이션", status_code=502,
        )
    if _MARKER_REELS_CODEC_REJECTED in text:
        raise ThreadsPublishError(
            "SANDBOX_FACEBOOK_REELS_CODEC_REJECTED",
            "sandbox: [sandbox:reels-codec-rejected] 마커 시뮬레이션", status_code=422,
        )
    if video_url is None:
        raise ThreadsPublishError(
            "FACEBOOK_REELS_VIDEO_REQUIRED", "릴스 발행은 영상이 필수입니다", status_code=422,
        )
    return f"sandbox-fb-reels-{uuid.uuid4().hex}"


async def get_container_status(
    client: httpx.AsyncClient, *, access_token: str, creation_id: str,
) -> tuple[str, str | None]:
    # instagram_sandbox_publish.py와 동형 — 사진/피드·릴스 전부 즉시 FINISHED로
    # 단순화(처리 실패 시뮬레이션은 create_reels_container 마커에서 이미 던진다).
    return "FINISHED", None


async def publish_container(
    client: httpx.AsyncClient, *, access_token: str, threads_user_id: str, creation_id: str,
) -> str:
    # facebook_publish.py와 동형 — create_container가 이미 "발행"까지 끝냈다는 계약이라
    # sandbox도 같은 id를 그대로 되돌려준다(추가 상태 생성 0).
    return creation_id


async def get_publishing_limit(
    client: httpx.AsyncClient, *, access_token: str, threads_user_id: str,
) -> tuple[int, int, int]:
    return 0, 100, 86400


async def get_permalink(client: httpx.AsyncClient, *, access_token: str, media_id: str) -> str | None:
    return f"https://sandbox.invalid/facebook/{media_id}"


async def delete_media(client: httpx.AsyncClient, *, access_token: str, media_id: str) -> None:
    # facebook_publish.py와 달리 supports_unpublish=True 선언과 짝을 맞춰 실제로
    # "삭제됨"을 시뮬레이션한다(sandbox_publish.py의 threads 계열과 동형 — 실
    # provider가 지원 확認된 능력은 sandbox도 성공으로 흉내낸다).
    return None


# ─── story #3571(Phase2·BE, 페드루 PO 確定 2026-09-06) — 댓글 수집+답변
# (instagram_sandbox_publish.py와 동형 계약) ──────────────────────────────────


def _deterministic_comment(*, media_id: str, index: int) -> dict:
    seed = int(uuid.uuid5(uuid.NAMESPACE_URL, f"{media_id}:{index}").hex[:8], 16)
    return {
        "id": f"sandbox-fb-comment-{media_id}-{index}",
        "text": f"샌드박스 FB 댓글 {index}(seed={seed % 1000})",
        "username": f"sandbox_fb_user_{index}",
        "timestamp": "2026-09-06T00:00:00+00:00",
    }


async def fetch_replies(client: httpx.AsyncClient, *, access_token: str, media_id: str) -> tuple[list[dict], bool]:
    """instagram_sandbox_publish.py::fetch_replies와 동형 — media_id 하나엔 항상
    같은 2건(순서 고정), complete=True 고정(페이지네이션 개념 없음).

    story #3597 — media_id가 `_EXPIRE_AFTER_PUBLISH_SUFFIX`를 달고 있으면 401을
    던진다(instagram_sandbox_publish.py::fetch_replies와 동형)."""
    if media_id.endswith(_EXPIRE_AFTER_PUBLISH_SUFFIX):
        raise ThreadsPublishError(
            "SANDBOX_FACEBOOK_TOKEN_EXPIRED",
            "sandbox: [sandbox:expire-after-publish] 마커 시뮬레이션(발행 후 토큰 만료)", status_code=401,
        )
    return [_deterministic_comment(media_id=media_id, index=i) for i in (1, 2)], True


async def reply(
    client: httpx.AsyncClient, *, access_token: str, threads_user_id: str, reply_to_id: str, text: str,
) -> tuple[str, str | None]:
    """facebook_publish.py::reply와 동형 계약 — 댓글 답변엔 permalink 개념이
    없어 두 번째 반환값은 항상 None(실 클라이언트와 동일하게, sandbox가 실제보다
    관대한 값을 지어내지 않는다)."""
    return f"sandbox-fb-reply-{uuid.uuid4().hex}", None
