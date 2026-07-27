"""story bea25062(§17d-1 ③) 계약 테스트: revoke_firebase_refresh_tokens() 구조 검증.
mock-first(S4/S5와 동일 패턴) — 실 Google REST 응답 형식은 non-prod 프로젝트 준비 후 재확인.
"""
from __future__ import annotations

import logging

import httpx
import pytest

from app.services import firebase_session_mint as mint_mod

FIREBASE_UID = "firebase-uid-revoke-1"
PROJECT_ID = "test-project"


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _fake_response(status_code: int, json_body: dict) -> httpx.Response:
    return httpx.Response(status_code=status_code, json=json_body, request=httpx.Request("POST", "https://example.test"))


@pytest.mark.anyio
async def test_revoke_success(monkeypatch):
    monkeypatch.setattr(mint_mod, "_get_access_token", lambda: "fake-access-token")

    async def fake_call(access_token, uid, project_id):
        assert access_token == "fake-access-token"
        assert uid == FIREBASE_UID
        assert project_id == PROJECT_ID
        return _fake_response(200, {"localId": [FIREBASE_UID]})
    monkeypatch.setattr(mint_mod, "_call_accounts_update_valid_since", fake_call)

    result = await mint_mod.revoke_firebase_refresh_tokens(FIREBASE_UID, PROJECT_ID)
    assert result is True


@pytest.mark.anyio
async def test_revoke_returns_false_when_adc_unavailable(monkeypatch):
    def raise_error():
        raise RuntimeError("no ADC")
    monkeypatch.setattr(mint_mod, "_get_access_token", raise_error)
    result = await mint_mod.revoke_firebase_refresh_tokens(FIREBASE_UID, PROJECT_ID)
    assert result is False


@pytest.mark.anyio
async def test_revoke_returns_false_on_network_error(monkeypatch):
    monkeypatch.setattr(mint_mod, "_get_access_token", lambda: "fake-access-token")

    async def fake_call(*args, **kwargs):
        raise httpx.ConnectError("connection refused")
    monkeypatch.setattr(mint_mod, "_call_accounts_update_valid_since", fake_call)

    result = await mint_mod.revoke_firebase_refresh_tokens(FIREBASE_UID, PROJECT_ID)
    assert result is False


@pytest.mark.anyio
async def test_revoke_returns_false_on_rejection(monkeypatch):
    monkeypatch.setattr(mint_mod, "_get_access_token", lambda: "fake-access-token")

    async def fake_call(*args, **kwargs):
        return _fake_response(400, {"error": {"message": "USER_NOT_FOUND"}})
    monkeypatch.setattr(mint_mod, "_call_accounts_update_valid_since", fake_call)

    result = await mint_mod.revoke_firebase_refresh_tokens(FIREBASE_UID, PROJECT_ID)
    assert result is False


@pytest.mark.anyio
async def test_firebase_uid_never_appears_in_logs(monkeypatch, caplog):
    monkeypatch.setattr(mint_mod, "_get_access_token", lambda: "fake-access-token")

    async def fake_call(access_token, uid, project_id):
        return _fake_response(200, {"localId": [uid]})
    monkeypatch.setattr(mint_mod, "_call_accounts_update_valid_since", fake_call)

    with caplog.at_level(logging.DEBUG):
        await mint_mod.revoke_firebase_refresh_tokens(FIREBASE_UID, PROJECT_ID)

    all_log_text = "\n".join(record.getMessage() for record in caplog.records)
    assert FIREBASE_UID not in all_log_text
