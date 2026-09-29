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

from datetime import UTC, datetime

from app.services.meta_ads_campaign import (
    BOOST_ADSET_BUDGET_FIELD,
    MetaAdsCampaignError,
    boost_ad_name,
    boost_adset_name,
    boost_campaign_name,
    spend_minor_from_insights,
)

_BUDGET_EXCEEDED_MARKER = "[sandbox:budget-exceeded]"
_PAUSE_DELAYED_MARKER = "[sandbox:pause-delayed]"
# story #4412 — «outcome unknown» and the lookup that adopts, end to end on dev (PO run after deploy):
# - `[sandbox:create-unknown]`: the create answers like a 503 (outcome unknown) while the campaign «exists» — the lookup finds
#   the campaign · ad set · ad (the adopt path). Once adopted (ids complete), the worker no longer calls create.
# - `[sandbox:create-unknown-none]`: same create, the lookup finds nothing («찾지 못했어요»).
# - `[sandbox:create-unknown-twice]`: same create, the lookup finds two campaigns of that name (no automatic adoption · a list).
# Sandbox ids are deterministic, so «none» after a confirmed retry would answer the same way again — it is for the lookup
# screens, not for a second creation.
_CREATE_UNKNOWN_MARKER = "[sandbox:create-unknown]"
_CREATE_UNKNOWN_NONE_MARKER = "[sandbox:create-unknown-none]"
_CREATE_UNKNOWN_TWICE_MARKER = "[sandbox:create-unknown-twice]"
# story #4412(PO 00:48Z) — same as create-unknown, but the found ad set's budget was changed in the ad account (not the sealed one).
_CREATE_UNKNOWN_BUDGET_CHANGED_MARKER = "[sandbox:create-unknown-budget-changed]"
_CREATE_UNKNOWN_MARKERS = (
    _CREATE_UNKNOWN_MARKER, _CREATE_UNKNOWN_NONE_MARKER, _CREATE_UNKNOWN_TWICE_MARKER, _CREATE_UNKNOWN_BUDGET_CHANGED_MARKER,
)
_FOUND_MARKERS = (_CREATE_UNKNOWN_MARKER, _CREATE_UNKNOWN_BUDGET_CHANGED_MARKER)


def _sandbox_ids(ad_account_id: str, object_story_id: str) -> dict:
    ns = uuid.uuid5(uuid.NAMESPACE_URL, f"{ad_account_id}:{object_story_id}")
    return {"campaign_id": f"sandbox-campaign-{ns}", "adset_id": f"sandbox-adset-{ns}", "ad_id": f"sandbox-ad-{ns}"}


def _now_meta() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%S+0000")

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
    existing: dict | None = None, gate_id: str = "",
) -> dict:
    """real과 같은 시그니처(story #4268 `existing` 포함). sandbox는 id가 결정적이라 이어 만들기와 새로 만들기의 결과가 같다."""
    # story #4417 — the same currency rule as the real create (an unknown currency creates nothing)
    from app.services.currency_minor import UnknownCurrencyError, meta_budget_units

    try:
        meta_budget_units(budget_minor, currency)
    except UnknownCurrencyError as exc:
        raise MetaAdsCampaignError("META_ADS_UNKNOWN_CURRENCY", str(exc), outcome_known=True) from exc
    if _BUDGET_EXCEEDED_MARKER in objective and not (existing or {}).get("campaign_id"):
        raise MetaAdsCampaignError(
            "META_ADS_CAMPAIGN_CREATE_FAILED",
            "sandbox: [sandbox:budget-exceeded] marker simulation — ad account spend cap reached",
            outcome_known=True,  # story #4409 — simulates Meta rejecting the create (nothing made)
        )
    if any(m in objective for m in _CREATE_UNKNOWN_MARKERS) and not all((existing or {}).get(k) for k in ("campaign_id", "adset_id", "ad_id")):
        raise MetaAdsCampaignError(
            "META_ADS_CAMPAIGN_CREATE_FAILED", "sandbox: create-unknown marker — no definite answer (like a 503)",
        )  # outcome_known left False: the campaign may exist
    # story #4412 (0420) — ids unique per run, like Meta's: two boosts of the same post in one ad account get different ids
    # (the lookup markers keep using `_sandbox_ids`, which the create-unknown flow never returns from create). The seed carries
    # the boost's gate (Qadir 01a0eb0b): without it two boosts of one post with the same sealed period · budget · objective got
    # the same ids, and the second run's write hit the unique indexes.
    ns = uuid.uuid5(
        uuid.NAMESPACE_URL,
        f"{gate_id}:{ad_account_id}:{object_story_id}:{starts_at_iso}:{ends_at_iso}:{budget_minor}:{objective}",
    )
    return {"campaign_id": f"sandbox-campaign-{ns}", "adset_id": f"sandbox-adset-{ns}", "ad_id": f"sandbox-ad-{ns}"}


