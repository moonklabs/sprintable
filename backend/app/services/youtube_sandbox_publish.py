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
- `[sandbox:provider-error]` — 기존 어휘 재사용(신규 마커 0, 페드루 明示④)."""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import httpx

from app.services.threads_publish import ThreadsPublishError
from app.services.youtube_quota import YouTubeQuotaExceededError

_MARKER_QUOTA_EXCEEDED = "[sandbox:youtube-quota-exceeded]"
_MARKER_PROVIDER_ERROR = "[sandbox:provider-error]"


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


async def create_reels_container(
    client: httpx.AsyncClient, *, access_token: str, threads_user_id: str, text: str,
    video_url: str, cover_url: str | None = None, channel_payload: dict | None = None,
) -> str:
    _raise_if_marked(text)
    return f"sandbox-youtube-video-{uuid.uuid4().hex}"


async def get_container_status(
    client: httpx.AsyncClient, *, access_token: str, creation_id: str,
) -> tuple[str, str | None]:
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
