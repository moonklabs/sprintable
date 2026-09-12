"""story #3813(Phase3·3-4 PR5-a, 페드루 PO 確定 2026-09-12) — 실 Stibee API 클라이언트
첫 조각. 저장 시점(연결 생성)에 발급받은 키가 진짜로 인증되는지 값싸게 확인하는
것만 이 조각의 범위(PO 明示 "저장 시 프로브는 auth-check 1개만, 다른 엔드포인트
프로브 0") — 세그먼트/수신자 수 조회·캠페인 생성·발송은 PR5-b(규모 산정 후속) 몫.

그라운딩(공개 문서·spec, 2026-09-12): `GET https://api.stibee.com/v2/auth-check`가
전용 테스트 엔드포인트("발급된 API 키를 사용해 인증이 정상적으로 되는지 확인할 수
있는 테스트용 요청") — 헤더 `AccessToken`만 필요, 요금제 무관하게 열려 있다.

순수 API 클라이언트로만 남는다(threads_publish.py와 동형 관례) — httpx.AsyncClient는
호출자가 구성해 넘긴다, 에러는 코드+메시지 예외 하나로 통일."""
from __future__ import annotations

import httpx

_AUTH_CHECK_URL = "https://api.stibee.com/v2/auth-check"


class StibeeAuthCheckFailed(Exception):
    """auth-check가 200이 아니거나(대개 401/403 — 요금제 게이팅으로 인한 다른 코드도
    이 자리로 떨어진다) 네트워크 자체가 실패했을 때. `.status_code`는 provider가 준
    HTTP status(네트워크 실패 시 None) — 호출부가 이 둘을 구분해 로그 상세를 고른다,
    사람에게 보이는 문구는 항상 하나("API 키가 유효하지 않습니다")로 통일한다(PO
    明示 — 원인 세분화는 사람이 할 일이 없어 화면에 안 싣는다)."""

    def __init__(self, message: str, *, status_code: int | None):
        self.status_code = status_code
        super().__init__(message)


async def verify_api_key(client: httpx.AsyncClient, *, api_key: str) -> None:
    """`GET /auth-check` — 200이면 정상 반환(값 없음). 그 외 status나 네트워크 실패는
    `StibeeAuthCheckFailed`(fail-closed, 호출부가 연결 저장을 막는다)."""
    try:
        resp = await client.get(_AUTH_CHECK_URL, headers={"AccessToken": api_key})
    except httpx.HTTPError as exc:
        raise StibeeAuthCheckFailed(str(exc), status_code=None) from exc
    if resp.status_code != 200:
        raise StibeeAuthCheckFailed(resp.text[:500], status_code=resp.status_code)
