"""story #4023 CHANGES 1(PO 지적) — infra/check_expiring_declarations.py 회귀가드.

배경: AC3의 «만료 임박 14일 전 경고»를 처음엔 check_env_drift.py main() 안에 찍었는데, 그
스크립트는 env-drift-guard.yml(스케줄 전용, 새벽 로그)에서만 돌아 PR을 여는 사람이 못 본다
— AC3의 목적("사람이 미리 봄")이 안 닫힌다. 이 스위트는 PR CI에서 매번 도는 별도 경량 축
(GCP 호출 0)이 실제로 GitHub Actions 주석 형식을 내는지 고정한다."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "infra"))

import check_expiring_declarations as mod  # noqa: E402


def _write_allowlist(tmp_path: Path, filename: str, content: str) -> None:
    infra_dir = tmp_path / "infra"
    infra_dir.mkdir(parents=True, exist_ok=True)
    (infra_dir / filename).write_text(content)


# ── 출력 형식(PO 명시 요구) ────────────────────────────────────────────────────

def test_format_gha_warning_matches_github_actions_annotation_syntax():
    """PO 지적 원문 그대로: `::warning file=infra/manual-env-allowlist.yml::…` 형식."""
    line = mod.format_gha_warning("infra/manual-env-allowlist.yml", "SOME_KEY 만료 임박")
    assert line == "::warning file=infra/manual-env-allowlist.yml::SOME_KEY 만료 임박"
    assert line.startswith("::warning file=")
    assert "::" in line[len("::warning file="):]


# ── AC3 양성/음성 대조 — code_read_high_baseline ──────────────────────────────

def test_positive_control_entry_expiring_in_10_days_is_collected(tmp_path):
    _write_allowlist(tmp_path, "manual-env-allowlist.yml", """
code_read_high_baseline:
  - key: SOON_KEY
    reason: r
    declared_by: PO
    until: "2026-09-27"
""")
    _write_allowlist(tmp_path, "serving-reality-allowlist.yml", "declared_pins: []\ndeclared_stalls: []\n")
    _write_allowlist(tmp_path, "mcp-path-contract-allowlist.yml", "declared_mismatches: []\ndeclared_indirect: []\n")

    from datetime import date
    findings = mod.collect_expiring_soon(repo_root=tmp_path, today=date(2026, 9, 17))
    assert len(findings) == 1
    rel_path, message = findings[0]
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
    _write_allowlist(tmp_path, "serving-reality-allowlist.yml", "declared_pins: []\ndeclared_stalls: []\n")
    _write_allowlist(tmp_path, "mcp-path-contract-allowlist.yml", "declared_mismatches: []\ndeclared_indirect: []\n")

    from datetime import date
    assert mod.collect_expiring_soon(repo_root=tmp_path, today=date(2026, 9, 17)) == []


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
    _write_allowlist(tmp_path, "serving-reality-allowlist.yml", "declared_pins: []\ndeclared_stalls: []\n")
    _write_allowlist(tmp_path, "mcp-path-contract-allowlist.yml", "declared_mismatches: []\ndeclared_indirect: []\n")

    from datetime import date
    assert mod.collect_expiring_soon(repo_root=tmp_path, today=date(2026, 9, 17)) == []


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
    _write_allowlist(tmp_path, "mcp-path-contract-allowlist.yml", "declared_mismatches: []\ndeclared_indirect: []\n")

    from datetime import date
    findings = mod.collect_expiring_soon(repo_root=tmp_path, today=date(2026, 9, 17))
    assert len(findings) == 1
    rel_path, message = findings[0]
    assert rel_path == "infra/serving-reality-allowlist.yml"
    assert "sprintable-frontend-prod" in message


def test_mcp_path_contract_indirect_entry_within_window_is_collected(tmp_path):
    _write_allowlist(tmp_path, "manual-env-allowlist.yml", "code_read_high_baseline: []\n")
    _write_allowlist(tmp_path, "serving-reality-allowlist.yml", "declared_pins: []\ndeclared_stalls: []\n")
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
    findings = mod.collect_expiring_soon(repo_root=tmp_path, today=date(2026, 9, 17))
    assert len(findings) == 1
    rel_path, message = findings[0]
    assert rel_path == "infra/mcp-path-contract-allowlist.yml"
    assert "chat.some_helper" in message


def test_permanent_indirect_entries_without_until_are_never_collected(tmp_path):
    """declared_permanent_indirect는 구조적으로 until이 없다 — 대상 섹션 목록에 아예 없으므로
    이 스크립트가 잘못 스캔해 KeyError 등을 내지 않는지도 같이 확認."""
    _write_allowlist(tmp_path, "manual-env-allowlist.yml", "code_read_high_baseline: []\n")
    _write_allowlist(tmp_path, "serving-reality-allowlist.yml", "declared_pins: []\ndeclared_stalls: []\n")
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
    assert mod.collect_expiring_soon(repo_root=tmp_path, today=date(2026, 9, 17)) == []


# ── main()은 findings가 있어도 항상 exit 0(report-only) ──────────────────────

def test_main_exits_zero_even_with_findings(monkeypatch, capsys):
    monkeypatch.setattr(
        mod, "collect_expiring_soon",
        lambda: [("infra/manual-env-allowlist.yml", "SOON_KEY — 3일 뒤 만료")],
    )
    exit_code = mod.main()
    out = capsys.readouterr().out
    assert exit_code == 0
    assert "::warning file=infra/manual-env-allowlist.yml::SOON_KEY — 3일 뒤 만료" in out


def test_main_exits_zero_with_no_findings(monkeypatch, capsys):
    monkeypatch.setattr(mod, "collect_expiring_soon", lambda: [])
    exit_code = mod.main()
    out = capsys.readouterr().out
    assert exit_code == 0
    assert "OK" in out


# ── 실 레포 대상 핀 테스트 ───────────────────────────────────────────────────

def test_real_repo_currently_has_no_expiring_declarations():
    """story #4023 AC1 반영 후 실 레포 3파일 전부 활성 until 항목 0건이므로 지금은 조용하다
    — 메커니즘 자체는 위 양성 대조가 증명한다."""
    assert mod.collect_expiring_soon() == []
