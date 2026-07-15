"""story 4dee942b(E-AUTH-REBUILD M2 Phase1-S5) 산티아고 §9 검토(2026-07-15) 반영: startup
fail-closed 가드 2건 — check_listen_config()(ee7794eb ③)와 동일 패턴."""
from __future__ import annotations

from types import SimpleNamespace

import pytest


def _s(**overrides):
    base = {
        "app_env": "development",
        "firebase_bff_internal_secret": "",
        "firebase_auth_issue_session": False,
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


def test_internal_secret_config_raises_when_prod_and_empty_and_feature_on():
    """산티아고 §9 finding 4 — 직접 probe로 확인된 misconfig를 startup에서 차단
    (Firebase 세션 발급 기능이 켜져 있을 때에 한해)."""
    from app.routers.auth_firebase_internal import check_internal_secret_config
    with pytest.raises(RuntimeError, match="FIREBASE_BFF_INTERNAL_SECRET"):
        check_internal_secret_config(_s(
            app_env="production", firebase_bff_internal_secret="", firebase_auth_issue_session=True,
        ))


def test_internal_secret_config_raises_when_staging_and_empty_and_feature_on():
    from app.routers.auth_firebase_internal import check_internal_secret_config
    with pytest.raises(RuntimeError):
        check_internal_secret_config(_s(
            app_env="staging", firebase_bff_internal_secret="", firebase_auth_mobile_issue=True,
        ))


def test_internal_secret_config_ok_when_prod_and_empty_but_all_firebase_features_off():
    """산티아고 #2202 재검토(2026-07-15) 배포 회귀 회귀가드 — 최초 구현은 Firebase 기능
    플래그와 무관하게 non-local이면 무조건 시크릿을 요구해서, Firebase 전부 default-off인
    현재 상태로 배포해도(deploy_backend.sh가 아직 시크릿을 배선 안 함) backend 전체가
    startup에서 죽는 회귀였다(직접 probe: prod_features_off_missing_secret_startup_
    allowed=False). 실제로 쓰는 기능이 꺼져 있으면 시크릿 미설정이어도 통과해야 한다."""
    from app.routers.auth_firebase_internal import check_internal_secret_config
    check_internal_secret_config(_s(
        app_env="production", firebase_bff_internal_secret="",
        firebase_auth_issue_session=False, firebase_auth_mobile_issue=False,
    ))


def test_internal_secret_config_raises_when_prod_and_empty_and_issue_session_on():
    from app.routers.auth_firebase_internal import check_internal_secret_config
    with pytest.raises(RuntimeError):
        check_internal_secret_config(_s(
            app_env="production", firebase_bff_internal_secret="",
            firebase_auth_issue_session=True, firebase_auth_mobile_issue=False,
        ))


def test_internal_secret_config_raises_when_prod_and_empty_and_mobile_issue_on():
    from app.routers.auth_firebase_internal import check_internal_secret_config
    with pytest.raises(RuntimeError):
        check_internal_secret_config(_s(
            app_env="production", firebase_bff_internal_secret="",
            firebase_auth_issue_session=False, firebase_auth_mobile_issue=True,
        ))


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
