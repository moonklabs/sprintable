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


def build_authorize_url(*, redirect_uri: str, state: str, app_id: str) -> str:
    """sandbox는 실제로 이 URL을 브라우저가 방문하지 않는다(테스트/QA가 callback을
    직접 호출) — 값 자체는 authorize 응답 계약(AuthorizeResponse.url)을 채우기
    위한 자리표시자."""
    return f"https://sandbox.local/facebook-oauth?state={state}"


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
