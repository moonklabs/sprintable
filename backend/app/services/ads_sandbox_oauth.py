"""story #3806(Phase3·마케팅운영·3-2 PR1, 페드루 PO 確定 2026-09-11) — Meta Ads 광고
계정 연결 sandbox. `meta_ads_oauth.py`와 정확히 같은 함수 시그니처(라우터가 채널로
모듈만 바꿔 끼우는 기존 dispatch 관례 — `facebook_sandbox_oauth.py`/`channel_
adapters.py::get_publish_client_module`과 동형 사상, 새 분기 로직 0)를 인프로세스
결정적 응답으로 구현한다(sandbox_publish.py "같은 코드 경로·가짜 데이터" 철학).
`facebook_sandbox_oauth.py`(story #3547/#3613)와 동형 — authorize가 실 Meta 도메인
대신 콜백 URL로 곧장 (code, state)를 실어 리다이렉트해, real 없이도 authorize→
callback→(필요시)select까지 전 구간이 그대로 라이브 왕복으로 실측된다.

**계정 수·상태 마커**(카드 §5 확定) — sandbox 앱 자격(`channel_app_credentials`,
channel="ads_sandbox")의 `app_id` 접미로 정한다. facebook_sandbox_oauth.py의
`:pages-0`/`:pages-1` 관례와 동형(개수 축) + 이번 스토리가 추가하는 2종(상태 축,
연결 단계에서 의미가 있는 것만 — 예산 초과·중지 지연은 boost 요청/실행이 아직
없어[PR2/PR3] 여기선 못 걺, sandbox_publish.py 카탈로그에 예약만 해 둔다):
  - `:accounts-0` — 계정 0개(422 CHANNEL_META_ADS_NO_ACCOUNTS_AVAILABLE).
  - `:accounts-1` — 계정 1개, 정상(즉시 연결).
  - `:account-unverified` — 계정 1개인데 `account_status=PENDING_RISK_REVIEW`(7,
    Meta 공식 enum) — `[sandbox:account-unverified]` 마커. 연결 자체는 되지만
    (Meta도 미인증 계정을 목록엔 보여준다) account_status가 비-ACTIVE로 옴 — 판정은
    호출부(라우터) 몫, 이 함수는 원값만 정직하게 낸다.
  - `:review-rejected` — `list_ad_accounts` 단계에서 즉시 예외(`MetaAdsOAuthError`
    코드 `META_ADS_ACCOUNT_REVIEW_REJECTED`) — 「앱 자체가 ads_management 심사에서
    거부됨」류, 개별 계정이 아니라 이 앱 자격 전체가 광고 API를 못 쓰는 상태 시뮬
    (Meta 공식 API 응답 형은 ⚠️미확認 — sandbox가 라이브에서 이 실패 모양을 먼저
    노출해 두는 것 자체가 이 마커의 존재 이유, threads_publish.py류 「미확認 딱지」
    관례와 동형).
  - 접미 없음(기본) — 계정 2개(선택 대기 경로 실측)."""
from __future__ import annotations

import httpx

from app.services.meta_ads_oauth import MetaAdsOAuthError

_ACCOUNTS_0_SUFFIX = ":accounts-0"
_ACCOUNTS_1_SUFFIX = ":accounts-1"
_ACCOUNT_UNVERIFIED_SUFFIX = ":account-unverified"
_REVIEW_REJECTED_SUFFIX = ":review-rejected"
_FAKE_TOKEN_PREFIX = "sandbox-meta-ads-user-token"

_SANDBOX_FAKE_CODE = "sandbox-oauth-code"

# Meta 공식 account_status enum(developers.facebook.com/docs/marketing-api/reference/
# ad-account/, 2026-09-11 fetch 확認) — 7=PENDING_RISK_REVIEW를 그대로 재사용(지어낸
# 값 0).
_ACCOUNT_STATUS_ACTIVE = 1
_ACCOUNT_STATUS_PENDING_RISK_REVIEW = 7


def build_authorize_url(*, redirect_uri: str, state: str, app_id: str) -> str:
    """meta_ads_oauth.py 시그니처 동형 — real Meta 없이 콜백 URL로 곧장 리다이렉트
    (facebook_sandbox_oauth.py `build_authorize_url` docstring 원칙 그대로)."""
    from urllib.parse import urlencode

    return f"{redirect_uri}?{urlencode({'code': _SANDBOX_FAKE_CODE, 'state': state})}"


async def exchange_code_for_short_lived_token(
    client: httpx.AsyncClient, *, code: str, redirect_uri: str, app_id: str, app_secret: str,
) -> tuple[str, str]:
    return f"{_FAKE_TOKEN_PREFIX}:{app_id}", ""


async def exchange_for_long_lived_token(
    client: httpx.AsyncClient, *, short_lived_token: str, app_id: str, app_secret: str,
) -> tuple[str, int]:
    # 장기 토큰에 app_id를 그대로 옮겨 싣는다 — list_ad_accounts가 이 값에서
    # 마커를 읽는다(facebook_sandbox_oauth.py와 동형).
    return short_lived_token, 5_184_000  # 60일(초).


async def list_ad_accounts(client: httpx.AsyncClient, *, user_access_token: str) -> list[dict]:
    """결정적 고정 후보 — 이름·id는 절대 안 바뀐다(facebook_sandbox_oauth.py
    `list_pages`와 동형 원칙, 라이브 판정이 이름을 대조한다)."""
    if user_access_token.endswith(_REVIEW_REJECTED_SUFFIX):
        # story #3806(BE 한글 사용자 문장 가드, #3779) — .message는 실 provider
        # 응답 텍스트를 그대로 옮기는 축(facebook_oauth.py 등 다른 *OAuthError와
        # 동형 — 로그·디버그용 영문 기술 문구)이지 사람에게 보이는 최종 문장이
        # 아니다. 사용자 문장은 라우터가 이 code를 잡을 때 i18n_catalog
        # "ads_sandbox.review_rejected"로 조립한다(캐치 지점만 locale을 안다).
        raise MetaAdsOAuthError(
            "META_ADS_ACCOUNT_REVIEW_REJECTED",
            "sandbox: [sandbox:review-rejected] marker simulation — ads_management review rejected",
        )
    if user_access_token.endswith(_ACCOUNTS_0_SUFFIX):
        return []
    if user_access_token.endswith(_ACCOUNTS_1_SUFFIX):
        return [{
            "account_id": "sandbox-ads-account-1", "name": "Sandbox Ads Account 1",
            "account_status": _ACCOUNT_STATUS_ACTIVE, "disable_reason": 0,
        }]
    if user_access_token.endswith(_ACCOUNT_UNVERIFIED_SUFFIX):
        return [{
            "account_id": "sandbox-ads-account-1", "name": "Sandbox Ads Account 1",
            "account_status": _ACCOUNT_STATUS_PENDING_RISK_REVIEW, "disable_reason": 0,
        }]
    return [
        {
            "account_id": "sandbox-ads-account-1", "name": "Sandbox Ads Account 1",
            "account_status": _ACCOUNT_STATUS_ACTIVE, "disable_reason": 0,
        },
        {
            "account_id": "sandbox-ads-account-2", "name": "Sandbox Ads Account 2",
            "account_status": _ACCOUNT_STATUS_ACTIVE, "disable_reason": 0,
        },
    ]
