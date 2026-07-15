"""story 4dee942b(E-AUTH-REBUILD M2 Phase1-S5) 산티아고 §9 검토(2026-07-15) 반영: startup
fail-closed 가드 2건 — check_listen_config()(ee7794eb ③)와 동일 패턴."""
from __future__ import annotations

from types import SimpleNamespace

import pytest


def _s(**overrides):
    base = {
        "app_env": "development",
        "firebase_bff_internal_secret": "",
        "firebase_auth_mobile_issue": False,
        "firebase_auth_mobile_app_check_required": False,
    }
    base.update(overrides)
    return SimpleNamespace(**base)


def test_internal_secret_config_ok_when_local_and_empty():
    from app.routers.auth_firebase_internal import check_internal_secret_config
    check_internal_secret_config(_s(app_env="development", firebase_bff_internal_secret=""))


def test_internal_secret_config_ok_when_prod_and_set():
    from app.routers.auth_firebase_internal import check_internal_secret_config
    check_internal_secret_config(_s(app_env="production", firebase_bff_internal_secret="real-secret"))


def test_internal_secret_config_raises_when_prod_and_empty():
    """산티아고 §9 finding 4 — 직접 probe로 확인된 misconfig를 startup에서 차단."""
    from app.routers.auth_firebase_internal import check_internal_secret_config
    with pytest.raises(RuntimeError, match="FIREBASE_BFF_INTERNAL_SECRET"):
        check_internal_secret_config(_s(app_env="production", firebase_bff_internal_secret=""))


def test_internal_secret_config_raises_when_staging_and_empty():
    from app.routers.auth_firebase_internal import check_internal_secret_config
    with pytest.raises(RuntimeError):
        check_internal_secret_config(_s(app_env="staging", firebase_bff_internal_secret=""))


def test_mobile_app_check_config_ok_when_mobile_issue_off():
    from app.services.firebase_verifier import check_mobile_app_check_config
    check_mobile_app_check_config(_s(firebase_auth_mobile_issue=False, firebase_auth_mobile_app_check_required=False))


def test_mobile_app_check_config_ok_when_both_on():
    from app.services.firebase_verifier import check_mobile_app_check_config
    check_mobile_app_check_config(_s(firebase_auth_mobile_issue=True, firebase_auth_mobile_app_check_required=True))


def test_mobile_app_check_config_raises_when_mobile_issue_on_without_app_check():
    """산티아고 §9 finding 1 — device binding 없는 네이티브 부트스트랩 발급이 prod에
    살아나가는 misconfig를 startup에서 차단."""
    from app.services.firebase_verifier import check_mobile_app_check_config
    with pytest.raises(RuntimeError, match="FIREBASE_AUTH_MOBILE_APP_CHECK_REQUIRED"):
        check_mobile_app_check_config(
            _s(firebase_auth_mobile_issue=True, firebase_auth_mobile_app_check_required=False)
        )
