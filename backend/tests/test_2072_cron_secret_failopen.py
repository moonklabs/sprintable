"""story #2072(high, 2026-07-21) — cron.py의 CRON_SECRET 게이트가 `_require_internal_secret`
(story #2071)보다도 넓게 열려 있던 결함(환경 체크 자체가 없었음). 같은 K_SERVICE 기반 판정으로
좁힌다 — check_internal_secret_config 회귀 테스트(test_e_auth_rebuild_phase1_s5_startup_guards.py)
와 동형 구조."""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest


def _s(**overrides):
    base = {"app_env": "development", "is_really_local": True}
    base.update(overrides)
    # story #2152: check_cron_secret_config은 이제 is_internal_secret_gate_exempt 단일
    # 프로퍼티만 본다 — 목(mock)도 실제 Settings와 동일하게 app_env+is_really_local의 AND로
    # 계산해서 넣어준다(SimpleNamespace엔 @property가 없어 직접 계산 필요).
    base["is_internal_secret_gate_exempt"] = (
        base["app_env"] == "development" and base["is_really_local"]
    )
    return SimpleNamespace(**base)


def test_check_cron_secret_config_ok_when_local_and_empty():
    from app.routers.cron import check_cron_secret_config
    check_cron_secret_config(_s(app_env="development", is_really_local=True))


def test_check_cron_secret_config_raises_when_prod():
    from app.routers.cron import check_cron_secret_config
    with pytest.raises(RuntimeError, match="CRON_SECRET"):
        check_cron_secret_config(_s(app_env="production", is_really_local=False))


def test_check_cron_secret_config_raises_when_dev_appenv_but_on_cloud_run():
    """story #2072 근본: APP_ENV=development여도 K_SERVICE가 있으면(노출된 dev) fail-closed."""
    from app.routers.cron import check_cron_secret_config
    with pytest.raises(RuntimeError, match="CRON_SECRET"):
        check_cron_secret_config(_s(app_env="development", is_really_local=False))


def test_verify_cron_raises_503_when_dev_appenv_but_on_cloud_run(monkeypatch):
    """런타임 게이트 — 노출된 dev에서 CRON_SECRET 미설정이면 이전엔 무조건 통과(fail-open)
    했다. 이제 503(fail-closed). is_really_local은 @property(setter 없음)라 K_SERVICE
    env var를 직접 조작 — 실제 판정 경로 그대로 태운다."""
    monkeypatch.setenv("K_SERVICE", "sprintable-backend-dev")
    monkeypatch.setattr("app.routers.cron.CRON_SECRET", None)
    monkeypatch.setattr("app.routers.cron.settings.app_env", "development")
    from fastapi import HTTPException

    from app.routers.cron import verify_cron
    request = MagicMock()
    with pytest.raises(HTTPException) as exc_info:
        verify_cron(request)
    assert exc_info.value.status_code == 503


def test_verify_cron_ok_when_truly_local(monkeypatch):
    monkeypatch.delenv("K_SERVICE", raising=False)
    monkeypatch.setattr("app.routers.cron.CRON_SECRET", None)
    monkeypatch.setattr("app.routers.cron.settings.app_env", "development")
    from app.routers.cron import verify_cron
    request = MagicMock()
    verify_cron(request)  # raise 없이 통과해야 함.


def test_verify_cron_still_requires_correct_secret_when_configured(monkeypatch):
    """무회귀 — CRON_SECRET이 설정된 기존 케이스는 그대로 헤더 검증."""
    monkeypatch.setattr("app.routers.cron.CRON_SECRET", "real-secret")
    from fastapi import HTTPException

    from app.routers.cron import verify_cron
    request = MagicMock()
    request.headers.get.return_value = "Bearer wrong"
    with pytest.raises(HTTPException) as exc_info:
        verify_cron(request)
    assert exc_info.value.status_code == 401

    request.headers.get.return_value = "Bearer real-secret"
    verify_cron(request)  # 정확한 시크릿이면 통과.
