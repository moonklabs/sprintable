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

import json
from datetime import datetime

import httpx

_GRAPH_BASE = "https://graph.facebook.com/v21.0"


class MetaAdsCampaignError(Exception):
    """meta_ads_oauth.py::MetaAdsOAuthError와 동형 — .code/.message 속성."""

    def __init__(self, code: str, message: str, *, partial: dict | None = None, outcome_known: bool = False):
        self.code = code
        self.message = message
        # story #4409(Qadir 4805 · PO 23:39Z) — True only when Meta's answer says the object was **not** created (a 4xx rejection),
        # and only where a raise site says so explicitly. The default is False: a new error path that forgets it stops as
        # «outcome unknown» for a person to check (the safe side), instead of releasing the claim and letting a retry create a
        # second campaign (customer ad spend).
        self.outcome_known = outcome_known
        # story #4268 — 3단계 생성 중 앞 단계가 이미 만들어진 뒤 실패하면 그 id들(campaign_id · adset_id). 워커가 실행 행에 남겨
        # 재시도가 이어서 만들게 한다(다시 만들면 고객 광고 계정에 PAUSED 객체가 중복으로 쌓인다).
        self.partial = dict(partial or {})
        super().__init__(message)


def boost_campaign_name(object_story_id: str) -> str:
    """story #4409 — the campaign's name at Meta, one rule for the create call, the «campaign to look for» line of the check
    dialog (/spend) and the lookup that adopts an existing campaign (4412)."""
    return f"Boost {object_story_id}"


def boost_adset_name(object_story_id: str) -> str:
    return f"Boost adset {object_story_id}"


def boost_ad_name(object_story_id: str) -> str:
    return f"Boost ad {object_story_id}"


# story #4412(PO 00:50Z) — the ad set field that carries the approved amount: one place for the create call, the lookup's
# fields and the adoption's budget check.
# story #4415 — `lifetime_budget`, not `daily_budget`. The approved amount is a **total** for the whole period: the screens show
# it as «총예산» and the spend cap stops at it (ads_boost_runs.cap_reached_at). Sent as a daily budget, a multi-day boost tried
# to spend the whole total on day one, and the cap stopped it only a capture interval late. Meta: lifetime_budget needs an
# end_time (sent: the sealed period) and is in the same units as ours (cents for USD, the basic unit for KRW); only one of the
# two budgets is set.
BOOST_ADSET_BUDGET_FIELD = "lifetime_budget"


def boost_adset_budget_minor(adset: dict) -> int | None:
    """The approved-amount field of an ad set as Meta returns it (a string of minor units). None when missing or unreadable."""
    try:
        return int(adset.get(BOOST_ADSET_BUDGET_FIELD))
    except (TypeError, ValueError):
        return None


# story #4412 — a lookup never decides on a partial list: past this many pages it refuses (META_ADS_LOOKUP_TOO_MANY).
BOOST_LOOKUP_MAX_PAGES = 20


def parse_meta_time(value: str | None) -> datetime | None:
    """Meta's `created_time` («2026-09-28T23:10:00+0000»). None when missing or unreadable."""
    if not value:
        return None
    for fmt in ("%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%dT%H:%M:%S.%f%z"):
        try:
            return datetime.strptime(value, fmt)
        except ValueError:
            continue
    return None


async def _list_named(client: httpx.AsyncClient, url: str, *, access_token: str, name: str, fields: str) -> list[dict]:
    """story #4412 — every object on `url` whose name is exactly `name`. The `filtering` name CONTAIN only narrows the pages
    (Meta does not document the name operators on these edges); the exact match is ours, so a different filter meaning never
    adopts a wrong object. Default visibility: deleted and archived objects are not returned (they cannot be reused)."""
    params: dict | None = {
        "access_token": access_token, "fields": fields, "limit": 100,
        "filtering": json.dumps([{"field": "name", "operator": "CONTAIN", "value": name}]),
    }
    found: list[dict] = []
    next_url: str | None = url
    for _ in range(BOOST_LOOKUP_MAX_PAGES):
        resp = await client.get(next_url, params=params)
        if resp.status_code != 200:
            raise MetaAdsCampaignError("META_ADS_LOOKUP_FAILED", resp.text[:500])
        body = resp.json()
        found += [item for item in body.get("data") or [] if item.get("name") == name]
        next_url = (body.get("paging") or {}).get("next")
        params = None  # the next URL carries the query
        if not next_url:
            return found
    raise MetaAdsCampaignError("META_ADS_LOOKUP_TOO_MANY", f"more than {BOOST_LOOKUP_MAX_PAGES} pages for «{name}»")


