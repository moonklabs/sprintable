"""story #3806(Phase3·마케팅운영·3-2 PR1, 페드루 PO 確定 2026-09-11) — Meta Ads(광고
계정) 연결 서버 OAuth 교환 + 계정 목록 조회. `facebook_oauth.py`(story #3547)와 동형
구조 — app_id/secret은 호출부(`channel_app_credentials.py` 3단 우선순위)가 해석해
넘긴다. Facebook Login과 같은 Graph OAuth 계열이라(Marketing API도 Graph API 위에
얹힌다) authorize/token 엔드포인트는 facebook_oauth.py와 동일 base — scope만
`ads_management`로 갈린다.

⚠️미확認 딱지(facebook_oauth.py/instagram_oauth.py 상단 관례와 동형) — `/me/
adaccounts` 엔드포인트 자체(공식 문서 fetch로 정확한 URL 문자열까지는 재확認 못함,
2026-09-11)와 응답 필드 shape은 디디의 일반 Meta Marketing API 지식이다. `account_
status`/`disable_reason` 정수 enum(1=ACTIVE·2=DISABLED 등)은 공식 문서 fetch로
확認(developers.facebook.com/docs/marketing-api/reference/ad-account/, 2026-09-11).
**이 모듈은 PR1(계정 연결 자리만) 시점에 App Review(`ads_management` 권한)·Business
Verification·실 앱 자격이 전혀 없어 라이브 왕복 자체가 불가능** — 코드는 구조만
갖춘다(카드 「코드는 어댑터 자리만·자격 값 0」 그대로). 출시 前 재확認 필수.

흐름: authorize(코드 부여) → callback(단기 유저 토큰) → 단기→장기(≈60일) 유저 토큰
교환(facebook_oauth.py와 동일 `fb_exchange_token` grant) → `list_ad_accounts`
(`/me/adaccounts`)로 이 유저가 접근 가능한 광고 계정 목록을 받는다. `account_status
!= 1`(ACTIVE 아님)인 계정은 목록에서 제외하지 않고 그대로 반환 — 「계정 미인증」
류 판정은 연결 단계가 아니라 boost 요청 시점(PR2)에서 하는 것이 더 정확할 수
있으나, 카드 §5가 이 마커를 connection 플로우 마커로 명시해 여기서도 상태를 실어
둔다(`account_status`/`disable_reason` 원값 그대로 candidate dict에 포함 — FE/후속
PR이 판정)."""
from __future__ import annotations

import httpx

_AUTHORIZE_BASE = "https://www.facebook.com/v21.0/dialog/oauth"
_GRAPH_BASE = "https://graph.facebook.com/v21.0"
_TOKEN_URL = _GRAPH_BASE + "/oauth/access_token"
_AD_ACCOUNTS_URL = _GRAPH_BASE + "/me/adaccounts"


class MetaAdsOAuthError(Exception):
    """code→token/장기교환/계정목록 실패. .code/.message가 FacebookOAuthError·
    ThreadsOAuthError·InstagramOAuthError와 동형 속성(라우터가 같은 except 튜플로
    묶어 처리)."""

    def __init__(self, code: str, message: str):
        self.code = code
        self.message = message
        super().__init__(message)


def build_authorize_url(*, redirect_uri: str, state: str, app_id: str) -> str:
    from urllib.parse import urlencode
    from app.services.channel_adapters import CHANNEL_ADAPTERS

    cfg = CHANNEL_ADAPTERS["meta_ads"]
    params = {
        "client_id": app_id, "redirect_uri": redirect_uri, "scope": cfg.scope,
        "response_type": "code", "state": state,
    }
    return f"{_AUTHORIZE_BASE}?{urlencode(params)}"


async def exchange_code_for_short_lived_token(
    client: httpx.AsyncClient, *, code: str, redirect_uri: str, app_id: str, app_secret: str,
) -> tuple[str, str]:
    """authorization code → (access_token, "") — facebook_oauth.py와 동형 시그니처
    (두 번째 원소는 list_ad_accounts가 계정 식별을 대신하므로 빈 문자열)."""
    resp = await client.get(
        _TOKEN_URL,
        params={"client_id": app_id, "client_secret": app_secret, "redirect_uri": redirect_uri, "code": code},
    )
    if resp.status_code != 200:
        raise MetaAdsOAuthError("META_ADS_TOKEN_EXCHANGE_FAILED", resp.text[:500])
    body = resp.json()
    access_token = body.get("access_token")
    if not access_token:
        raise MetaAdsOAuthError("META_ADS_TOKEN_EXCHANGE_MISSING_FIELDS", "access_token missing")
    return access_token, ""


async def exchange_for_long_lived_token(
    client: httpx.AsyncClient, *, short_lived_token: str, app_id: str, app_secret: str,
) -> tuple[str, int]:
    resp = await client.get(
        _TOKEN_URL,
        params={
            "grant_type": "fb_exchange_token", "client_id": app_id, "client_secret": app_secret,
            "fb_exchange_token": short_lived_token,
        },
    )
    if resp.status_code != 200:
        raise MetaAdsOAuthError("META_ADS_LONG_LIVED_EXCHANGE_FAILED", resp.text[:500])
    body = resp.json()
    access_token = body.get("access_token")
    expires_in = body.get("expires_in")
    if not access_token or not expires_in:
        raise MetaAdsOAuthError("META_ADS_LONG_LIVED_EXCHANGE_MISSING_FIELDS", "access_token/expires_in missing")
    return access_token, int(expires_in)


async def list_ad_accounts(client: httpx.AsyncClient, *, user_access_token: str) -> list[dict]:
    """`GET /me/adaccounts` — 장기 유저 토큰으로 이 유저가 접근 가능한 광고 계정
    목록을 받는다. 반환은 `[{"account_id": str, "name": str, "account_status": int,
    "disable_reason": int}, ...]`(원본 `id`가 `act_<id>` 접두를 갖는 축과 `account_id`
    필드가 접두 없는 원본 축, 둘 중 어느 쪽인지는 ⚠️미확認 — 라이브 확認 전 접두
    유무 확定 필요). `account_status`/`disable_reason` 판정(활성/미인증/심사거부
    분류)은 이 함수가 하지 않는다 — 원값 그대로 넘기고 호출부(라우터/PR2)가 판정
    (같은 값이 다른 뜻으로 오해석되면 안 되므로 정규화는 최대한 늦게)."""
    resp = await client.get(
        _AD_ACCOUNTS_URL,
        params={"access_token": user_access_token, "fields": "account_id,name,account_status,disable_reason"},
    )
    if resp.status_code != 200:
        raise MetaAdsOAuthError("META_ADS_LIST_ACCOUNTS_FAILED", resp.text[:500])
    body = resp.json()
    entries = body.get("data")
    if entries is None:
        raise MetaAdsOAuthError("META_ADS_LIST_ACCOUNTS_MISSING_FIELD", "data missing in response")
    accounts = []
    for entry in entries:
        account_id, name = entry.get("account_id") or entry.get("id"), entry.get("name")
        if not account_id:
            continue
        accounts.append({
            "account_id": str(account_id), "name": name or str(account_id),
            "account_status": entry.get("account_status"), "disable_reason": entry.get("disable_reason"),
        })
    return accounts
