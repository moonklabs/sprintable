"""story #2422 — env 드리프트 가드가 나흘째 FAIL인데 아무도 못 알아챈 병의 회귀가드.

증상 재현: 매일 같은 모양의 Discord 알림(``⛔ env 드리프트 가드 FAIL — 상세: <link>``)이
와서 "어제와 같은 실패"인지 "오늘 새로 생긴 실패"인지 구분이 안 됐다 — 빨강이 «배경음»이
되면 가드가 있어도 없는 것과 같다(초록이 알리바이가 되는 것의 반대편). 두 축을 고정한다:
①`check_env_drift.py`가 FAIL 집합을 파일로 남기는가(``ENV_DRIFT_STATE_FILE``), ②그 파일을
전날 지문과 대조해 신규/해소/연속일수를 정확히 가르는가(``compare_env_drift_state.py``).
"""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]
_INFRA_DIR = _REPO_ROOT / "infra"


def _load_module(name: str):
    spec = importlib.util.spec_from_file_location(name, _INFRA_DIR / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# ── ① check_env_drift.py — 상태파일 기록 ─────────────────────────────────────

def test_write_state_file_noop_without_env_var(tmp_path, monkeypatch):
    """ENV_DRIFT_STATE_FILE이 안 설정돼 있으면(로컬 수동 실행 기본) 아무 파일도 안 남긴다."""
    mod = _load_module("check_env_drift")
    monkeypatch.delenv("ENV_DRIFT_STATE_FILE", raising=False)
    mod._write_state_file(["some finding"], only_env="dev")
    # 파일 경로 자체가 없으니 생성 여부를 직접 검증할 길이 없다 — 예외 없이 조용히 끝나야
    # 정상(파일을 안 쓰는 것 자체가 이 테스트의 단언).


def test_write_state_file_records_fail_lines_sorted_and_deduped(tmp_path, monkeypatch):
    mod = _load_module("check_env_drift")
    out = tmp_path / "state.json"
    monkeypatch.setenv("ENV_DRIFT_STATE_FILE", str(out))
    mod._write_state_file(["B finding", "A finding", "A finding"], only_env="prod")
    data = json.loads(out.read_text(encoding="utf-8"))
    assert data == {"env": "prod", "fail_lines": ["A finding", "B finding"]}


def test_write_state_file_records_empty_list_on_clean_run(tmp_path, monkeypatch):
    """FAIL 0건이어도 반드시 파일을 남긴다 — "어제는 빨강, 오늘은 초록" 해소 전이를
    다음 비교가 알아야 하므로 파일 부재와 빈 목록을 구분해야 한다."""
    mod = _load_module("check_env_drift")
    out = tmp_path / "state.json"
    monkeypatch.setenv("ENV_DRIFT_STATE_FILE", str(out))
    mod._write_state_file([], only_env="dev")
    data = json.loads(out.read_text(encoding="utf-8"))
    assert data == {"env": "dev", "fail_lines": []}


# ── ② compare_env_drift_state.py — 신규/해소/연속일수 판정 ──────────────────

def _write(path: Path, fail_lines: list[str]) -> str:
    path.write_text(json.dumps({"fail_lines": fail_lines}), encoding="utf-8")
    return str(path)


def test_first_ever_failure_is_new_with_streak_one(tmp_path):
    """캐시 미스(직전 digest 파일 없음)면 지금 있는 것 전부가 "신규"로 읽혀야 한다 —
    "처음 보는 빨강"과 "계속되던 빨강"을 가르지 못하면 이 스토리의 존재 이유가 없다."""
    mod = _load_module("compare_env_drift_state")
    dev = _write(tmp_path / "dev.json", ["A", "B"])
    prod = _write(tmp_path / "prod.json", [])
    missing_digest = str(tmp_path / "does-not-exist.json")

    result = mod.compare([("dev", dev), ("prod", prod)], missing_digest, "2026-08-02")

    assert result["new_items"] == ["[dev] A", "[dev] B"]
    assert result["resolved_items"] == []
    assert result["streak_days"] == 1
    assert result["since"] == "2026-08-02"
    assert result["unchanged"] is False


def test_identical_failure_set_increments_streak_and_keeps_since(tmp_path):
    """이 테스트가 스토리의 핵심 실패 재현이다 — 나흘 동안 정확히 이 경로를 탔다."""
    mod = _load_module("compare_env_drift_state")
    dev = _write(tmp_path / "dev.json", ["A", "B"])
    prod = _write(tmp_path / "prod.json", [])
    digest = tmp_path / "digest.json"
    digest.write_text(
        json.dumps({"fail_lines": ["[dev] A", "[dev] B"], "since": "2026-07-30", "streak_days": 3}),
        encoding="utf-8",
    )

    result = mod.compare([("dev", dev), ("prod", prod)], str(digest), "2026-08-02")

    assert result["new_items"] == []
    assert result["resolved_items"] == []
    assert result["streak_days"] == 4
    assert result["since"] == "2026-07-30"
    assert result["unchanged"] is True


def test_mixed_new_and_resolved_resets_streak(tmp_path):
    """집합이 «달라지면»(신규가 생겼든 기존이 없어졌든) 연속선은 오늘부터 다시 센다 —
    "어제와 완전히 같은 그 문제"가 아니면 "며칠째"라는 말 자체가 거짓이 된다."""
    mod = _load_module("compare_env_drift_state")
    dev = _write(tmp_path / "dev.json", ["A", "C"])  # B 해소, C 신규
    prod = _write(tmp_path / "prod.json", [])
    digest = tmp_path / "digest.json"
    digest.write_text(
        json.dumps({"fail_lines": ["[dev] A", "[dev] B"], "since": "2026-07-30", "streak_days": 3}),
        encoding="utf-8",
    )

    result = mod.compare([("dev", dev), ("prod", prod)], str(digest), "2026-08-02")

    assert result["new_items"] == ["[dev] C"]
    assert result["resolved_items"] == ["[dev] B"]
    assert result["streak_days"] == 1
    assert result["since"] == "2026-08-02"
    assert result["unchanged"] is False


def test_all_resolved_reports_resolved_with_no_current_fail(tmp_path):
    mod = _load_module("compare_env_drift_state")
    dev = _write(tmp_path / "dev.json", [])
    prod = _write(tmp_path / "prod.json", [])
    digest = tmp_path / "digest.json"
    digest.write_text(
        json.dumps({"fail_lines": ["[dev] A", "[dev] B"], "since": "2026-07-30", "streak_days": 3}),
        encoding="utf-8",
    )

    result = mod.compare([("dev", dev), ("prod", prod)], str(digest), "2026-08-02")

    assert result["current_fail"] == []
    assert result["resolved_items"] == ["[dev] A", "[dev] B"]
    assert result["new_items"] == []


def test_prod_and_dev_findings_both_labeled_and_merged(tmp_path):
    """두 env의 실패가 한 digest에 합쳐지되, 어느 쪽인지 라벨이 안 사라진다 — 그래야
    다음 대조가 "dev의 A"와 "prod의 A"를 같은 것으로 잘못 묶지 않는다."""
    mod = _load_module("compare_env_drift_state")
    dev = _write(tmp_path / "dev.json", ["A"])
    prod = _write(tmp_path / "prod.json", ["A"])  # 같은 이름, 다른 env
    missing_digest = str(tmp_path / "none.json")

    result = mod.compare([("dev", dev), ("prod", prod)], missing_digest, "2026-08-02")

    assert result["current_fail"] == ["[dev] A", "[prod] A"]
    assert len(result["new_items"]) == 2  # 둘 다 별개 신규 항목 — 병합되지 않음


# ── digest 기록 — 다음 실행이 읽을 파일 자체가 맞게 쓰이는지 ────────────────

def test_write_digest_persists_fail_lines_since_and_streak(tmp_path):
    mod = _load_module("compare_env_drift_state")
    out = tmp_path / "digest.json"
    result = {
        "current_fail": ["[dev] A"],
        "new_items": ["[dev] A"],
        "resolved_items": [],
        "streak_days": 1,
        "since": "2026-08-02",
        "unchanged": False,
    }
    mod.write_digest(str(out), result)
    saved = json.loads(out.read_text(encoding="utf-8"))
    assert saved == {"fail_lines": ["[dev] A"], "since": "2026-08-02", "streak_days": 1}


# ── 알림 문구 — "새 실패"와 "동일 반복"이 실제로 다른 문장을 낸다 ───────────

def test_message_for_new_failure_leads_with_new_marker():
    mod = _load_module("compare_env_drift_state")
    result = {
        "current_fail": ["[dev] A"], "new_items": ["[dev] A"], "resolved_items": [],
        "streak_days": 1, "since": "2026-08-02", "unchanged": False,
    }
    msg = mod.format_discord_message(result, "https://example.com/run/1")
    assert "새" in msg.splitlines()[0]
    assert "[dev] A" in msg


def test_message_for_recurring_failure_states_streak_not_new_marker():
    """이 테스트가 스토리의 존재 이유다 — 문구 첫 줄이 "새 실패"와 "동일 반복"을 갈라야
    다음 사람이 «어제와 같은 실패»를 클릭해서 확認하지 않고도 알 수 있다."""
    mod = _load_module("compare_env_drift_state")
    result = {
        "current_fail": ["[dev] A", "[dev] B"], "new_items": [], "resolved_items": [],
        "streak_days": 4, "since": "2026-07-30", "unchanged": True,
    }
    msg = mod.format_discord_message(result, "https://example.com/run/1")
    first_line = msg.splitlines()[0]
    assert "동일 반복 4일째" in first_line
    assert "새" not in first_line.replace("새 항목 없음", "")  # "새 실패 발견" 마커가 없어야 함(양성대조)
