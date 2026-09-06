"""story #3583-BE(Phase2·마케팅운영, 페드루 PO 確定 2026-09-06) — GA4 «고객 소유»
측정 연결. 이 파일은 `ga4_oauth.py`의 순수 함수/HTTP 왕복 단위(가짜 클라이언트,
real DB 불요)만 — 실 Postgres가 필요한 라우터·인사이트 부착 테스트는
`test_3583_ga4_measurement_connection_router.py`/`test_3583_ga4_insight_
enrichment.py`로 분리했다(그 파일들만 destructive_schema, 이 파일은 매 CI 샤드
마다 불필요한 fresh-DB 생성 비용을 안 낸다 — story #3579 60초 가드 경계대역 전례
반영, 처음부터 3-way로 쪼갠다)."""
from __future__ import annotations

import pytest


@pytest.fixture
def anyio_backend():
    return "asyncio"




def test_build_authorize_url_includes_offline_and_consent():
    """덧붙임(a) — access_type=offline+prompt=consent 없으면 refresh_token이 안
    온다. AC로 고정."""
    from app.services.ga4_oauth import build_authorize_url

    url = build_authorize_url(redirect_uri="https://backend.example/cb", state="s", client_id="cid")
    assert "access_type=offline" in url
    assert "prompt=consent" in url
    assert "analytics.readonly" in url


@pytest.mark.anyio
async def test_exchange_code_for_tokens_missing_refresh_token_raises():
    """재동의 누락 등으로 refresh_token이 응답에 없으면 즉시 실패(저장 뒤 나중에
    발견되는 것보다 즉시 드러나는 것이 낫다)."""
    from app.services.ga4_oauth import GA4OAuthError, exchange_code_for_tokens

    class _FakeResponse:
        status_code = 200
        headers = {"content-type": "application/json"}
        def json(self):
            return {"access_token": "tok", "expires_in": 3600}  # refresh_token 없음.
        text = "{}"

    class _FakeClient:
        async def post(self, url, *, data):
            return _FakeResponse()

    with pytest.raises(GA4OAuthError) as exc_info:
        await exchange_code_for_tokens(
            _FakeClient(), code="c", redirect_uri="https://x", client_id="cid", client_secret="sec",
        )
    assert exc_info.value.code == "GA4_TOKEN_EXCHANGE_NO_REFRESH_TOKEN"


@pytest.mark.anyio
async def test_refresh_access_token_invalid_grant_classified_as_revoked():
    from app.services.ga4_oauth import GA4OAuthError, classify_ga4_reauth_reason, is_persistent_ga4_auth_failure, refresh_access_token

    class _FakeResponse:
        status_code = 400
        headers = {"content-type": "application/json"}
        def json(self):
            return {"error": "invalid_grant"}
        text = '{"error": "invalid_grant"}'

    class _FakeClient:
        async def post(self, url, *, data):
            return _FakeResponse()

    with pytest.raises(GA4OAuthError) as exc_info:
        await refresh_access_token(_FakeClient(), refresh_token="r", client_id="cid", client_secret="sec")
    assert is_persistent_ga4_auth_failure(exc_info.value) is True
    assert classify_ga4_reauth_reason(exc_info.value) == "revoked"


@pytest.mark.anyio
async def test_refresh_access_token_429_is_transient_not_persistent():
    """429/5xx/네트워크는 그 회차만 «미제공» — needs_reauth로 승격하면 안 된다."""
    from app.services.ga4_oauth import GA4OAuthError, is_persistent_ga4_auth_failure, refresh_access_token

    class _FakeResponse:
        status_code = 429
        headers = {"content-type": "text/plain"}
        text = "rate limited"

    class _FakeClient:
        async def post(self, url, *, data):
            return _FakeResponse()

    with pytest.raises(GA4OAuthError) as exc_info:
        await refresh_access_token(_FakeClient(), refresh_token="r", client_id="cid", client_secret="sec")
    assert is_persistent_ga4_auth_failure(exc_info.value) is False


