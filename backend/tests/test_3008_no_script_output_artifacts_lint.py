"""story #3008 — lint_no_script_output_artifacts.py의 정탐/오탐 회귀 가드. 실물 디렉토리가
아니라 합성 fixture로 짓는다(실물이 고쳐져도 이 테스트는 안 사라진다, story #2786/#2335
lint와 동형).

양성대조는 사고 원문(fk_null_survey_result.json, 2026-05-04)의 파일명 패턴과 위험 필드명을
각각 재현한다."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))
from lint_no_script_output_artifacts import find_violations  # noqa: E402


def _write(tmp_path: Path, name: str, content: str) -> Path:
    p = tmp_path / name
    p.write_text(content)
    return p


# ── 양성대조: 사고 원문 재현 ──────────────────────────────────────────────

def test_positive_control_result_json_filename_pattern(tmp_path):
    """사고 원문 그대로의 파일명(fk_null_survey_result.json)."""
    _write(tmp_path, "fk_null_survey_result.json", '{"connection": "10.0.0.1"}')
    violations = find_violations(tmp_path)
    assert len(violations) == 1
    assert "명명 관례" in violations[0][1]


def test_positive_control_dump_filename_pattern(tmp_path):
    _write(tmp_path, "org_members_dump.json", '{}')
    violations = find_violations(tmp_path)
    assert len(violations) == 1


def test_positive_control_dangerous_field_regardless_of_filename(tmp_path):
    """파일명이 관례를 안 따라도(예: notes.json) 위험 필드명이 있으면 잡는다."""
    _write(tmp_path, "notes.json", '{"supabase_auth_uid": "abc-123"}')
    violations = find_violations(tmp_path)
    assert len(violations) == 1
    assert "내부 UUID 매핑" in violations[0][1]


def test_positive_control_registered_users_mapping_field(tmp_path):
    _write(tmp_path, "diag.txt", 'registered_users_mapping: [...]')
    violations = find_violations(tmp_path)
    assert len(violations) == 1


# ── 음성대조: 정상 관례는 통과 ──────────────────────────────────────────────

def test_negative_control_legit_iac_script_passes(tmp_path):
    """provision_*.sh류 정본 IaC 스크립트 — 명명도 안 걸리고 위험 필드명도 없다."""
    _write(tmp_path, "provision_cloud_sql.sh", "#!/bin/bash\ngcloud sql instances create sprintable-dev")
    assert find_violations(tmp_path) == []


def test_negative_control_lint_script_itself_not_scanned(tmp_path):
    """이 가드 자신(lint_no_script_output_artifacts.py)은 스캔 대상에서 빠진다 — docstring이
    위험 필드명을 예시로 인용해도 자기 자신을 오탐하지 않는다(자기지시 문제 방지)."""
    # 실제 SELF 가드는 파일명으로 판별하므로, 합성 tmp_path에선 이름이 다르면 여전히 스캔된다
    # — 여기서는 정확히 그 파일명일 때만 면제됨을 확認한다.
    _write(tmp_path, "lint_no_script_output_artifacts.py", "supabase_auth_uid")
    assert find_violations(tmp_path) == []


def test_negative_control_result_substring_not_at_filename_boundary_passes(tmp_path):
    """"_result"가 확장자 직전에 오지 않으면(예: results_archive.md) 정규식이 매치하지 않는다
    — 의도된 관용(파일명 관례는 "_result.<ext>" 정확히 그 끝 형태만 겨냥)."""
    _write(tmp_path, "results_archive.md", "# 아카이브")
    assert find_violations(tmp_path) == []
