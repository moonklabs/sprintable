"""story #3813(Phase3·3-4 PR5-a, 페드루 PO 確定 2026-09-12) — `stibee_client.py`
직접 단위 테스트. DB 불요 — `httpx.MockTransport`로 api.stibee.com 응답을 흉내낸다
(test_e4fc29fa_webhook_publish_adapter.py와 동형 관례)."""
from __future__ import annotations

import httpx
import pytest

from app.services.stibee_client import StibeeAuthCheckFailed, verify_api_key


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
