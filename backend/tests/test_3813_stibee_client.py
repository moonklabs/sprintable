"""story #3813(Phase3·3-4 PR5-a, 페드루 PO 確定 2026-09-12) — `stibee_client.py`
직접 단위 테스트. DB 불요 — `httpx.MockTransport`로 api.stibee.com 응답을 흉내낸다
(test_e4fc29fa_webhook_publish_adapter.py와 동형 관례)."""
from __future__ import annotations

import httpx
import pytest

import json
from datetime import datetime, timezone

from app.services.stibee_client import (
    StibeeApiError,
    StibeeAuthCheckFailed,
    create_email,
    fetch_send_result,
    reserve_email,
    set_content,
    utc_to_kst_reserve_time,
    verify_api_key,
)


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _transport(handler):
    return httpx.MockTransport(handler)


@pytest.mark.anyio
async def test_verify_api_key_sends_access_token_header_to_auth_check_url():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["method"] = request.method
        captured["url"] = str(request.url)
        captured["access_token_header"] = request.headers.get("AccessToken")
        return httpx.Response(200, json={})

    async with httpx.AsyncClient(transport=_transport(handler)) as client:
        await verify_api_key(client, api_key="real-key-abc")

    assert captured["method"] == "GET"
    assert captured["url"] == "https://api.stibee.com/v2/auth-check"
    assert captured["access_token_header"] == "real-key-abc"


@pytest.mark.anyio
async def test_verify_api_key_raises_on_401():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, text="Unauthorized")

    async with httpx.AsyncClient(transport=_transport(handler)) as client:
        with pytest.raises(StibeeAuthCheckFailed) as exc_info:
            await verify_api_key(client, api_key="fake-key")

    assert exc_info.value.status_code == 401
    assert exc_info.value.is_key_rejected is True


@pytest.mark.anyio
async def test_verify_api_key_raises_on_400_stibee_no_token():
    """story #3813 PR5-a CHANGES — 그라운딩 정정 회귀: 실 auth-check가 존재하지
    않는 키에 실제로 400(Errors.Authorization.NoToken)을 낸다(2026-09-12 실호출
    확認, 문서가 암시한 401/403이 아니었다). 400도 4xx라 키 거절로 분류돼야 한다."""
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, json={"code": "Errors.Authorization.NoToken", "message": "존재하지 않는 토큰 입니다."})

    async with httpx.AsyncClient(transport=_transport(handler)) as client:
        with pytest.raises(StibeeAuthCheckFailed) as exc_info:
            await verify_api_key(client, api_key="fake-key")

    assert exc_info.value.status_code == 400
    assert exc_info.value.is_key_rejected is True


@pytest.mark.anyio
async def test_verify_api_key_raises_on_network_error():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("network unreachable")

    async with httpx.AsyncClient(transport=_transport(handler)) as client:
        with pytest.raises(StibeeAuthCheckFailed) as exc_info:
            await verify_api_key(client, api_key="any-key")

    assert exc_info.value.status_code is None
    assert exc_info.value.is_key_rejected is False


@pytest.mark.anyio
async def test_verify_api_key_raises_on_5xx_is_not_key_rejected():
    """story #3813 PR5-a CHANGES — 스티비 쪽 장애(5xx)는 키 거절이 아니다(사람이
    할 일=재시도, 재발급이 아니다)."""
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, text="Service Unavailable")

    async with httpx.AsyncClient(transport=_transport(handler)) as client:
        with pytest.raises(StibeeAuthCheckFailed) as exc_info:
            await verify_api_key(client, api_key="any-key")

    assert exc_info.value.status_code == 503
    assert exc_info.value.is_key_rejected is False


# story #3813 PR5-b(페드루 PO 確定 2026-09-12) — 실 stibee 발송 클라이언트.


@pytest.mark.anyio
async def test_create_email_posts_metadata_json_and_returns_id():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["method"] = request.method
        captured["url"] = str(request.url)
        captured["body"] = json.loads(request.content) if request.content else None
        return httpx.Response(200, json={"id": 12345})

    async with httpx.AsyncClient(transport=_transport(handler)) as client:
        email_id = await create_email(
            client, api_key="real-key", subject="9월 소식지", sender_email="a@b.com", sender_name="발신자",
            list_id="777",
        )

    assert email_id == 12345
    assert captured["method"] == "POST"
    assert captured["url"] == "https://api.stibee.com/v2/emails"
    assert captured["body"] == {
        "subject": "9월 소식지", "senderEmail": "a@b.com", "senderName": "발신자", "listId": 777,
    }


@pytest.mark.anyio
async def test_create_email_raises_plan_restricted():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, json={"code": "Errors.Service.NeedProPlan", "message": "프로 요금제 이상부터 사용할 수 있습니다"})

    async with httpx.AsyncClient(transport=_transport(handler)) as client:
        with pytest.raises(StibeeApiError) as exc_info:
            await create_email(client, api_key="k", subject="s", sender_email="a@b.com", sender_name="n", list_id="1")

    assert exc_info.value.status_code == 400
    assert exc_info.value.is_plan_restricted is True
    assert exc_info.value.is_sender_not_verified is False


