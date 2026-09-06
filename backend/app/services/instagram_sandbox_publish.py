"""story #3320(Phase2·마케팅운영, 페드루 PO 確定 2026-09-05) — dev 전용 Instagram
샌드박스 발행 클라이언트. `sandbox_publish.py`(story 5b27b32f)와 정확히 같은 설계
계약(결정적·상태 없음·`ThreadsPublishError` 재사용, 신규 판정 로직 0) — 다만 이
채널은 `channel="instagram_sandbox"`로 별도 등록한다(기존 `"sandbox"`는 Threads류
TEXT-optional 채널을 흉내내는 값이라, 「이미지 필수」인 Instagram의 별도 성질을
같은 채널 값 안에 욱여넣지 않는다 — `get_publish_client_module`의 채널→모듈 dict가
이 구분을 그대로 반영).

`channel_adapters.py::get_publish_client_module`이 이 모듈로 디스패치하는 유일한
지점(sandbox_publish.py와 동형 개입 지점 사상) — 오케스트레이션(channel_posts.py)은
어느 쪽이 골렸는지 모른다."""
from __future__ import annotations

import uuid

import httpx

from app.services.threads_publish import ThreadsPublishError

# sandbox_publish.py와 동형 마커 3종(429/provider-error/expired-token) — Instagram
# 도 인증·한도 실패 시뮬레이션은 같은 어휘를 쓴다(신규 마커 어휘 0). 컨테이너
# 폴링·comment-2-deleted류는 이 조각(①) 스코프 밖(이미지 필수라 컨테이너 자체는
# 항상 즉시 FINISHED로 단순화 — Instagram이 Threads IMAGE 컨테이너처럼 비동기
# 처리 지연을 흉내내야 하는지는 실계정 왕복 뒤 재검토, 그라운딩 미확認 축).
_MARKER_429 = "[sandbox:429]"
_MARKER_PROVIDER_ERROR = "[sandbox:provider-error]"
_MARKER_EXPIRED_TOKEN = "[sandbox:expired-token]"


async def create_container(
    client: httpx.AsyncClient, *, access_token: str, threads_user_id: str, text: str,
    image_url: str | None = None,
) -> str:
    """instagram_publish.py와 동형 — 이미지 필수(None이면 즉시 거부, 실 provider와
    같은 조건을 sandbox도 지킨다 — sandbox가 실제보다 관대하면 「sandbox는 됐는데
    실계정은 막힘」류 격차가 생긴다)."""
    if _MARKER_429 in text:
        raise ThreadsPublishError("SANDBOX_INSTAGRAM_RATE_LIMITED", "sandbox: [sandbox:429] 마커 시뮬레이션", status_code=429)
    if _MARKER_PROVIDER_ERROR in text:
        raise ThreadsPublishError(
            "SANDBOX_INSTAGRAM_PROVIDER_ERROR", "sandbox: [sandbox:provider-error] 마커 시뮬레이션", status_code=502,
        )
    if _MARKER_EXPIRED_TOKEN in text:
        raise ThreadsPublishError(
            "SANDBOX_INSTAGRAM_TOKEN_EXPIRED", "sandbox: [sandbox:expired-token] 마커 시뮬레이션", status_code=401,
        )
    if image_url is None:
        raise ThreadsPublishError(
            "INSTAGRAM_IMAGE_REQUIRED", "Instagram 발행은 이미지가 필수입니다(피드 이미지 1장)", status_code=422,
        )
    return f"sandbox-ig-creation-{uuid.uuid4().hex}"


