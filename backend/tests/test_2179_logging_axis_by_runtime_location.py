"""story #2179(2026-07-24, 오르테가군 근본 판정) — JSON 로그 여부의 판정 축을 "환경 이름"
(`APP_ENV` 문자열 비교)에서 "실행 위치"(`settings.is_really_local`, story #2071→#2152)로
교체한다.

## 근본
예전: `configure_logging(json_logs=os.getenv("APP_ENV","development") != "development")`.
JSON 로그가 필요한 진짜 조건은 "어느 환경인가"가 아니라 "Cloud Logging으로 나가는가" =
"Cloud Run/GCE에서 도는가"다. 그런데 환경 **이름**으로 그걸 판정하고 있어서, 이름 컨벤션이
흔들리면(dev Cloud Run에 `APP_ENV`가 아예 안 박혀 기본값 "development"를 상속) 판정이
조용히 틀어졌다 — dev에서 `logger.info(..., extra={"structured": {...}})`(story #2176 emit
계측·P1-S8 RAG 검색 계측·llm_client 비용/토큰 계측 전부)가 텍스트 포매터를 타면서 값이 통째로
버려지고 있었다(메시지 텍스트만 남음).

## 근본수정
`is_really_local`은 이미 "진짜 로컬인가"를 이름이 아니라 실행 위치 신호(K_SERVICE 존재=Cloud
Run 확定·PYTEST_CURRENT_TEST=테스트·SPRINTABLE_LOCAL_DEV=로컬 docker-compose 명시)로
판정한다(story #2152가 GCE 오판까지 이미 닫아둠 — `test_2152_runtime_local_detection.py`
참조). 이 신호를 뒤집어 재사용하면 환경 이름을 하나도 안 건드리고 dev·prod·GCE·MCP가 전부
자동으로 맞는다 — `APP_ENV` 배선도, 그로 인한 Redis 키 네임스페이스 부작용(AC3)도 불요.
"""
from __future__ import annotations

import inspect
import json
import logging
from io import StringIO

from app.core.config import settings
from app.core.logging_config import JsonFormatter, configure_logging


def _clear_runtime_signals(monkeypatch):
    monkeypatch.delenv("PYTEST_CURRENT_TEST", raising=False)
    monkeypatch.delenv("K_SERVICE", raising=False)
    monkeypatch.delenv("SPRINTABLE_LOCAL_DEV", raising=False)


# ── 소스 고정 — 회귀 가드(오늘 세운 "선언은 pinning 테스트로" 관례 그대로) ────────────
def test_main_wires_json_logs_from_is_really_local_not_app_env():
    import app.main as main_mod

    source = inspect.getsource(main_mod)
    assert "configure_logging(json_logs=not settings.is_really_local)" in source, (
        "json_logs 판정이 실행 위치 축(is_really_local)을 쓰는지 소스 고정 — 이게 없으면 "
        "다음에 누가 다시 APP_ENV 문자열 비교로 되돌려도 아무도 모른다"
    )
    assert 'os.getenv("APP_ENV"' not in source, (
        "옛 환경-이름 축(APP_ENV 문자열 비교)이 되살아나면 실패 — #2179가 고친 그 자리"
    )


def test_main_declares_bare_uvicorn_is_a_deliberate_tradeoff():
    """오르테가군 지적 — "판정 근거뿐 아니라 무너지는 조건까지" 선언할 것. bare uvicorn(
    docker-compose 없이)이 텍스트→JSON으로 바뀌는 게 실수가 아니라 의도된 판단이라는 것이
    소스에서 사라지면 실패 — 사라지면 다음 사람이 "왜 갑자기 JSON이지"로 헤맨다."""
    import app.main as main_mod

    source = inspect.getsource(main_mod)
    assert "bare" in source and "uvicorn" in source
    assert "SPRINTABLE_LOCAL_DEV" in source


def test_gce_stale_comment_correction_exists():
    """오르테가군 지적 — deploy_realtime_gce.sh의 "#2071이라 GCE에서 is_really_local
    계속 True" 서술이 #2152 이후로는 사실이 아닌데 정정이 안 남아있으면 다음 사람이 그
    낡은 주석만 읽고 속는다. 정정 문장 존재를 고정."""
    from pathlib import Path

    script = (Path(__file__).resolve().parents[1] / "scripts" / "deploy_realtime_gce.sh").read_text()
    assert "정정(story #2179" in script
    assert "test_gce_is_not_local" in script


