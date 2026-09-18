"""story #3813(Phase3·3-4 PR5-a·PR5-b, 페드루 PO 確定 2026-09-12) — 실 Stibee API
클라이언트. PR5-a는 저장 시점 auth-check 하나만(연결 생성 fail-closed). PR5-b가
발행(캠페인 생성)·발송(예약)·발송 결과(로그 집계) 3축을 더한다.

그라운딩(공개 문서·spec, 2026-09-12):
- `GET /auth-check` — 키 인증 확인 전용, 요금제 무관.
- 캠페인 생성은 **3콜**: `POST /emails`(JSON: subject·senderEmail·senderName·
  listId, 본문 필드 없음) → `POST /emails/{id}/content`(⚠️JSON 아님 — `Content-
  Type: text/html`로 원시 HTML을 바디 그대로, "작성 중" 상태에서만 수정 가능) →
  `POST /emails/{id}/reserve?reserveTime=...`(쿼리, `YYYYMMDDhhmmss`·KST 고정·
  과거 시각 거절).
- 요금제 부족: HTTP 400 + 바디 `code: "Errors.Service.NeedProPlan"`(403 아님 —
  auth-check의 400 정정과 같은 패턴).
- 발신자 미인증: HTTP 400 + 바디 `code: "Errors.Authorization.PermissionDenied"`.
- `GET /emails/{id}/logs`(발송 결과) — 개별 수신자 이벤트 로그, offset/limit(최대
  1000) 페이지네이션, 집계 전용 엔드포인트 없음. `actionName` 전체 열거값이
  문서에 없음(재확認 2026-09-12) — `"DELIVERED"` 예시 하나만 확실, "오픈"에
  해당하는 문자열은 미확認(실 키 왕복 前까지 `opens=None`, 지어내지 않는다).

순수 API 클라이언트로만 남는다(threads_publish.py와 동형 관례) — httpx.AsyncClient는
호출자가 구성해 넘긴다, 에러는 코드+메시지 예외 하나로 통일."""
from __future__ import annotations

from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import httpx

_AUTH_CHECK_URL = "https://api.stibee.com/v2/auth-check"
_BASE_URL = "https://api.stibee.com/v2"
_KST = ZoneInfo("Asia/Seoul")


class StibeeAuthCheckFailed(Exception):
    """auth-check가 200이 아니거나 네트워크 자체가 실패했을 때. `.status_code`는
    provider가 준 HTTP status(네트워크 실패·타임아웃 시 None).

    story #3813 PR5-a CHANGES(페드루 PO 確定 2026-09-12) — 「스티비가 안 닿는 것」
    (네트워크·타임아웃·5xx)과 「키가 틀린 것」(스티비가 실제로 응답해서 거절)은
    사람이 할 일이 다르다(전자=잠시 뒤 재시도, 후자=키 재발급) — 호출부가
    `.is_key_rejected`로 갈라 서로 다른 문구를 고른다.

    ⚠️그라운딩 정정(2026-09-12, 실 호출 확認) — PO가 처음 가정한 "401/403"은
    실물과 다르다: 실제 `GET /auth-check`에 존재하지 않는 키를 실으면 **400**
    (`{"code":"Errors.Authorization.NoToken","message":"존재하지 않는 토큰 입니다."}`)
    이 온다. 그래서 판정축을 "401/403이냐"가 아니라 "스티비가 응답했느냐(4xx 전체=
    거절)"로 잡는다 — 5xx(스티비 쪽 장애)·None(네트워크 자체가 안 닿음)만 「일시
    불가」, 나머지 4xx는 전부 「키 거절」."""

    def __init__(self, message: str, *, status_code: int | None):
        self.status_code = status_code
        super().__init__(message)

    @property
    def is_key_rejected(self) -> bool:
        """스티비가 실제로 응답해서 거절(4xx)했으면 True — 「키 재발급」이 처방.
        응답 자체가 없거나(None) 스티비 쪽 장애(5xx)면 False — 「잠시 뒤 재시도」."""
        return self.status_code is not None and 400 <= self.status_code < 500