async def create_carousel_container(
    client: httpx.AsyncClient, *, access_token: str, threads_user_id: str, text: str, image_urls: list[str],
) -> str:
    """story #3550(Phase2, 페드루 PO 確定 2026-09-06) — instagram_publish.py::
    create_carousel_container와 동형 계약(결정적·상태 없음). 자식 N번째 실패
    마커(1-indexed) — `[sandbox:carousel-child-{n}-failed]`를 text에 심으면 그
    번째 자식에서 예외를 던져 부모 컨테이너가 아예 안 만들어진다(원자성 재현,
    「자식 하나 실패=부모도 실패」는 실측 아님·Meta 문서 지식 가정)."""
    if _MARKER_429 in text:
        raise ThreadsPublishError("SANDBOX_INSTAGRAM_RATE_LIMITED", "sandbox: [sandbox:429] 마커 시뮬레이션", status_code=429)
    if _MARKER_PROVIDER_ERROR in text:
        raise ThreadsPublishError(
            "SANDBOX_INSTAGRAM_PROVIDER_ERROR", "sandbox: [sandbox:provider-error] 마커 시뮬레이션", status_code=502,
        )
    if _MARKER_EXPIRED_TOKEN in text:
        raise ThreadsPublishError(
            "SANDBOX_INSTAGRAM_TOKEN_EXPIRED", "sandbox: [sandbox:expired-token] 마커 시뮬레이션", status_code=401,
        )
    for index, _image_url in enumerate(image_urls, start=1):
        marker = f"[sandbox:carousel-child-{index}-failed]"
        if marker in text:
            raise ThreadsPublishError(
                "SANDBOX_INSTAGRAM_CAROUSEL_CHILD_FAILED", f"sandbox: {marker} 마커 시뮬레이션", status_code=502,
            )
    return f"sandbox-ig-carousel-{uuid.uuid4().hex}"


async def get_container_status(
    client: httpx.AsyncClient, *, access_token: str, creation_id: str,
) -> tuple[str, str | None]:
    # 이미지 컨테이너라도 조각①은 즉시 FINISHED로 단순화(위 모듈 docstring 참고).
    return "FINISHED", None


async def publish_container(
    client: httpx.AsyncClient, *, access_token: str, threads_user_id: str, creation_id: str,
) -> str:
    return f"sandbox-ig-media-{uuid.uuid4().hex}"


async def get_publishing_limit(
    client: httpx.AsyncClient, *, access_token: str, threads_user_id: str,
) -> tuple[int, int, int]:
    # 항상 넉넉한 잔량 — sandbox_publish.py와 동형(429 시뮬레이션은 create_container
    # 마커로만 유발, 이 함수는 text를 못 받는다).
    return 0, 100, 86400


async def get_permalink(client: httpx.AsyncClient, *, access_token: str, media_id: str) -> str | None:
    return f"https://sandbox.invalid/instagram/{media_id}"


async def delete_media(client: httpx.AsyncClient, *, access_token: str, media_id: str) -> None:
    # instagram_publish.py와 동형 — 실제로 확認 안 된 능력을 sandbox가 먼저 지어내지
    # 않는다(no-fiction). supports_unpublish=False라 오케스트레이션이 애초에 안 부름.
    raise ThreadsPublishError(
        "INSTAGRAM_DELETE_MEDIA_NOT_IMPLEMENTED",
        "Instagram 미디어 삭제 API는 아직 확認되지 않아 구현하지 않았습니다", status_code=501,
    )


# ─── story #3320 조각③ — 댓글 수집+답변(sandbox_publish.py와 동형 계약) ────────


def _deterministic_comment(*, media_id: str, index: int) -> dict:
    seed = int(uuid.uuid5(uuid.NAMESPACE_URL, f"{media_id}:{index}").hex[:8], 16)
    return {
        "id": f"sandbox-ig-comment-{media_id}-{index}",
        "text": f"샌드박스 IG 댓글 {index}(seed={seed % 1000})",
        "username": f"sandbox_ig_user_{index}",
        "timestamp": "2026-09-05T00:00:00+00:00",
    }


async def fetch_replies(client: httpx.AsyncClient, *, access_token: str, media_id: str) -> tuple[list[dict], bool]:
    """sandbox_publish.py::fetch_replies와 동형 — media_id 하나엔 항상 같은 2건
    (순서 고정), complete=True 고정(페이지네이션 개념 없음). AC8류
    comment-2-deleted 시각 시뮬레이션은 이 조각(③) 스코프 밖(원 스토리 §3516
    AC8이 이미 threads/기존 sandbox에서 검증한 마커라 여기서 중복 재발명 안 함)."""
    return [_deterministic_comment(media_id=media_id, index=i) for i in (1, 2)], True


async def reply(
    client: httpx.AsyncClient, *, access_token: str, threads_user_id: str, reply_to_id: str, text: str,
) -> tuple[str, str | None]:
    """instagram_publish.py::reply와 동형 계약 — 댓글 답변엔 permalink 개념이
    없어 두 번째 반환값은 항상 None(실 클라이언트와 동일하게, sandbox가 실제보다
    관대한 값을 지어내지 않는다)."""
    return f"sandbox-ig-reply-{uuid.uuid4().hex}", None
