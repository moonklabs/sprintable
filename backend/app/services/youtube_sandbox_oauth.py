"""story #3815(Phase3·3-5 PR1, 페드루 PO 確定 2026-09-12) — YouTube 연결 sandbox.
`youtube_oauth.py`와 정확히 같은 함수 시그니처(라우터가 채널로 모듈만 바꿔 끼우는
기존 dispatch 관례 — `x_sandbox_oauth.py`/`channel_adapters.py::get_publish_client_
module`과 동형 사상, 새 분기 로직 0)를 인프로세스 결정적 응답으로 구현한다.
authorize가 실 Google 도메인 대신 콜백 URL로 곧장 (code, state)를 실어 리다이렉트해,
real 없이도 authorize→callback 전 구간이 그대로 라이브 왕복으로 실측된다(x_sandbox_
oauth.py와 동형 원칙).

x_sandbox_oauth.py와 다른 자리 — YouTube 표준 refresh는 **회전하지 않는다**
(youtube_oauth.py 상단 딱지) 라 회전-세대 마커 시뮬레이션이 없다. `refresh_access_
token()`은 그냥 새 access_token만 결정적으로 내고 refresh_token은 넘겨받은 값을
그대로 되돌린다 — 실 provider 관측과 정확히 같은 모양."""
from __future__ import annotations

import uuid

import httpx

_ACCESS_PREFIX = "sandbox-youtube-access"
_REFRESH_PREFIX = "sandbox-youtube-refresh"
_SANDBOX_FAKE_CODE = "sandbox-oauth-code"


def build_authorize_url(*, redirect_uri: str, state: str, code_challenge: str, app_id: str) -> str:
    """youtube_oauth.py 시그니처 동형 — real Google 없이 콜백 URL로 곧장 리다이렉트
    (x_sandbox_oauth.py 원칙 그대로, code_challenge는 시그니처만 맞추고 sandbox
    왕복엔 안 쓴다)."""
    from urllib.parse import urlencode

    return f"{redirect_uri}?{urlencode({'code': _SANDBOX_FAKE_CODE, 'state': state})}"


async def exchange_code_for_token(
    client: httpx.AsyncClient, *, code: str, redirect_uri: str, code_verifier: str, app_id: str, app_secret: str,
) -> tuple[str, str, int]:
    return f"{_ACCESS_PREFIX}:{app_id}", f"{_REFRESH_PREFIX}:{app_id}", 3600


async def refresh_access_token(
    client: httpx.AsyncClient, *, refresh_token: str, app_id: str, app_secret: str,
) -> tuple[str, str, int]:
    """회전 없음 결정적 시뮬레이션 — 새 access_token만 내고 `refresh_token`은
    넘겨받은 값 그대로 되돌린다(youtube_oauth.refresh_access_token과 같은 계약,
    x_sandbox_oauth.py의 세대-회전 마커 대상 아님)."""
    new_access_token = f"{_ACCESS_PREFIX}:{app_id}:{uuid.uuid4().hex[:8]}"
    return new_access_token, refresh_token, 3600


async def test_connection(client: httpx.AsyncClient, *, access_token: str) -> dict:
    """결정적 고정 값(x_sandbox_oauth.test_connection과 동형 원칙 — 이름·id는
    절대 안 바뀐다, 라이브 판정이 이 값을 대조한다)."""
    return {"id": "sandbox-youtube-channel-1", "title": "Sandbox YouTube Channel"}
