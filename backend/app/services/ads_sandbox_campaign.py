"""story #3806(Phase3·3-2 PR3 워커 fix, 페드루 PO 確定 2026-09-11) — meta_ads_campaign.py
동형 sandbox(같은 함수 시그니처, 인프로세스 결정적 응답 — sandbox_publish.py 철학
그대로). 카드 §5가 지정한 4마커 중 sandbox_publish.py가 「예약만·미구현」으로 남겨둔
나머지 둘을 여기서 구현한다(`[sandbox:budget-exceeded]`·`[sandbox:pause-delayed]`).

마커 캐리어 — boost 요청에 "텍스트" 필드가 없다(channel_post/site_post와 달리).
가장 가까운 자유 문자열 축은 `objective`(카드가 채택한 마커 규칙 "텍스트 안 어디에든"
원칙을 그대로 적용 — ads_boost.py::request_ads_boost가 이 값을 검증 없이 그대로
받는다는 것도 실측 확認)."""
from __future__ import annotations

import uuid

import httpx

from app.services.meta_ads_campaign import MetaAdsCampaignError

_BUDGET_EXCEEDED_MARKER = "[sandbox:budget-exceeded]"
_PAUSE_DELAYED_MARKER = "[sandbox:pause-delayed]"

# sandbox_publish.py 카탈로그 갱신(story #3806 §5, 이 PR이 신규 구현) —
# `[sandbox:budget-exceeded]` objective에 포함되면 campaign 생성 자체가 Meta의
# 계정 지출 한도 초과 실패를 흉내낸다(개별 boost 예산 봉인 초과와는 다른 축 —
# 그건 PR 2의 ADS_BUDGET_EXCEEDS_SEAL이 이미 요청 시점에 막는다, 이건 "그 광고
# 계정 자체가 Meta의 전체 지출 한도에 걸린" 시나리오).
#
# `[sandbox:pause-delayed]`는 이 모듈의 함수 시그니처를 real과 동형으로 유지하려고
# (meta_ads_campaign.py와 「같은 함수 시그니처」 원칙, 이 파일 상단 참고) 여기서
# 안 잡는다 — set_campaign_status는 objective를 안 받는다(campaign_id만 안다).
# 호출부(app/services/ads_boost_execution.py)가 gate.sealed_ads_objective에서
# 이 마커를 직접 읽어 판정한다(그 값이야말로 이 호출 시점에 유일하게 남아 있는
# "사용자가 무엇을 요청했는지"의 근거 — publication_command에는 objective가
# 없다). 카드가 요구한 「중지 복구시간」 evidence(명령 시각→채널 반영 시각)의
# 재료 — sandbox가 "접수는 성공했지만 반영은 지연"을 먼저 노출해 둔다.


async def create_boost_campaign(
    client: httpx.AsyncClient, *, ad_account_id: str, access_token: str, object_story_id: str,
    budget_minor: int, currency: str, starts_at_iso: str, ends_at_iso: str, objective: str,
) -> dict:
    if _BUDGET_EXCEEDED_MARKER in objective:
        raise MetaAdsCampaignError(
            "META_ADS_CAMPAIGN_CREATE_FAILED",
            "sandbox: [sandbox:budget-exceeded] marker simulation — ad account spend cap reached",
        )
    seed = f"{ad_account_id}:{object_story_id}"
    ns = uuid.uuid5(uuid.NAMESPACE_URL, seed)
    return {
        "campaign_id": f"sandbox-campaign-{ns}", "adset_id": f"sandbox-adset-{ns}",
        "ad_id": f"sandbox-ad-{ns}",
    }


async def set_campaign_status(
    client: httpx.AsyncClient, *, campaign_id: str, access_token: str, status: str,
) -> None:
    return  # sandbox — 항상 성공. pause-delayed 판정은 호출부 몫(위 모듈 docstring).
