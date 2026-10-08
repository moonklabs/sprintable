"""story #4398 — 요청 상한이 셀 사용자 IP(`app.core.client_ip.client_ip`)와 1단계 적용(resend 전용 limiter)의 위조 표.

| 요청 | 꾸민 헤더 | 세는 IP |
| 프런트(비밀 맞음) | X-Sprintable-Client-IP | 그 값 |
| 백엔드 run.app 직통 | X-Sprintable-Client-IP · XFF 앞 칸 | XFF 오른쪽 끝(앞단이 붙인 접속 주소) |
| 비밀 미설정 | 전부 | XFF 오른쪽 끝 |
| 오른쪽 끝이 Cloudflare 대역(#4546) | XFF 앞 칸 | CF-Connecting-IP(없거나 깨지면 오른쪽 끝) |
| 오른쪽 끝이 Cloudflare 아님(#4546) | CF-Connecting-IP · XFF 앞 칸의 CF 주소 | XFF 오른쪽 끝 |
| Cloud Run 밖 | XFF | 소켓 주소 |
"""
from __future__ import annotations

import httpx
import pytest
from fastapi import FastAPI, Request
from slowapi import Limiter
from slowapi.errors import RateLimitExceeded
from starlette.responses import JSONResponse

from app.core.client_ip import CLIENT_IP_HEADER, EDGE_KEY_HEADER, client_ip

_SECRET = "edge-secret-4398"


def _request(headers: dict[str, str], peer: str = "10.0.0.9") -> Request:
    return Request({
        "type": "http", "method": "POST", "path": "/", "query_string": b"",
        "headers": [(k.lower().encode(), v.encode()) for k, v in headers.items()],
        "client": (peer, 5555),
    })


@pytest.fixture
def on_cloud_run(monkeypatch):
    monkeypatch.setenv("K_SERVICE", "sprintable-backend-dev")


