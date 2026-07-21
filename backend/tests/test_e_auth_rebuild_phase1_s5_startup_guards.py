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
        "firebase_oauth_handoff_enabled": False,
        "firebase_auth_mobile_app_check_required": False,
        # story #2071: 기본값=진짜 로컬(테스트 러너는 Cloud Run이 아님). on-Cloud-Run
        # 시나리오를 검증하는 테스트만 is_really_local=False로 override.
        "is_really_local": True,
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


def test_internal_secret_config_raises_when_prod_and_empty_and_oauth_handoff_on():
    """story 1931 — 신규 firebase_oauth_handoff_enabled 플래그도 다른 Firebase 내부
    엔드포인트 플래그와 동일하게 fail-closed 대상이어야 한다(누락 시 secret 없이 배포돼도
    startup이 안 죽는 회귀 — check_internal_secret_config_ok_when_prod_and_empty_but_all_
    firebase_features_off와 대칭되는 온-케이스)."""
    from app.routers.auth_firebase_internal import check_internal_secret_config
    with pytest.raises(RuntimeError):
        check_internal_secret_config(_s(
            app_env="production", firebase_bff_internal_secret="", firebase_oauth_handoff_enabled=True,
        ))


def test_internal_secret_config_raises_when_dev_appenv_but_on_cloud_run():
    """story #2071(critical, 2026-07-21): APP_ENV=development인데 실제로는 Cloud Run
    위(K_SERVICE 존재 — 노출된 dev 배포)면 "로컬" 예외가 더 이상 적용되면 안 된다. 이게
    민군/오르테가군이 실측 확定한 결함의 근본원인 — app_env 문자열만으로 "로컬"을 판정해서
    노출된 dev가 fail-open을 그대로 탔다."""
    from app.routers.auth_firebase_internal import check_internal_secret_config
    with pytest.raises(RuntimeError, match="FIREBASE_BFF_INTERNAL_SECRET"):
        check_internal_secret_config(_s(
            app_env="development", firebase_bff_internal_secret="", firebase_auth_issue_session=True,
            is_really_local=False,
        ))


def test_internal_secret_config_ok_when_dev_appenv_and_truly_local():
    """대조군 — K_SERVICE가 없는 진짜 로컬(uvicorn/pytest)은 여전히 예외 대상."""
    from app.routers.auth_firebase_internal import check_internal_secret_config
    check_internal_secret_config(_s(
        app_env="development", firebase_bff_internal_secret="", firebase_auth_issue_session=True,
        is_really_local=True,
    ))


def test_require_internal_secret_raises_503_when_dev_appenv_but_on_cloud_run(monkeypatch):
    """story #2071: 런타임 게이트(_require_internal_secret) 쪽도 동일 — 노출된 dev에서
    시크릿 미설정이면 인증 없이 통과(fail-open)하던 것을 503(fail-closed)으로 닫는다."""
    monkeypatch.setenv("K_SERVICE", "sprintable-backend-dev")
    monkeypatch.setattr("app.routers.auth_firebase_internal.settings.app_env", "development")
    monkeypatch.setattr("app.routers.auth_firebase_internal.settings.firebase_bff_internal_secret", "")
    from app.routers.auth_firebase_internal import _require_internal_secret
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as exc_info:
        _require_internal_secret(None)
    assert exc_info.value.status_code == 503


def test_require_internal_secret_ok_when_truly_local(monkeypatch):
    monkeypatch.delenv("K_SERVICE", raising=False)
    monkeypatch.setattr("app.routers.auth_firebase_internal.settings.app_env", "development")
    monkeypatch.setattr("app.routers.auth_firebase_internal.settings.firebase_bff_internal_secret", "")
    from app.routers.auth_firebase_internal import _require_internal_secret
    _require_internal_secret(None)  # raise 없이 통과해야 함(진짜 로컬).


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
