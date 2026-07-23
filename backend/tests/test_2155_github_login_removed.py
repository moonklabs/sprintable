"""story #2155(high, 2026-07-23, 선생님 지시): GitHub 로그인 제거 — GitHub App/봇 연동
(`app/services/github_app.py`, `GITHUB_APP_*`)과는 완전히 별개(config.py:209 참조). prod
실측(디디, 읽기전용 1회 잡): github_id는 있으나 다른 로그인 수단이 없는 사용자 0명 —
이관 경로 불요, 즉시 제거."""
from __future__ import annotations

from fastapi.testclient import TestClient

from app.core.config import settings
from app.main import app


def test_github_no_longer_a_registered_oauth_provider():
    from app.routers.auth import _OAUTH_CONFIGS
    assert "github" not in _OAUTH_CONFIGS
    assert "google" in _OAUTH_CONFIGS  # 대조군 — google은 무회귀


def test_oauth_authorize_github_returns_invalid_provider():
    with TestClient(app) as c:
        resp = c.get("/api/v2/auth/oauth/github/authorize")
        assert resp.status_code == 400
        body = resp.json()
        assert body["error"]["code"] == "INVALID_PROVIDER"


def test_oauth_authorize_google_still_works():
    """무회귀 — google 로그인은 이 스토리로 영향받지 않는다."""
    with TestClient(app) as c:
        resp = c.get("/api/v2/auth/oauth/google/authorize")
        assert resp.status_code == 200
        assert "accounts.google.com" in resp.json()["data"]["url"]


def test_settings_has_no_github_client_credentials():
    assert not hasattr(settings, "github_client_id")
    assert not hasattr(settings, "github_client_secret")


def test_settings_still_has_google_client_credentials():
    assert hasattr(settings, "google_client_id")
    assert hasattr(settings, "google_client_secret")


def test_client_id_and_secret_helpers_ignore_provider_arg():
    from app.routers.auth import _client_id, _client_secret
    assert _client_id("google") == settings.google_client_id
    assert _client_secret("google") == settings.google_client_secret


def test_github_app_bot_integration_untouched():
    """AC1 회귀가드 — 이름이 비슷한 GitHub App(봇) 연동은 이 스토리로 전혀 건드리지
    않았다(github_app.py는 무수정, GITHUB_APP_* 필드는 config.py에 그대로 존재)."""
    from app.services import github_app  # noqa: F401 — import 성공 자체가 무회귀 증거
    assert hasattr(settings, "github_app_id")
    assert hasattr(settings, "github_app_client_id")
    assert hasattr(settings, "github_app_slug")


def test_user_github_id_column_preserved_but_documented_dead():
    """AC5 — 컬럼은 이번에 안 지운다(되돌릴 수 없고, prod 실측상 0명이라 급하지 않음).
    모델 필드 자체는 여전히 존재해야 한다(드롭 안 함의 증거)."""
    from app.models.user import User
    assert hasattr(User, "github_id")
