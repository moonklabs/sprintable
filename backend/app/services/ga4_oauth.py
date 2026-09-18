"""story #3583-BE(Phase2·마케팅운영, 페드루 PO 確定 2026-09-06) — GA4 «고객 소유»
측정 연결 OAuth(analytics.readonly) + Admin API(속성 목록). 로그인용 Google
OAuth 클라이언트(`settings.google_client_id`/`google_client_secret`, auth.py
`_OAUTH_CONFIGS["google"]`)를 그대로 재사용하되(PO 確定, 새 클라이언트 등록 0)
스코프·redirect_uri·플로우는 로그인과 완전히 분리한 별도 왕복이다(로그인
콜백을 이 스코프가 오염시키지 않는다).

⚠️미확認 표기 없음 — Google OAuth2/Admin API v1beta는 공개 문서로 확정된
엔드포인트·필드명(이 코드베이스의 Threads/Instagram/Facebook 그라운딩과 달리
Meta 사설 API 추정이 아니라 Google 표준 OAuth2 + 문서화된 REST API).

이 코드베이스 기존 관례(threads_oauth.py/facebook_oauth.py) 그대로 — SDK 대신
httpx 직접 호출(신규 의존성 0), 예외는 `.code`/`.message` 속성 하나로 통일."""
from __future__ import annotations

import httpx

_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth"
_TOKEN_URL = "https://oauth2.googleapis.com/token"
_REVOKE_URL = "https://oauth2.googleapis.com/revoke"
_ACCOUNT_SUMMARIES_URL = "https://analyticsadmin.googleapis.com/v1beta/accountSummaries"

GA4_READONLY_SCOPE = "https://www.googleapis.com/auth/analytics.readonly"


class GA4OAuthError(Exception):
    """code→token/refresh/revoke/속성목록 실패. `.code`는 이 모듈이 붙이는
    분류 문자열(GA4_TOKEN_EXCHANGE_FAILED 등) — 라우터의 except 처리 축.
    `.google_error`는 Google이 준 원본 `error` 필드(예: "invalid_grant") —
    호출부(콜백/refresh 경로)가 needs_reauth 사유(revoked/expired/error)를
    가르는 유일한 근거(페드루 明示 — 사람이 고쳐야 풀리는 것만 승격, 429/5xx/
    네트워크는 이 필드가 없거나 무관한 값이라 그 회차 «미제공»으로만 처리)."""

    def __init__(self, code: str, message: str, *, google_error: str | None = None, status_code: int | None = None):
        self.code = code
        self.message = message
        self.google_error = google_error
        self.status_code = status_code
        super().__init__(message)


def build_authorize_url(*, redirect_uri: str, state: str, client_id: str) -> str:
    """덧붙임(a, 페드루 明示 2026-09-06) — `access_type=offline`+`prompt=consent`가
    없으면 최초 왕복에서 refresh_token이 안 온다(Google은 사용자당 클라이언트당
    최초 동의 시에만 refresh_token을 준다 — 재동의 없는 재인증 시도는 access_token
    뿐이라 이게 없으면 1시간 뒤 전부 needs_reauth가 된다). AC로 고정."""
    from urllib.parse import urlencode

    params = {
        "client_id": client_id, "redirect_uri": redirect_uri, "response_type": "code",
        "scope": GA4_READONLY_SCOPE, "access_type": "offline", "prompt": "consent", "state": state,
    }
    return f"{_AUTHORIZE_URL}?{urlencode(params)}"


async def exchange_code_for_tokens(
    client: httpx.AsyncClient, *, code: str, redirect_uri: str, client_id: str, client_secret: str,
) -> tuple[str, str, int]:
    """authorization code → (access_token, refresh_token, expires_in초). refresh_
    token이 응답에 없으면(재동의 누락·prompt=consent 안 실린 재시도 등) 즉시
    실패 — «있는데 저장을 안 함»이 아니라 «애초에 안 왔다»를 정직하게 드러낸다."""
    resp = await client.post(
        _TOKEN_URL,
        data={
            "code": code, "client_id": client_id, "client_secret": client_secret,
            "redirect_uri": redirect_uri, "grant_type": "authorization_code",
        },
    )
    body = resp.json() if resp.headers.get("content-type", "").startswith("application/json") else {}
    if resp.status_code != 200:
        raise GA4OAuthError(
            "GA4_TOKEN_EXCHANGE_FAILED", resp.text[:500],
            google_error=body.get("error"), status_code=resp.status_code,
        )
    access_token, refresh_token, expires_in = body.get("access_token"), body.get("refresh_token"), body.get("expires_in")
    if not access_token or not expires_in:
        raise GA4OAuthError("GA4_TOKEN_EXCHANGE_MISSING_FIELDS", "access_token/expires_in missing")
    if not refresh_token:
        raise GA4OAuthError(
            "GA4_TOKEN_EXCHANGE_NO_REFRESH_TOKEN",
            "refresh_token이 응답에 없습니다 — Google 계정 설정에서 이 앱 권한을 해제한 뒤 다시 연결해 주세요"
            "(access_type=offline+prompt=consent 재동의 필요).",
        )
    return access_token, refresh_token, int(expires_in)


