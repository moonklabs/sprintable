"""story #4417 — ad spend and budgets go by the currency's minor units (one table, `app/services/currency_minor.py`).

Before: `get_campaign_spend_minor` multiplied Meta's `spend` by 100 whatever the currency — KRW (no decimals) read 100× the
real spend, so the cap stopped a boost at 1% of the approved amount — and it relied on the Insights default period
(`last_30d`), so a boost longer than 30 days read less than it spent."""
from __future__ import annotations

import re
from pathlib import Path

import httpx
import pytest

from app.services.currency_minor import (
    CURRENCY_EXPONENTS,
    UnknownCurrencyError,
    currency_exponent,
    decimal_amount_to_minor,
    meta_budget_units,
    minor_to_decimal_amount,
)
from app.services.meta_ads_campaign import (
    BOOST_ADSET_BUDGET_FIELD,
    SPEND_INSIGHTS_DATE_PRESET,
    MetaAdsCampaignError,
    create_boost_campaign,
    get_campaign_spend_minor,
    spend_minor_from_insights,
)

_WEB_TABLE = Path(__file__).resolve().parents[2] / "apps/web/src/components/content/generation-budget-indicator.tsx"


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ── the table ─────────────────────────────────────────────────────────────────────────────────────────────────────────

def test_exponents_krw_0_usd_2():
    assert CURRENCY_EXPONENTS == {"KRW": 0, "USD": 2}


@pytest.mark.parametrize("currency", ["JPY", "EUR", "krw", "", None])
def test_a_currency_outside_the_table_is_an_error_not_a_guess(currency):
    with pytest.raises(UnknownCurrencyError):
        currency_exponent(currency)


def test_the_web_table_has_the_same_exponents():
    """The web keeps its own copy (formatting and input); a drift would show one amount and seal another."""
    source = _WEB_TABLE.read_text(encoding="utf-8")
    match = re.search(r"const CURRENCY_EXPONENTS[^=]*=\s*\{([^}]*)\}", source)
    assert match, f"CURRENCY_EXPONENTS not found in {_WEB_TABLE}"
    web = {k: int(v) for k, v in re.findall(r"(\w+)\s*:\s*(\d+)", match.group(1))}
    assert web == CURRENCY_EXPONENTS


def test_meta_budget_offsets_equal_ten_to_the_exponent():
    """Marketing API «Currencies» (read 2026-09-29): KRW offset 1 · USD offset 100 — budgets in those units are our minor
    units, so the amount goes to Meta unchanged."""
    meta_offsets = {"KRW": 1, "USD": 100}
    assert {c: 10 ** e for c, e in CURRENCY_EXPONENTS.items()} == meta_offsets
    assert meta_budget_units(50_000, "KRW") == 50_000
    assert meta_budget_units(1_234, "USD") == 1_234
    with pytest.raises(UnknownCurrencyError):
        meta_budget_units(50_000, "JPY")


# ── major string → minor ──────────────────────────────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize(("amount", "currency", "minor"), [
    ("5000", "KRW", 5_000),
    ("5000.00", "KRW", 5_000),
    ("4999.5", "KRW", 5_000),
    ("12.34", "USD", 1_234),
    ("12.345", "USD", 1_235),
    ("0", "USD", 0),
])
def test_decimal_amount_to_minor(amount, currency, minor):
    assert decimal_amount_to_minor(amount, currency) == minor


@pytest.mark.parametrize("amount", ["", "abc", "NaN", "Infinity"])
def test_a_non_number_is_an_error(amount):
    with pytest.raises(ValueError):
        decimal_amount_to_minor(amount, "KRW")


@pytest.mark.parametrize(("minor", "currency", "text"), [(12_345, "KRW", "12345"), (12_345, "USD", "123.45")])
def test_minor_to_decimal_amount_round_trips(minor, currency, text):
    assert minor_to_decimal_amount(minor, currency) == text
    assert decimal_amount_to_minor(text, currency) == minor


# ── Insights rows → spend ─────────────────────────────────────────────────────────────────────────────────────────────

