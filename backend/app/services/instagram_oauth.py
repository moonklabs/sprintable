"""story #3320(Phase2·마케팅운영, 페드루 PO 確定 2026-09-05) — Instagram Login(Business
Login for Instagram) 서버 OAuth 교환. `threads_oauth.py`(story #3373)와 동형 구조 —
app_id/secret은 호출부(`channel_app_credentials.py`의 3단 우선순위)가 해석해 넘긴다.

엔드포인트·스코프·「Facebook Page 연결 불요」는 페드루 PO가 2026-09-06 Meta 공식 문서
(developers.facebook.com)로 직접 재확認한 값 — threads_oauth.py처럼 지식 컷오프 추정이
아니다(다만 실 계정 왕복 검증은 아직, App Review 뒤 — sandbox까지가 이 조각 라이브
범위, 그라운딩 결과 3320 스토리 코멘트 참고).

⚠️미확認 딱지 — PKCE: Meta 문서에 `code_challenge`/`code_challenge_method` 언급이
없어(페드루 재확認 2026-09-06) 이 구현은 PKCE를 아예 안 보낸다. threads_oauth.py의
토글 플래그 패턴과 다른 이유 — 그쪽은 문헌이 불확실해 플래그로 즉시 되돌릴 여지를
남겼지만, 여기는 문헌이 이미 "미언급=미지원"쪽으로 명확해 코드 자체를 단순화했다.
CSRF·재사용 방지는 `channel_oauth_state.py`의 state 서명이 PKCE 유무와 무관하게
이미 담당(threads와 동일 축).

흐름: authorize(코드 부여, PKCE 없음) → callback(단기 토큰+IG-scoped user_id, "data"
배열 응답 — Threads의 평면 응답과 다른 shape, 그라운딩·PO 재확認 둘 다 반영) → 단기→
장기(60일) 토큰 교환(`ig_exchange_token`) → (만료 임박마다) 장기 토큰 재발급
(`ig_refresh_token`, refresh_mode="reissue_from_access_token" — threads와 동형)."""
from __future__ import annotations

import httpx

_AUTHORIZE_BASE = "https://www.instagram.com/oauth/authorize"
_TOKEN_URL = "https://api.instagram.com/oauth/access_token"
# 장기토큰 교환/갱신은 페드루 PO가 2026-09-06 재확認한 그대로 버전 세그먼트가
# 없는 전용 엔드포인트(일반 Graph API 호출과 다름) — 바꾸지 않는다.
_EXCHANGE_URL = "https://graph.instagram.com/access_token"
_REFRESH_URL = "https://graph.instagram.com/refresh_access_token"
# story #3320 — 페드루 PO REQUIRED(2026-09-06, #3872 PASS 철회) — /me는 일반
# Graph API 호출이라 instagram_publish.py::_GRAPH_BASE와 같은 버전 호스트로
# 통일(위 두 전용 엔드포인트와는 다른 축).
_GRAPH_BASE = "https://graph.instagram.com/v25.0"
_ME_URL = _GRAPH_BASE + "/me"


class InstagramOAuthError(Exception):
    """code→token/장기교환/갱신/me 조회 실패. .code/.message가 그대로 API 에러 응답에
    매핑(ThreadsOAuthError와 동형 속성 — 라우터가 두 예외를 같은 except 튜플로 묶어
    처리할 수 있게, 새 에러 매핑 로직 0)."""

    def __init__(self, code: str, message: str):
        self.code = code
        self.message = message
        super().__init__(message)


def build_authorize_url(*, redirect_uri: str, state: str, app_id: str) -> str:
    """PKCE 없음(위 미확認 딱지 참고) — `app_id`는 threads_oauth.py와 동형 이유로
    호출부가 해석해 넘긴다(이 함수는 조직 등록/플랫폼 공용 앱 3단 우선순위를 모른다)."""
    from urllib.parse import urlencode
    from app.services.channel_adapters import CHANNEL_ADAPTERS

    cfg = CHANNEL_ADAPTERS["instagram"]
    params = {
        "client_id": app_id, "redirect_uri": redirect_uri, "scope": cfg.scope,
        "response_type": "code", "state": state,
    }
    return f"{_AUTHORIZE_BASE}?{urlencode(params)}"


