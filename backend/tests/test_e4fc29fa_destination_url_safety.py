"""story e4fc29fa(Phase1·마케팅운영, 페드루 PO 確定 2026-09-04, 조각④) —
`destination_url_safety.py`(공용 SSRF 방지 헬퍼, wordpress_publish.py·webhook_publish.py
공유) 직접 단위 테스트. `dns_stub`(tests/conftest.py)로 실 네트워크 없이 결정적으로
DNS 해석을 통제한다."""
from __future__ import annotations

import pytest

from app.services.destination_url_safety import (
    DestinationURLUnsafeError,
    assert_destination_url_safe,
)


@pytest.mark.anyio
async def test_allows_https_url_resolving_to_public_ip(dns_stub):
    url = await assert_destination_url_safe("https://customer-blog.example.com/")
    assert url == "https://customer-blog.example.com"


@pytest.mark.anyio
async def test_rejects_http_scheme():
    with pytest.raises(DestinationURLUnsafeError):
        await assert_destination_url_safe("http://customer-blog.example.com")


@pytest.mark.anyio
async def test_rejects_domain_resolving_to_private_ip(dns_stub):
    """DNS rebinding류 — 문자열은 평범한 도메인이어도 해석된 IP가 RFC1918 사설
    대역이면 거부한다. 뮤테이션 대상: DNS 해석 단계를 지우면(스킴만 검사) RED."""
    dns_stub.map("attacker.example.com", "10.0.0.5")
    with pytest.raises(DestinationURLUnsafeError):
        await assert_destination_url_safe("https://attacker.example.com")


@pytest.mark.anyio
async def test_rejects_domain_resolving_to_loopback(dns_stub):
    dns_stub.map("attacker.example.com", "127.0.0.1")
    with pytest.raises(DestinationURLUnsafeError):
        await assert_destination_url_safe("https://attacker.example.com")


@pytest.mark.anyio
async def test_rejects_domain_resolving_to_link_local_metadata_ip(dns_stub):
    """169.254.169.254 — GCP/AWS/Azure 클라우드 메타데이터 SSRF 표적. 뮤테이션 대상:
    link-local 검사를 지우면 이 assert가 RED(메타데이터 자격 탈취 클래스)."""
    dns_stub.map("attacker.example.com", "169.254.169.254")
    with pytest.raises(DestinationURLUnsafeError) as exc_info:
        await assert_destination_url_safe("https://attacker.example.com")
    assert "link-local" in str(exc_info.value)


@pytest.mark.anyio
async def test_rejects_url_with_no_host():
    with pytest.raises(DestinationURLUnsafeError):
        await assert_destination_url_safe("https://")


@pytest.mark.anyio
async def test_rejects_dns_resolution_failure(monkeypatch):
    """gaierror(NXDOMAIN 등)도 fail-closed — "안전하다고 확인 못 함"을 통과로 지어내지
    않는다. 실 네트워크에 기대지 않도록 getaddrinfo 자체가 에러를 던지게 스텁한다."""
    import socket as socket_mod

    def _raise(*args, **kwargs):
        raise socket_mod.gaierror("Name or service not known")

    monkeypatch.setattr(socket_mod, "getaddrinfo", _raise)
    with pytest.raises(DestinationURLUnsafeError):
        await assert_destination_url_safe("https://this-domain-does-not-exist-e4fc29fa.invalid")


@pytest.mark.anyio
async def test_allow_loopback_true_skips_dns_for_loopback_host():
    """allow_loopback=True(호출자가 자기 dev 스텁 플래그로 이미 게이트)면 http://
    127.0.0.1·http://localhost는 DNS 해석 없이 통과 — dns_stub 없이도(=진짜 DNS를
    안 탄다는 증거) 성공해야 한다."""
    url = await assert_destination_url_safe("http://127.0.0.1:8080/", allow_loopback=True)
    assert url == "http://127.0.0.1:8080"
    url2 = await assert_destination_url_safe("http://localhost:8080/", allow_loopback=True)
    assert url2 == "http://localhost:8080"


@pytest.mark.anyio
async def test_allow_loopback_false_rejects_loopback_scheme():
    with pytest.raises(DestinationURLUnsafeError):
        await assert_destination_url_safe("http://127.0.0.1:8080/", allow_loopback=False)


@pytest.mark.anyio
async def test_allow_loopback_true_still_rejects_non_loopback_http():
    """allow_loopback=True는 loopback host만의 예외다 — 다른 http:// 도메인은 그대로
    거부(뮤테이션 대상: allow_loopback이 스킴 강제 전체를 무력화하면 RED)."""
    with pytest.raises(DestinationURLUnsafeError):
        await assert_destination_url_safe("http://customer-blog.example.com", allow_loopback=True)
