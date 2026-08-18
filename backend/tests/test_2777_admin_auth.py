"""story #2777 — require_admin_operator 단위 테스트(DB 불요, id_token 검증만 mock).

fail-closed 3축: ①미설정(audience/allowlist 없음)=503 ②토큰 검증 실패/이메일 미검증=403
③allowlist 밖 이메일=403. 통과 1축 확認."""
from __future__ import annotations

import pytest
from fastapi import HTTPException

from app.core.config import settings
from app.dependencies import admin_auth


@pytest.fixture(autouse=True)
def _reset_settings():
    orig_audience = settings.admin_operator_audience
    orig_allowlist = settings.admin_operator_allowlist
    yield
    settings.admin_operator_audience = orig_audience
    settings.admin_operator_allowlist = orig_allowlist


@pytest.mark.asyncio
async def test_unconfigured_audience_fails_closed_503():
    settings.admin_operator_audience = ""
    settings.admin_operator_allowlist = "operator@moonklabs.com"

    with pytest.raises(HTTPException) as exc_info:
        await admin_auth.require_admin_operator(authorization="Bearer whatever")
    assert exc_info.value.status_code == 503


@pytest.mark.asyncio
async def test_unconfigured_allowlist_fails_closed_503():
    settings.admin_operator_audience = "https://backend.example.com"
    settings.admin_operator_allowlist = ""

    with pytest.raises(HTTPException) as exc_info:
        await admin_auth.require_admin_operator(authorization="Bearer whatever")
    assert exc_info.value.status_code == 503


@pytest.mark.asyncio
async def test_missing_authorization_header_403():
    settings.admin_operator_audience = "https://backend.example.com"
    settings.admin_operator_allowlist = "operator@moonklabs.com"

    with pytest.raises(HTTPException) as exc_info:
        await admin_auth.require_admin_operator(authorization=None)
    assert exc_info.value.status_code == 403


@pytest.mark.asyncio
async def test_token_verify_failure_403(monkeypatch):
    settings.admin_operator_audience = "https://backend.example.com"
    settings.admin_operator_allowlist = "operator@moonklabs.com"

    def _raise(*_a, **_k):
        raise ValueError("bad token")

    monkeypatch.setattr(admin_auth.id_token, "verify_oauth2_token", _raise)

    with pytest.raises(HTTPException) as exc_info:
        await admin_auth.require_admin_operator(authorization="Bearer bad")
    assert exc_info.value.status_code == 403


@pytest.mark.asyncio
async def test_email_not_in_allowlist_403(monkeypatch):
    settings.admin_operator_audience = "https://backend.example.com"
    settings.admin_operator_allowlist = "operator@moonklabs.com"

    monkeypatch.setattr(
        admin_auth.id_token, "verify_oauth2_token",
        lambda *a, **k: {"email": "intruder@evil.com", "email_verified": True, "sub": "123"},
    )

    with pytest.raises(HTTPException) as exc_info:
        await admin_auth.require_admin_operator(authorization="Bearer token")
    assert exc_info.value.status_code == 403


@pytest.mark.asyncio
async def test_valid_operator_passes(monkeypatch):
    settings.admin_operator_audience = "https://backend.example.com"
    settings.admin_operator_allowlist = "operator@moonklabs.com, other@moonklabs.com"

    monkeypatch.setattr(
        admin_auth.id_token, "verify_oauth2_token",
        lambda *a, **k: {"email": "Operator@moonklabs.com", "email_verified": True, "sub": "123"},
    )

    result = await admin_auth.require_admin_operator(authorization="Bearer token")
    assert result.email == "operator@moonklabs.com"  # 대소문자 정규화
    assert result.subject == "123"
