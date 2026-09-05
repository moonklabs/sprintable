"""story #3547(Phase2·마케팅운영, 페드루 PO 確定 2026-09-06) — dev 전용 Facebook Page
샌드박스 발행 클라이언트. `facebook_publish.py`와 정확히 같은 함수 시그니처(신규
판정 로직 0) — 결정적·상태 없음(sandbox_publish.py·instagram_sandbox_publish.py와
동형 설계 계약). comments/insights 함수는 아예 안 둔다(declare-only, supports_
fetch_replies/insight_metrics를 어댑터에서 선언 안 함 — 페드루 PO 明示 2026-09-06)."""
from __future__ import annotations

import uuid

import httpx

from app.services.threads_publish import ThreadsPublishError

_MARKER_429 = "[sandbox:429]"
_MARKER_PROVIDER_ERROR = "[sandbox:provider-error]"
_MARKER_EXPIRED_TOKEN = "[sandbox:expired-token]"


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
    return f"sandbox-fb-post-{uuid.uuid4().hex}"


async def get_container_status(
    client: httpx.AsyncClient, *, access_token: str, creation_id: str,
) -> tuple[str, str | None]:
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
