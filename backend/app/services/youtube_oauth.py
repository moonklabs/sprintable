"""story #3815(Phase3·3-5 PR1, 페드루 PO 確定 2026-09-12) — YouTube(Google) 서버
OAuth 2.0 교환. `x_oauth.py`(threads_oauth.py 계열)와 동형 3단 우선순위로 앱 id/
secret은 호출부(channel_app_credentials.resolve_app_credentials)가 해석해 넘긴다.

x_oauth.py와의 핵심 차이 — X는 refresh_token이 **1회용 회전**(매 갱신마다 새 값
발급·이전 값 즉시 무효)인 반면, Google 표준 OAuth 2.0 refresh_token grant는
**회전하지 않는다**(공개 문서 안정 사실 — 갱신 응답엔 access_token/expires_in만
오고 refresh_token은 최초 발급값이 그대로 계속 유효, provider가 명시적으로 폐기
하지 않는 한). 그런데도 `refresh_access_token()`이 X와 같은 3튜플을 반환하는
이유는 순수 시그니처 호환 — `cron.py::_ROTATING_REFRESH_FN_BY_CHANNEL` 디스패치
계약(refresh_token 인자로 받고 (new_access, new_refresh, expires_in) 3튜플 반환)에
그대로 맞추기 위함이다(새 refresh_mode 값 발명 대신 기존 계약 재사용 — 세 번째
반환값은 항상 "넘겨받은 값을 그대로 되돌려주는 것"이지 진짜 새 자격이 아니다).

Google 표준 사실(공개 문서 안정) — authorize 요청에 `access_type=offline`+
`prompt=consent`가 둘 다 없으면, 이미 한 번 동의한 사용자의 재인증 시 refresh_token
자체가 응답에서 아예 빠진다(최초 동의 시에만 기본 발급) — 이 두 파라미터는 항상
같이 싣는다. 토큰 엔드포인트는 X(HTTP Basic)와 달리 client_id/client_secret을
POST body에 평문으로 받는다(공개 문서 안정 사실).

⚠️미확認(착수 시 재확認 필요, x_oauth.py 상단 딱지와 동형 원칙) — YouTube Data
API v3의 정확한 스코프 문자열·quota 비용표는 지식 컷오프(2026-01) 기준 최선
추정이다. 실 앱 왕복 전까지 "코드는 정확한 형태로 존재하되 라이브 미검증" 상태로
남는다."""
from __future__ import annotations

import httpx

_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth"
_TOKEN_URL = "https://oauth2.googleapis.com/token"
_CHANNELS_URL = "https://www.googleapis.com/youtube/v3/channels"


class YouTubeOAuthError(Exception):
    """code→token/refresh/channel 조회 실패. .code/.message가 그대로 API 에러 응답에
    매핑(x_oauth.XOAuthError와 동형 계약)."""

    def __init__(self, code: str, message: str):
        self.code = code
        self.message = message
        super().__init__(message)


def build_authorize_url(*, redirect_uri: str, state: str, code_challenge: str, app_id: str) -> str:
    """PKCE 사용(Google은 공개·기밀 클라이언트 둘 다 지원 — X처럼 필수도 Threads
    처럼 거부도 아니라 우회 플래그 불요). `app_id`는 x_oauth.py와 동형 이유로
    호출부가 미리 해석해 넘긴다."""
    from urllib.parse import urlencode
    from app.services.channel_adapters import CHANNEL_ADAPTERS

    cfg = CHANNEL_ADAPTERS["youtube"]
    params = {
        "response_type": "code",
        "client_id": app_id,
        "redirect_uri": redirect_uri,
        "scope": cfg.scope,
        "state": state,
        "code_challenge": code_challenge,
        "code_challenge_method": "S256",
        # 위 모듈 딱지 — 이 둘이 없으면 재인증 시 refresh_token이 응답에서 빠진다.
        "access_type": "offline",
        "prompt": "consent",
    }
    return f"{_AUTHORIZE_URL}?{urlencode(params)}"


