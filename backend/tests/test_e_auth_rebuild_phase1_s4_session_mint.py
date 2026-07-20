"""story 132e7204(E-AUTH-REBUILD M2 Phase1-S4) 계약 테스트: mint_session_cookie() 구조 검증.

⚠️non-prod Firebase 프로젝트 준비 전까지는 `_get_access_token`/`_call_create_session_cookie`를
모킹 — 오르테가군 승인(2026-07-15)한 mock-first 패턴. 실 Google API 형식(요청/응답 필드명)은
문서 근거이나 non-prod 프로젝트로 라이브 왕복 확인 전까지는 가정임을 명시(PR 설명에도 기재).
"""
from __future__ import annotations

import logging

import httpx
import pytest

from app.services import firebase_session_mint as mint_mod

ID_TOKEN = "fake-verified-id-token-value-should-never-be-logged"
PROJECT_ID = "test-project"


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _fake_response(status_code: int, json_body: dict) -> httpx.Response:
    return httpx.Response(status_code=status_code, json=json_body, request=httpx.Request("POST", "https://example.test"))


@pytest.mark.anyio
async def test_mint_success_returns_session_cookie(monkeypatch):
    monkeypatch.setattr(mint_mod, "_get_access_token", lambda: "fake-access-token")

    async def fake_call(access_token, id_token, project_id, valid_duration_seconds):
        assert access_token == "fake-access-token"
        assert id_token == ID_TOKEN
        assert project_id == PROJECT_ID
        return _fake_response(200, {"sessionCookie": "minted-cookie-value"})

    monkeypatch.setattr(mint_mod, "_call_create_session_cookie", fake_call)

    result = await mint_mod.mint_session_cookie(ID_TOKEN, PROJECT_ID)
    assert result == "minted-cookie-value"


@pytest.mark.anyio
async def test_mint_returns_none_when_adc_token_unavailable(monkeypatch):
    def fake_get_token():
        raise RuntimeError("no ADC credentials in this environment")

    monkeypatch.setattr(mint_mod, "_get_access_token", fake_get_token)
    result = await mint_mod.mint_session_cookie(ID_TOKEN, PROJECT_ID)
    assert result is None


@pytest.mark.anyio
async def test_mint_returns_none_on_network_error(monkeypatch):
    monkeypatch.setattr(mint_mod, "_get_access_token", lambda: "fake-access-token")

    async def fake_call(*args, **kwargs):
        raise httpx.ConnectError("connection refused")

    monkeypatch.setattr(mint_mod, "_call_create_session_cookie", fake_call)
    result = await mint_mod.mint_session_cookie(ID_TOKEN, PROJECT_ID)
    assert result is None


@pytest.mark.anyio
async def test_mint_returns_none_when_google_rejects(monkeypatch):
    monkeypatch.setattr(mint_mod, "_get_access_token", lambda: "fake-access-token")

    async def fake_call(*args, **kwargs):
        return _fake_response(400, {"error": {"message": "INVALID_ID_TOKEN"}})

    monkeypatch.setattr(mint_mod, "_call_create_session_cookie", fake_call)
    result = await mint_mod.mint_session_cookie(ID_TOKEN, PROJECT_ID)
    assert result is None


@pytest.mark.anyio
async def test_mint_returns_none_on_malformed_response(monkeypatch):
    monkeypatch.setattr(mint_mod, "_get_access_token", lambda: "fake-access-token")

    async def fake_call(*args, **kwargs):
        return _fake_response(200, {"unexpected": "shape"})  # sessionCookie 필드 없음

    monkeypatch.setattr(mint_mod, "_call_create_session_cookie", fake_call)
    result = await mint_mod.mint_session_cookie(ID_TOKEN, PROJECT_ID)
    assert result is None


@pytest.mark.anyio
async def test_id_token_never_appears_in_logs(monkeypatch, caplog):
    """doc §6.4 acceptance test 9: id_token/세션쿠키 값이 로그에 절대 안 남는지 성공/실패
    경로 모두에서 확인."""
    monkeypatch.setattr(mint_mod, "_get_access_token", lambda: "fake-access-token")

    async def fake_call_success(*args, **kwargs):
        return _fake_response(200, {"sessionCookie": "secret-cookie-value-xyz"})

    monkeypatch.setattr(mint_mod, "_call_create_session_cookie", fake_call_success)
    with caplog.at_level(logging.DEBUG):
        result = await mint_mod.mint_session_cookie(ID_TOKEN, PROJECT_ID)
    assert result == "secret-cookie-value-xyz"
    all_log_text = "\n".join(record.getMessage() for record in caplog.records)
    assert ID_TOKEN not in all_log_text
    assert "secret-cookie-value-xyz" not in all_log_text

    caplog.clear()

    async def fake_call_failure(*args, **kwargs):
        return _fake_response(401, {"error": {"message": "INVALID"}})

    monkeypatch.setattr(mint_mod, "_call_create_session_cookie", fake_call_failure)
    with caplog.at_level(logging.DEBUG):
        result2 = await mint_mod.mint_session_cookie(ID_TOKEN, PROJECT_ID)
    assert result2 is None
    all_log_text2 = "\n".join(record.getMessage() for record in caplog.records)
    assert ID_TOKEN not in all_log_text2
