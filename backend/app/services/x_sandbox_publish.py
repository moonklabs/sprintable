"""story #3808(Phase3·3-3 PR2, 페드루 PO 確定 2026-09-11) — dev 전용 X 샌드박스
발행 클라이언트. `x_publish.py`와 정확히 같은 5-함수 파사드 시그니처(facebook_
sandbox_publish.py/instagram_sandbox_publish.py와 동형 설계 계약 — 결정적·상태
없음·`ThreadsPublishError` 재사용, 신규 판정 로직 0). 이미지 컨테이너도 다른
sandbox들과 동형으로 즉시 FINISHED로 단순화(비동기 처리 지연 시뮬레이션은 이
카드 범위 밖).

AC2 결정적 마커 4종(카드 원문) — 앞 3종은 기존 sandbox 어휘 그대로(신규 마커
어휘 0), `duplicate-post`만 X 신설(실 X가 완전 동일 내용 재게시를 거부하는
공개 알려진 정책 — 정확한 HTTP status는 ⚠️미확認이라 `classify_graph_error_
code`의 401/403 폴백(CHANNEL_TOKEN_EXPIRED로 오분류)과 안 겹치는 400으로
시뮬레이션한다, 실 X 왕복 뒤 재확認 대상).

story #3808 PR3(2026-09-11) — 5번째 마커 `[sandbox:api-budget-exceeded]`.
ads_sandbox_campaign.py::_BUDGET_EXCEEDED_MARKER와 동형 축 — 우리 조직 규칙
(`api_usage_budget`, x_publish_budget.py::check_api_usage_budget_or_raise)이
막는 «우리 상한»과는 다른 축, "X 공급자 자신의 계정 종량 상한에 걸렸다"는
provider-측 거부를 흉내낸다(두 축이 다른 이유: 우리 상한은 create_container
호출 前에 이미 걸러지므로, 이 마커가 여기서 걸린다는 것 자체가 "우리 통과는
됐지만 provider가 별도로 거부"하는 시나리오 재현)."""
from __future__ import annotations

import uuid

import httpx

from app.services.threads_publish import ThreadsPublishError

_MARKER_429 = "[sandbox:429]"
_MARKER_PROVIDER_ERROR = "[sandbox:provider-error]"
_MARKER_EXPIRED_TOKEN = "[sandbox:expired-token]"
_MARKER_DUPLICATE_POST = "[sandbox:duplicate-post]"
_MARKER_API_BUDGET_EXCEEDED = "[sandbox:api-budget-exceeded]"


def _raise_if_marked(text: str) -> None:
    """.message는 provider 원문 축(threads_publish.py::ThreadsPublishError 상단
    딱지 그대로) — 로그·디버그용 영문 기술 문구지 사람에게 보이는 최종 문장이
    아니다. x_oauth.py/x_sandbox_oauth.py(PR1)와 동형으로 영문 유지 — 한글로
    쓰면 story #3779 baseline 「줄기만 허용」 ratchet에 걸린다(기존 facebook_
    sandbox_publish.py류 한글 마커 문구는 이 ratchet 도입 前 grandfather된
    것이라 재사용 불가, 신규 파일은 이 함정을 피해야 한다)."""
    if _MARKER_429 in text:
        raise ThreadsPublishError("SANDBOX_X_RATE_LIMITED", "sandbox: [sandbox:429] marker simulation", status_code=429)
    if _MARKER_PROVIDER_ERROR in text:
        raise ThreadsPublishError(
            "SANDBOX_X_PROVIDER_ERROR", "sandbox: [sandbox:provider-error] marker simulation", status_code=502,
        )
    if _MARKER_EXPIRED_TOKEN in text:
        raise ThreadsPublishError(
            "SANDBOX_X_TOKEN_EXPIRED", "sandbox: [sandbox:expired-token] marker simulation", status_code=401,
        )
    if _MARKER_DUPLICATE_POST in text:
        raise ThreadsPublishError(
            "SANDBOX_X_DUPLICATE_POST", "sandbox: [sandbox:duplicate-post] marker simulation", status_code=400,
        )
    if _MARKER_API_BUDGET_EXCEEDED in text:
        raise ThreadsPublishError(
            "SANDBOX_X_API_BUDGET_EXCEEDED",
            "sandbox: [sandbox:api-budget-exceeded] marker simulation — provider account spend cap reached",
            status_code=402,
        )


async def create_container(
    client: httpx.AsyncClient, *, access_token: str, threads_user_id: str, text: str,
    image_url: str | None = None,
) -> str:
    _raise_if_marked(text)
    return f"sandbox-x-post-{uuid.uuid4().hex}"


async def get_container_status(
    client: httpx.AsyncClient, *, access_token: str, creation_id: str,
) -> tuple[str, str | None]:
    return "FINISHED", None


async def publish_container(
    client: httpx.AsyncClient, *, access_token: str, threads_user_id: str, creation_id: str,
) -> str:
    return f"sandbox-x-tweet-{uuid.uuid4().hex}"


async def get_permalink(client: httpx.AsyncClient, *, access_token: str, media_id: str) -> str | None:
    return f"https://sandbox.invalid/x/{media_id}"


async def get_publishing_limit(
    client: httpx.AsyncClient, *, access_token: str, threads_user_id: str,
) -> tuple[int, int, int]:
    return 0, 10_000, 86_400


async def publish_x_thread(
    client: httpx.AsyncClient, *, access_token: str, texts: list[str], media_id: str | None = None,
) -> list[dict]:
    """`x_publish.py::publish_x_thread`와 동형 계약(N세그먼트 reply 체인) — 결정적
    시뮬레이션. 세그먼트 중 하나라도 마커가 있으면 그 세그먼트에서 멈추고(이전
    세그먼트는 이미 "발행"됐다는 사실을 예외의 `.published_segments`로 실어 던진다
    — x_publish.py 부분성공 계약과 동형)."""
    results: list[dict] = []
    for index, text in enumerate(texts):
        try:
            _raise_if_marked(text)
        except ThreadsPublishError as exc:
            exc.published_segments = results  # type: ignore[attr-defined]
            raise
        tweet_id = f"sandbox-x-tweet-{uuid.uuid4().hex}"
        results.append({
            "sequence": index + 1, "external_id": tweet_id,
            "permalink": f"https://sandbox.invalid/x/{tweet_id}",
        })
    return results
