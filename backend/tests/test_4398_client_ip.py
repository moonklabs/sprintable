"""story #4398 — 요청 상한이 셀 사용자 IP(`app.core.client_ip.client_ip`)와 1단계 적용(resend 전용 limiter)의 위조 표.

| 요청 | 꾸민 헤더 | 세는 IP |
| 프런트(비밀 맞음) | X-Sprintable-Client-IP | 그 값 |
| 백엔드 run.app 직통 | X-Sprintable-Client-IP · XFF 앞 칸 | XFF 오른쪽 끝(앞단이 붙인 접속 주소) |
| 비밀 미설정 | 전부 | XFF 오른쪽 끝 |
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
