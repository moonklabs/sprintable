"""story #2821 — infra/check_env_drift.py 스케줄 가드 dev FAIL 회귀가드.

실사고(2026-08-19): 드리프트가 아니라 스크립트 크래시였다. `office-converter-dev`
(story #2771, gotenberg 공개 이미지)는 컨테이너 스펙에 `env` 필드 자체가 없어
`gcloud run services describe --format=json(...containers[0].env)`가 literal JSON
`null`을 낸다 — 빈 문자열이 아니라 텍스트 "null"이라 기존 `if not out` 가드를 통과하고,
`json.loads("null")`이 `None`이 되어 `data.get(...)`이 AttributeError로 죽었다.

축① — 어느 서비스가 왜(`_live_env_entries`의 None 가드 + 진단 출력).
축② — office-converter-dev가 `_SERVICE_SCRIPT_MAP`(마스터)에 아예 미등재였던 부수 발견
(None-크래시가 그 자리를 가리고 있었을 뿐).
축③ — Discord "상세 없음(호출 경로 오류 의심)" 알림도 같은 근본원인이었다: 크래시가
`_write_state_file` 호출 전에 스크립트를 죽여 그날 state 파일이 아예 안 남고,
`compare_env_drift_state.py`가 "파일 없음"을 fail_lines=[]로 읽어 그 방어 문구를 냈다
— 별도 결함이 아니다. 재발 방지로 `_run_cli`가 미처리 예외를 state 파일에 진단명으로
남기고 다시 던진다(다음에 «다른» 예외가 나도 같은 침묵이 재발하지 않게).

gcloud 라이브 접근 없이(`_run` 몽키패치) 실행 가능.
"""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[2]
_INFRA_DIR = _REPO_ROOT / "infra"


def _load_check_env_drift():
    spec = importlib.util.spec_from_file_location(
        "check_env_drift", _INFRA_DIR / "check_env_drift.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# ── 축① _live_env_entries — None/빈 문자열/정상 3갈래 ────────────────────────

def test_live_env_entries_returns_empty_on_json_null(monkeypatch, capsys):
    """실사고 재현 — describe가 literal 'null'을 내면 크래시 대신 env 0건으로 처리한다."""
    mod = _load_check_env_drift()
    monkeypatch.setattr(mod, "_run", lambda cmd: "null")

    result = mod._live_env_entries("office-converter-dev")

    assert result == []
    assert "office-converter-dev" in capsys.readouterr().out


def test_live_env_entries_returns_empty_on_blank_output(monkeypatch):
    """기존 가드(빈 문자열) 회귀 없음 — 이번 변경이 이 갈래를 깨지 않는다."""
    mod = _load_check_env_drift()
    monkeypatch.setattr(mod, "_run", lambda cmd: "")

    assert mod._live_env_entries("some-service") == []


def test_live_env_entries_parses_normal_json_unaffected(monkeypatch):
    """양성대조 — 정상 describe 응답(진짜 env 있음)은 그대로 파싱된다(None 가드가 happy
    path를 건드리지 않는다는 증명)."""
    mod = _load_check_env_drift()
    payload = json.dumps({
        "spec": {"template": {"spec": {"containers": [
            {"env": [{"name": "APP_URL", "value": "https://dev-app.sprintable.ai"}]}
        ]}}}
    })
    monkeypatch.setattr(mod, "_run", lambda cmd: payload)

    result = mod._live_env_entries("sprintable-backend-dev")

    assert result == [{"name": "APP_URL", "value": "https://dev-app.sprintable.ai"}]


# ── 축② office-converter-dev 마스터 등재 ─────────────────────────────────────

def test_office_converter_dev_registered_in_master():
    mod = _load_check_env_drift()
    assert "office-converter-dev" in mod._SERVICE_SCRIPT_MAP
    assert mod._env_for_service("office-converter-dev") == "dev"


def test_office_converter_dev_no_longer_falls_into_unmapped(monkeypatch):
    """등재 전엔 None-크래시가 이 서비스를 "매핑 안 된 신규 서비스" 판정 자체에 도달하지도
    못하게 가렸다 — 이제 정상적으로 checked 대상에 들어가고 unmapped엔 안 잡힘을 증명."""
    mod = _load_check_env_drift()

    def _fake_live_env_entries(service):
        return []

    monkeypatch.setattr(mod, "_list_live_services", lambda: ["office-converter-dev"])
    monkeypatch.setattr(mod, "_live_env_entries", _fake_live_env_entries)
    monkeypatch.setattr(mod, "_load_allowlist", lambda: ({}, {}))
    monkeypatch.setattr(mod, "_iac_covered_keys", lambda: set())
    monkeypatch.setattr(mod, "_settings_field_env_keys", lambda: set())
    monkeypatch.setattr(mod, "_load_settings_exempt", lambda: {})
    monkeypatch.setattr(mod, "_web_env_reads", lambda: {})
    monkeypatch.setattr(mod, "_load_code_read_exempt", lambda: set())
    monkeypatch.setattr(mod, "_load_code_read_high_baseline", lambda: {})
    monkeypatch.setattr(mod, "_service_subset_wellformed_violations", lambda: [])
    monkeypatch.setattr(mod, "_external_iac_wellformed_violations", lambda: [])

    exit_code = mod.main(only_env="dev")

    assert exit_code == 0


# ── 축③ 미처리 예외도 state 파일에 진단명을 남긴다 ────────────────────────────

def test_unhandled_exception_writes_diagnostic_state_file_before_reraising(
    tmp_path, monkeypatch
):
    """실사고의 축③ 재발 방지 — main() 밖 예외라도 state 파일이 비어있는 채로 남지 않는다.
    이게 없으면 compare_env_drift_state.py가 "파일 없음"을 fail_lines=[]로 읽어 Discord가
    "상세 없음(호출 경로 오류 의심)"을 낸다(실사고 그 문구)."""
    mod = _load_check_env_drift()
    state_path = tmp_path / "state.json"
    monkeypatch.setenv("ENV_DRIFT_STATE_FILE", str(state_path))

    def _boom(only_env=None):
        raise RuntimeError("simulated future crash — unrelated to the None case")

    monkeypatch.setattr(mod, "main", _boom)

    with pytest.raises(RuntimeError, match="simulated future crash"):
        mod._run_cli(["--only-env", "dev"])

    data = json.loads(state_path.read_text(encoding="utf-8"))
    assert data["env"] == "dev"
    assert len(data["fail_lines"]) == 1
    assert "RuntimeError" in data["fail_lines"][0]
    assert "simulated future crash" in data["fail_lines"][0]


def test_run_cli_returns_main_exit_code_on_clean_run(monkeypatch):
    mod = _load_check_env_drift()
    monkeypatch.setattr(mod, "main", lambda only_env=None: 0)
    monkeypatch.delenv("ENV_DRIFT_STATE_FILE", raising=False)

    assert mod._run_cli([]) == 0
