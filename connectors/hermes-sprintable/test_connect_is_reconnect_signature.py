"""story #2564(S9) — SprintableAdapter.connect()가 BasePlatformAdapter의
keyword-only `is_reconnect` 인자를 못 받아 매 연결(최초든 재연결이든)이
TypeError로 죽던 라이브 인시던트(2026-08-12 13:20:04~16:28:46 KST, ~3h8m
dev sprintable 채널 다운) 회귀 가드.

이 결함은 `hermes plugins install` 정식 경로로 처음 실행한 격리 e2e에서만
드러났다 — 라이브 사본은 이 시그니처 변경 이전 hermes-agent 버전에 맞춰
수동 복사된 채 멈춰 있었을 뿐. mock/import-only 테스트로는 실제 프레임워크가
호출부에서 넘기는 kwarg 불일치를 못 잡는다(connect()가 존재하는지만 보고
실제 호출 시그니처 정합은 안 봄) — 그래서 inspect.signature로 바인딩
자체를 고정한다.
"""
from __future__ import annotations

import inspect
import os
import sys

import pytest

_HERMES_AGENT = os.path.expanduser("~/.hermes/hermes-agent")
if os.path.isdir(_HERMES_AGENT):
    sys.path.insert(0, _HERMES_AGENT)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

adapter = pytest.importorskip(
    "adapter", reason="hermes-agent gateway.* framework not available on this machine",
)


def test_connect_accepts_is_reconnect_kwarg():
    sig = inspect.signature(adapter.SprintableAdapter.connect)
    sig.bind(object(), is_reconnect=True)
    sig.bind(object(), is_reconnect=False)


def test_connect_accepts_no_args_for_cold_boot():
    sig = inspect.signature(adapter.SprintableAdapter.connect)
    sig.bind(object())