def test_krw_spend_is_not_multiplied_by_100():
    """The story's case: 5,000 won spent is 5,000 in our units (it read 500,000 — the cap stopped at 1% of the budget)."""
    assert spend_minor_from_insights([{"spend": "5000", "account_currency": "KRW"}], currency="KRW") == 5_000


def test_usd_spend_is_in_cents():
    assert spend_minor_from_insights([{"spend": "12.34", "account_currency": "USD"}], currency="USD") == 1_234


def test_no_rows_is_zero_spend():
    assert spend_minor_from_insights([], currency="KRW") == 0


def test_an_account_currency_other_than_the_sealed_one_is_an_error():
    with pytest.raises(MetaAdsCampaignError) as exc:
        spend_minor_from_insights([{"spend": "12.34", "account_currency": "USD"}], currency="KRW")
    assert exc.value.code == "META_ADS_SPEND_CURRENCY_MISMATCH"


def test_a_missing_account_currency_is_an_error():
    with pytest.raises(MetaAdsCampaignError) as exc:
        spend_minor_from_insights([{"spend": "5000"}], currency="KRW")
    assert exc.value.code == "META_ADS_SPEND_CURRENCY_MISMATCH"


def test_an_unknown_sealed_currency_is_an_error():
    with pytest.raises(MetaAdsCampaignError) as exc:
        spend_minor_from_insights([{"spend": "5000", "account_currency": "JPY"}], currency="JPY")
    assert exc.value.code == "META_ADS_SPEND_UNKNOWN_CURRENCY"


# ── the real adapter's calls ──────────────────────────────────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_the_spend_read_asks_for_the_whole_period_and_the_account_currency():
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"data": [{"spend": "5000", "account_currency": "KRW"}]})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        spend = await get_campaign_spend_minor(client, campaign_id="c1", access_token="tok", currency="KRW")
    assert spend == 5_000
    params = seen[0].url.params
    assert SPEND_INSIGHTS_DATE_PRESET == "maximum"
    assert params["date_preset"] == "maximum"
    assert params["time_increment"] == "all_days"  # one row for the whole period (Qadir 01a0eb3b ④)
    assert set(params["fields"].split(",")) >= {"spend", "account_currency"}


