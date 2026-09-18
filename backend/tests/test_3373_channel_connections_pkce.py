"""story #3373(Phase1·마케팅운영, 선생님 확定 2026-09-03) — PKCE fallback flag(페드루 PO
2026-09-03 07:56Z — Meta가 code_challenge를 거부할 때 재배포 없이 끄는 자리). story
#3579(2026-09-06, 페드루 PO 確定) 후속으로 `test_3373_channel_connections.py`(31
테스트)에서 3-way 분할 — 원본 파일이 러너 정규화 60초 가드 경계대역(36~77s 관측)에
있어 러너가 조금만 느려져도 가드에 걸림. 세팅 헬퍼·픽스처는
`test_3373_channel_connections_auth.py`에서 그대로 재사용(중복 재발명 0) — autouse
픽스처(`_dispose_global_engine_after_test`·`_configure_secrets`)만 pytest 관례상
파일마다 재선언(import로는 전파 안 됨, story #3562 전례와 동일).

이 파일 담당 — PKCE 플래그 기본 활성/비활성 시 authorize URL 파라미터·단기 토큰 교환의
code_verifier 포함/생략."""
from __future__ import annotations

import os

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.destructive_schema,
    pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요"),
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


@pytest.fixture(autouse=True)
def _configure_secrets(monkeypatch):
    """crypto·state 시크릿을 매 테스트 새로 구성(격리) — billing_key_crypto 테스트와 동형 패턴."""
    import importlib
    from cryptography.fernet import Fernet

    import app.core.config as config_module
    monkeypatch.setattr(config_module.settings, "channel_credential_encryption_key", Fernet.generate_key().decode())
    monkeypatch.setattr(config_module.settings, "channel_oauth_state_secret", "test-channel-oauth-state-secret")

    import app.services.channel_credential_crypto as crypto_module
    importlib.reload(crypto_module)
    yield
    importlib.reload(crypto_module)


# ─── PKCE fallback flag(페드루 PO 2026-09-03 07:56Z — Meta가 code_challenge를 거부할 때
# 재배포 없이 끄는 자리) ────────────────────────────────────────────────────────

def test_build_authorize_url_includes_pkce_params_by_default(monkeypatch):
    import app.core.config as config_module
    monkeypatch.setattr(config_module.settings, "threads_pkce_enabled", True)

    from app.services.threads_oauth import build_authorize_url

    url = build_authorize_url(redirect_uri="https://x/callback", state="s", code_challenge="chal123", app_id="app-id")
    assert "code_challenge=chal123" in url
    assert "code_challenge_method=S256" in url
    assert "client_id=app-id" in url


def test_build_authorize_url_omits_pkce_params_when_flag_disabled(monkeypatch):
    import app.core.config as config_module
    monkeypatch.setattr(config_module.settings, "threads_pkce_enabled", False)

    from app.services.threads_oauth import build_authorize_url

    url = build_authorize_url(redirect_uri="https://x/callback", state="s", code_challenge="chal123", app_id="app-id")
    assert "code_challenge" not in url
    assert "chal123" not in url


@pytest.mark.anyio
async def test_short_lived_token_exchange_omits_code_verifier_when_pkce_disabled(monkeypatch):
    import app.core.config as config_module
    monkeypatch.setattr(config_module.settings, "threads_pkce_enabled", False)

    from app.services.threads_oauth import exchange_code_for_short_lived_token

    captured = {}

    class _FakeResponse:
        status_code = 200
        def json(self):
            return {"access_token": "tok", "user_id": "acc-1"}

    class _FakeClient:
        async def post(self, url, *, data):
            captured["data"] = data
            return _FakeResponse()

    await exchange_code_for_short_lived_token(
        _FakeClient(), code="c", redirect_uri="https://x/callback", code_verifier="verifier123",
        app_id="app-id", app_secret="app-secret",
    )
    assert "code_verifier" not in captured["data"]


@pytest.mark.anyio
async def test_short_lived_token_exchange_includes_code_verifier_by_default(monkeypatch):
    import app.core.config as config_module
    monkeypatch.setattr(config_module.settings, "threads_pkce_enabled", True)

    from app.services.threads_oauth import exchange_code_for_short_lived_token

    captured = {}

    class _FakeResponse:
        status_code = 200
        def json(self):
            return {"access_token": "tok", "user_id": "acc-1"}

    class _FakeClient:
        async def post(self, url, *, data):
            captured["data"] = data
            return _FakeResponse()

    await exchange_code_for_short_lived_token(
        _FakeClient(), code="c", redirect_uri="https://x/callback", code_verifier="verifier123",
        app_id="app-id", app_secret="app-secret",
    )
    assert captured["data"]["code_verifier"] == "verifier123"
    assert captured["data"]["client_id"] == "app-id"
    assert captured["data"]["client_secret"] == "app-secret"
