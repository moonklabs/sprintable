"""story #4023 CHANGES 1/2(PO 지적) — infra/check_expiring_declarations.py 회귀가드.

배경: AC3의 «만료 임박 14일 전 경고»를 처음엔 check_env_drift.py main() 안에 찍었는데, 그
스크립트는 env-drift-guard.yml(스케줄 전용, 새벽 로그)에서만 돌아 PR을 여는 사람이 못 본다
— AC3의 목적("사람이 미리 봄")이 안 닫힌다. 이 스위트는 PR CI에서 매번 도는 별도 경량 축
(GCP 호출 0)이 실제로 GitHub Actions 주석 형식을 내는지, 그리고(CHANGES 2) 이 축 자체가
조용히 꺼지는 3가지 길(파일 없음·섹션 키 부재·`until` 형식 파손)을 구조적 오류로 승격하는지
고정한다."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "infra"))

import check_expiring_declarations as mod  # noqa: E402


def _write_allowlist(tmp_path: Path, filename: str, content: str) -> None:
    infra_dir = tmp_path / "infra"
    infra_dir.mkdir(parents=True, exist_ok=True)
    (infra_dir / filename).write_text(content)


_EMPTY_SERVING_REALITY = "declared_pins: []\ndeclared_stalls: []\n"
_EMPTY_MCP_PATH_CONTRACT = "declared_mismatches: []\ndeclared_indirect: []\n"


# ── 출력 형식(PO 명시 요구) ────────────────────────────────────────────────────

def test_format_gha_warning_matches_github_actions_annotation_syntax():
    """PO 지적 원문 그대로: `::warning file=infra/manual-env-allowlist.yml::…` 형식."""
    line = mod.format_gha_warning("infra/manual-env-allowlist.yml", "SOME_KEY 만료 임박")
    assert line == "::warning file=infra/manual-env-allowlist.yml::SOME_KEY 만료 임박"


def test_format_gha_error_matches_github_actions_annotation_syntax():
    line = mod.format_gha_error("infra/manual-env-allowlist.yml", "섹션 부재")
    assert line == "::error file=infra/manual-env-allowlist.yml::섹션 부재"


# ── AC3 양성/음성 대조 — code_read_high_baseline ──────────────────────────────

def test_positive_control_entry_expiring_in_10_days_is_collected(tmp_path):
    _write_allowlist(tmp_path, "manual-env-allowlist.yml", """
code_read_high_baseline:
  - key: SOON_KEY
    reason: r
    declared_by: PO
    until: "2026-09-27"
""")
    _write_allowlist(tmp_path, "serving-reality-allowlist.yml", _EMPTY_SERVING_REALITY)
    _write_allowlist(tmp_path, "mcp-path-contract-allowlist.yml", _EMPTY_MCP_PATH_CONTRACT)

    from datetime import date
    result = mod.collect_expiry_findings(repo_root=tmp_path, today=date(2026, 9, 17))
    assert result.errors == []
    assert len(result.warnings) == 1
    rel_path, message = result.warnings[0]
    assert rel_path == "infra/manual-env-allowlist.yml"
    assert "SOON_KEY" in message and "10일 뒤 만료" in message


def test_entry_beyond_warning_window_is_not_collected(tmp_path):
    _write_allowlist(tmp_path, "manual-env-allowlist.yml", """
code_read_high_baseline:
  - key: FAR_KEY
    reason: r
    declared_by: PO
    until: "2026-10-07"
