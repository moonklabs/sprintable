"""story #3547(Phase2·마케팅운영, 페드루 PO 確定 2026-09-06) — Facebook Login 서버
OAuth 교환 + 페이지 목록 조회. `instagram_oauth.py`(story #3320)와 동형 구조 —
app_id/secret은 호출부(`channel_app_credentials.py`의 3단 우선순위)가 해석해 넘긴다.

⚠️미확認 딱지(instagram_oauth.py 상단 관례와 동형) — 아래 엔드포인트·응답 shape은
디디의 일반 Meta Graph API 지식이며, 이 조각 착수 시점 PO의 실 문서 재확認 대상이다
(threads_oauth.py 최초 작성 시 지식-컷오프 추정이 실제로 틀렸던 선례가 있다 — 재확認
전 라이브 왕복 금지). code_challenge(PKCE)는 안 보낸다 — 서버가 app_secret을 쥔
confidential client 흐름이라(authorize→callback 전 구간 이 백엔드가 처리) instagram_
oauth.py와 같은 판단.

흐름: authorize(코드 부여) → callback(단기 유저 토큰, 평면 응답 — Threads류와 동형,
Instagram의 `data` 배열과 다름) → 단기→장기(≈60일) 유저 토큰 교환 → `list_pages`
(`/me/accounts`)로 이 유저가 관리하는 페이지 목록+각 페이지 토큰을 받는다(페이지
토큰은 유저 토큰에서 파생돼 별도 교환 콜이 불요 — 이것도 ⚠️미확認, Meta 문서
지식)."""
from __future__ import annotations

import httpx

_AUTHORIZE_BASE = "https://www.facebook.com/v21.0/dialog/oauth"
_GRAPH_BASE = "https://graph.facebook.com/v21.0"
_TOKEN_URL = _GRAPH_BASE + "/oauth/access_token"
_ACCOUNTS_URL = _GRAPH_BASE + "/me/accounts"


class FacebookOAuthError(Exception):
    """code→token/장기교환/페이지목록 실패. .code/.message가 ThreadsOAuthError·
    InstagramOAuthError와 동형 속성(라우터가 같은 except 튜플로 묶어 처리)."""

    def __init__(self, code: str, message: str):
        self.code = code
        self.message = message
        super().__init__(message)


def build_authorize_url(*, redirect_uri: str, state: str, app_id: str) -> str:
    from urllib.parse import urlencode
    from app.services.channel_adapters import CHANNEL_ADAPTERS

    cfg = CHANNEL_ADAPTERS["facebook"]
    params = {
        "client_id": app_id, "redirect_uri": redirect_uri, "scope": cfg.scope,
        "response_type": "code", "state": state,
    }
    return f"{_AUTHORIZE_BASE}?{urlencode(params)}"


async def exchange_code_for_short_lived_token(
    client: httpx.AsyncClient, *, code: str, redirect_uri: str, app_id: str, app_secret: str,
) -> tuple[str, str]:
    """authorization code → (access_token, "") — Facebook 콜백은 IG-scoped user_id류
    필드를 안 준다(그라운딩 확認), 두 번째 원소는 threads_oauth.py/instagram_oauth.py
    와 시그니처를 맞추기 위한 빈 문자열(list_pages가 실제 계정 식별을 대신한다)."""
    resp = await client.get(
        _TOKEN_URL,
        params={
            "client_id": app_id, "client_secret": app_secret, "redirect_uri": redirect_uri, "code": code,
        },
    )
    if resp.status_code != 200:
        raise FacebookOAuthError("FACEBOOK_TOKEN_EXCHANGE_FAILED", resp.text[:500])
    body = resp.json()
    access_token = body.get("access_token")
    if not access_token:
        raise FacebookOAuthError("FACEBOOK_TOKEN_EXCHANGE_MISSING_FIELDS", "access_token missing")
    return access_token, ""


async def exchange_for_long_lived_token(
    client: httpx.AsyncClient, *, short_lived_token: str, app_id: str, app_secret: str,
) -> tuple[str, int]:
    """단기 유저 토큰 → (장기 유저 access_token, expires_in초, ≈60일). instagram_
    oauth.py와 달리 app_id가 이 호출에도 필요하다(그라운딩 확認 — fb_exchange_token
    grant는 client_id/client_secret 둘 다 요구)."""
    resp = await client.get(
        _TOKEN_URL,
        params={
            "grant_type": "fb_exchange_token", "client_id": app_id, "client_secret": app_secret,
            "fb_exchange_token": short_lived_token,
        },
    )
    if resp.status_code != 200:
        raise FacebookOAuthError("FACEBOOK_LONG_LIVED_EXCHANGE_FAILED", resp.text[:500])
    body = resp.json()
    access_token = body.get("access_token")
    expires_in = body.get("expires_in")
    if not access_token or not expires_in:
        raise FacebookOAuthError("FACEBOOK_LONG_LIVED_EXCHANGE_MISSING_FIELDS", "access_token/expires_in missing")
    return access_token, int(expires_in)


async def list_pages(client: httpx.AsyncClient, *, user_access_token: str) -> list[dict]:
    """`GET /me/accounts` — 장기 유저 토큰으로 그 유저가 관리하는 페이지 목록을 받는다.
    반환은 `[{"page_id": str, "name": str, "access_token": str}, ...]`(원본 응답의
    `id`를 `page_id`로 정규화 — 이 코드베이스 관례상 다른 축과 이름 충돌 방지, 새
    의미 추가 아님). 페이지 토큰이 이미 이 응답에 포함돼(그라운딩 ⚠️미확認) 별도
    교환 콜이 불요하다."""
    resp = await client.get(_ACCOUNTS_URL, params={"access_token": user_access_token})
    if resp.status_code != 200:
        raise FacebookOAuthError("FACEBOOK_LIST_PAGES_FAILED", resp.text[:500])
    body = resp.json()
    entries = body.get("data")
    if entries is None:
        raise FacebookOAuthError("FACEBOOK_LIST_PAGES_MISSING_FIELD", "data missing in response")
    pages = []
    for entry in entries:
        page_id, name, page_token = entry.get("id"), entry.get("name"), entry.get("access_token")
        if not page_id or not page_token:
            continue
        pages.append({"page_id": str(page_id), "name": name or str(page_id), "access_token": page_token})
    return pages
