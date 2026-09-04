"""story e4fc29fa(Phase1·마케팅운영, 페드루 PO 確定 2026-09-04, 조각④) — 고객이 넣는
목적지 URL(WordPress site_url·webhook target) 전부가 거치는 공용 SSRF 방지 검사.

wordpress_publish.py(조각③b)의 `_validate_https`가 문자열 프리픽스만 봤다 — 페드루
리뷰 B1(조각③c)로 loopback 예외를 dev 플래그로 잠갔지만, **문자열 검사 자체의 한계**
(도메인이 나중에 내부 IP로 rebind되는 DNS rebinding류)는 그대로 남아 있었다. 여기서는
호스트를 실제로 DNS 해석하고 **해석된 모든 IP**가 사설(RFC1918)·loopback·link-local
(169.254.0.0/16 — GCP/AWS/Azure 클라우드 메타데이터 169.254.169.254가 이 대역 안)·
예약/멀티캐스트/미지정이 아님을 확인한 뒤에만 통과시킨다("해석 시점" 검사, PO 明示).

TOCTOU 한계(明示, 스코프 결정) — 이 검사와 실제 연결 사이에 DNS 응답이 다시 바뀌는
찰나의 rebinding까지 막으려면 검증한 IP로 직접 연결(SNI/Host는 원 호스트 유지)하는
IP-pinning이 필요하다. 이 조각은 그 전 단계(해석 시점 IP 블록리스트)까지 — 발행 요청은
사람의 승인 행위 뒤에나 재시도 주기(분 단위)로만 일어나 실시간 rebinding 경합의 실익이
낮다는 판단(발행 빈도·타이밍이 공격자 통제 밖). IP-pinning은 후속 강화 항목으로 명시
남긴다."""
from __future__ import annotations

import asyncio
import ipaddress
import socket
from urllib.parse import urlsplit

_LOOPBACK_HOSTS = ("127.0.0.1", "localhost")


def _resolve_host(host: str, port: int | None) -> list:
    """story e4fc29fa(조각⑤ 발견·즉시수정) — `socket.getaddrinfo`를 직접 참조하지
    않고 이 얇은 함수 뒤로 감싼다. 테스트가 DNS 해석을 결정적으로 통제하려고
    `socket.getaddrinfo` 자체를 monkeypatch하면(가장 직관적인 방법처럼 보인다)
    **프로세스 전역**이 바뀌어 같은 테스트 안의 asyncpg(Postgres 커넥션도 내부에서
    호스트를 해석한다)까지 오작동해 DB 커넥션이 타임아웃난다(실측 확認 — 이 조각의
    connection-creation 테스트가 dns_stub과 실 DB를 같이 쓰다가 처음 이 증상을
    냈다). 이 함수 하나만 patch 대상으로 삼으면(tests/conftest.py::dns_stub) 다른
    소켓 사용처는 전혀 안 건드린다."""
    return socket.getaddrinfo(host, port)


class DestinationURLUnsafeError(ValueError):
    """목적지 URL이 https://가 아니거나, 해석된 IP가 사설/loopback/link-local 등
    내부망 대역이다(SSRF fail-closed)."""

    def __init__(self, *, url: str, reason: str):
        self.url = url
        self.reason = reason
        super().__init__(f"목적지 URL이 안전하지 않습니다({reason}): {url!r}")


def _unsafe_ip_reason(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> str | None:
    if ip.is_loopback:
        return "loopback"
    if ip.is_link_local:
        return "link-local(클라우드 메타데이터 169.254.169.254 포함 대역)"
    if ip.is_private:
        return "사설 대역(RFC1918)"
    if ip.is_reserved:
        return "예약 대역"
    if ip.is_multicast:
        return "멀티캐스트"
    if ip.is_unspecified:
        return "미지정 주소"
    return None


async def assert_destination_url_safe(url: str, *, allow_loopback: bool = False) -> str:
    """https:// 강제 — `allow_loopback=True`(호출자가 자기 dev 스텁 플래그로 이미
    게이트한 경우만 전달)면 `http://127.0.0.1`·`http://localhost`만 예외(DNS 해석·IP
    블록리스트는 생략 — loopback은 정의상 이미 안전한 대상, 신뢰된 자기 자신).

    그 외엔 스킴이 https://여야 하고, host를 실제로 DNS 해석해(`socket.getaddrinfo`,
    블로킹이라 executor로) 해석된 모든 IP가 안전해야 통과한다.

    반환값은 trailing slash를 제거한 url(호출자가 base로 그대로 쓴다 — 기존
    `_validate_https`의 반환 계약과 동형)."""
    parsed = urlsplit(url)
    host = parsed.hostname
    if not host:
        raise DestinationURLUnsafeError(url=url, reason="host가 없습니다")

    if allow_loopback and parsed.scheme == "http" and host in _LOOPBACK_HOSTS:
        return url.rstrip("/")

    if parsed.scheme != "https":
        raise DestinationURLUnsafeError(url=url, reason="https://가 아닙니다")

    loop = asyncio.get_running_loop()
    try:
        infos = await loop.run_in_executor(None, _resolve_host, host, None)
    except socket.gaierror as exc:
        raise DestinationURLUnsafeError(url=url, reason=f"DNS 해석 실패: {exc}") from exc

    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        reason = _unsafe_ip_reason(ip)
        if reason is not None:
            raise DestinationURLUnsafeError(url=url, reason=f"해석된 IP {ip}가 {reason}")

    return url.rstrip("/")