async def find_boost_campaigns(
    client: httpx.AsyncClient, *, ad_account_id: str, access_token: str, object_story_id: str, objective: str = "",
) -> list[dict]:
    """story #4412 — campaigns named `boost_campaign_name(object_story_id)` in the ad account: id · name · created_time.
    `objective` is only for the sandbox's markers (same signature)."""
    return await _list_named(
        client, f"{_GRAPH_BASE}/act_{ad_account_id}/campaigns", access_token=access_token,
        name=boost_campaign_name(object_story_id), fields="id,name,created_time,effective_status",
    )


async def find_boost_adsets(
    client: httpx.AsyncClient, *, campaign_id: str, access_token: str, object_story_id: str, objective: str = "",
    expected_budget_minor: int | None = None,
) -> list[dict]:
    """Ad sets named `boost_adset_name` under `campaign_id`: id · name · campaign_id · created_time · the budget field
    (`BOOST_ADSET_BUDGET_FIELD`; the budget lives on the ad set — PO 00:48Z: an adopted ad set must still carry the sealed amount). `expected_budget_minor` is for the
    sandbox only (same signature)."""
    return await _list_named(
        client, f"{_GRAPH_BASE}/{campaign_id}/adsets", access_token=access_token,
        name=boost_adset_name(object_story_id), fields=f"id,name,campaign_id,created_time,{BOOST_ADSET_BUDGET_FIELD}",
    )


async def find_boost_ads(
    client: httpx.AsyncClient, *, adset_id: str, access_token: str, object_story_id: str, objective: str = "",
) -> list[dict]:
    """Ads named `boost_ad_name` under `adset_id`: id · name · adset_id · created_time."""
    return await _list_named(
        client, f"{_GRAPH_BASE}/{adset_id}/ads", access_token=access_token,
        name=boost_ad_name(object_story_id), fields="id,name,adset_id,created_time",
    )