@pytest.fixture
def with_secret(monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(settings, "edge_client_ip_secret", _SECRET)


def test_frontend_with_the_right_key_is_trusted(on_cloud_run, with_secret):
    req = _request({CLIENT_IP_HEADER: "203.0.113.7", EDGE_KEY_HEADER: _SECRET, "X-Forwarded-For": "34.1.2.3"})
    assert client_ip(req) == "203.0.113.7"


def test_direct_call_forging_the_client_ip_header_counts_the_connecting_address(on_cloud_run, with_secret):
    req = _request({CLIENT_IP_HEADER: "203.0.113.7", EDGE_KEY_HEADER: "guess", "X-Forwarded-For": "203.0.113.7, 198.51.100.9"})
    assert client_ip(req) == "198.51.100.9"


def test_forged_client_ip_header_without_any_key_is_ignored(on_cloud_run, with_secret):
    req = _request({CLIENT_IP_HEADER: "203.0.113.7", "X-Forwarded-For": "198.51.100.9"})
    assert client_ip(req) == "198.51.100.9"


def test_without_a_configured_secret_the_header_is_never_trusted(on_cloud_run, monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(settings, "edge_client_ip_secret", "")
    req = _request({CLIENT_IP_HEADER: "203.0.113.7", EDGE_KEY_HEADER: "", "X-Forwarded-For": "1.1.1.1, 198.51.100.9"})
    assert client_ip(req) == "198.51.100.9"


def test_a_malformed_forwarded_client_ip_falls_back_even_with_the_right_key(on_cloud_run, with_secret):
    req = _request({CLIENT_IP_HEADER: "not-an-ip", EDGE_KEY_HEADER: _SECRET, "X-Forwarded-For": "198.51.100.9"})
    assert client_ip(req) == "198.51.100.9"


def test_outside_cloud_run_the_socket_address_is_used(monkeypatch):
    monkeypatch.delenv("K_SERVICE", raising=False)
    req = _request({"X-Forwarded-For": "203.0.113.7"}, peer="127.0.0.1")
    assert client_ip(req) == "127.0.0.1"


def test_a_malformed_rightmost_forwarded_entry_falls_back_to_the_socket(on_cloud_run):
    req = _request({"X-Forwarded-For": "203.0.113.7, garbage"}, peer="10.0.0.9")
    assert client_ip(req) == "10.0.0.9"


def test_ipv6_is_normalized(on_cloud_run, with_secret):
    req = _request({CLIENT_IP_HEADER: "2001:DB8::0001", EDGE_KEY_HEADER: _SECRET})
    assert client_ip(req) == "2001:db8::1"


# ── story #4546: the backend behind Cloudflare (whether or not prod is — right either way) ──

_CF_EDGE = "172.70.1.2"  # in 172.64.0.0/13
_CF_EDGE_V6 = "2606:4700:10::1"


def test_4546_cloudflare_edge_at_the_right_end_trusts_cf_connecting_ip(on_cloud_run):
    """① the connecting address is a Cloudflare edge → the user is CF-Connecting-IP (Cloudflare always overwrites it)."""
    assert client_ip(_request({"X-Forwarded-For": f"192.0.2.9, {_CF_EDGE}", "CF-Connecting-IP": "203.0.113.7"})) == "203.0.113.7"
    assert client_ip(_request({"X-Forwarded-For": _CF_EDGE_V6, "CF-Connecting-IP": "2001:DB8::7"})) == "2001:db8::7"


def test_4546_a_non_cloudflare_right_end_ignores_a_forged_cf_connecting_ip(on_cloud_run):
    """② run.app direct: the connecting address is not Cloudflare → a CF-Connecting-IP the caller wrote is ignored."""
    assert client_ip(_request({"X-Forwarded-For": "198.51.100.9", "CF-Connecting-IP": "203.0.113.7"})) == "198.51.100.9"


def test_4546_a_forged_cloudflare_address_in_the_left_items_is_not_the_connecting_address(on_cloud_run):
    """③ a caller writing a Cloudflare address into XFF's left items does not make the request «from Cloudflare»."""
    forged = {"X-Forwarded-For": f"{_CF_EDGE}, 198.51.100.9", "CF-Connecting-IP": "203.0.113.7"}
    assert client_ip(_request(forged)) == "198.51.100.9"


def test_4546_cloudflare_edge_without_a_usable_cf_connecting_ip_keeps_the_edge(on_cloud_run):
    assert client_ip(_request({"X-Forwarded-For": _CF_EDGE})) == _CF_EDGE
    assert client_ip(_request({"X-Forwarded-For": _CF_EDGE, "CF-Connecting-IP": "nope"})) == _CF_EDGE


def test_4546_the_front_s_secret_still_wins_over_the_cloudflare_rule(on_cloud_run, with_secret):
    req = _request({CLIENT_IP_HEADER: "203.0.113.1", EDGE_KEY_HEADER: _SECRET, "X-Forwarded-For": _CF_EDGE, "CF-Connecting-IP": "192.0.2.5"})
    assert client_ip(req) == "203.0.113.1"


def test_4546_outside_cloud_run_cloudflare_headers_change_nothing(monkeypatch):
    monkeypatch.delenv("K_SERVICE", raising=False)
    assert client_ip(_request({"X-Forwarded-For": _CF_EDGE, "CF-Connecting-IP": "203.0.113.7"}, peer="127.0.0.1")) == "127.0.0.1"


def test_4546_every_cloudflare_range_is_used_by_the_check():
    """Each listed range is one the check really uses (Kadir 5019: the list pin alone let a range drop out of the check) — its
    first address is Cloudflare; the address just before it is not, unless that one is itself in a listed range."""
    import ipaddress

    from app.core.client_ip import CLOUDFLARE_IPV4_RANGES, CLOUDFLARE_IPV6_RANGES, is_cloudflare_address

    networks = [ipaddress.ip_network(r) for r in CLOUDFLARE_IPV4_RANGES + CLOUDFLARE_IPV6_RANGES]
    for net in networks:
        assert is_cloudflare_address(str(net.network_address)), f"{net} is listed but the check does not use it"
        assert is_cloudflare_address(str(net.broadcast_address)), f"{net}'s last address is not checked"
        before = net.network_address - 1
        if not any(before in other for other in networks):
            assert not is_cloudflare_address(str(before)), f"the address before {net} is not Cloudflare"


def test_4546_cloudflare_ranges_are_the_web_s_list():
    """One list: the backend's ranges are exactly the web's (apps/web/src/lib/client-ip.ts) — change one, this fails."""
    import re
    from pathlib import Path

    from app.core.client_ip import CLOUDFLARE_IPV4_RANGES, CLOUDFLARE_IPV6_RANGES

    web = (Path(__file__).resolve().parents[2] / "apps/web/src/lib/client-ip.ts").read_text(encoding="utf-8")

    def ranges(name: str) -> list[str]:
        block = re.search(rf"export const {name} = \[(.*?)\] as const;", web, re.S)
        assert block, f"{name} not found in client-ip.ts"
        return re.findall(r"'([^']+)'", block.group(1))

    assert list(CLOUDFLARE_IPV4_RANGES) == ranges("CLOUDFLARE_IPV4_RANGES")
    assert list(CLOUDFLARE_IPV6_RANGES) == ranges("CLOUDFLARE_IPV6_RANGES")


# ── 1단계 적용: resend 전용 limiter의 key_func로 실제 상한을 돌린다(메모리 저장 · 켜 둔 limiter) ──

def _limited_app() -> FastAPI:
    """실제 resend 전용 limiter가 쓰는 key_func를 그대로 가져와(배선까지 검증) 켜 둔 메모리 limiter에 건다."""
    from app.core.rate_limit import resend_verification_limiter

    limiter = Limiter(key_func=resend_verification_limiter._key_func, storage_uri="memory://", enabled=True)
    app = FastAPI()
    app.state.limiter = limiter

    @app.exception_handler(RateLimitExceeded)
    async def _429(request, exc):  # noqa: ANN001
        return JSONResponse(status_code=429, content={})

    @app.post("/limited")
    @limiter.limit("2/minute")
    async def limited(request: Request):
        return {"ok": True}

    return app


async def _statuses(app: FastAPI, header_sets: list[dict[str, str]]) -> list[int]:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        return [(await c.post("/limited", headers=h)).status_code for h in header_sets]


@pytest.mark.anyio
async def test_limit_counts_different_users_separately_through_the_frontend(on_cloud_run, with_secret):
    """프런트가 사용자마다 다른 IP를 비밀과 함께 넘기면 따로 센다 — 예전(앞단 주소 하나)이면 셋째부터 모두 429."""
    app = _limited_app()
    users = [{CLIENT_IP_HEADER: f"203.0.113.{n}", EDGE_KEY_HEADER: _SECRET, "X-Forwarded-For": "34.1.2.3"} for n in (1, 2, 3)]
    assert await _statuses(app, users * 2) == [200] * 6


@pytest.mark.anyio
async def test_forged_headers_on_a_direct_call_cannot_dodge_the_limit(on_cloud_run, with_secret):
    """직통 공격자가 요청마다 다른 X-Sprintable-Client-IP · XFF 앞 칸을 꾸며도 접속 주소 하나로 세어 셋째부터 429."""
    app = _limited_app()
    forged = [{CLIENT_IP_HEADER: f"203.0.113.{n}", EDGE_KEY_HEADER: "guess", "X-Forwarded-For": f"192.0.2.{n}, 198.51.100.9"}
              for n in (1, 2, 3, 4)]
    assert await _statuses(app, forged) == [200, 200, 429, 429]


@pytest.fixture
def anyio_backend():
    return "asyncio"
