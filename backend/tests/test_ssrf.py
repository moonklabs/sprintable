"""SEC-04: SSRF 차단 단위 테스트."""
from __future__ import annotations

import socket
from unittest.mock import patch

import pytest
from fastapi import HTTPException


def _addrinfo(ip: str):
    """socket.getaddrinfo 반환 형식 모킹."""
    return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, 0))]


# ─── _is_blocked_ip ────────────────────────────────────────────────────────────

def test_private_10_blocked():
    from app.core.ssrf import _is_blocked_ip
    assert _is_blocked_ip("10.0.0.1") is True
    assert _is_blocked_ip("10.255.255.255") is True


def test_private_172_blocked():
    from app.core.ssrf import _is_blocked_ip
    assert _is_blocked_ip("172.16.0.1") is True
    assert _is_blocked_ip("172.31.255.255") is True


def test_private_192_168_blocked():
    from app.core.ssrf import _is_blocked_ip
    assert _is_blocked_ip("192.168.1.1") is True


def test_link_local_169_blocked():
    from app.core.ssrf import _is_blocked_ip
    assert _is_blocked_ip("169.254.169.254") is True  # AWS 메타데이터 서버


def test_loopback_blocked():
    from app.core.ssrf import _is_blocked_ip
    assert _is_blocked_ip("127.0.0.1") is True
    assert _is_blocked_ip("::1") is True


def test_public_ip_allowed():
    from app.core.ssrf import _is_blocked_ip
    assert _is_blocked_ip("1.2.3.4") is False
    assert _is_blocked_ip("8.8.8.8") is False
    assert _is_blocked_ip("52.223.0.1") is False  # Discord CDN 대역


# ─── validate_webhook_url ──────────────────────────────────────────────────────

def test_validate_blocks_private_ip():
    from app.core.ssrf import validate_webhook_url
    with patch("socket.getaddrinfo", return_value=_addrinfo("192.168.1.100")):
        with pytest.raises(ValueError, match="blocked IP"):
            validate_webhook_url("https://internal.example.com/hook")


def test_validate_blocks_metadata_ip():
    from app.core.ssrf import validate_webhook_url
    with patch("socket.getaddrinfo", return_value=_addrinfo("169.254.169.254")):
        with pytest.raises(ValueError, match="blocked IP"):
            validate_webhook_url("https://metadata.example.com/hook")


def test_validate_blocks_loopback():
    from app.core.ssrf import validate_webhook_url
    with patch("socket.getaddrinfo", return_value=_addrinfo("127.0.0.1")):
        with pytest.raises(ValueError, match="blocked IP"):
            validate_webhook_url("https://localhost/hook")


def test_validate_passes_public_ip():
    from app.core.ssrf import validate_webhook_url
    with patch("socket.getaddrinfo", return_value=_addrinfo("162.159.135.232")):
        validate_webhook_url("https://discord.com/api/webhooks/123/abc")  # 예외 없음


def test_validate_raises_on_dns_failure():
    from app.core.ssrf import validate_webhook_url
    with patch("socket.getaddrinfo", side_effect=socket.gaierror("NXDOMAIN")):
        with pytest.raises(ValueError, match="Cannot resolve"):
            validate_webhook_url("https://nonexistent.invalid/hook")


# ─── schema validator 통합 ────────────────────────────────────────────────────

def test_schema_blocks_private_ip_url():
    from app.schemas.webhook_config import UpsertWebhookConfig
    import uuid
    with patch("socket.getaddrinfo", return_value=_addrinfo("10.0.0.1")):
        with pytest.raises(Exception):  # pydantic ValidationError
            UpsertWebhookConfig(
                member_id=uuid.uuid4(),
                url="https://internal.corp/hook",
            )


def test_schema_passes_public_url():
    from app.schemas.webhook_config import UpsertWebhookConfig
    import uuid
    with patch("socket.getaddrinfo", return_value=_addrinfo("162.159.135.232")):
        obj = UpsertWebhookConfig(
            member_id=uuid.uuid4(),
            url="https://discord.com/api/webhooks/123/abc",
        )
    assert obj.url == "https://discord.com/api/webhooks/123/abc"