async def create_boost_campaign(
    client: httpx.AsyncClient, *, ad_account_id: str, access_token: str, object_story_id: str,
    budget_minor: int, currency: str, starts_at_iso: str, ends_at_iso: str, objective: str,
    existing: dict | None = None, gate_id: str = "",
) -> dict:
    """반환 {"campaign_id","adset_id","ad_id"}(전부 str). 3단계 순차 생성 — 앞 단계가
    실패하면 뒤 단계를 아예 안 부른다(실패 시 이미 만든 객체를 지우려 하지 않는다 — publish_channel_
    post_draft류 "이미 만든 걸 지우려 하지 않는다" 관례와 동형).

    story #4268 — `existing`에 이미 만든 id가 있으면 그 단계는 건너뛰고 이어서 만든다(재시도가 캠페인 · 광고 세트를 또 만들어
    고객 계정에 PAUSED 객체가 중복으로 쌓이던 결함). 중간에 실패하면 그때까지 만든 id를 `MetaAdsCampaignError.partial`에
    실어 올린다(워커가 실행 행에 남겨 다음 재시도가 이어 간다).

    `gate_id` is not sent to Meta (Meta makes its own ids); it is in the signature for the sandbox, which derives its ids from
    it (story #4412 · Qadir 01a0eb0b)."""
    ids = {k: v for k, v in (existing or {}).items() if v}

    def fail(code: str, message: str, *, outcome_known: bool = False) -> MetaAdsCampaignError:
        return MetaAdsCampaignError(code, message, partial=ids, outcome_known=outcome_known)

    # story #4417 — the budget in Meta's units for the sealed currency, before any call: an unknown currency creates nothing
    # (a known «not created»).
    from app.services.currency_minor import UnknownCurrencyError, meta_budget_units

    try:
        budget_units = meta_budget_units(budget_minor, currency)
    except UnknownCurrencyError as exc:
        raise fail("META_ADS_UNKNOWN_CURRENCY", str(exc), outcome_known=True) from exc

    if not ids.get("campaign_id"):
        campaign_resp = await client.post(
            f"{_GRAPH_BASE}/act_{ad_account_id}/campaigns",
            params={
                "access_token": access_token, "name": boost_campaign_name(object_story_id),
                "objective": objective, "status": "PAUSED", "special_ad_categories": "[]",
            },
        )
        if campaign_resp.status_code != 200:
            raise fail(
                "META_ADS_CAMPAIGN_CREATE_FAILED", campaign_resp.text[:500], outcome_known=400 <= campaign_resp.status_code < 500,
            )
        campaign_id = campaign_resp.json().get("id")
        if not campaign_id:
            raise fail("META_ADS_CAMPAIGN_CREATE_MISSING_FIELD", "id missing", outcome_known=False)
        ids["campaign_id"] = str(campaign_id)

    if not ids.get("adset_id"):
        adset_resp = await client.post(
            f"{_GRAPH_BASE}/act_{ad_account_id}/adsets",
            params={
                "access_token": access_token, "name": boost_adset_name(object_story_id),
                "campaign_id": ids["campaign_id"], BOOST_ADSET_BUDGET_FIELD: budget_units, "billing_event": "IMPRESSIONS",
                "optimization_goal": "REACH", "start_time": starts_at_iso, "end_time": ends_at_iso,
                "status": "PAUSED",
            },
        )
        if adset_resp.status_code != 200:
            raise fail(
                "META_ADS_ADSET_CREATE_FAILED", adset_resp.text[:500], outcome_known=400 <= adset_resp.status_code < 500,
            )
        adset_id = adset_resp.json().get("id")
        if not adset_id:
            raise fail("META_ADS_ADSET_CREATE_MISSING_FIELD", "id missing", outcome_known=False)
        ids["adset_id"] = str(adset_id)

    if not ids.get("ad_id"):
        ad_resp = await client.post(
            f"{_GRAPH_BASE}/act_{ad_account_id}/ads",
            params={
                "access_token": access_token, "name": boost_ad_name(object_story_id), "adset_id": ids["adset_id"],
                "creative": f'{{"object_story_id":"{object_story_id}"}}', "status": "PAUSED",
            },
        )
        if ad_resp.status_code != 200:
            raise fail("META_ADS_AD_CREATE_FAILED", ad_resp.text[:500], outcome_known=400 <= ad_resp.status_code < 500)
        ad_id = ad_resp.json().get("id")
        if not ad_id:
            raise fail("META_ADS_AD_CREATE_MISSING_FIELD", "id missing", outcome_known=False)
        ids["ad_id"] = str(ad_id)

    return {"campaign_id": ids["campaign_id"], "adset_id": ids["adset_id"], "ad_id": ids["ad_id"]}


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


# story #4417 — the Insights period for the spend read. Meta's default is `last_30d` (Marketing API reference, «Ad Campaign
# Insights» · `date_preset`: «Default value: last_30d», enum includes `maximum`; read 2026-09-29), so a boost longer than 30
# days would read less than it spent and the cap would stop it late. `maximum` = everything the campaign has.
SPEND_INSIGHTS_DATE_PRESET = "maximum"

# story #4417 — spend read errors that a retry can't fix (the currency, not the call): the capture fails with the code.
SPEND_CURRENCY_ERROR_CODES = frozenset({"META_ADS_SPEND_CURRENCY_MISMATCH", "META_ADS_SPEND_UNKNOWN_CURRENCY"})