async def exchange_code_for_token(
    client: httpx.AsyncClient, *, code: str, redirect_uri: str, code_verifier: str, app_id: str, app_secret: str,
) -> tuple[str, str, int]:
    """authorization code → (access_token, refresh_token, expires_in초). 단일 hop —
    threads/facebook류의 단기→장기 2단 교환이 Google엔 없다."""
    resp = await client.post(
        _TOKEN_URL,
        data={
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": redirect_uri,
            "code_verifier": code_verifier,
            "client_id": app_id,
            "client_secret": app_secret,
        },
    )
    if resp.status_code != 200:
        raise YouTubeOAuthError("YOUTUBE_TOKEN_EXCHANGE_FAILED", resp.text[:500])
    body = resp.json()
    access_token = body.get("access_token")
    refresh_token = body.get("refresh_token")
    expires_in = body.get("expires_in")
    if not access_token or not refresh_token or not expires_in:
        raise YouTubeOAuthError(
            "YOUTUBE_TOKEN_EXCHANGE_MISSING_FIELDS", "access_token/refresh_token/expires_in missing",
        )
    return access_token, refresh_token, int(expires_in)


async def refresh_access_token(
    client: httpx.AsyncClient, *, refresh_token: str, app_id: str, app_secret: str,
) -> tuple[str, str, int]:
    """refresh_mode="refresh_token" 재사용(모듈 상단 딱지) — Google은 회전하지
    않으므로 세 번째 반환값(new_refresh_token)은 항상 넘겨받은 `refresh_token`을
    그대로 되돌린다(호출부가 그 값을 다시 저장해도 무해 — 실제로는 아무것도 안
    바뀐 것과 같다)."""
    resp = await client.post(
        _TOKEN_URL,
        data={
            "grant_type": "refresh_token", "refresh_token": refresh_token,
            "client_id": app_id, "client_secret": app_secret,
        },
    )
    if resp.status_code != 200:
        raise YouTubeOAuthError("YOUTUBE_REFRESH_FAILED", resp.text[:500])
    body = resp.json()
    new_access_token = body.get("access_token")
    expires_in = body.get("expires_in")
    if not new_access_token or not expires_in:
        raise YouTubeOAuthError("YOUTUBE_REFRESH_MISSING_FIELDS", "access_token/expires_in missing")
    return new_access_token, refresh_token, int(expires_in)


async def test_connection(client: httpx.AsyncClient, *, access_token: str) -> dict:
    """연결 시험(x_oauth.test_connection과 동형 계약) — 인증된 Google 계정이 소유한
    YouTube 채널을 조회한다(`mine=true`). 계정에 채널이 하나도 없으면(콘텐츠
    크리에이터 등록 前) 명시 에러로 죽는다 — 「연결은 됐는데 채널이 안 보인다」는
    조용한 실패를 만들지 않는다. ⚠️미확認·갭 — 한 Google 계정이 여러 브랜드
    채널을 가진 경우 `items[0]`(첫 번째)만 쓴다(facebook 페이지류의 다중 선택
    갈래가 이 카드 범위 밖 — PR1은 X처럼 "가장 단순한 갈래 하나"만 연다)."""
    resp = await client.get(
        _CHANNELS_URL, params={"part": "snippet", "mine": "true"},
        headers={"Authorization": f"Bearer {access_token}"},
    )
    if resp.status_code != 200:
        raise YouTubeOAuthError("YOUTUBE_TEST_CONNECTION_FAILED", resp.text[:500])
    items = resp.json().get("items") or []
    if not items:
        raise YouTubeOAuthError(
            "YOUTUBE_NO_CHANNEL_FOUND", "authenticated Google account has no YouTube channel",
        )
    channel = items[0]
    return {"id": channel.get("id"), "title": (channel.get("snippet") or {}).get("title")}
