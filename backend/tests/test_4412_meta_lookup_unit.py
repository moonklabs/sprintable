"""story #4412 — the Meta lookup (MockTransport; no live Meta yet): exact name match on our side, pagination to the end, a page
cap that refuses rather than decide on a partial list, and non-200 as an error."""
import asyncio
import json

import httpx
import pytest

from app.services import meta_ads_campaign as meta


def _run(handler, **kwargs):
    async def go():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await meta.find_boost_campaigns(
                client, ad_account_id="1", access_token="t", object_story_id="10_20", **kwargs,
            )
    return asyncio.run(go())


def test_only_the_exact_name_counts_and_the_filter_is_sent():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["filtering"] = json.loads(request.url.params["filtering"])
        return httpx.Response(200, json={"data": [
            {"id": "a", "name": "Boost 10_20"},
            {"id": "b", "name": "Boost 10_20 copy"},  # what a CONTAIN filter lets through
            {"id": "c", "name": "boost 10_20"},
        ]})

    assert [c["id"] for c in _run(handler)] == ["a"]
    assert seen["filtering"] == [{"field": "name", "operator": "CONTAIN", "value": "Boost 10_20"}]


def test_all_pages_are_read():
    def handler(request: httpx.Request) -> httpx.Response:
        if "after=p2" in str(request.url):
            return httpx.Response(200, json={"data": [{"id": "b", "name": "Boost 10_20"}]})
        return httpx.Response(200, json={
            "data": [{"id": "a", "name": "Boost 10_20"}], "paging": {"next": "https://graph.facebook.com/v21.0/x?after=p2"},
        })

    assert [c["id"] for c in _run(handler)] == ["a", "b"]


def test_too_many_pages_refuse_instead_of_deciding_on_a_partial_list():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"data": [], "paging": {"next": "https://graph.facebook.com/v21.0/x?after=n"}})

    with pytest.raises(meta.MetaAdsCampaignError) as exc:
        _run(handler)
    assert exc.value.code == "META_ADS_LOOKUP_TOO_MANY"


def test_a_non_200_is_an_error():
    with pytest.raises(meta.MetaAdsCampaignError) as exc:
        _run(lambda r: httpx.Response(500, json={"error": {"message": "down"}}))
    assert exc.value.code == "META_ADS_LOOKUP_FAILED"


def test_meta_time_is_parsed():
    assert meta.parse_meta_time("2026-09-28T23:10:00+0000").isoformat() == "2026-09-28T23:10:00+00:00"
    assert meta.parse_meta_time("nonsense") is None


def test_the_budget_field_is_one_rule_for_create_lookup_and_check():
    """PO 00:50Z — the adoption's budget check reads the field the create call sets (4415 may change it)."""
    sent = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST" and request.url.path.endswith("/adsets"):
            sent["adset_body"] = dict(request.url.params)  # the create call sends its fields as query parameters
            return httpx.Response(200, json={"id": "as1"})
        if request.method == "GET" and request.url.path.endswith("/adsets"):
            sent["lookup_fields"] = request.url.params["fields"]
            return httpx.Response(200, json={"data": []})
        return httpx.Response(200, json={"id": "x1"})

    async def go():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            await meta.create_boost_campaign(
                client, ad_account_id="1", access_token="t", object_story_id="10_20", budget_minor=50_000, currency="KRW",
                starts_at_iso="2026-09-29T00:00:00+00:00", ends_at_iso="2026-09-30T00:00:00+00:00", objective="POST_ENGAGEMENT",
            )
            await meta.find_boost_adsets(client, campaign_id="c1", access_token="t", object_story_id="10_20")

    asyncio.run(go())
    field = meta.BOOST_ADSET_BUDGET_FIELD
    assert sent["adset_body"][field] == "50000"
    assert field in sent["lookup_fields"].split(",")
    assert meta.boost_adset_budget_minor({field: "50000"}) == 50_000
    assert meta.boost_adset_budget_minor({}) is None
