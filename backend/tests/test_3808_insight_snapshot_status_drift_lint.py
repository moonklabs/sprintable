"""story #3808(Phase3·3-3 PR4, 페드루 PO CHANGES 2026-09-12) —
lint_insight_snapshot_status_drift.py의 정탐/오탐 회귀 가드. 합성 fixture로 짓는다
(실물이 고쳐져도 이 테스트는 안 사라진다 — test_3697_channel_insight_metrics_drift_
lint.py·test_3216_business_info_email_footer_drift_lint.py와 동형 관례)."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))
from lint_insight_snapshot_status_drift import (  # noqa: E402
    StatusExtractionIncompleteError,
    extract_backend_status_vocabulary,
    extract_frontend_status_vocabulary,
    find_drift,
    main as lint_main,
)
import pytest  # noqa: E402

BACKEND_PY_MATCHING = '''
async def schedule_insight_snapshots(db, *, org_id):
    stmt = pg_insert(InsightSnapshot).values(
        id=uuid.uuid4(), status="pending",
    ).on_conflict_do_nothing()
    await db.execute(stmt)
    await db.execute(
        update(InsightSnapshot).where(InsightSnapshot.status.in_(("pending",))).values(status="superseded")
    )


async def process_due_insight_snapshots(db):
    for snapshot in rows:
        snapshot.status = "in_progress"
    await db.commit()
    for snapshot in rows:
        if await _finalize_snapshot_write(db, snapshot, new_status="unsupported"):
            pass
        if await _finalize_snapshot_write(db, snapshot, new_status="captured"):
            pass
        if await _finalize_snapshot_write(db, snapshot, new_status="failed"):
            pass
'''

FRONTEND_TS_MATCHING = """
export type InsightSnapshotStatus =
  | 'pending'
  | 'in_progress'
  | 'captured'
  | 'unsupported'
  | 'failed'
  | 'superseded';
"""


def test_matching_files_report_zero_drift():
    backend_only, frontend_only = find_drift(BACKEND_PY_MATCHING, FRONTEND_TS_MATCHING)
    assert backend_only == set()
    assert frontend_only == set()


def test_be_new_value_not_mirrored_in_fe_is_detected():
    """BE가 새 상태값을 추가했는데 FE 유니온이 안 따라오면 그 값만 backend_only로
    잡혀야 한다(페드루 PO 리뷰가 지적한 정확히 이 회귀 — #4208의 skipped 누락)."""
    changed_backend = BACKEND_PY_MATCHING.replace(
        'new_status="failed"):\n            pass\n',
        'new_status="failed"):\n            pass\n'
        '        if await _finalize_snapshot_write(db, snapshot, new_status="skipped"):\n            pass\n',
        1,
    )
    backend_only, frontend_only = find_drift(changed_backend, FRONTEND_TS_MATCHING)
    assert backend_only == {"skipped"}
    assert frontend_only == set()


def test_fe_ghost_value_not_in_be_is_detected():
    """FE 유니온에 BE가 실제로 안 쓰는 유령값이 섞이면(#3746류) frontend_only로
    잡혀야 한다 — 양방향 완전성."""
    ghosted_frontend = FRONTEND_TS_MATCHING.replace("| 'superseded';", "| 'superseded'\n  | 'dead_letter';")
    backend_only, frontend_only = find_drift(BACKEND_PY_MATCHING, ghosted_frontend)
    assert backend_only == set()
    assert frontend_only == {"dead_letter"}


def test_attribute_assignment_scoped_to_snapshot_variable_name_only():
    """⭐오탐 회귀 방지(실측 발견) — `.status = "값"` 대입이 `snapshot` 변수가 아닌
    다른 모델(예: GA4Connection)에 걸리면 그 값을 InsightSnapshot 어휘로 잘못
    섞으면 안 된다."""
    backend_with_unrelated_status_assign = BACKEND_PY_MATCHING + '''

async def _promote_ga4(ga4_connection):
    ga4_connection.status = "needs_reauth"
'''
    values = extract_backend_status_vocabulary(backend_with_unrelated_status_assign)
    assert "needs_reauth" not in values


def test_frontend_extraction_missing_union_block_raises():
    with pytest.raises(StatusExtractionIncompleteError):
        extract_frontend_status_vocabulary("export type SomethingElse = 'x' | 'y';")


# ─── AC — 실물 두 파일이 지금 실제로 일치하는지 ─────────────────────────────────

def test_current_repo_files_pass_the_guard():
    assert lint_main() == 0