def spend_minor_from_insights(data: list, *, currency: str) -> int:
    """story #4417 — Insights rows → spend in our minor units, one rule for the real adapter and the sandbox.

    `spend` is a decimal string in the ad account's currency («5000» won · «12.34» dollars); `currency_minor` turns it into
    minor units (KRW ×1 · USD ×100). `account_currency` must be the sealed currency — a different one (or a currency outside
    the table) is an error, not a conversion: the spend stays unknown and no cap decision is taken on it. No rows = nothing
    spent yet (0)."""
    from app.services.currency_minor import UnknownCurrencyError, decimal_amount_to_minor

    if not data:
        return 0  # 아직 노출/지출 이력 0 — "미제공"이 아니라 "0"으로 정직하게 낸다.
    row = data[0]
    spend_str = row.get("spend")
    if spend_str is None:
        raise MetaAdsCampaignError("META_ADS_SPEND_MISSING_FIELD", "spend missing in insights response")
    account_currency = row.get("account_currency")
    if account_currency != currency:
        raise MetaAdsCampaignError(
            "META_ADS_SPEND_CURRENCY_MISMATCH",
            f"insights account_currency {account_currency!r} is not the sealed currency {currency!r}",
        )
    try:
        return decimal_amount_to_minor(spend_str, currency)
    except UnknownCurrencyError as exc:
        raise MetaAdsCampaignError("META_ADS_SPEND_UNKNOWN_CURRENCY", str(exc)) from exc
    except ValueError as exc:
        raise MetaAdsCampaignError("META_ADS_SPEND_NOT_A_NUMBER", str(exc)) from exc


async def get_ad_account_currency(
    client: httpx.AsyncClient, *, ad_account_id: str, access_token: str, expected_currency: str | None = None,
    objective: str = "",
) -> str:
    """story #4417 (Qadir 01a0eb3b ②) — the ad account's currency (Marketing API «Ad Account» field `currency`), read before a
    boost start creates or switches on anything: budgets are sent in the account's currency, so a sealed KRW amount on a USD
    account would be read as cents (50,000 won → $500). `expected_currency` · `objective` are for the sandbox only (same
    signature). Nothing is written at the provider, so a failure here is a known «not created»."""
    resp = await client.get(
        f"{_GRAPH_BASE}/act_{ad_account_id}", params={"access_token": access_token, "fields": "currency"},
    )
    if resp.status_code != 200:
        raise MetaAdsCampaignError("META_ADS_ACCOUNT_READ_FAILED", resp.text[:500], outcome_known=True)
    currency = resp.json().get("currency")
    if not currency:
        raise MetaAdsCampaignError(
            "META_ADS_ACCOUNT_CURRENCY_MISSING", "currency missing in ad account response", outcome_known=True,
        )
    return str(currency)


async def get_campaign_spend_minor(
    client: httpx.AsyncClient, *, campaign_id: str, access_token: str, currency: str,
) -> int:
    """story #3806(Phase3·3-2 PR4, 페드루 PO 確定 2026-09-11) — 캠페인 누적 지출(minor unit int, gate.sealed_ads_budget_minor와
    같은 단위). story #4417 — the period is asked for explicitly (`SPEND_INSIGHTS_DATE_PRESET`, not Meta's 30-day default) and
    the conversion goes by the sealed `currency` (`spend_minor_from_insights`), not a fixed ×100."""
    resp = await client.get(
        f"{_GRAPH_BASE}/{campaign_id}/insights",
        params={
            "access_token": access_token, "fields": "spend,account_currency", "date_preset": SPEND_INSIGHTS_DATE_PRESET,
            # one row for the whole period (Qadir 01a0eb3b) — `spend_minor_from_insights` reads data[0]
            "time_increment": "all_days",
        },
    )
    if resp.status_code != 200:
        raise MetaAdsCampaignError("META_ADS_SPEND_FETCH_FAILED", resp.text[:500])
    return spend_minor_from_insights(resp.json().get("data") or [], currency=currency)