async def verify_api_key(client: httpx.AsyncClient, *, api_key: str) -> None:
    """`GET /auth-check` — 200이면 정상 반환(값 없음). 그 외 status나 네트워크 실패는
    `StibeeAuthCheckFailed`(fail-closed, 호출부가 연결 저장을 막는다)."""
    try:
        resp = await client.get(_AUTH_CHECK_URL, headers={"AccessToken": api_key})
    except httpx.HTTPError as exc:
        raise StibeeAuthCheckFailed(str(exc), status_code=None) from exc
    if resp.status_code != 200:
        raise StibeeAuthCheckFailed(resp.text[:500], status_code=resp.status_code)


class StibeeApiError(Exception):
    """story #3813 PR5-b — 캠페인 생성·발송(예약)·발송결과 조회 3축 공용 예외.
    `.provider_code`는 스티비 응답 바디의 `code` 필드 원문(예: "Errors.Service.
    NeedProPlan") — HTTP status만으론 부족하다(같은 400이 여러 뜻을 갖는다,
    그라운딩 정정 그대로). `.status_code`는 네트워크 실패 시 None."""

    def __init__(self, message: str, *, status_code: int | None, provider_code: str | None = None):
        self.status_code = status_code
        self.provider_code = provider_code
        super().__init__(message)

    @property
    def is_plan_restricted(self) -> bool:
        return self.provider_code == "Errors.Service.NeedProPlan"

    @property
    def is_sender_not_verified(self) -> bool:
        return self.provider_code == "Errors.Authorization.PermissionDenied"


async def _request_json(
    client: httpx.AsyncClient, method: str, path: str, *, api_key: str, headers: dict | None = None, **kwargs,
) -> dict:
    """공용 JSON 왕복 — 2xx면 body dict 반환, 그 외/네트워크 실패는 `StibeeApiError`
    (바디가 JSON이면 `code`를 `.provider_code`로 뽑는다, malformed면 None). 호출부가
    자기만의 `headers`(예: `set_content`의 `Content-Type: text/html`)를 넘기면
    `AccessToken`과 합쳐서 보낸다(덮어쓰지 않는다)."""
    merged_headers = {"AccessToken": api_key, **(headers or {})}
    try:
        resp = await client.request(method, f"{_BASE_URL}{path}", headers=merged_headers, **kwargs)
    except httpx.HTTPError as exc:
        raise StibeeApiError(str(exc), status_code=None) from exc
    if resp.status_code // 100 != 2:
        provider_code = None
        try:
            provider_code = resp.json().get("code")
        except ValueError:
            pass
        raise StibeeApiError(resp.text[:500], status_code=resp.status_code, provider_code=provider_code)
    if not resp.content:
        return {}
    return resp.json()


async def create_email(
    client: httpx.AsyncClient, *, api_key: str, subject: str, sender_email: str, sender_name: str, list_id: str,
) -> int:
    """`POST /emails` — 캠페인 메타(제목·발신자·대상 주소록)만 만든다(본문 필드
    자체가 없음, 그라운딩 정정). 반환은 스티비 email id(정수) — `set_content`·
    `reserve_email`이 이어서 이 id를 쓴다."""
    body = await _request_json(
        client, "POST", "/emails", api_key=api_key,
        json={"subject": subject, "senderEmail": sender_email, "senderName": sender_name, "listId": int(list_id)},
    )
    return int(body["id"])


async def set_content(client: httpx.AsyncClient, *, api_key: str, email_id: int, html: str) -> None:
    """`POST /emails/{id}/content` — ⚠️JSON이 아니다(그라운딩 정정): `Content-Type:
    text/html`로 원시 HTML을 바디 그대로 보낸다. "작성 중" 상태에서만 통과."""
    await _request_json(
        client, "POST", f"/emails/{email_id}/content", api_key=api_key,
        content=html.encode("utf-8"), headers={"Content-Type": "text/html; charset=utf-8"},
    )