@pytest.mark.anyio
async def test_refresh_access_token_403_classified_as_error():
    from app.services.ga4_oauth import GA4OAuthError, classify_ga4_reauth_reason, is_persistent_ga4_auth_failure, refresh_access_token

    class _FakeResponse:
        status_code = 403
        headers = {"content-type": "application/json"}
        def json(self):
            return {"error": "access_denied"}
        text = '{"error": "access_denied"}'

    class _FakeClient:
        async def post(self, url, *, data):
            return _FakeResponse()

    with pytest.raises(GA4OAuthError) as exc_info:
        await refresh_access_token(_FakeClient(), refresh_token="r", client_id="cid", client_secret="sec")
    assert is_persistent_ga4_auth_failure(exc_info.value) is True
    assert classify_ga4_reauth_reason(exc_info.value) == "error"


@pytest.mark.anyio
async def test_list_properties_flattens_account_summaries():
    from app.services.ga4_oauth import list_properties

    class _FakeResponse:
        status_code = 200
        def json(self):
            return {"accountSummaries": [
                {"account": "accounts/1", "propertySummaries": [
                    {"property": "properties/111", "displayName": "속성 A"},
                    {"property": "properties/222", "displayName": "속성 B"},
                ]},
                {"account": "accounts/2", "propertySummaries": [
                    {"property": "properties/333", "displayName": "속성 C"},
                ]},
            ]}

    class _FakeClient:
        async def get(self, url, *, headers):
            return _FakeResponse()

    props = await list_properties(_FakeClient(), access_token="tok")
    assert props == [
        {"property_id": "111", "display_name": "속성 A"},
        {"property_id": "222", "display_name": "속성 B"},
        {"property_id": "333", "display_name": "속성 C"},
    ]


@pytest.mark.anyio
async def test_revoke_token_failure_raises():
    from app.services.ga4_oauth import GA4OAuthError, revoke_token

    class _FakeResponse:
        status_code = 400
        text = "bad token"

    class _FakeClient:
        async def post(self, url, *, params):
            return _FakeResponse()

    with pytest.raises(GA4OAuthError):
        await revoke_token(_FakeClient(), token="tok")




@pytest.mark.anyio
async def test_fetch_ga4_inflow_sums_metric_values():
    from app.services.insight_snapshots import _fetch_ga4_inflow

    class _FakeResponse:
        status_code = 200
        def json(self):
            return {
                "metricHeaders": [{"name": "sessions"}, {"name": "totalUsers"}, {"name": "conversions"}],
                "rows": [{"metricValues": [{"value": "10"}, {"value": "8"}, {"value": "2"}]}],
            }

    class _FakeClient:
        async def post(self, url, *, json, headers):
            return _FakeResponse()

    result = await _fetch_ga4_inflow(
        _FakeClient(), access_token="tok", property_id="1", source="threads", medium="social",
        campaign="draft-1", start_date="2026-09-01", end_date="2026-09-01",
    )
    assert result == {"inflow_sessions": 10, "inflow_users": 8, "inflow_conversions": 2}


@pytest.mark.anyio
async def test_fetch_ga4_inflow_no_rows_returns_empty_dict():
    """0으로 지어내지 않는다 — 그 UTM으로 온 세션이 실제로 0건이든 GA4 처리
    지연이든, rows가 없으면 빈 dict(호출부가 그대로 미제공 처리)."""
    from app.services.insight_snapshots import _fetch_ga4_inflow

    class _FakeResponse:
        status_code = 200
        def json(self):
            return {"metricHeaders": [{"name": "sessions"}], "rows": []}

    class _FakeClient:
        async def post(self, url, *, json, headers):
            return _FakeResponse()

    result = await _fetch_ga4_inflow(
        _FakeClient(), access_token="tok", property_id="1", source="threads", medium="social",
        campaign="draft-1", start_date="2026-09-01", end_date="2026-09-01",
    )
    assert result == {}
