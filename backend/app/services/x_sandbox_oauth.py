"""story #3808(Phase3·3-3 PR1, 페드루 PO 確定 2026-09-11) — X 연결 sandbox.
`x_oauth.py`와 정확히 같은 함수 시그니처(라우터가 채널로 모듈만 바꿔 끼우는 기존
dispatch 관례 — `ads_sandbox_oauth.py`/`channel_adapters.py::get_publish_client_
module`과 동형 사상, 새 분기 로직 0)를 인프로세스 결정적 응답으로 구현한다.
`ads_sandbox_oauth.py`와 동형 — authorize가 실 X 도메인 대신 콜백 URL로 곧장
(code, state)를 실어 리다이렉트해, real 없이도 authorize→callback 전 구간이 그대로
라이브 왕복으로 실측된다.

**1회용 회전 마커**(카드 AC1 「회전 후 옛 refresh로 재발급 시 실패 마커」) — refresh_
token 문자열 자체에 회전 세대(generation)를 실어 나른다(`sandbox-x-refresh:{app_id}:
g{n}`). `refresh_access_token()`은 세대를 1 올린 새 refresh_token을 결정적으로
반환한다 — "옛 세대 재사용"은 **호출부(테스트)가 이전에 받은 문자열을 그대로 다시
넘기는 것 자체**로 재현한다(실 provider가 서버측에 "마지막 발급 세대"를 기억해 거부
하는 것과 같은 관측을 순수 함수로 낸다: `_MARKER_STALE_GENERATION`가 박힌 refresh_
token — 세대 번호가 0 이하로 내려가면[음수 접미] 회전-후-재사용 실패를 결정적으로
낸다). facebook_sandbox_oauth.py `_MARKER_EXPIRED_TOKEN`류와 동형 명명 관례."""
from __future__ import annotations

import re
import uuid

import httpx

from app.services.x_oauth import XOAuthError

_ACCESS_PREFIX = "sandbox-x-access"
_REFRESH_PREFIX = "sandbox-x-refresh"
_SANDBOX_FAKE_CODE = "sandbox-oauth-code"

_GENERATION_RE = re.compile(r":g(-?\d+)$")


def build_authorize_url(*, redirect_uri: str, state: str, code_challenge: str, app_id: str) -> str:
    """x_oauth.py 시그니처 동형 — real X 없이 콜백 URL로 곧장 리다이렉트
    (ads_sandbox_oauth.py `build_authorize_url` 원칙 그대로, code_challenge는
    시그니처만 맞추고 sandbox 왕복엔 안 쓴다)."""
    from urllib.parse import urlencode

    return f"{redirect_uri}?{urlencode({'code': _SANDBOX_FAKE_CODE, 'state': state})}"


async def exchange_code_for_token(
    client: httpx.AsyncClient, *, code: str, redirect_uri: str, code_verifier: str, app_id: str, app_secret: str,
) -> tuple[str, str, int]:
    """세대 0에서 시작 — `refresh_access_token()`이 이 세대를 1씩 올린다."""
    return f"{_ACCESS_PREFIX}:{app_id}", f"{_REFRESH_PREFIX}:{app_id}:g0", 7200


async def refresh_access_token(
    client: httpx.AsyncClient, *, refresh_token: str, app_id: str, app_secret: str,
) -> tuple[str, str, int]:
    """1회용 회전 결정적 시뮬레이션 — 넘긴 refresh_token의 세대를 파싱해 +1한 새
    refresh_token을 낸다. 세대 파싱이 실패하거나(형식 오염) `_MARKER_STALE_
    GENERATION`(음수 세대)이면 "옛 세대 재사용" 실패를 낸다 — 실 X가 이미 회전된
    refresh_token 재사용을 거부하는 것과 같은 관측(사용자 문장은 호출부 몫,
    ads_sandbox_oauth.py MetaAdsOAuthError.message 관례와 동형 — 이 .message는
    provider 원문 축)."""
    match = _GENERATION_RE.search(refresh_token)
    if match is None or int(match.group(1)) < 0:
        raise XOAuthError(
            "X_REFRESH_TOKEN_REUSED",
            "sandbox: [sandbox:refresh-token-reused] marker simulation — rotated refresh_token reused",
        )
    generation = int(match.group(1))
    new_refresh_token = f"{_REFRESH_PREFIX}:{app_id}:g{generation + 1}:{uuid.uuid4().hex[:8]}"
    new_access_token = f"{_ACCESS_PREFIX}:{app_id}:{uuid.uuid4().hex[:8]}"
    return new_access_token, new_refresh_token, 7200


async def test_connection(client: httpx.AsyncClient, *, access_token: str) -> dict:
    """결정적 고정 값(ads_sandbox_oauth.py list_ad_accounts와 동형 원칙 — 이름·id는
    절대 안 바뀐다, 라이브 판정이 이 값을 대조한다)."""
    return {"id": "sandbox-x-user-1", "username": "sandbox_x_user"}
