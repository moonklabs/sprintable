"""story #2384 — backend/scripts/ 루트에 새 .py가 조용히 추가되는 것을 막는 lint.

배경: backend/Dockerfile은 scripts/jobs/·scripts/migrate.sh만 배포 이미지에 COPY한다(#1666
의도적 축소 — deploy/setup/provision .sh·RUNBOOK 등 비-런타임 전용, recon-surface 최소화).
그런데 이 경계가 코드 어디에도 강제되지 않아 "운영 DB에 실제로 접속하는 스크립트"가 이
scripts/ 루트에 놓이는 사고가 이미 두 번 났다:
  1. backfill_reference_semantic_candidates.py — 오르테가 2026-07-31(#2727 후속)
     scripts/jobs/로 이동, 이유를 자기 docstring에 남김.
  2. backfill_activity_events.py·expire_undeliverable_pending_dispatched_events.py —
     이 스토리(#2384)에서 같은 이유로 같은 이동.
두 번 다 "그때그때 옮긴다"였지 재발을 막는 자리가 없었다 — 이 lint가 그 자리다.

메커니즘: scripts/ 루트의 .py 파일을 전수로 훑어 아래 allowlist와 대조한다. allowlist에
없는 새 .py가 추가되면 이 테스트가 빨개진다 — 작성자가 "이건 CI 전용(로컬/CI에서만 돌고
배포 이미지 진입 불필요)"이라고 판단했으면 allowlist에 그 근거와 함께 추가하고, "운영 DB에
접속해야 한다"고 판단했으면 scripts/jobs/로 옮긴다. ⛔이 lint는 새 파일이 어느 쪽인지
대신 판단해 주지 않는다 — 판단을 강제로 만들 뿐이다(안 만들면 조용히 scripts/ 루트에
얹히던 지금까지의 실패 모드를 막는다).
"""
from __future__ import annotations

from pathlib import Path

_SCRIPTS_ROOT = Path(__file__).resolve().parent.parent / "scripts"

# CI/로컬 전용으로 확인된 .py — 전부 CI 워크플로가 리포 체크아웃에서 직접 부르거나(lint 게이트),
# 엔지니어가 로컬에서 1회성으로 돌리는 분석 도구. 운영 DB에 상시 접속해 데이터를 변경하지
# 않는다(model_db_drift_audit.py는 읽기 전용 감사 — ALEMBIC_DATABASE_URL로 로컬에서 돌리는
# 것을 전제로 문서화돼 있다, story #2181).
_CI_OR_LOCAL_ONLY_ALLOWLIST = frozenset({
    "ci_alembic_sibling_pr_collision_check.py",   # story #2401 — CI 전용, git+gh api만 사용(운영 DB 무접속)
    "ci_alembic_single_step_promotion_check.py",  # story #2330 — CI 전용 fresh-DB 재현
    "lint_business_info_email_footer_drift.py",   # story #3216 — CI lint 게이트(정적 텍스트 대조, 운영 DB 무접속)
    "lint_candidate_source_ownership.py",         # story #2363 AC6 — CI lint 게이트
    "lint_commit_before_validate.py",             # story #2459 — CI lint 게이트(AST 정적분석, 운영 DB 무접속)
    "lint_dependency_override_get_read_db.py",    # story #2451 — CI lint 게이트(tests/ override 스캔, 운영 DB 무접속)
    "lint_destructive_test_sql.py",               # story #2786 — CI lint 게이트(tests/ 재귀 AST 스캔, 운영 DB 무접속)
    "lint_project_access_403.py",                 # story #2342 AC7 — CI lint 게이트
    "lint_query_sentinel_direct_calls.py",        # story #2335 — CI lint 게이트
    "lint_no_script_output_artifacts.py",         # story #3008 — CI lint 게이트(scripts/ 파일명·내용 정적 스캔, 운영 DB 무접속)
    "model_db_drift_audit.py",                    # story #2181 — 로컬 1회성 감사(읽기 전용)
    "shard_destructive_tests.py",                 # story #2293 — CI 매트릭스 샤딩 유틸
})


def test_scripts_root_python_files_are_all_allowlisted():
    root_py_files = {p.name for p in _SCRIPTS_ROOT.glob("*.py")}
    unlisted = root_py_files - _CI_OR_LOCAL_ONLY_ALLOWLIST
    assert not unlisted, (
        f"backend/scripts/ 루트에 allowlist 밖 .py가 있다: {sorted(unlisted)}. "
        "이 파일이 운영 DB에 접속하는 스크립트라면 scripts/jobs/로 옮겨라(그래야 배포 이미지에 "
        "실린다 — Dockerfile은 scripts/jobs/만 COPY한다, story #1666/#2727/#2384 참조). "
        "CI/로컬 전용이 맞다면 이 파일의 _CI_OR_LOCAL_ONLY_ALLOWLIST에 근거와 함께 추가하라."
    )


def test_allowlist_entries_still_exist_in_scripts_root():
    """allowlist가 옛 파일명을 들고 죽지 않게 — 옮기거나 지웠으면 여기서도 빼야 한다."""
    root_py_files = {p.name for p in _SCRIPTS_ROOT.glob("*.py")}
    stale = _CI_OR_LOCAL_ONLY_ALLOWLIST - root_py_files
    assert not stale, f"allowlist에 있지만 scripts/ 루트에 더 이상 없는 파일: {sorted(stale)}"
