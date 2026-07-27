"""story #2152(high, 2026-07-23) 근본수정 — story #2071이 도입한 `is_really_local = not
K_SERVICE` 판정은 "Cloud Run만 존재한다"는 전제가 깨지자(story #2142 GCE realtime-gateway)
그대로 재발했다: GCE도 K_SERVICE가 없으므로 "진짜 로컬"로 오판됐다.

이 파일은 AC2(실패 방향이 안전한 쪽 — 모르면 로컬 아님)·AC5(Cloud Run/GCE/진짜 로컬 세
시나리오 고정)를 실제 `settings.is_really_local`/`is_internal_secret_gate_exempt` 프로퍼티
(SimpleNamespace 목이 아니라 진짜 판정 로직)로 검증한다."""
from __future__ import annotations

from app.core.config import settings


def _clear_runtime_signals(monkeypatch):
    """세 시나리오 전부 이 상태에서 시작 — `PYTEST_CURRENT_TEST`를 지우지 않으면 pytest가
    실행 중이라는 사실 자체가 항상 '로컬'로 판정돼 Cloud Run/GCE 시나리오를 흉내낼 수 없다
    (pytest가 매 테스트마다 이 값을 자동 세팅 — 신규 발명 아님)."""
    monkeypatch.delenv("PYTEST_CURRENT_TEST", raising=False)
    monkeypatch.delenv("K_SERVICE", raising=False)
    monkeypatch.delenv("SPRINTABLE_LOCAL_DEV", raising=False)


def test_cloud_run_is_not_local(monkeypatch):
    """Cloud Run: K_SERVICE 자동주입 — 로컬 아님(#2071 이래 불변, 회귀가드)."""
    _clear_runtime_signals(monkeypatch)
    monkeypatch.setenv("K_SERVICE", "sprintable-backend-dev")
    assert settings.is_really_local is False


def test_gce_is_not_local(monkeypatch):
    """story #2152 핵심 회귀 — GCE는 K_SERVICE가 없다(Cloud Run 전용 주입). 이전 판정
    (`not K_SERVICE`)은 여기서 True(로컬)로 오판했다. 새 판정은 SPRINTABLE_LOCAL_DEV도
    없으므로 안전하게 False(로컬 아님)로 떨어져야 한다."""
    _clear_runtime_signals(monkeypatch)
    assert settings.is_really_local is False


def test_unknown_future_runtime_defaults_to_not_local(monkeypatch):
    """AC2 핵심 주장의 일반형 — GCE라는 특정 케이스가 아니어도, 아무 긍정 신호가 없는
    '모르는 런타임'은 전부 로컬 아님으로 떨어진다(부재 신호를 쌓아가는 방식이 아니라
    긍정 신호 하나만 보는 설계이므로, 다음에 또 다른 런타임이 나와도 이 결과는 그대로다)."""
    _clear_runtime_signals(monkeypatch)
    assert settings.is_really_local is False


def test_truly_local_via_pytest_marker_needs_no_extra_setup(monkeypatch):
    """대조군 — 기존 테스트 스위트 어디에도 SPRINTABLE_LOCAL_DEV가 세팅돼 있지 않지만,
    pytest 실행 자체가 자동으로 '진짜 로컬' 신호가 된다(PYTEST_CURRENT_TEST를 지우지 않는
    케이스)."""
    monkeypatch.delenv("K_SERVICE", raising=False)
    monkeypatch.delenv("SPRINTABLE_LOCAL_DEV", raising=False)
    assert settings.is_really_local is True


def test_truly_local_via_explicit_marker(monkeypatch):
    """자체호스팅 docker-compose·bare uvicorn --reload 대조군 — pytest가 아니어도
    SPRINTABLE_LOCAL_DEV를 명시하면 로컬로 인정된다(.env.example·docker-compose.yml에
    기본 포함, story #2152)."""
    _clear_runtime_signals(monkeypatch)
    monkeypatch.setenv("SPRINTABLE_LOCAL_DEV", "1")
    assert settings.is_really_local is True


def test_local_dev_marker_accepts_true_and_yes(monkeypatch):
    _clear_runtime_signals(monkeypatch)
    for value in ("true", "True", "yes", "YES"):
        monkeypatch.setenv("SPRINTABLE_LOCAL_DEV", value)
        assert settings.is_really_local is True


def test_local_dev_marker_rejects_falsy_values(monkeypatch):
    _clear_runtime_signals(monkeypatch)
    for value in ("0", "false", ""):
        monkeypatch.setenv("SPRINTABLE_LOCAL_DEV", value)
        assert settings.is_really_local is False


def test_gate_exempt_requires_both_dev_appenv_and_really_local(monkeypatch):
    """AC4 — `is_internal_secret_gate_exempt`는 app_env와 is_really_local을 코드 구조로
    AND 묶는다(cron.py/auth_firebase_internal.py가 is_really_local을 단독으로 볼 여지를
    없앤다). is_really_local만 True여도 app_env가 dev가 아니면 여전히 게이트가 걸린다."""
    _clear_runtime_signals(monkeypatch)
    monkeypatch.setenv("SPRINTABLE_LOCAL_DEV", "1")
    monkeypatch.setattr(settings, "app_env", "production")
    assert settings.is_really_local is True
    assert settings.is_internal_secret_gate_exempt is False


def test_gate_exempt_true_only_when_both_hold(monkeypatch):
    _clear_runtime_signals(monkeypatch)
    monkeypatch.setenv("SPRINTABLE_LOCAL_DEV", "1")
    monkeypatch.setattr(settings, "app_env", "development")
    assert settings.is_internal_secret_gate_exempt is True


def test_gate_exempt_false_when_appenv_missing_defaults_dev_but_runtime_unknown(monkeypatch):
    """AC6 — APP_ENV 누락(기본값 development)만으로는 더 이상 게이트가 안 열린다.
    is_really_local이 안전한 새 기본값(False)이라 combined 판정이 이 축 하나만으로도
    막힌다(배포 스크립트가 APP_ENV를 채우는 것에 의존하지 않는다)."""
    _clear_runtime_signals(monkeypatch)
    monkeypatch.setattr(settings, "app_env", "development")  # Settings 클래스 기본값과 동일
    assert settings.is_internal_secret_gate_exempt is False