@pytest.mark.anyio
async def test_create_email_raises_sender_not_verified():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, json={"code": "Errors.Authorization.PermissionDenied", "message": "사용할 수 없는 발신자"})

    async with httpx.AsyncClient(transport=_transport(handler)) as client:
        with pytest.raises(StibeeApiError) as exc_info:
            await create_email(client, api_key="k", subject="s", sender_email="a@b.com", sender_name="n", list_id="1")

    assert exc_info.value.is_sender_not_verified is True
    assert exc_info.value.is_plan_restricted is False


@pytest.mark.anyio
async def test_set_content_sends_raw_html_not_json():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["content_type"] = request.headers.get("Content-Type")
        captured["body"] = request.content.decode("utf-8")
        return httpx.Response(200, json={})

    async with httpx.AsyncClient(transport=_transport(handler)) as client:
        await set_content(client, api_key="k", email_id=12345, html="<html><body>hi</body></html>")

    assert captured["url"] == "https://api.stibee.com/v2/emails/12345/content"
    assert captured["content_type"] == "text/html; charset=utf-8"
    assert captured["body"] == "<html><body>hi</body></html>"


def test_utc_to_kst_reserve_time_adds_9_hours():
    """UTC 2026-09-12 05:30:00 → KST(UTC+9) 2026-09-12 14:30:00."""
    utc_dt = datetime(2026, 9, 12, 5, 30, 0, tzinfo=timezone.utc)
    assert utc_to_kst_reserve_time(utc_dt) == "20260912143000"


def test_utc_to_kst_reserve_time_crosses_midnight():
    """UTC 2026-09-12 23:00:00 → KST 2026-09-13 08:00:00(날짜가 바뀐다)."""
    utc_dt = datetime(2026, 9, 12, 23, 0, 0, tzinfo=timezone.utc)
    assert utc_to_kst_reserve_time(utc_dt) == "20260913080000"


def test_utc_to_kst_reserve_time_handles_naive_datetime_as_utc():
    naive_dt = datetime(2026, 9, 12, 5, 30, 0)
    assert utc_to_kst_reserve_time(naive_dt) == "20260912143000"


@pytest.mark.anyio
async def test_reserve_email_sends_kst_query_param():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        return httpx.Response(200, json={})

    utc_dt = datetime(2026, 9, 12, 5, 30, 0, tzinfo=timezone.utc)
    async with httpx.AsyncClient(transport=_transport(handler)) as client:
        await reserve_email(client, api_key="k", email_id=12345, scheduled_at_utc=utc_dt)

    assert captured["url"] == "https://api.stibee.com/v2/emails/12345/reserve?reserveTime=20260912143000"


@pytest.mark.anyio
async def test_reserve_email_raises_on_past_time_rejection():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, json={"code": "Errors.Data.InvalidRequest", "message": "과거 시간은 예약할 수 없습니다"})

    async with httpx.AsyncClient(transport=_transport(handler)) as client:
        with pytest.raises(StibeeApiError) as exc_info:
            await reserve_email(
                client, api_key="k", email_id=1, scheduled_at_utc=datetime(2020, 1, 1, tzinfo=timezone.utc),
            )

    assert exc_info.value.provider_code == "Errors.Data.InvalidRequest"


@pytest.mark.anyio
async def test_fetch_send_result_aggregates_actionname_across_pages():
    """2페이지(limit 1000 채운 뒤 짧은 2페이지) — DELIVERED 1200건+임의 액션 300건
    집계, delivered만 확정 매핑·opens는 None(미확認)."""
    pages = [
        [{"actionName": "DELIVERED"} for _ in range(1000)],
        [{"actionName": "DELIVERED"} for _ in range(200)] + [{"actionName": "SOME_OTHER_ACTION"} for _ in range(300)],
    ]
    call_count = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        idx = call_count["n"]
        call_count["n"] += 1
        return httpx.Response(200, json={"items": pages[idx], "total": 1500, "offset": idx * 1000, "limit": 1000})

    async with httpx.AsyncClient(transport=_transport(handler)) as client:
        result = await fetch_send_result(client, api_key="k", email_id=12345)

    assert call_count["n"] == 2
    assert result["counts"] == {"DELIVERED": 1200, "SOME_OTHER_ACTION": 300}
    assert result["delivered"] == 1200
    assert result["opens"] is None
    assert result["truncated"] is False


@pytest.mark.anyio
async def test_fetch_send_result_stops_at_page_cap_and_marks_truncated():
    def handler(request: httpx.Request) -> httpx.Response:
        # 매 페이지 정확히 limit만큼 채워 절대 "짧은 페이지"가 안 나오게(무한처럼 보이는 캠페인).
        return httpx.Response(200, json={"items": [{"actionName": "DELIVERED"}] * 1000})

    async with httpx.AsyncClient(transport=_transport(handler)) as client:
        result = await fetch_send_result(client, api_key="k", email_id=12345)

    assert result["truncated"] is True
    assert result["delivered"] == 1000 * 50  # _LOGS_MAX_PAGES


@pytest.mark.anyio
async def test_fetch_send_result_retries_once_on_429():
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        if len(calls) == 1:
            return httpx.Response(429, headers={"Retry-After": "0"})
        return httpx.Response(200, json={"items": [{"actionName": "DELIVERED"}]})

    async with httpx.AsyncClient(transport=_transport(handler)) as client:
        result = await fetch_send_result(client, api_key="k", email_id=12345)

    assert len(calls) == 2
    assert result["delivered"] == 1
