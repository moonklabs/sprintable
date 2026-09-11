"""story #3808(Phase3·3-3 PR1, 페드루 PO 確定 2026-09-11) — X(트위터) 서버 OAuth 2.0
교환. 앱 id/secret은 호출부(channel_app_credentials.resolve_app_credentials, threads_
oauth.py와 동형 3단 우선순위)가 해석해 넘긴다.

threads_oauth.py와의 핵심 차이 — X는 PKCE가 **선택이 아니라 필수**(공개 문서 안정
사실 — code_challenge 없이 authorization_code grant 자체를 거부한다)라 `settings.
threads_pkce_enabled`류 우회 플래그가 없다. 그리고 토큰 교환이 **단일 hop**이다
(threads/facebook류의 단기→장기 2단 교환이 없음 — 이 함수가 돌려주는 access_token·
refresh_token이 그대로 최종 자격이고, 만료(대개 2시간)마다 refresh_token으로 갱신).

⚠️미확認(착수 시 재확認 필요, threads_oauth.py 상단 딱지와 동형 원칙) — 아래
엔드포인트 호스트(x.com/api.x.com, twitter.com/api.twitter.com 이관 시점 혼용 가능)·
토큰 응답 필드명은 지식 컷오프(2026-01) 기준 최선 추정이다. 실 앱 왕복 전까지
"코드는 정확한 형태로 존재하되 라이브 미검증" 상태로 남는다.

refresh_token **1회용 회전**(공개 문서 안정 사실 — OAuth 2.0 refresh token rotation,
매 갱신마다 새 refresh_token 발급·이전 값 즉시 무효)이 이 모듈의 존재 이유다 —
`refresh_access_token()`이 (new_access_token, new_refresh_token, expires_in) 3튜플을
돌려주는 게 threads_oauth.refresh_long_lived_token()의 2튜플과 다른 유일한 이유."""
from __future__ import annotations

import base64

import httpx

_AUTHORIZE_BASE = "https://x.com/i/oauth2/authorize"
_TOKEN_URL = "https://api.x.com/2/oauth2/token"
_ME_URL = "https://api.x.com/2/users/me"


class XOAuthError(Exception):
    """code→token/refresh/me 조회 실패. .code/.message가 그대로 API 에러 응답에 매핑
    (threads_oauth.ThreadsOAuthError와 동형 계약)."""

    def __init__(self, code: str, message: str):
        self.code = code
        self.message = message
        super().__init__(message)


def _basic_auth_header(app_id: str, app_secret: str) -> str:
    """X 토큰 엔드포인트는 confidential client를 HTTP Basic(RFC 6749 §2.3.1)으로
    인증한다(공개 문서 안정 사실) — client_secret을 요청 body에 평문으로 안 싣는다."""
    raw = f"{app_id}:{app_secret}".encode("utf-8")
    return f"Basic {base64.b64encode(raw).decode('ascii')}"


def build_authorize_url(*, redirect_uri: str, state: str, code_challenge: str, app_id: str) -> str:
    """PKCE 필수(threads_oauth.py와 다른 자리 — 우회 플래그 없음). `app_id`는
    threads_oauth.py와 동형 이유로 호출부가 미리 해석해 넘긴다."""
    from urllib.parse import urlencode
    from app.services.channel_adapters import CHANNEL_ADAPTERS

    cfg = CHANNEL_ADAPTERS["x"]
    params = {
        "response_type": "code",
        "client_id": app_id,
        "redirect_uri": redirect_uri,
        "scope": cfg.scope,
        "state": state,
        "code_challenge": code_challenge,
        "code_challenge_method": "S256",
    }
    return f"{cfg.authorize_url}?{urlencode(params)}"


async def exchange_code_for_token(
    client: httpx.AsyncClient, *, code: str, redirect_uri: str, code_verifier: str, app_id: str, app_secret: str,
) -> tuple[str, str, int]:
    """authorization code → (access_token, refresh_token, expires_in초). 단일 hop —
    threads/facebook류의 단기→장기 2단 교환이 X엔 없다."""
    resp = await client.post(
        _TOKEN_URL,
        data={
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": redirect_uri,
            "code_verifier": code_verifier,
            "client_id": app_id,
        },
        headers={"Authorization": _basic_auth_header(app_id, app_secret)},
    )
    if resp.status_code != 200:
        raise XOAuthError("X_TOKEN_EXCHANGE_FAILED", resp.text[:500])
    body = resp.json()
    access_token = body.get("access_token")
    refresh_token = body.get("refresh_token")
    expires_in = body.get("expires_in")
    if not access_token or not refresh_token or not expires_in:
        raise XOAuthError("X_TOKEN_EXCHANGE_MISSING_FIELDS", "access_token/refresh_token/expires_in missing")
    return access_token, refresh_token, int(expires_in)


async def refresh_access_token(
    client: httpx.AsyncClient, *, refresh_token: str, app_id: str, app_secret: str,
) -> tuple[str, str, int]:
    """refresh_mode="refresh_token" — **1회용 회전**: 이 호출이 성공하면 넘긴
    refresh_token은 즉시 무효(provider 측 폐기, 재사용 시 실패)가 되고, 반환된
    새 refresh_token으로 호출부가 저장을 갈아 끼워야 한다(3튜플 반환이 그 신호 —
    threads_oauth.refresh_long_lived_token()의 2튜플과 다른 유일한 이유)."""
    resp = await client.post(
        _TOKEN_URL,
        data={"grant_type": "refresh_token", "refresh_token": refresh_token, "client_id": app_id},
        headers={"Authorization": _basic_auth_header(app_id, app_secret)},
    )
    if resp.status_code != 200:
        raise XOAuthError("X_REFRESH_FAILED", resp.text[:500])
    body = resp.json()
    new_access_token = body.get("access_token")
    new_refresh_token = body.get("refresh_token")
    expires_in = body.get("expires_in")
    if not new_access_token or not new_refresh_token or not expires_in:
        raise XOAuthError("X_REFRESH_MISSING_FIELDS", "access_token/refresh_token/expires_in missing")
    return new_access_token, new_refresh_token, int(expires_in)


async def test_connection(client: httpx.AsyncClient, *, access_token: str) -> dict:
    """연결 시험(threads_oauth.test_connection과 동형 계약) — provider 경량 호출,
    토큰은 이 함수 밖으로 절대 안 나간다."""
    resp = await client.get(_ME_URL, headers={"Authorization": f"Bearer {access_token}"})
    if resp.status_code != 200:
        raise XOAuthError("X_TEST_CONNECTION_FAILED", resp.text[:500])
    body = resp.json().get("data", {})
    return {"id": body.get("id"), "username": body.get("username")}