@pytest.mark.anyio
async def test_the_ad_set_budget_is_sent_in_the_sealed_currency_units():
    posted: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        posted.append(request)
        return httpx.Response(200, json={"id": f"id-{len(posted)}"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        await create_boost_campaign(
            client, ad_account_id="1", access_token="tok", object_story_id="p_1", budget_minor=50_000, currency="KRW",
            starts_at_iso="2026-10-01T00:00:00+00:00", ends_at_iso="2026-10-08T00:00:00+00:00", objective="REACH",
        )
    adset = next(r for r in posted if r.url.path.endswith("/adsets"))
    assert adset.url.params[BOOST_ADSET_BUDGET_FIELD] == "50000"


@pytest.mark.anyio
async def test_an_unknown_currency_creates_nothing_and_says_so():
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(200, json={"id": "x"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(MetaAdsCampaignError) as exc:
            await create_boost_campaign(
                client, ad_account_id="1", access_token="tok", object_story_id="p_1", budget_minor=50_000, currency="JPY",
                starts_at_iso="2026-10-01T00:00:00+00:00", ends_at_iso="2026-10-08T00:00:00+00:00", objective="REACH",
            )
    assert exc.value.code == "META_ADS_UNKNOWN_CURRENCY"
    assert exc.value.outcome_known is True  # nothing was created — a known «not created», not «outcome unknown»
    assert calls == []


# ── the sandbox takes the same conversion ─────────────────────────────────────────────────────────────────────────────

@pytest.mark.anyio
@pytest.mark.parametrize("currency", ["KRW", "USD"])
async def test_the_sandbox_spend_goes_through_the_same_conversion(currency, monkeypatch):
    import app.services.ads_sandbox_campaign as sandbox

    seen: list[str] = []
    real = sandbox.spend_minor_from_insights

    def spy(data, *, currency):
        seen.append(currency)
        return real(data, currency=currency)

    monkeypatch.setattr(sandbox, "spend_minor_from_insights", spy)
    assert await sandbox.get_campaign_spend_minor(None, campaign_id="c", access_token="t", currency=currency) == 12_345
    assert seen == [currency]


@pytest.mark.anyio
async def test_the_sandbox_refuses_an_unknown_currency_like_the_real_adapter():
    import app.services.ads_sandbox_campaign as sandbox

    with pytest.raises(MetaAdsCampaignError) as spend_exc:
        await sandbox.get_campaign_spend_minor(None, campaign_id="c", access_token="t", currency="JPY")
    assert spend_exc.value.code == "META_ADS_SPEND_UNKNOWN_CURRENCY"
    with pytest.raises(MetaAdsCampaignError) as create_exc:
        await sandbox.create_boost_campaign(
            None, ad_account_id="1", access_token="t", object_story_id="p_1", budget_minor=1, currency="JPY",
            starts_at_iso="2026-10-01T00:00:00+00:00", ends_at_iso="2026-10-08T00:00:00+00:00", objective="REACH",
        )
    assert create_exc.value.code == "META_ADS_UNKNOWN_CURRENCY" and create_exc.value.outcome_known is True


@pytest.mark.anyio
async def test_a_usd_budget_is_sent_in_cents():
    """Qadir 01a0eb3b ④ — the USD side of the budget wire (cents = Meta's offset 100)."""
    posted: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        posted.append(request)
        return httpx.Response(200, json={"id": f"id-{len(posted)}"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        await create_boost_campaign(
            client, ad_account_id="1", access_token="tok", object_story_id="p_1", budget_minor=1_234, currency="USD",
            starts_at_iso="2026-10-01T00:00:00+00:00", ends_at_iso="2026-10-08T00:00:00+00:00", objective="REACH",
        )
    adset = next(r for r in posted if r.url.path.endswith("/adsets"))
    assert adset.url.params[BOOST_ADSET_BUDGET_FIELD] == "1234"  # $12.34


# ── the ad account's currency, read before a start creates anything (Qadir 01a0eb3b ②) ──────────────────────────────

@pytest.mark.anyio
async def test_the_ad_account_currency_is_read_from_the_account():
    from app.services.meta_ads_campaign import get_ad_account_currency

    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"currency": "USD", "id": "act_1"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        assert await get_ad_account_currency(client, ad_account_id="1", access_token="tok") == "USD"
    assert seen[0].url.path.endswith("/act_1") and seen[0].url.params["fields"] == "currency"


@pytest.mark.anyio
@pytest.mark.parametrize(("status", "body", "code"), [
    (500, {"error": "x"}, "META_ADS_ACCOUNT_READ_FAILED"),
    (200, {"id": "act_1"}, "META_ADS_ACCOUNT_CURRENCY_MISSING"),
])
async def test_an_unreadable_account_currency_is_a_known_not_created(status, body, code):
    from app.services.meta_ads_campaign import get_ad_account_currency

    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(status, json=body))) as client:
        with pytest.raises(MetaAdsCampaignError) as exc:
            await get_ad_account_currency(client, ad_account_id="1", access_token="tok")
    assert exc.value.code == code and exc.value.outcome_known is True  # a read: nothing was written


def test_a_failed_account_read_is_retried_and_a_different_currency_is_for_a_person():
    from app.services.publication_command import FAILURE_KIND_NEEDS_CHECK, classify_failure_kind

    assert classify_failure_kind("META_ADS_ACCOUNT_READ_FAILED") != FAILURE_KIND_NEEDS_CHECK
    assert classify_failure_kind("ADS_BOOST_ACCOUNT_CURRENCY_MISMATCH") == FAILURE_KIND_NEEDS_CHECK


@pytest.mark.anyio
async def test_the_sandbox_account_answers_the_sealed_currency_unless_marked():
    import app.services.ads_sandbox_campaign as sandbox

    assert await sandbox.get_ad_account_currency(None, ad_account_id="1", access_token="t", expected_currency="KRW") == "KRW"
    assert await sandbox.get_ad_account_currency(
        None, ad_account_id="1", access_token="t", expected_currency="KRW", objective="REACH [sandbox:account-currency-usd]",
    ) == "USD"