# ── 위치별 판정이 실제로 옳은 json_logs 값을 내는지(is_really_local 자체는 #2152가 이미
#    전수 검증했으므로, 여기선 "그 값을 뒤집어 json_logs로 쓴다"는 #2179 고유의 계약만 확認) ──
def test_cloud_run_gets_json_logs(monkeypatch):
    _clear_runtime_signals(monkeypatch)
    monkeypatch.setenv("K_SERVICE", "sprintable-backend-dev")
    assert (not settings.is_really_local) is True


def test_gce_gets_json_logs(monkeypatch):
    """#2152 핵심 — GCE는 K_SERVICE가 없지만 SPRINTABLE_LOCAL_DEV도 없어 is_really_local
    =False로 정확히 떨어진다(과거 #2071 판정은 여기서 True로 오판했었음). #2179가 그 정확한
    신호를 그대로 재사용하므로 GCE realtime도 자동으로 JSON 로그를 받는다."""
    _clear_runtime_signals(monkeypatch)
    assert (not settings.is_really_local) is True


def test_docker_compose_local_dev_keeps_text_logs(monkeypatch):
    """README 공식 로컬 개발 경로(`docker compose up`)는 SPRINTABLE_LOCAL_DEV=1을 심는다 —
    무회귀로 텍스트 로그를 유지해야(오르테가군 명시 확認 요청)."""
    _clear_runtime_signals(monkeypatch)
    monkeypatch.setenv("SPRINTABLE_LOCAL_DEV", "1")
    assert (not settings.is_really_local) is False


def test_pytest_run_keeps_text_logs(monkeypatch):
    """pytest 실행 자체가 PYTEST_CURRENT_TEST로 자동 '로컬' 판정 — 테스트 로그도 무회귀."""
    monkeypatch.delenv("K_SERVICE", raising=False)
    monkeypatch.delenv("SPRINTABLE_LOCAL_DEV", raising=False)
    assert (not settings.is_really_local) is False


# ── configure_logging() 자체가 그 값을 받아 실제로 JSON/텍스트를 가르는지 + structured
#    필드가 JSON 경로에서 실제로 살아남는지(#2179가 고치려던 원 증상의 직접 회귀가드) ──
def _capture_one_log_line(json_logs: bool, structured: dict) -> str:
    configure_logging(json_logs=json_logs)
    root = logging.getLogger()
    stream = StringIO()
    # StreamHandler(sys.stdout) 대신 캡처용 스트림으로 교체 — configure_logging이 세운
    # 핸들러의 포매터만 재사용(같은 포매터 클래스가 실제로 쓰이는지가 검증 대상).
    root.handlers[0].stream = stream
    logging.getLogger("test_2179").info("probe message", extra={"structured": structured})
    return stream.getvalue().strip()


def test_json_logs_true_preserves_structured_fields(monkeypatch):
    """#2179 원 증상의 직접 회귀가드 — json_logs=True(Cloud Run/GCE 경로)면 구조화 필드가
    실제로 로그 라인에 살아남는다(전에는 여기가 통째로 버려졌다)."""
    line = _capture_one_log_line(True, {"server_processing_ms": 20.9, "recipient_count": 2})
    payload = json.loads(line)
    assert payload["server_processing_ms"] == 20.9
    assert payload["recipient_count"] == 2
    assert payload["message"] == "probe message"


def test_json_logs_false_drops_structured_fields_but_keeps_message():
    """대조군 — json_logs=False(로컬)면 메시지는 남되 구조화 필드는 텍스트 포매터가 모른다
    (#2179가 dev에서 실제로 겪은 정확한 증상 — 오탐 방지를 위해 이 대조도 같이 고정)."""
    line = _capture_one_log_line(False, {"server_processing_ms": 20.9})
    assert "probe message" in line
    assert "20.9" not in line
    assert "server_processing_ms" not in line


def test_json_formatter_is_the_class_used_when_json_logs_true():
    configure_logging(json_logs=True)
    root = logging.getLogger()
    assert isinstance(root.handlers[0].formatter, JsonFormatter)


def test_plain_formatter_is_used_when_json_logs_false():
    configure_logging(json_logs=False)
    root = logging.getLogger()
    assert not isinstance(root.handlers[0].formatter, JsonFormatter)
    assert isinstance(root.handlers[0].formatter, logging.Formatter)