async def refresh_access_token(
    client: httpx.AsyncClient, *, refresh_token: str, client_id: str, client_secret: str,
) -> tuple[str, int]:
    """refresh_token → (새 access_token, expires_in초). refresh_token 자체는 이
    호출로 갱신되지 않는다(Google 표준 동작 — 응답에 refresh_token이 다시 안
    와도 기존 저장값을 계속 쓴다). 실패 시 `.google_error`에 Google의 `error`
    필드(주로 "invalid_grant"=폐기/만료)를 그대로 실어 호출부가 needs_reauth
    사유를 가른다."""
    resp = await client.post(
        _TOKEN_URL,
        data={
            "refresh_token": refresh_token, "client_id": client_id, "client_secret": client_secret,
            "grant_type": "refresh_token",
        },
    )
    body = resp.json() if resp.headers.get("content-type", "").startswith("application/json") else {}
    if resp.status_code != 200:
        raise GA4OAuthError(
            "GA4_TOKEN_REFRESH_FAILED", resp.text[:500],
            google_error=body.get("error"), status_code=resp.status_code,
        )
    access_token, expires_in = body.get("access_token"), body.get("expires_in")
    if not access_token or not expires_in:
        raise GA4OAuthError("GA4_TOKEN_REFRESH_MISSING_FIELDS", "access_token/expires_in missing")
    return access_token, int(expires_in)


async def revoke_token(client: httpx.AsyncClient, *, token: str) -> None:
    """덧붙임(b) — DELETE 처리의 «토큰 폐기» 축. Google이 더는 이 토큰을 인정
    안 하게 만든다(단순 DB 삭제만으론 토큰 자체는 Google 쪽에 살아있다 — 진짜
    폐기는 이 호출). 실패해도(이미 폐기됐거나 네트워크 문제) 호출부의 행 삭제
    자체는 막지 않는다 — 우리 쪽 연결 해제가 Google의 응답 여부에 인질 잡히면
    안 된다(로그만 남기고 계속 진행이 호출부 책임)."""
    resp = await client.post(_REVOKE_URL, params={"token": token})
    if resp.status_code != 200:
        raise GA4OAuthError("GA4_TOKEN_REVOKE_FAILED", resp.text[:500], status_code=resp.status_code)


async def list_properties(client: httpx.AsyncClient, *, access_token: str) -> list[dict]:
    """GA4 Admin API `GET /v1beta/accountSummaries` — 이 계정이 접근 가능한 모든
    GA4 계정의 속성을 한 번에 받는다(계정별로 따로 조회 불요). 반환은
    `[{"property_id": str, "display_name": str}, ...]`(원본의 "properties/{id}"
    형 리소스명에서 숫자 id만 뽑는다 — 이 코드베이스가 이미 다른 채널에서 쓰는
    "원본 id 정규화" 관례와 동형)."""
    resp = await client.get(
        _ACCOUNT_SUMMARIES_URL, headers={"Authorization": f"Bearer {access_token}"},
    )
    if resp.status_code != 200:
        raise GA4OAuthError("GA4_LIST_PROPERTIES_FAILED", resp.text[:500], status_code=resp.status_code)
    body = resp.json()
    properties: list[dict] = []
    for account in body.get("accountSummaries") or []:
        for prop in account.get("propertySummaries") or []:
            resource_name = prop.get("property") or ""
            property_id = resource_name.rsplit("/", 1)[-1] if resource_name else None
            if not property_id:
                continue
            properties.append({
                "property_id": property_id,
                "display_name": prop.get("displayName") or property_id,
            })
    return properties


# 덧붙임(c, 페드루 明示 2026-09-06) — "사람이 고쳐야 풀리는 것만 연결 상태(needs_
# reauth)로 승격한다". 판정은 이 두 함수가 유일한 근거(라우터의 대화형 경로·
# insight_snapshots.py의 백그라운드 inflow 경로 둘 다 이걸 공유 — 판정 로직 중복 0).
# 이 튜플이 「지속 실패」의 전부다 — 여기 없는 값(429·5xx·None 포함)은 전부 일시적
# 취급(allowlist 방식 — 새 지속 실패 코드가 생기면 여기 추가하는 쪽이, "제외 목록"을
# 유지하며 무엇을 빠뜨렸는지 계속 걱정하는 쪽보다 안전하다).
_PERSISTENT_STATUS_CODES = (400, 401, 403)


def is_persistent_ga4_auth_failure(exc: GA4OAuthError) -> bool:
    """True=사람이 다시 연결해야 풀림(needs_reauth 승격 대상) — 401/403/400(invalid_
    grant 등 Google이 명시 거부). False=일시적(429·5xx·네트워크 미도달·status_code
    없음) — 이번 회차만 «미제공»으로 넘기고 연결 상태는 그대로 둔다(과잉 승격 방지)."""
    return exc.status_code in _PERSISTENT_STATUS_CODES


def classify_ga4_reauth_reason(exc: GA4OAuthError) -> str:
    """`is_persistent_ga4_auth_failure(exc)`가 True일 때만 호출 — 'expired'|
    'revoked'|'error'(ConnectionRow ReauthNote 값 집합 재사용, 계약 보강 5) 중
    하나. invalid_grant(Google이 refresh_token을 더는 인정 안 함 — 폐기·회전
    등)만 명시 'revoked'로 가른다(페드루 明示) — 403(권한/스코프 상실)은 'error'
    · 그 외 지속 실패(400인데 invalid_grant가 아닌 경우 등)는 'expired'로
    폴백한다."""
    if exc.google_error == "invalid_grant":
        return "revoked"
    if exc.status_code == 403:
        return "error"
    return "expired"
