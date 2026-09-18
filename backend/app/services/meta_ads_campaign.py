"""story #3806(Phase3·3-2 PR3 워커 fix, 페드루 PO 確定 2026-09-11) — 승인된 boost를
실제 Meta 캠페인으로 만들고 일시정지/재개하는 Marketing API 왕복.

⚠️미확認 딱지(meta_ads_oauth.py 상단 관례와 동형) — 이 모듈도 **App Review
(`ads_management`)·Business Verification·실 앱 자격이 전혀 없어 라이브 왕복 자체가
불가능**(카드 「코드는 어댑터 자리만·자격 값 0」). 아래 엔드포인트 경로·필드명은
Meta Marketing API 공식 문서 일반 지식이나 공식 문서 fetch로 재확認은 못함(2026-09-11)
— 출시 前 재확認 필수. `object_story_id` 기반 「Page post ad」(PR 2 그라운딩 ⑤ 확認,
WebFetch로 그 메커니즘 자체는 확認됨) 생성이 표준 3계층(campaign→adset→ad)임은
Marketing API 문서 구조상 변하지 않는 사실.

흐름: campaign 생성(objective) → adset 생성(daily/lifetime budget·schedule·
targeting) → ad 생성(creative={object_story_id}) → 상태 전환은 이 3개 객체 중
campaign의 `status` 필드(ACTIVE|PAUSED)만 바꾸면 계층 전체가 따라간다(Meta
표준 동작 — adset/ad 개별 상태를 안 건드려도 campaign이 PAUSED면 하위 전체가
집행 중지된다)."""
from __future__ import annotations

import httpx

_GRAPH_BASE = "https://graph.facebook.com/v21.0"


class MetaAdsCampaignError(Exception):
    """meta_ads_oauth.py::MetaAdsOAuthError와 동형 — .code/.message 속성."""

    def __init__(self, code: str, message: str):
        self.code = code
        self.message = message
        super().__init__(message)


async def create_boost_campaign(
    client: httpx.AsyncClient, *, ad_account_id: str, access_token: str, object_story_id: str,
    budget_minor: int, currency: str, starts_at_iso: str, ends_at_iso: str, objective: str,
) -> dict:
    """반환 {"campaign_id","adset_id","ad_id"}(전부 str). 3단계 순차 생성 — 앞 단계가
    실패하면 뒤 단계를 아예 안 부른다(부분 생성 상태로 남기지 않음, 실패 시 이미 만든
    객체 롤백은 워커 재시도가 아니라 사람의 재승인 흐름에 맡긴다 — publish_channel_
    post_draft류 "이미 만든 걸 지우려 하지 않는다" 관례와 동형)."""
    campaign_resp = await client.post(
        f"{_GRAPH_BASE}/act_{ad_account_id}/campaigns",
        params={
            "access_token": access_token, "name": f"Boost {object_story_id}",
            "objective": objective, "status": "PAUSED", "special_ad_categories": "[]",
        },
    )
    if campaign_resp.status_code != 200:
        raise MetaAdsCampaignError("META_ADS_CAMPAIGN_CREATE_FAILED", campaign_resp.text[:500])
    campaign_id = campaign_resp.json().get("id")
    if not campaign_id:
        raise MetaAdsCampaignError("META_ADS_CAMPAIGN_CREATE_MISSING_FIELD", "id missing")

    adset_resp = await client.post(
        f"{_GRAPH_BASE}/act_{ad_account_id}/adsets",
        params={
            "access_token": access_token, "name": f"Boost adset {object_story_id}",
            "campaign_id": campaign_id, "daily_budget": budget_minor, "billing_event": "IMPRESSIONS",
            "optimization_goal": "REACH", "start_time": starts_at_iso, "end_time": ends_at_iso,
            "status": "PAUSED",
        },
    )
    if adset_resp.status_code != 200:
        raise MetaAdsCampaignError("META_ADS_ADSET_CREATE_FAILED", adset_resp.text[:500])
    adset_id = adset_resp.json().get("id")
    if not adset_id:
        raise MetaAdsCampaignError("META_ADS_ADSET_CREATE_MISSING_FIELD", "id missing")

    ad_resp = await client.post(
        f"{_GRAPH_BASE}/act_{ad_account_id}/ads",
        params={
            "access_token": access_token, "name": f"Boost ad {object_story_id}", "adset_id": adset_id,
            "creative": f'{{"object_story_id":"{object_story_id}"}}', "status": "PAUSED",
        },
    )
    if ad_resp.status_code != 200:
        raise MetaAdsCampaignError("META_ADS_AD_CREATE_FAILED", ad_resp.text[:500])
    ad_id = ad_resp.json().get("id")
    if not ad_id:
        raise MetaAdsCampaignError("META_ADS_AD_CREATE_MISSING_FIELD", "id missing")

    return {"campaign_id": str(campaign_id), "adset_id": str(adset_id), "ad_id": str(ad_id)}


async def set_campaign_status(
    client: httpx.AsyncClient, *, campaign_id: str, access_token: str, status: str,
) -> None:
    """status ∈ {"ACTIVE","PAUSED"}. boost_start도 이 함수를 재사용(campaign을
    PAUSED로 만든 뒤 ACTIVE로 전환 — 생성 직후 바로 ACTIVE로 만들지 않는 이유는
    `create_boost_campaign`이 3단계 중 일부만 성공한 상태로 광고가 집행되는 걸
    막기 위해서다, 위 함수 docstring과 같은 판단)."""
    resp = await client.post(
        f"{_GRAPH_BASE}/{campaign_id}", params={"access_token": access_token, "status": status},
    )
    if resp.status_code != 200:
        raise MetaAdsCampaignError("META_ADS_CAMPAIGN_STATUS_UPDATE_FAILED", resp.text[:500])


async def get_campaign_spend_minor(
    client: httpx.AsyncClient, *, campaign_id: str, access_token: str,
) -> int:
    """story #3806(Phase3·3-2 PR4, 페드루 PO 確定 2026-09-11) — 캠페인 누적 지출(그
    캠페인 전체 lifetime, `date_preset` 미지정 시 Meta 기본값 — ⚠️미확認: Insights
    API가 기본으로 lifetime을 주는지 별도 date_preset이 필요한지는 공식 문서 fetch로
    재확認 못함, meta_ads_oauth.py 상단과 동일 딱지). `spend` 필드는 Meta가 통화
    소수점 문자열("12.34")로 낸다 — 이 레포 관례(minor unit int, gate.sealed_ads_
    budget_minor와 같은 단위)로 맞추려 100을 곱해 반올림한다(⚠️미확認: 모든 통화가
    2자리 소수인지는 통화별로 다를 수 있어 재확認 필요 — KRW는 소수점이 없는 통화라
    이 가정이 깨질 수 있는 자리, 출시 前 재확認)."""
    resp = await client.get(
        f"{_GRAPH_BASE}/{campaign_id}/insights", params={"access_token": access_token, "fields": "spend"},
    )
    if resp.status_code != 200:
        raise MetaAdsCampaignError("META_ADS_SPEND_FETCH_FAILED", resp.text[:500])
    data = resp.json().get("data") or []
    if not data:
        return 0  # 아직 노출/지출 이력 0 — "미제공"이 아니라 "0"으로 정직하게 낸다.
    spend_str = data[0].get("spend")
    if spend_str is None:
        raise MetaAdsCampaignError("META_ADS_SPEND_MISSING_FIELD", "spend missing in insights response")
    return round(float(spend_str) * 100)
