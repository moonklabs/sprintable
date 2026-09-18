"""story #3813(Phase3·3-4 PR2, 페드루 PO 確定 2026-09-12) — 뉴스레터 ESP 「발행」
(=ESP 캠페인 생성, 발송 아님) dev 전용 샌드박스. `x_sandbox_publish.py`와 정확히
같은 5-함수 파사드 시그니처(facebook_sandbox_publish.py류와 동형 설계 계약 —
결정적·상태 없음·`ThreadsPublishError` 재사용, 신규 판정 로직 0). `threads_user_id`
파라미터명은 dispatcher 공용 계약 그대로(실제로는 stibee 쪽 발신자 식별자 개념
자체가 없다 — connection.account_id="default" 고정, PR1 참고).

실 스티비 API 호출 0(페드루 PO 明示, 2026-09-12) — `stibee_publish.py`(진짜 Stibee
HTTP 클라이언트)는 이 PR 범위 밖(wordpress/webhook의 조각⑤/③b·④ 선례와 동형 순서
— 연결·게이트 기전이 먼저, 실 provider 왕복은 후속). `subject`는 channel_posts.py
오케스트레이터가 `version.channel_payload`에서 뽑아 이 함수에 넘긴다(공용 5-함수
시그니처에 없던 새 kwarg — stibee/stibee_sandbox 전용 분기에서만 채워짐, 다른
채널 create_container 시그니처는 무변경)."""
from __future__ import annotations

import uuid

import httpx

from app.services.threads_publish import ThreadsPublishError

_MARKER_PROVIDER_ERROR = "[sandbox:provider-error]"
_MARKER_INVALID_RECIPIENT = "[sandbox:invalid-recipient]"


def _raise_if_marked(text: str) -> None:
    """.message는 provider 원문 축(threads_publish.py::ThreadsPublishError 상단
    딱지 그대로) — 로그·디버그용 영문 기술 문구지 사람에게 보이는 최종 문장이
    아니다. 한글로 쓰면 story #3779 baseline ratchet에 걸린다(x_sandbox_publish.py
    동형 판단)."""
    if _MARKER_PROVIDER_ERROR in text:
        raise ThreadsPublishError(
            "SANDBOX_STIBEE_PROVIDER_ERROR", "sandbox: [sandbox:provider-error] marker simulation", status_code=502,
        )
    if _MARKER_INVALID_RECIPIENT in text:
        raise ThreadsPublishError(
            "SANDBOX_STIBEE_INVALID_RECIPIENT", "sandbox: [sandbox:invalid-recipient] marker simulation",
            status_code=400,
        )


async def create_container(
    client: httpx.AsyncClient, *, access_token: str, threads_user_id: str, text: str,
    image_url: str | None = None, subject: str | None = None,
) -> str:
    """ESP 캠페인 생성 — 실 Stibee는 비동기 처리 없이 즉시 캠페인 id를 낸다고
    가정(⚠️미확認, 실 provider 왕복 전까지는 sandbox/instagram_sandbox 동형으로
    단순화). 마커는 본문(text)·제목(subject) 어느 쪽에 있어도 잡는다."""
    _raise_if_marked(text)
    if subject:
        _raise_if_marked(subject)
    return f"sandbox-stibee-campaign-{uuid.uuid4().hex}"


async def get_container_status(
    client: httpx.AsyncClient, *, access_token: str, creation_id: str,
) -> tuple[str, str | None]:
    return "FINISHED", None


async def publish_container(
    client: httpx.AsyncClient, *, access_token: str, threads_user_id: str, creation_id: str,
) -> str:
    """no-op(create_container가 이미 캠페인 id를 발급) — facebook_publish.py의
    「사진/피드는 create_container가 이미 발행까지 끝냈다」 동형 판단. 여기서
    "발행"은 ESP 캠페인 생성까지 — 실제 수신자에게 나가는 「발송」은 이 함수
    소관이 아니다(newsletter_send 게이트 승인 뒤 별도 명령, PR2 모듈 docstring
    참고)."""
    return creation_id


async def get_permalink(client: httpx.AsyncClient, *, access_token: str, media_id: str) -> str | None:
    return f"https://sandbox.invalid/stibee/campaigns/{media_id}"


async def get_publishing_limit(
    client: httpx.AsyncClient, *, access_token: str, threads_user_id: str,
) -> tuple[int, int, int]:
    return 0, 10_000, 86_400