""")
    _write_allowlist(tmp_path, "serving-reality-allowlist.yml", _EMPTY_SERVING_REALITY)
    _write_allowlist(tmp_path, "mcp-path-contract-allowlist.yml", _EMPTY_MCP_PATH_CONTRACT)

    from datetime import date
    result = mod.collect_expiry_findings(repo_root=tmp_path, today=date(2026, 9, 17))
    assert result.errors == [] and result.warnings == []


def test_entry_expiring_in_exactly_14_days_is_collected(tmp_path):
    """⭐카디르 QA 지적(#4407, 비차단 후속) — `0 <= horizon <= warning_days`(경계 포함)의
    정확히 그 경계값(horizon == _WARNING_DAYS == 14)이 이전엔 테스트로 안 고정돼 있었다.
    today=2026-09-17 + 14일 = 2026-10-01."""
    _write_allowlist(tmp_path, "manual-env-allowlist.yml", """
code_read_high_baseline:
  - key: EXACTLY_14_KEY
    reason: r
    declared_by: PO
    until: "2026-10-01"
""")
    _write_allowlist(tmp_path, "serving-reality-allowlist.yml", _EMPTY_SERVING_REALITY)
    _write_allowlist(tmp_path, "mcp-path-contract-allowlist.yml", _EMPTY_MCP_PATH_CONTRACT)

    from datetime import date
    result = mod.collect_expiry_findings(repo_root=tmp_path, today=date(2026, 9, 17))
    assert result.errors == []
    assert len(result.warnings) == 1
    rel_path, message = result.warnings[0]
    assert rel_path == "infra/manual-env-allowlist.yml"
    assert "EXACTLY_14_KEY" in message and "14일 뒤 만료" in message


def test_entry_expiring_in_exactly_15_days_is_just_outside_window(tmp_path):
    """위 테스트의 음성 대조 — 경계값 바로 밖(horizon == 15)은 수집되지 않는다. 이 둘이
    쌍으로 있어야 `<=`(포함)를 `<`(미포함)로 실수해도 어느 한쪽이 반드시 RED가 된다."""
    _write_allowlist(tmp_path, "manual-env-allowlist.yml", """
code_read_high_baseline:
  - key: EXACTLY_15_KEY
    reason: r
    declared_by: PO
    until: "2026-10-02"
""")
    _write_allowlist(tmp_path, "serving-reality-allowlist.yml", _EMPTY_SERVING_REALITY)
    _write_allowlist(tmp_path, "mcp-path-contract-allowlist.yml", _EMPTY_MCP_PATH_CONTRACT)

    from datetime import date
    result = mod.collect_expiry_findings(repo_root=tmp_path, today=date(2026, 9, 17))
    assert result.errors == [] and result.warnings == []


def test_already_expired_entry_is_not_double_reported(tmp_path):
    """이미 만료된 건 각 가드 본체(check_env_drift.py 등)의 FAIL 축이 담당 — 이 경량 축은
    «아직 안 만료됐지만 임박» 구간만 맡아 중복 신호를 안 낸다."""
    _write_allowlist(tmp_path, "manual-env-allowlist.yml", """
code_read_high_baseline:
  - key: OLD_KEY
    reason: r
    declared_by: PO
    until: "2026-09-01"
""")
    _write_allowlist(tmp_path, "serving-reality-allowlist.yml", _EMPTY_SERVING_REALITY)
    _write_allowlist(tmp_path, "mcp-path-contract-allowlist.yml", _EMPTY_MCP_PATH_CONTRACT)

    from datetime import date
    result = mod.collect_expiry_findings(repo_root=tmp_path, today=date(2026, 9, 17))
    assert result.errors == [] and result.warnings == []


# ── 세 자매 파일 전부 커버(PO 비차단 제안) ─────────────────────────────────────

def test_serving_reality_pin_entry_within_window_is_collected(tmp_path):
    _write_allowlist(tmp_path, "manual-env-allowlist.yml", "code_read_high_baseline: []\n")
    _write_allowlist(tmp_path, "serving-reality-allowlist.yml", """
declared_pins:
  - service: sprintable-frontend-prod
    reason: r
    declared_by: PO
    until: "2026-09-20"
declared_stalls: []
""")
    _write_allowlist(tmp_path, "mcp-path-contract-allowlist.yml", _EMPTY_MCP_PATH_CONTRACT)

    from datetime import date
    result = mod.collect_expiry_findings(repo_root=tmp_path, today=date(2026, 9, 17))
    assert result.errors == []
    assert len(result.warnings) == 1
    rel_path, message = result.warnings[0]
    assert rel_path == "infra/serving-reality-allowlist.yml"
    assert "sprintable-frontend-prod" in message


def test_mcp_path_contract_indirect_entry_within_window_is_collected(tmp_path):
    _write_allowlist(tmp_path, "manual-env-allowlist.yml", "code_read_high_baseline: []\n")
    _write_allowlist(tmp_path, "serving-reality-allowlist.yml", _EMPTY_SERVING_REALITY)
    _write_allowlist(tmp_path, "mcp-path-contract-allowlist.yml", """
declared_mismatches: []
declared_indirect:
  - module: chat
    function: some_helper
    reason: r
    declared_by: PO
    until: "2026-09-22"
""")

    from datetime import date
    result = mod.collect_expiry_findings(repo_root=tmp_path, today=date(2026, 9, 17))
    assert result.errors == []
    assert len(result.warnings) == 1
    rel_path, message = result.warnings[0]
    assert rel_path == "infra/mcp-path-contract-allowlist.yml"
    assert "chat.some_helper" in message


def test_permanent_indirect_entries_without_until_are_never_collected(tmp_path):
    """declared_permanent_indirect는 구조적으로 until이 없다 — 대상 섹션 목록에 아예 없으므로
    이 스크립트가 잘못 스캔해 KeyError 등을 내지 않는지도 같이 확認."""
    _write_allowlist(tmp_path, "manual-env-allowlist.yml", "code_read_high_baseline: []\n")
    _write_allowlist(tmp_path, "serving-reality-allowlist.yml", _EMPTY_SERVING_REALITY)
    _write_allowlist(tmp_path, "mcp-path-contract-allowlist.yml", """
declared_mismatches: []
declared_indirect: []
declared_permanent_indirect:
  - module: attachments
    function: upload_attachments
    reason: r
    declared_by: PO
""")

    from datetime import date
    result = mod.collect_expiry_findings(repo_root=tmp_path, today=date(2026, 9, 17))
    assert result.errors == [] and result.warnings == []


# ── CHANGES 2 — 이 축 자체가 조용히 꺼지는 3가지 길을 구조적 오류로 승격 ──────────

def test_missing_file_is_a_structural_error_not_silent_ok(tmp_path):
    """길 ① — 파일 자체가 사라지면 «OK»가 아니라 오류다(이 축이 대상을 못 보는 것)."""
    (tmp_path / "infra").mkdir(parents=True, exist_ok=True)
    # manual-env-allowlist.yml을 아예 안 씀(삭제/이동된 상황 재현).
    _write_allowlist(tmp_path, "serving-reality-allowlist.yml", _EMPTY_SERVING_REALITY)
    _write_allowlist(tmp_path, "mcp-path-contract-allowlist.yml", _EMPTY_MCP_PATH_CONTRACT)

    from datetime import date
    result = mod.collect_expiry_findings(repo_root=tmp_path, today=date(2026, 9, 17))
    assert len(result.errors) == 1
    rel_path, message = result.errors[0]
    assert rel_path == "infra/manual-env-allowlist.yml"
    assert "파일 자체가 없다" in message


def test_renamed_section_key_is_a_structural_error_not_silent_empty(tmp_path):
    """길 ② — 섹션 키 이름이 바뀌면(리팩터 등) `or []`로 조용히 빈 목록 취급되던 것을
    구조적 오류로 승격 — 빈 목록 `[]`(정상)과 키 자체 부재(오류)를 구분한다."""
    _write_allowlist(tmp_path, "manual-env-allowlist.yml", "code_read_high_baseline_RENAMED: []\n")
    _write_allowlist(tmp_path, "serving-reality-allowlist.yml", _EMPTY_SERVING_REALITY)
    _write_allowlist(tmp_path, "mcp-path-contract-allowlist.yml", _EMPTY_MCP_PATH_CONTRACT)

    from datetime import date
    result = mod.collect_expiry_findings(repo_root=tmp_path, today=date(2026, 9, 17))
    assert len(result.errors) == 1
    rel_path, message = result.errors[0]
    assert rel_path == "infra/manual-env-allowlist.yml"
    assert "code_read_high_baseline" in message and "없다" in message


def test_malformed_until_date_is_a_warning_not_silently_dropped(tmp_path):
    """길 ③ — `until` 형식이 깨지면 `continue`로 조용히 사라지던 것을 경고로 드러낸다."""
    _write_allowlist(tmp_path, "manual-env-allowlist.yml", """
code_read_high_baseline:
  - key: BROKEN_KEY
    reason: r
    declared_by: PO
    until: "not-a-date"
""")
    _write_allowlist(tmp_path, "serving-reality-allowlist.yml", _EMPTY_SERVING_REALITY)
    _write_allowlist(tmp_path, "mcp-path-contract-allowlist.yml", _EMPTY_MCP_PATH_CONTRACT)

    from datetime import date
    result = mod.collect_expiry_findings(repo_root=tmp_path, today=date(2026, 9, 17))
    assert result.errors == []
    assert len(result.warnings) == 1
    rel_path, message = result.warnings[0]
    assert rel_path == "infra/manual-env-allowlist.yml"
    assert "BROKEN_KEY" in message and "형식" in message


# ── main()은 errors가 있으면 exit 1, warnings만 있으면 exit 0(report-only) ────

def test_main_exits_zero_with_warnings_only(monkeypatch, capsys):
    monkeypatch.setattr(
        mod, "collect_expiry_findings",
        lambda: mod.ExpiryScanResult(warnings=[("infra/manual-env-allowlist.yml", "SOON_KEY — 3일 뒤 만료")]),
    )
    exit_code = mod.main()
    out = capsys.readouterr().out
    assert exit_code == 0
    assert "::warning file=infra/manual-env-allowlist.yml::SOON_KEY — 3일 뒤 만료" in out


def test_main_exits_one_with_structural_errors(monkeypatch, capsys):
    monkeypatch.setattr(
        mod, "collect_expiry_findings",
        lambda: mod.ExpiryScanResult(errors=[("infra/manual-env-allowlist.yml", "파일 자체가 없다")]),
    )
    exit_code = mod.main()
    out = capsys.readouterr().out
    assert exit_code == 1
    assert "::error file=infra/manual-env-allowlist.yml::파일 자체가 없다" in out


def test_main_exits_zero_with_no_findings(monkeypatch, capsys):
    monkeypatch.setattr(mod, "collect_expiry_findings", lambda: mod.ExpiryScanResult())
    exit_code = mod.main()
    out = capsys.readouterr().out
    assert exit_code == 0
    assert "OK" in out


# ── 실 레포 대상 핀 테스트(CHANGES 2 — 파일·섹션이 실제로 존재함을 단언) ──────────

def test_real_repo_all_three_files_and_five_sections_are_actually_present():
    """PO 지적 — 예전엔 findings==[]만 확認해 파일이 사라져도 통과했다. 이제는 errors==[]가
    «파일 3개·섹션 5개(code_read_high_baseline·declared_pins·declared_stalls·
    declared_mismatches·declared_indirect) 전부 실제로 존재하고 읽혔다»는 뜻이라 그 자체가
    존재 단언이다."""
    result = mod.collect_expiry_findings()
    assert result.errors == [], f"이 축이 대상을 못 보고 있음: {result.errors}"


def test_real_repo_currently_has_no_expiring_declarations():
    """story #4023 AC1 반영 후 실 레포 3파일 전부 활성 until 항목 0건이므로 지금은 조용하다
    — 메커니즘 자체는 위 양성 대조가 증명한다."""
    result = mod.collect_expiry_findings()
    assert result.warnings == []
