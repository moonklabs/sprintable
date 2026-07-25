"""story #2138(2026-07-24, 까심 전수 확認 근거) — outbox+dual_publish/dispatch 동시 활성화
fail-closed startup 가드.

이전엔 이 위험 조합을 막는 게 outbox_dispatcher_loop() docstring 경고문 한 줄뿐이었다
(model_validator·startup assertion·런타임 체크 전부 0건). `check_cron_secret_config`(#2072)·
`check_listen_config`(ee7794eb)와 동형 — main lifespan이 호출하는 fail-closed startup 가드로
승격한다.
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.services.event_broker import check_outbox_dual_publish_config


def _s(**overrides):
    base = {
        "event_broker_outbox_enabled": False,
        "event_broker_redis_dual_publish_enabled": False,
        "event_broker_redis_dispatch_enabled": False,
    }
    base.update(overrides)
    return SimpleNamespace(**base)


def test_ok_when_outbox_off_regardless_of_others():
    # outbox 자체가 꺼져 있으면 다른 플래그가 뭐든 무해(무회귀 — 켜기 전엔 이 가드 자체가 no-op).
    check_outbox_dual_publish_config(_s(
        event_broker_outbox_enabled=False,
        event_broker_redis_dual_publish_enabled=True,
        event_broker_redis_dispatch_enabled=True,
    ))


def test_ok_when_outbox_alone():
    check_outbox_dual_publish_config(_s(event_broker_outbox_enabled=True))


def test_raises_when_outbox_and_dual_publish_both_on():
    with pytest.raises(RuntimeError, match="dual_publish"):
        check_outbox_dual_publish_config(_s(
            event_broker_outbox_enabled=True,
            event_broker_redis_dual_publish_enabled=True,
        ))


def test_raises_when_outbox_and_dispatch_both_on():
    with pytest.raises(RuntimeError, match="dispatch"):
        check_outbox_dual_publish_config(_s(
            event_broker_outbox_enabled=True,
            event_broker_redis_dispatch_enabled=True,
        ))


def test_raises_when_all_three_on():
    """dual_publish 위반이 dispatch보다 먼저 걸리는지(둘 다 위험하지만 최소 1개는 반드시
    잡아야 하고, 어느 쪽이든 fail-closed면 충분 — 순서 자체를 계약으로 강제하진 않음)."""
    with pytest.raises(RuntimeError):
        check_outbox_dual_publish_config(_s(
            event_broker_outbox_enabled=True,
            event_broker_redis_dual_publish_enabled=True,
            event_broker_redis_dispatch_enabled=True,
        ))


def test_startup_wired_in_main_lifespan():
    """main.py lifespan이 실제로 이 가드를 부르는지 소스 고정 — #2072/ee7794eb와 같은
    "만들었는데 안 부름" 패턴 재발 방지."""
    import inspect
    import app.main as main_mod

    source = inspect.getsource(main_mod.lifespan)
    assert "check_outbox_dual_publish_config()" in source


def test_error_message_explains_why_not_just_that():
    """오르테가군 지시 — 어서션 문구에 «무엇을 막는지·왜 위험한지»가 있어야(다음 사람이
    "왜 못 켜지"만 알고 "왜 위험한지"를 모르면 우회하려 들 것이라는 지적)."""
    with pytest.raises(RuntimeError) as exc_info:
        check_outbox_dual_publish_config(_s(
            event_broker_outbox_enabled=True,
            event_broker_redis_dual_publish_enabled=True,
        ))
    msg = str(exc_info.value)
    assert "중복배달" in msg or "두 번" in msg  # 왜 위험한지
    assert "대체" in msg or "먼저 끄고" in msg  # 어떻게 풀지
