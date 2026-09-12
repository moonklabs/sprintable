"""story #3816(Phase3·3-6, 페드루 PO 確定 2026-09-12) — `ghost_client.py` 직접 단위
테스트. DB 불요 — `httpx.MockTransport`로 Ghost Admin API 응답을 흉내낸다
(test_3813_stibee_client.py와 동형 관례)."""
from __future__ import annotations

import httpx
import pytest
from jose import jwt

from app.services.ghost_client import (
    GhostSiteVerifyFailed,
    sign_admin_jwt,
    verify_admin_api_key,
)


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _transport(handler):
    return httpx.MockTransport(handler)


# {id}:{hex secret} 형 — secret은 임의 32자리 hex(실 길이는 미확認, 형식 검증은
# "hex로 디코딩되는가"만 본다).
_FAKE_ADMIN_KEY = "64f1a2b3c4d5e6f7a8b9c0d1:0123456789abcdef0123456789abcdef"


def test_sign_admin_jwt_sets_kid_header_and_admin_audience():
    token = sign_admin_jwt(_FAKE_ADMIN_KEY)
    header = jwt.get_unverified_header(token)
    claims = jwt.get_unverified_claims(token)
    assert header["alg"] == "HS256"
    assert header["kid"] == "64f1a2b3c4d5e6f7a8b9c0d1"
    assert claims["aud"] == "/admin/"


def test_sign_admin_jwt_exp_is_exactly_300_seconds_after_iat():
    """Ghost가 exp-iat ≤ 5분을 강제한다(그라운딩) — 정확히 300초로 고정, 더 길게
    잡으면 실 사이트에서 조용히 거절될 위험을 스스로 만든다."""
    token = sign_admin_jwt(_FAKE_ADMIN_KEY)
    claims = jwt.get_unverified_claims(token)
    assert claims["exp"] - claims["iat"] == 300


def test_sign_admin_jwt_malformed_key_raises_before_any_signing():
    from app.services.ghost_client import GhostAdminKeyMalformedError

    with pytest.raises(GhostAdminKeyMalformedError):
        sign_admin_jwt("not-a-colon-separated-key")


def test_sign_admin_jwt_non_hex_secret_raises():
    from app.services.ghost_client import GhostAdminKeyMalformedError

    with pytest.raises(GhostAdminKeyMalformedError):
        sign_admin_jwt("some-id:not-hex-zzz")


@pytest.mark.anyio
async def test_verify_admin_api_key_sends_ghost_auth_header_to_site_endpoint():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["method"] = request.method
        captured["url"] = str(request.url)
        captured["auth_header"] = request.headers.get("Authorization")
        return httpx.Response(200, json={"site": {}})

    async with httpx.AsyncClient(transport=_transport(handler)) as client:
        await verify_admin_api_key(client, site_url="https://blog.example.com", admin_api_key=_FAKE_ADMIN_KEY)

    assert captured["method"] == "GET"
    assert captured["url"] == "https://blog.example.com/ghost/api/admin/site/"
    assert captured["auth_header"].startswith("Ghost ")


@pytest.mark.anyio
async def test_verify_admin_api_key_strips_trailing_slash_from_site_url():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        return httpx.Response(200, json={"site": {}})

    async with httpx.AsyncClient(transport=_transport(handler)) as client:
        await verify_admin_api_key(client, site_url="https://blog.example.com/", admin_api_key=_FAKE_ADMIN_KEY)

    assert captured["url"] == "https://blog.example.com/ghost/api/admin/site/"


@pytest.mark.anyio
async def test_verify_admin_api_key_raises_on_401():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, text="Unauthorized")

    async with httpx.AsyncClient(transport=_transport(handler)) as client:
        with pytest.raises(GhostSiteVerifyFailed) as exc_info:
            await verify_admin_api_key(client, site_url="https://blog.example.com", admin_api_key=_FAKE_ADMIN_KEY)

    assert exc_info.value.status_code == 401
    assert exc_info.value.is_key_rejected is True
    assert exc_info.value.is_site_not_found is False


@pytest.mark.anyio
async def test_verify_admin_api_key_raises_on_403():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(403, text="Forbidden")

    async with httpx.AsyncClient(transport=_transport(handler)) as client:
        with pytest.raises(GhostSiteVerifyFailed) as exc_info:
            await verify_admin_api_key(client, site_url="https://blog.example.com", admin_api_key=_FAKE_ADMIN_KEY)

    assert exc_info.value.status_code == 403
    assert exc_info.value.is_key_rejected is True
    assert exc_info.value.is_site_not_found is False


@pytest.mark.anyio
async def test_verify_admin_api_key_raises_on_404_is_site_not_found_not_key_rejected():
    """story #3816 CHANGES 1(페드루 PO 지목 2026-09-12) — site_url은 사용자 입력이라
    주소 자체가 틀림(오타·Ghost 아닌 사이트)도 흔히 404로 온다. 이걸 키 오류로
    뭉치면 사람이 키를 다시 붙여넣어도 같은 오류가 재현되는 거짓 진입점이 된다
    (뮤테이션 대상 — (401, 403) 판정에서 403을 빼면 그 위 테스트가 RED여야 한다)."""
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, text="Not Found")

    async with httpx.AsyncClient(transport=_transport(handler)) as client:
        with pytest.raises(GhostSiteVerifyFailed) as exc_info:
            await verify_admin_api_key(client, site_url="https://not-a-ghost-site.example.com", admin_api_key=_FAKE_ADMIN_KEY)

    assert exc_info.value.status_code == 404
    assert exc_info.value.is_key_rejected is False
    assert exc_info.value.is_site_not_found is True


@pytest.mark.anyio
async def test_verify_admin_api_key_raises_on_network_error():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("network unreachable")

    async with httpx.AsyncClient(transport=_transport(handler)) as client:
        with pytest.raises(GhostSiteVerifyFailed) as exc_info:
            await verify_admin_api_key(client, site_url="https://blog.example.com", admin_api_key=_FAKE_ADMIN_KEY)

    assert exc_info.value.status_code is None
    assert exc_info.value.is_key_rejected is False
    assert exc_info.value.is_site_not_found is False


@pytest.mark.anyio
async def test_verify_admin_api_key_malformed_key_is_key_rejected_without_network_call():
    """story #3816 — 형식이 틀린 키는 네트워크를 타지도 않고 즉시 거절(fail-closed,
    뮤테이션 대상: key_malformed 강제 True 분기를 지우면 이 테스트가 RED여야 한다)."""
    called = False

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal called
        called = True
        return httpx.Response(200, json={"site": {}})

    async with httpx.AsyncClient(transport=_transport(handler)) as client:
        with pytest.raises(GhostSiteVerifyFailed) as exc_info:
            await verify_admin_api_key(client, site_url="https://blog.example.com", admin_api_key="malformed")

    assert called is False
    assert exc_info.value.status_code is None
    assert exc_info.value.is_key_rejected is True
    assert exc_info.value.is_site_not_found is False
