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
