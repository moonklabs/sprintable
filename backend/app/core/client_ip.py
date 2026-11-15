"""story #4398 — 요청 상한(slowapi)이 셀 사용자 IP를 정하는 한 곳.

신뢰 경계:
- 프런트(BFF)가 사용자 IP를 한 번 정해(Cloudflare 대역에서 온 접속일 때만 `CF-Connecting-IP`) `X-Sprintable-Client-IP`로 넘기고,
  `X-Sprintable-Edge-Key`에 공유 비밀을 싣는다. 비밀이 맞을 때만 그 값을 믿는다(상수 시간 비교).
- 그 밖(모바일 직통 · 백엔드 run.app 직통 · 비밀 미설정)은 Cloud Run 앞단(GFE)이 X-Forwarded-For **오른쪽 끝**에 붙인 접속 주소 —
  클라이언트가 보낸 XFF 앞 칸은 꾸밀 수 있지만 이 칸은 못 꾸민다.
  story #4546: 그 접속 주소가 **Cloudflare 공개 대역**이면(백엔드 도메인이 Cloudflare 뒤일 때) 사용자 IP = `CF-Connecting-IP`
  (Cloudflare가 늘 덮어씀) — 웹 `apps/web/src/lib/client-ip.ts`와 같은 규칙 · 같은 대역(시험이 두 목록을 맞물려 고정).
  접속 주소가 Cloudflare가 아니면(run.app 직통) 꾸민 `CF-Connecting-IP`는 무시한다.
- Cloud Run 밖(로컬 · 테스트)에선 소켓 주소(`request.client.host`). 단 VM처럼 앞문(Caddy)이 XFF를 덮어써 한 칸만 남기는 배포는
  `TRUST_FORWARDED_FOR=true`로 Cloud Run과 같은 규칙을 쓴다(story 4796) — 안 켜면 VM에선 모든 사용자가 앞문 주소 하나로 세어진다.

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


def _behind_trusted_front() -> bool:
    """XFF 오른쪽 끝을 접속 주소로 믿어도 되는 배포인가 — Cloud Run 앞단(GFE), 또는 VM에서 Caddy가 XFF를 덮어쓰는 배포(story 4796, TRUST_FORWARDED_FOR)."""
    return _on_cloud_run() or settings.trust_forwarded_for


def client_ip_with_source(request: Request) -> tuple[str, str]:
    """(요청 상한이 셀 사용자 IP, 그 IP를 어느 길로 정했나). 길 = `edge`(프런트가 비밀과 함께 넘김) · `xff`(앞문이 덮어쓴 오른쪽 끝) · `cf`(그 끝이 Cloudflare 대역이라 CF-Connecting-IP) · `socket`(소켓 주소).
    story 4915 AC6 — 길을 같이 돌려주는 이유: 설정이 틀리면(비밀 불일치 · TRUST_FORWARDED_FOR 꺼짐) 조용히 `socket`으로 떨어져 «모든 사용자가 한 통»이 되므로, 어느 길로 정했는지를 로그로 볼 수 있어야 한다."""
    secret = settings.edge_client_ip_secret
    if secret:
        given = request.headers.get(EDGE_KEY_HEADER, "")
        forwarded_ip = _valid_ip(request.headers.get(CLIENT_IP_HEADER))
        if given and forwarded_ip and hmac.compare_digest(given.encode(), secret.encode()):
            return forwarded_ip, "edge"
    if _behind_trusted_front():
        # several header LINES (not only several comma-separated entries) are possible: the front door appends its own line last, so the last line's last entry is the connecting address
        # (`headers.get()` would return the FIRST line — the one a client can send)
        getlist = getattr(request.headers, "getlist", None)
        lines = getlist("x-forwarded-for") if getlist else ([request.headers["x-forwarded-for"]] if "x-forwarded-for" in request.headers else [])
        xff = lines[-1] if lines else ""
        connecting = _valid_ip(xff.rsplit(",", 1)[-1]) if xff else None
        if connecting:
            if is_cloudflare_address(connecting):
                cf = _valid_ip(request.headers.get("cf-connecting-ip"))
                return (cf, "cf") if cf else (connecting, "xff")
            return connecting, "xff"
    return (request.client.host if request.client else "unknown"), "socket"


def client_ip(request: Request) -> str:
    """요청 상한이 셀 사용자 IP. 위 신뢰 경계 순서대로 — 하나도 못 정하면 소켓 주소(없으면 빈 문자열이 아니라 "unknown")."""
    return client_ip_with_source(request)[0]


def fold_ip(ip: str) -> str:
    """상한 통을 가르는 «사람 단위 주소». IPv6는 사용자가 자기 /64 안에서 주소를 마음대로 바꿀 수 있어(가정용 회선이 /64를 통째로 줌) 주소 전체를 키로 쓰면 요청마다 통을 갈아탈 수 있다 → /64 접두로 접는다.
    IPv4-mapped IPv6(`::ffff:a.b.c.d`)는 같은 IPv4로 푼다. 주소가 아니면(`unknown` 등) 그대로."""
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return ip
    if addr.version == 6:
        if addr.ipv4_mapped is not None:
            return str(addr.ipv4_mapped)
        return str(ipaddress.ip_network((addr, 64), strict=False))
    return str(addr)


def audit_client_ip(request: Request) -> str | None:
    """The address an AUDIT row records (`login_audit_logs.ip_address`): the same rule as `client_ip`, NOT folded (an investigation needs the exact address) and `None` — not the string "unknown" — when no rule found one.
    story 4915: these rows were written from the socket address (`request.client.host`), which behind the front door (Cloud Run's front end · the VM's front container) is the same address for every person."""
    ip = client_ip(request)
    return None if ip == "unknown" else ip