def utc_to_kst_reserve_time(scheduled_at_utc: datetime) -> str:
    """봉인된 UTC 시각(`gate.sealed_newsletter_scheduled_at`)을 스티비 `reserveTime`
    쿼리 형식(`YYYYMMDDhhmmss`, 대한민국 표준시 UTC+9 고정)으로 변환한다."""
    if scheduled_at_utc.tzinfo is None:
        scheduled_at_utc = scheduled_at_utc.replace(tzinfo=timezone.utc)
    kst = scheduled_at_utc.astimezone(_KST)
    return kst.strftime("%Y%m%d%H%M%S")


async def reserve_email(client: httpx.AsyncClient, *, api_key: str, email_id: int, scheduled_at_utc: datetime) -> None:
    """`POST /emails/{id}/reserve?reserveTime=...` — 봉인 시각이 항상 있으므로
    `send_now`류 즉시발송은 안 쓴다(PO 明示). 과거 시각이면 스티비가 400
    `Errors.Data.InvalidRequest`로 거절(재검증은 호출부 몫 — 이 함수는 변환·왕복만)."""
    reserve_time = utc_to_kst_reserve_time(scheduled_at_utc)
    await _request_json(
        client, "POST", f"/emails/{email_id}/reserve", api_key=api_key, params={"reserveTime": reserve_time},
    )


_LOGS_PAGE_LIMIT = 1000
# story #3813 PR5-b — 캠페인당 호출 수 상한(PO 明示). 수신자 수 4,200명 기준 로그
# 행수가 이보다 훨씬 클 순 있으나(수신자당 여러 이벤트: DELIVERED·오픈·클릭 등)
# 무한 페이지네이션을 막는 안전판 — 도달하면 그때까지 집계값을 그대로 쓴다
# (부분 집계임을 raw_payload의 `truncated=True`로 남겨 지어내지 않는다).
_LOGS_MAX_PAGES = 50


async def fetch_send_result(client: httpx.AsyncClient, *, api_key: str, email_id: int) -> dict:
    """`GET /emails/{id}/logs` 전량 페이지네이션(limit 1000/회, 상한 `_LOGS_MAX_PAGES`
    회) + `actionName`별 카운트 집계. 429는 `Retry-After` 헤더(없으면 1초) 대기 후
    재시도(그라운딩 rate limit 1000/분) — 페이지당 최대 1회 재시도(무한 루프 방지).

    반환: `{"counts": {actionName: count, ...}, "delivered": int, "opens": None,
    "truncated": bool}` — `delivered`만 확정 매핑("DELIVERED"), `opens`는 실
    actionName 미확認이라 지어내지 않고 None(호출부가 raw counts를 보존해 나중에
    한 줄만 고치면 되게)."""
    counts: dict[str, int] = {}
    offset = 0
    truncated = False
    for page in range(_LOGS_MAX_PAGES):
        retried = False
        while True:
            try:
                resp = await client.get(
                    f"{_BASE_URL}/emails/{email_id}/logs", headers={"AccessToken": api_key},
                    params={"offset": offset, "limit": _LOGS_PAGE_LIMIT},
                )
            except httpx.HTTPError as exc:
                raise StibeeApiError(str(exc), status_code=None) from exc
            if resp.status_code == 429 and not retried:
                import asyncio

                wait_seconds = float(resp.headers.get("Retry-After", "1"))
                await asyncio.sleep(wait_seconds)
                retried = True
                continue
            break
        if resp.status_code // 100 != 2:
            provider_code = None
            try:
                provider_code = resp.json().get("code")
            except ValueError:
                pass
            raise StibeeApiError(resp.text[:500], status_code=resp.status_code, provider_code=provider_code)
        body = resp.json()
        items = body.get("items", [])
        for item in items:
            action_name = item.get("actionName")
            if action_name:
                counts[action_name] = counts.get(action_name, 0) + 1
        if len(items) < _LOGS_PAGE_LIMIT:
            break
        offset += _LOGS_PAGE_LIMIT
        if page == _LOGS_MAX_PAGES - 1:
            truncated = True

    return {"counts": counts, "delivered": counts.get("DELIVERED", 0), "opens": None, "truncated": truncated}
