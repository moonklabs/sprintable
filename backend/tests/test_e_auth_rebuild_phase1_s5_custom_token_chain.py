"""story 4dee942b(E-AUTH-REBUILD M2 Phase1-S5) 계약 테스트: mint_custom_token()→
exchange_custom_token_for_id_token()→mint_session_cookie_for_uid() 체인 구조 검증.

⚠️mock-first(오르테가군 승인 2026-07-15, S4와 동일 패턴) — ADC 서명/Google REST 응답 형식은
non-prod 프로젝트 준비 후 실 왕복으로 재확인 필요.
"""
from __future__ import annotations

import logging

import httpx
import pytest

from app.services import firebase_session_mint as mint_mod

FIREBASE_UID = "firebase-uid-native-1"
PROJECT_ID = "test-project"
WEB_API_KEY = "fake-web-api-key"


@pytest.fixture
def anyio_backend():
    return "asyncio"


class _FakeServiceAccountCredentials:
    service_account_email = "sa@test-project.iam.gserviceaccount.com"

    def sign_bytes(self, data: bytes) -> bytes:
        return b"fake-signature-bytes"


def _fake_response(status_code: int, json_body: dict) -> httpx.Response:
    return httpx.Response(status_code=status_code, json=json_body, request=httpx.Request("POST", "https://example.test"))


@pytest.mark.anyio
async def test_mint_custom_token_success_with_service_account_credentials(monkeypatch):
    monkeypatch.setattr(mint_mod, "_get_signing_credentials", lambda: _FakeServiceAccountCredentials())
    token = mint_mod.mint_custom_token(FIREBASE_UID)
    assert token is not None
    # 3-part JWT shape (header.payload.signature), 서명값 자체는 fake라 검증 안 함 — 구조만.
    assert token.count(".") == 2


@pytest.mark.anyio
async def test_mint_custom_token_returns_none_when_adc_unavailable(monkeypatch):
    def raise_error():
        raise RuntimeError("no ADC")
    monkeypatch.setattr(mint_mod, "_get_signing_credentials", raise_error)
    assert mint_mod.mint_custom_token(FIREBASE_UID) is None


@pytest.mark.anyio
async def test_mint_custom_token_returns_none_for_user_credentials_without_signer(monkeypatch):
    """gcloud auth application-default login(사용자 자격증명)엔 sign_bytes가 없다 — service
    account만 custom token 서명 가능(로컬 개발 함정 명시 회귀 가드)."""
    class _UserCredentials:
        pass
    monkeypatch.setattr(mint_mod, "_get_signing_credentials", lambda: _UserCredentials())
    assert mint_mod.mint_custom_token(FIREBASE_UID) is None


@pytest.mark.anyio
async def test_exchange_custom_token_success(monkeypatch):
    async def fake_call(custom_token, web_api_key):
        assert web_api_key == WEB_API_KEY
        return _fake_response(200, {"idToken": "exchanged-id-token-value"})
    monkeypatch.setattr(mint_mod, "_call_sign_in_with_custom_token", fake_call)
    result = await mint_mod.exchange_custom_token_for_id_token("fake-custom-token", WEB_API_KEY)
    assert result == "exchanged-id-token-value"


@pytest.mark.anyio
async def test_exchange_custom_token_returns_none_without_web_api_key():
    result = await mint_mod.exchange_custom_token_for_id_token("fake-custom-token", "")
    assert result is None


@pytest.mark.anyio
async def test_exchange_custom_token_returns_none_on_rejection(monkeypatch):
    async def fake_call(custom_token, web_api_key):
        return _fake_response(400, {"error": {"message": "INVALID_CUSTOM_TOKEN"}})
    monkeypatch.setattr(mint_mod, "_call_sign_in_with_custom_token", fake_call)
    result = await mint_mod.exchange_custom_token_for_id_token("fake-custom-token", WEB_API_KEY)
    assert result is None


@pytest.mark.anyio
async def test_mint_session_cookie_for_uid_full_chain_success(monkeypatch):
    monkeypatch.setattr(mint_mod, "_get_signing_credentials", lambda: _FakeServiceAccountCredentials())

    async def fake_exchange_call(custom_token, web_api_key):
        return _fake_response(200, {"idToken": "exchanged-id-token"})
    monkeypatch.setattr(mint_mod, "_call_sign_in_with_custom_token", fake_exchange_call)

    monkeypatch.setattr(mint_mod, "_get_access_token", lambda: "fake-access-token")

    async def fake_session_call(access_token, id_token, project_id, valid_duration_seconds):
        assert id_token == "exchanged-id-token"
        return _fake_response(200, {"sessionCookie": "final-session-cookie"})
    monkeypatch.setattr(mint_mod, "_call_create_session_cookie", fake_session_call)

    result = await mint_mod.mint_session_cookie_for_uid(FIREBASE_UID, PROJECT_ID, WEB_API_KEY)
    assert result == "final-session-cookie"


@pytest.mark.anyio
async def test_mint_session_cookie_for_uid_returns_none_when_custom_token_fails(monkeypatch):
    def raise_error():
        raise RuntimeError("no ADC")
    monkeypatch.setattr(mint_mod, "_get_signing_credentials", raise_error)
    result = await mint_mod.mint_session_cookie_for_uid(FIREBASE_UID, PROJECT_ID, WEB_API_KEY)
    assert result is None


@pytest.mark.anyio
async def test_mint_session_cookie_for_uid_returns_none_when_exchange_fails(monkeypatch):
    monkeypatch.setattr(mint_mod, "_get_signing_credentials", lambda: _FakeServiceAccountCredentials())

    async def fake_exchange_call(custom_token, web_api_key):
        return _fake_response(400, {"error": {"message": "INVALID"}})
    monkeypatch.setattr(mint_mod, "_call_sign_in_with_custom_token", fake_exchange_call)

    result = await mint_mod.mint_session_cookie_for_uid(FIREBASE_UID, PROJECT_ID, WEB_API_KEY)
    assert result is None


@pytest.mark.anyio
async def test_custom_token_and_exchange_never_appear_in_logs(monkeypatch, caplog):
    monkeypatch.setattr(mint_mod, "_get_signing_credentials", lambda: _FakeServiceAccountCredentials())

    async def fake_exchange_call(custom_token, web_api_key):
        return _fake_response(200, {"idToken": "super-secret-id-token"})
    monkeypatch.setattr(mint_mod, "_call_sign_in_with_custom_token", fake_exchange_call)

    with caplog.at_level(logging.DEBUG):
        custom_token = mint_mod.mint_custom_token(FIREBASE_UID)
        id_token = await mint_mod.exchange_custom_token_for_id_token(custom_token, WEB_API_KEY)
    assert id_token == "super-secret-id-token"

    all_log_text = "\n".join(record.getMessage() for record in caplog.records)
    assert custom_token not in all_log_text
    assert "super-secret-id-token" not in all_log_text
