"""story #3547(Phase2·마케팅운영, 페드루 PO 確定 2026-09-06) — Facebook Page 연결
sandbox. `facebook_oauth.py`와 정확히 같은 함수 시그니처(라우터가 채널로 모듈만
바꿔 끼우는 기존 dispatch 관례 — `channel_adapters.py::get_publish_client_module`
과 동형 사상, 새 분기 로직 0)를 인프로세스 결정적 응답으로 구현한다(sandbox_
publish.py "같은 코드 경로·가짜 데이터" 철학).

**페이지 수 마커**(페드루 PO 確定) — sandbox 앱 자격(`channel_app_credentials`,
channel="facebook_sandbox")의 `app_id` 접미로 정한다: `:pages-0`(0개)·`:pages-1`
(1개)·접미 없음(기본 2개). 실제 authorize→callback→(필요시)select 라우터 코드
전체가 real과 완전히 동일하게 타야 하므로(그래야 셋 갈래가 전부 라이브 왕복으로
실측된다) app_id를 별도 파라미터로 안 넘기고 이 모듈이 발급하는 가짜 토큰 문자열에
그대로 실어 옮긴다(`list_pages`가 그 토큰에서 되읽는다 — app_id 자체는 비밀이 아님,
channel_app_credential.py 모델 주석 참고).

list_pages가 돌려주는 페이지 이름·id는 결정적 고정값이다(페드루 PO 明示 2026-09-06
— 라이브 판정이 이름을 대조한다)."""
from __future__ import annotations

import httpx

_PAGES_0_SUFFIX = ":pages-0"
_PAGES_1_SUFFIX = ":pages-1"
_FAKE_TOKEN_PREFIX = "sandbox-fb-user-token"


_SANDBOX_FAKE_CODE = "sandbox-oauth-code"


def build_authorize_url(*, redirect_uri: str, state: str, app_id: str) -> str:
    """story #3613(페드루 PO 確定 2026-09-07) — 원판은 `https://sandbox.local/...`
    (실존하지 않는 도메인)을 냈다 — 자체 docstring이 "브라우저가 실제로 이 URL을
    방문하지 않는다(테스트/QA가 callback을 직접 호출)"고 적어 뒀지만, /organization/
    channels의 「다시 연결」 버튼은 이 URL로 «브라우저를» 리다이렉트한다(§13-8 AC5의
    유일한 라이브 검증 경로) — 즉 실제로는 브라우저가 방문«해야»했는데 방문할 수
    없는 도메인이라 그 경로 자체가 결함이었다(결함 2, #3613이 같은 스토리에서 닫음).

    처방 — `redirect_uri`(=`_redirect_uri(org_id, channel)`, 이 채널의 콜백 URL 그
    자체)로 가짜 `code`와 real `state`를 실어 곧장 리다이렉트한다. 브라우저 관점에서
    "authorize" 리다이렉트가 즉시 "callback" 리다이렉트가 되는 셈 — real Meta 없이도
    같은 코드 경로(FE callback route → BE callback endpoint → connection 갱신)를
    전부 그대로 탄다(sandbox_publish.py "같은 코드 경로·가짜 데이터" 철학과 동일).
    `code` 값 자체는 `exchange_code_for_short_lived_token`이 검증 없이 무조건 고정
    가짜 토큰을 내므로 아무 문자열이나 무방 — `state`만 실물이어야 한다(BE가
    `CHANNEL_OAUTH_STATE_INVALID`로 검증)."""
    from urllib.parse import urlencode

    return f"{redirect_uri}?{urlencode({'code': _SANDBOX_FAKE_CODE, 'state': state})}"


async def exchange_code_for_short_lived_token(
    client: httpx.AsyncClient, *, code: str, redirect_uri: str, app_id: str, app_secret: str,
) -> tuple[str, str]:
    return f"{_FAKE_TOKEN_PREFIX}:{app_id}", ""


async def exchange_for_long_lived_token(
    client: httpx.AsyncClient, *, short_lived_token: str, app_id: str, app_secret: str,
) -> tuple[str, int]:
    # 장기 토큰에 app_id를 그대로 옮겨 싣는다 — list_pages가 이 값에서 마커를 읽는다.
    return short_lived_token, 5_184_000  # 60일(초) — facebook_oauth.py와 동형 근사.


async def list_pages(client: httpx.AsyncClient, *, user_access_token: str) -> list[dict]:
    """결정적 고정 후보(페드루 PO 明示) — 이름·id는 절대 안 바뀐다."""
    if user_access_token.endswith(_PAGES_0_SUFFIX):
        return []
    if user_access_token.endswith(_PAGES_1_SUFFIX):
        return [{"page_id": "sandbox-page-1", "name": "Sandbox Page 1", "access_token": "sandbox-page-token-1"}]
    return [
        {"page_id": "sandbox-page-1", "name": "Sandbox Page 1", "access_token": "sandbox-page-token-1"},
        {"page_id": "sandbox-page-2", "name": "Sandbox Page 2", "access_token": "sandbox-page-token-2"},
    ]
