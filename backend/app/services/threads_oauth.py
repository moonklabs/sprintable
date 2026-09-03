"""story #3373(Phase1·마케팅운영) — Threads(Meta) 서버 OAuth 교환. Sprintable 공용 앱
(threads_app_id/secret) + 조직별 토큰. 기존 `plugins/sprintable/connectors/threads.ts`
(sprintable-agent-plugins, story #3311)엔 발행 API 호출만 있고 OAuth 교환 로직 자체가
없다(그라운딩 doc 6766a399 §5) — 이 파일이 신규다.

⚠️미확인(그라운딩 §9, 착수 시 재확인 필요) — 아래 엔드포인트·파라미터명은 Meta Threads API
공개 문서(지식 컷오프 2026-01) 기준 최선 추정이다. Meta가 스펙을 바꿨거나 이 구현이 틀렸으면
`test_connection()`(§ 아래) 또는 실 콜백 왕복에서 즉시 드러난다 — PO/QA가 실 Meta 앱으로
1회 왕복 검증 전에는 "코드는 정확한 형태로 존재하되 라이브 미검증" 상태로 남는다.

⚠️PKCE 수용 여부도 이 미확인에 포함된다(페드루 PO 리뷰 2026-09-03 07:26Z) — Threads가
`code_challenge`/`code_challenge_method` 쿼리 파라미터를 인식하는지 문헌상 확실치 않다.
실 왕복에서 Meta가 이 파라미터를 거부하면(예: `invalid_request`) `build_authorize_url()`의
`code_challenge`/`code_challenge_method` 두 줄만 제거하면 되도록 다른 로직과 분리해 뒀다 —
CSRF·재사용 방지는 `channel_oauth_state.py`의 HS256 서명 state(+nonce+TTL)가 PKCE와
독립적으로 이미 담당하므로, PKCE가 거부돼도 보안 축 자체는 무너지지 않는다(PKCE는 심층
방어층 하나가 빠지는 것뿐). `exchange_code_for_short_lived_token()`의 `code_verifier`
전달도 같은 이유로 이 함수 안에 격리(제거 시 파급 0).

흐름: authorize(코드 부여, PKCE) → callback(단기 토큰 교환) → 단기→장기(60일) 토큰 교환 →
(만료 임박마다) 장기 토큰 재발급(refresh_mode="reissue_from_access_token", refresh_token 불요)."""
from __future__ import annotations

import httpx

from app.core.config import settings

_AUTHORIZE_BASE = "https://threads.net/oauth/authorize"
_TOKEN_URL = "https://graph.threads.net/oauth/access_token"
_EXCHANGE_URL = "https://graph.threads.net/access_token"
_REFRESH_URL = "https://graph.threads.net/refresh_access_token"
_ME_URL = "https://graph.threads.net/v1.0/me"


class ThreadsOAuthError(Exception):
    """code→token/장기교환/갱신/me 조회 실패. .code/.message가 그대로 API 에러 응답에 매핑."""

    def __init__(self, code: str, message: str):
        self.code = code
        self.message = message
        super().__init__(message)


def build_authorize_url(*, redirect_uri: str, state: str, code_challenge: str) -> str:
    from urllib.parse import urlencode
    from app.services.channel_adapters import CHANNEL_ADAPTERS

    cfg = CHANNEL_ADAPTERS["threads"]
    params = {
        "client_id": settings.threads_app_id,
        "redirect_uri": redirect_uri,
        "scope": cfg.scope,
        "response_type": "code",
        "state": state,
        "code_challenge": code_challenge,
        "code_challenge_method": "S256",
    }
    return f"{cfg.authorize_url}?{urlencode(params)}"


async def exchange_code_for_short_lived_token(
    client: httpx.AsyncClient, *, code: str, redirect_uri: str, code_verifier: str,
) -> tuple[str, str]:
    """authorization code → (access_token, threads_user_id). 단기 토큰(~1h)."""
    resp = await client.post(
        _TOKEN_URL,
        data={
            "client_id": settings.threads_app_id,
            "client_secret": settings.threads_app_secret,
            "grant_type": "authorization_code",
            "redirect_uri": redirect_uri,
            "code": code,
            "code_verifier": code_verifier,
        },
    )
    if resp.status_code != 200:
        raise ThreadsOAuthError("THREADS_TOKEN_EXCHANGE_FAILED", resp.text[:500])
    body = resp.json()
    access_token = body.get("access_token")
    user_id = body.get("user_id")
    if not access_token or user_id is None:
        raise ThreadsOAuthError("THREADS_TOKEN_EXCHANGE_MISSING_FIELDS", "access_token/user_id missing")
    return access_token, str(user_id)


async def exchange_for_long_lived_token(
    client: httpx.AsyncClient, *, short_lived_token: str,
) -> tuple[str, int]:
    """단기 토큰 → (장기 access_token, expires_in초). 장기 토큰은 ~60일."""
    resp = await client.get(
        _EXCHANGE_URL,
        params={
            "grant_type": "th_exchange_token",
            "client_secret": settings.threads_app_secret,
            "access_token": short_lived_token,
        },
    )
    if resp.status_code != 200:
        raise ThreadsOAuthError("THREADS_LONG_LIVED_EXCHANGE_FAILED", resp.text[:500])
    body = resp.json()
    access_token = body.get("access_token")
    expires_in = body.get("expires_in")
    if not access_token or not expires_in:
        raise ThreadsOAuthError("THREADS_LONG_LIVED_EXCHANGE_MISSING_FIELDS", "access_token/expires_in missing")
    return access_token, int(expires_in)


async def refresh_long_lived_token(client: httpx.AsyncClient, *, current_token: str) -> tuple[str, int]:
    """refresh_mode="reissue_from_access_token" — 현재 유효한 장기 토큰으로 새 장기 토큰을
    재발급한다(refresh_token 불요, Meta 요건상 발급 후 24h 이상 지난 토큰만 대상)."""
    resp = await client.get(
        _REFRESH_URL,
        params={"grant_type": "th_refresh_token", "access_token": current_token},
    )
    if resp.status_code != 200:
        raise ThreadsOAuthError("THREADS_REFRESH_FAILED", resp.text[:500])
    body = resp.json()
    access_token = body.get("access_token")
    expires_in = body.get("expires_in")
    if not access_token or not expires_in:
        raise ThreadsOAuthError("THREADS_REFRESH_MISSING_FIELDS", "access_token/expires_in missing")
    return access_token, int(expires_in)


async def test_connection(client: httpx.AsyncClient, *, access_token: str) -> dict:
    """연결 시험(유나 화면설계 §8④) — provider 경량 호출, 토큰은 이 함수 밖으로 절대 안 나간다
    (호출부는 이 반환값만 쓰고 access_token 변수를 더 들고 있지 않는다)."""
    resp = await client.get(_ME_URL, params={"fields": "id,username", "access_token": access_token})
    if resp.status_code != 200:
        raise ThreadsOAuthError("THREADS_TEST_CONNECTION_FAILED", resp.text[:500])
    body = resp.json()
    return {"id": body.get("id"), "username": body.get("username")}
