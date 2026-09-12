"""story #3815(Phase3·3-5 PR2, 페드루 PO 確定 2026-09-12) — dev 전용 YouTube
샌드박스 발행 클라이언트. `youtube_publish.py`와 정확히 같은 5-함수 파사드
시그니처(x_sandbox_publish.py와 동형 설계 계약 — 결정적·상태 없음·
`ThreadsPublishError` 재사용, 신규 판정 로직 0). resumable 업로드 HTTP
왕복 전부 생략 — 즉시 FINISHED(다른 sandbox들과 동형 단순화).

마커 3종(카드 원문, 페드루 PO 決定④) — `text`(=video description, 재그라운딩
정정으로 title이 아니라 description 축에 싣는다 — x_sandbox_publish.py가
tweet 본문에 싣는 것과 동형 위치, YouTube에서 제목은 채널_payload 쪽 구조화
필드라 마커 은닉 자리로 안 맞는다) 안에 있으면:
- `[sandbox:youtube-quota-exceeded]` — 플랫폼 quota가 실제로 바닥나길
  기다리지 않고 결정적으로 422 경로를 재현(`youtube_quota.py::
  YouTubeQuotaExceededError`를 오케스트레이션 대신 여기서 직접 냄 — 실
  quota 축과 별개의 "provider가 알아서 걸었다"는 시나리오는 없어 이 한
  경로로 충분, x_sandbox_publish.py의 api-budget-exceeded 마커와 동형
  사상이나 예외 클래스는 quota 축 것을 그대로 재사용).
- `[sandbox:youtube-privacy-locked]` — 감사 미완 강제잠금(`_resolved_
  privacy_status`)이 실제로 요청값을 덮어썼다는 사실을 결정적으로 관찰
  가능하게 만든다(설정값 `youtube_api_audit_incomplete`을 몰라도 이
  마커 하나로 그 분기를 항상 통과시킨다 — 테스트가 env 값에 기대지
  않아도 되게).
- `[sandbox:provider-error]` — 기존 어휘 재사용(신규 마커 0, 페드루 明示④).

마커 4번째(CHANGES②, 페드루 PO 지적 2026-09-12 11:34Z) — `[sandbox:youtube-
processing-long]`: 트랜스코딩이 5분(다른 채널의 컨테이너 폴링 상한)을 넘겨도
YouTube는 거짓 실패가 아니어야 함을 증명하는 자리. state 없는 sandbox 설계
원칙을 지키기 위해(process 메모리 0) 이 마커를 creation_id 자체에 새긴다
(process 재기동에도 다음 `get_container_status` 호출이 같은 id 문자열만
보고 결정적으로 재현) — X의 `[sandbox:429-once]`가 DB 실물(row)로 상태를
드는 것과 달리 이건 id 자체가 상태라 DB도 불필요."""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import httpx

from app.services.threads_publish import ThreadsPublishError
from app.services.youtube_quota import YouTubeQuotaExceededError

_MARKER_QUOTA_EXCEEDED = "[sandbox:youtube-quota-exceeded]"
_MARKER_PROVIDER_ERROR = "[sandbox:provider-error]"
_MARKER_PROCESSING_LONG = "[sandbox:youtube-processing-long]"
_PROCESSING_LONG_ID_TAG = "processing-long"


def _raise_if_marked(text: str) -> None:
    if _MARKER_QUOTA_EXCEEDED in text:
        now = datetime.now(timezone.utc)
        reset_at = now.replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(days=1)
        raise YouTubeQuotaExceededError(
            limit_units=10_000, spent_units=10_000, estimated_units=1_600, remaining_units=0, reset_at=reset_at,
        )
    if _MARKER_PROVIDER_ERROR in text:
        raise ThreadsPublishError(
            "SANDBOX_YOUTUBE_PROVIDER_ERROR", "sandbox: [sandbox:provider-error] marker simulation",
            status_code=502,
        )


async def create_container(
    client: httpx.AsyncClient, *, access_token: str, threads_user_id: str, text: str,
    image_url: str | None = None,
) -> str:
    """발견 즉시 수정 — youtube_publish.py::create_container와 동형(위 딱지
    참고, `channel_posts.py:1711`의 무조건 속성-접근 대비)."""
    raise ThreadsPublishError(
        "SANDBOX_YOUTUBE_IMAGE_CONTAINER_UNSUPPORTED",
        "sandbox: YouTube has no image container concept (video_required=True channel)",
        status_code=500,
    )


async def create_reels_container(
    client: httpx.AsyncClient, *, access_token: str, threads_user_id: str, text: str,
    video_url: str, cover_url: str | None = None, channel_payload: dict | None = None,
) -> str:
    _raise_if_marked(text)
    if _MARKER_PROCESSING_LONG in text:
        return f"sandbox-youtube-video-{_PROCESSING_LONG_ID_TAG}-{uuid.uuid4().hex}"
    return f"sandbox-youtube-video-{uuid.uuid4().hex}"


async def get_container_status(
    client: httpx.AsyncClient, *, access_token: str, creation_id: str,
) -> tuple[str, str | None]:
    if _PROCESSING_LONG_ID_TAG in creation_id:
        return "IN_PROGRESS", None
    return "FINISHED", None


async def publish_container(
    client: httpx.AsyncClient, *, access_token: str, threads_user_id: str, creation_id: str,
) -> str:
    return creation_id


async def get_permalink(client: httpx.AsyncClient, *, access_token: str, media_id: str) -> str | None:
    return f"https://www.youtube.com/watch?v={media_id}"


async def get_publishing_limit(
    client: httpx.AsyncClient, *, access_token: str, threads_user_id: str,
) -> tuple[int, int, int]:
    return 0, 10_000, 86_400
