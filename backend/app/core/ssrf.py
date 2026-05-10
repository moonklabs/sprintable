"""SSRF 방어 유틸 — webhook URL이 private/link-local/metadata IP를 가리키지 않는지 검증."""
from __future__ import annotations

import ipaddress
import socket
from urllib.parse import urlparse

_BLOCKED_NETWORKS = [
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("169.254.0.0/16"),   # link-local (AWS/GCP metadata 포함)
    ipaddress.ip_network("127.0.0.0/8"),       # loopback
    ipaddress.ip_network("0.0.0.0/8"),
    ipaddress.ip_network("::1/128"),            # IPv6 loopback
    ipaddress.ip_network("fc00::/7"),           # IPv6 ULA private
    ipaddress.ip_network("fe80::/10"),          # IPv6 link-local
]


def _is_blocked_ip(ip: str) -> bool:
    try:
        addr = ipaddress.ip_address(ip)
        # ::ffff:x.x.x.x 형태의 IPv4-mapped IPv6 → IPv4로 언매핑 후 재검사
        if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped is not None:
            addr = addr.ipv4_mapped
        return any(addr in net for net in _BLOCKED_NETWORKS)
    except ValueError:
        return True  # 파싱 실패 → 차단


def validate_webhook_url(url: str) -> None:
    """URL hostname을 DNS resolve하여 private/link-local IP면 ValueError."""
    parsed = urlparse(url)
    hostname = parsed.hostname
    if not hostname:
        raise ValueError("Invalid URL: no hostname")

    try:
        infos = socket.getaddrinfo(hostname, None)
    except socket.gaierror as exc:
        raise ValueError(f"Cannot resolve hostname '{hostname}': {exc}") from exc

    for info in infos:
        ip = info[4][0]
        if _is_blocked_ip(ip):
            raise ValueError(f"URL resolves to blocked IP: {ip}")


async def validate_webhook_url_async(url: str) -> None:
    """Async context용 — thread pool에서 DNS resolve 실행 (이벤트 루프 블로킹 방지)."""
    import asyncio
    await asyncio.to_thread(validate_webhook_url, url)