async def find_boost_campaigns(
    client: httpx.AsyncClient, *, ad_account_id: str, access_token: str, object_story_id: str, objective: str = "",
) -> list[dict]:
    """story #4412 — same signature as the real lookup; answers from the create-unknown markers."""
    if not any(m in objective for m in (*_FOUND_MARKERS, _CREATE_UNKNOWN_TWICE_MARKER)):
        return []
    ids = _sandbox_ids(ad_account_id, object_story_id)
    found = [{"id": ids["campaign_id"], "name": boost_campaign_name(object_story_id), "created_time": _now_meta()}]
    if _CREATE_UNKNOWN_TWICE_MARKER in objective:
        found.append({"id": ids["campaign_id"] + "-copy", "name": boost_campaign_name(object_story_id), "created_time": _now_meta()})
    return found


async def find_boost_adsets(
    client: httpx.AsyncClient, *, campaign_id: str, access_token: str, object_story_id: str, objective: str = "",
    expected_budget_minor: int | None = None,
) -> list[dict]:
    if not any(m in objective for m in _FOUND_MARKERS):
        return []
    ns = campaign_id.removeprefix("sandbox-campaign-")
    budget = (expected_budget_minor or 0) + (1000 if _CREATE_UNKNOWN_BUDGET_CHANGED_MARKER in objective else 0)
    return [{"id": f"sandbox-adset-{ns}", "name": boost_adset_name(object_story_id), "campaign_id": campaign_id,
             "created_time": _now_meta(), BOOST_ADSET_BUDGET_FIELD: str(budget)}]


async def find_boost_ads(
    client: httpx.AsyncClient, *, adset_id: str, access_token: str, object_story_id: str, objective: str = "",
) -> list[dict]:
    if not any(m in objective for m in _FOUND_MARKERS):
        return []
    ns = adset_id.removeprefix("sandbox-adset-")
    return [{"id": f"sandbox-ad-{ns}", "name": boost_ad_name(object_story_id), "adset_id": adset_id,
             "created_time": _now_meta()}]


async def set_campaign_status(
    client: httpx.AsyncClient, *, campaign_id: str, access_token: str, status: str,
) -> None:
    return  # sandbox — 항상 성공. pause-delayed 판정은 호출부 몫(위 모듈 docstring).


# story #3806(Phase3·3-2 PR4, 페드루 PO 確定 2026-09-11) — 결정적 고정값(ads_sandbox_
# oauth.py::list_ad_accounts의 「이름·id는 절대 안 바뀐다」 원칙과 동형) — 해시 유도
# 대신 고정 상수를 쓴 이유는 테스트가 정확한 값을 assert할 수 있게(해시면 테스트가
# 같은 계산을 재구현해야 한다, 취약).
_FIXED_SPEND_MINOR = 12_345


# story #4417 — `[sandbox:account-currency-usd]` in the objective: the ad account answers USD (a KRW-sealed boost then stops
# before anything is created). Without it the account has the sealed currency.
_ACCOUNT_CURRENCY_USD_MARKER = "[sandbox:account-currency-usd]"


async def get_ad_account_currency(
    client: httpx.AsyncClient, *, ad_account_id: str, access_token: str, expected_currency: str | None = None,
    objective: str = "",
) -> str:
    """story #4417 — same signature as the real read (plus `objective` for the marker)."""
    if _ACCOUNT_CURRENCY_USD_MARKER in objective:
        return "USD"
    if not expected_currency:
        raise MetaAdsCampaignError("META_ADS_ACCOUNT_CURRENCY_MISSING", "sandbox: no expected currency", outcome_known=True)
    return expected_currency


async def get_campaign_spend_minor(
    client: httpx.AsyncClient, *, campaign_id: str, access_token: str, currency: str,
) -> int:
    """story #4417 — the fixed spend comes back through the real conversion: an Insights row in major units for the sealed
    currency («12345» won · «123.45» dollars), read by `spend_minor_from_insights` like Meta's answer."""
    from app.services.currency_minor import UnknownCurrencyError, minor_to_decimal_amount

    try:
        spend = minor_to_decimal_amount(_FIXED_SPEND_MINOR, currency)
    except UnknownCurrencyError as exc:
        raise MetaAdsCampaignError("META_ADS_SPEND_UNKNOWN_CURRENCY", str(exc)) from exc
    return spend_minor_from_insights([{"spend": spend, "account_currency": currency}], currency=currency)