async def exchange_code_for_short_lived_token(
    client: httpx.AsyncClient, *, code: str, redirect_uri: str, app_id: str, app_secret: str,
) -> tuple[str, str]:
    """authorization code → (access_token, ig_scoped_user_id). 단기 토큰. 응답이
    `{"data": [{"access_token": ..., "user_id": ...}]}` 형태(Instagram Login 특유의
    data 배열 — threads_oauth.py의 평면 `{"access_token":...,"user_id":...}`와 다름,
    페드루 재확認 2026-09-06)라 배열이 오면 첫 원소를, 혹시 평면으로 오면 그대로
    읽는다(양쪽 다 대응 — 문서·실 왕복 사이 사소한 shape 드리프트에 방어적)."""
    data = {
        "client_id": app_id, "client_secret": app_secret, "grant_type": "authorization_code",
        "redirect_uri": redirect_uri, "code": code,
    }
    resp = await client.post(_TOKEN_URL, data=data)
    if resp.status_code != 200:
        raise InstagramOAuthError("INSTAGRAM_TOKEN_EXCHANGE_FAILED", resp.text[:500])
    body = resp.json()
    entries = body.get("data")
    entry = entries[0] if isinstance(entries, list) and entries else body
    access_token = entry.get("access_token")
    user_id = entry.get("user_id")
    if not access_token or user_id is None:
        raise InstagramOAuthError("INSTAGRAM_TOKEN_EXCHANGE_MISSING_FIELDS", "access_token/user_id missing")
    return access_token, str(user_id)


async def exchange_for_long_lived_token(
    client: httpx.AsyncClient, *, short_lived_token: str, app_secret: str,
) -> tuple[str, int]:
    """단기 토큰 → (장기 access_token, expires_in초). 장기 토큰은 ~60일."""
    resp = await client.get(
        _EXCHANGE_URL,
        params={"grant_type": "ig_exchange_token", "client_secret": app_secret, "access_token": short_lived_token},
    )
    if resp.status_code != 200:
        raise InstagramOAuthError("INSTAGRAM_LONG_LIVED_EXCHANGE_FAILED", resp.text[:500])
    body = resp.json()
    access_token = body.get("access_token")
    expires_in = body.get("expires_in")
    if not access_token or not expires_in:
        raise InstagramOAuthError("INSTAGRAM_LONG_LIVED_EXCHANGE_MISSING_FIELDS", "access_token/expires_in missing")
    return access_token, int(expires_in)


async def refresh_long_lived_token(client: httpx.AsyncClient, *, current_token: str) -> tuple[str, int]:
    """refresh_mode="reissue_from_access_token" — 현재 유효한 장기 토큰으로 새 장기
    토큰을 재발급한다(refresh_token 불요, threads와 동형)."""
    resp = await client.get(_REFRESH_URL, params={"grant_type": "ig_refresh_token", "access_token": current_token})
    if resp.status_code != 200:
        raise InstagramOAuthError("INSTAGRAM_REFRESH_FAILED", resp.text[:500])
    body = resp.json()
    access_token = body.get("access_token")
    expires_in = body.get("expires_in")
    if not access_token or not expires_in:
        raise InstagramOAuthError("INSTAGRAM_REFRESH_MISSING_FIELDS", "access_token/expires_in missing")
    return access_token, int(expires_in)


async def test_connection(client: httpx.AsyncClient, *, access_token: str) -> dict:
    """연결 시험 — provider 경량 호출, 토큰은 이 함수 밖으로 절대 안 나간다(threads_
    oauth.py와 동형 규율)."""
    resp = await client.get(_ME_URL, params={"fields": "id,username", "access_token": access_token})
    if resp.status_code != 200:
        raise InstagramOAuthError("INSTAGRAM_TEST_CONNECTION_FAILED", resp.text[:500])
    body = resp.json()
    return {"id": body.get("id"), "username": body.get("username")}
