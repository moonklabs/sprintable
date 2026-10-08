"""story #4398 — 요청 상한(slowapi)이 셀 사용자 IP를 정하는 한 곳.

신뢰 경계:
- 프런트(BFF)가 사용자 IP를 한 번 정해(Cloudflare 대역에서 온 접속일 때만 `CF-Connecting-IP`) `X-Sprintable-Client-IP`로 넘기고,
  `X-Sprintable-Edge-Key`에 공유 비밀을 싣는다. 비밀이 맞을 때만 그 값을 믿는다(상수 시간 비교).
- 그 밖(모바일 직통 · 백엔드 run.app 직통 · 비밀 미설정)은 Cloud Run 앞단(GFE)이 X-Forwarded-For **오른쪽 끝**에 붙인 접속 주소 —
  클라이언트가 보낸 XFF 앞 칸은 꾸밀 수 있지만 이 칸은 못 꾸민다.
  story #4546: 그 접속 주소가 **Cloudflare 공개 대역**이면(백엔드 도메인이 Cloudflare 뒤일 때) 사용자 IP = `CF-Connecting-IP`
  (Cloudflare가 늘 덮어씀) — 웹 `apps/web/src/lib/client-ip.ts`와 같은 규칙 · 같은 대역(시험이 두 목록을 맞물려 고정).
  접속 주소가 Cloudflare가 아니면(run.app 직통) 꾸민 `CF-Connecting-IP`는 무시한다.
- Cloud Run 밖(로컬 · 테스트)에선 소켓 주소(`request.client.host`).

⚠️ «XFF 오른쪽 끝 = 접속 주소»는 dev 로그 실측(4398 AC0 ④)이 전제 — 확인 전엔 병합하지 않는다.
"""
from __future__ import annotations

import hmac
import ipaddress
import os

from starlette.requests import Request

from app.core.config import settings

CLIENT_IP_HEADER = "x-sprintable-client-ip"
EDGE_KEY_HEADER = "x-sprintable-edge-key"

# story #4546 — Cloudflare가 공개한 자기 대역. 웹 client-ip.ts의 CLOUDFLARE_IPV4_RANGES · CLOUDFLARE_IPV6_RANGES와 같은 목록
# (출처 https://www.cloudflare.com/ips-v4 · ips-v6, 2026-09-28 조회) — 바꿀 땐 둘을 함께(test_4398_client_ip가 맞물림 고정).
CLOUDFLARE_IPV4_RANGES = (
    "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18",
    "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20", "197.234.240.0/22", "198.41.128.0/17",
    "162.158.0.0/15", "104.16.0.0/13", "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
)
CLOUDFLARE_IPV6_RANGES = (
    "2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32", "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32",
)
_CLOUDFLARE_NETWORKS = tuple(ipaddress.ip_network(r) for r in CLOUDFLARE_IPV4_RANGES + CLOUDFLARE_IPV6_RANGES)


def is_cloudflare_address(ip: str) -> bool:
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return any(addr.version == net.version and addr in net for net in _CLOUDFLARE_NETWORKS)


def _valid_ip(value: str | None) -> str | None:
    if not value:
        return None
    try:
        return str(ipaddress.ip_address(value.strip()))
    except ValueError:
        return None


def _on_cloud_run() -> bool:
    return bool(os.environ.get("K_SERVICE"))


def client_ip(request: Request) -> str:
    """요청 상한이 셀 사용자 IP. 위 신뢰 경계 순서대로 — 하나도 못 정하면 소켓 주소(없으면 빈 문자열이 아니라 "unknown")."""
    secret = settings.edge_client_ip_secret
    if secret:
        given = request.headers.get(EDGE_KEY_HEADER, "")
        forwarded_ip = _valid_ip(request.headers.get(CLIENT_IP_HEADER))
        if given and forwarded_ip and hmac.compare_digest(given.encode(), secret.encode()):
            return forwarded_ip
    if _on_cloud_run():
        xff = request.headers.get("x-forwarded-for", "")
        connecting = _valid_ip(xff.rsplit(",", 1)[-1]) if xff else None
        if connecting:
            if is_cloudflare_address(connecting):
                return _valid_ip(request.headers.get("cf-connecting-ip")) or connecting
            return connecting
    return request.client.host if request.client else "unknown"
