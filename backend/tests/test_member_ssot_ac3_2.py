"""E-MEMBER-SSOT AC3-2: 식별 컬럼 v2 + team_members FK 완화 구조 회귀.

Batch2: stories/tasks/epics assignee_id team_members FK 제거(grant-only 할당 500 해소, migration 0078).
실데이터 백필/parity는 test_member_ssot_parity_realdb.py(실 PG) 및 격리 PG 하네스로 검증.
"""
from __future__ import annotations

import pytest


@pytest.mark.parametrize("model_name", ["Epic", "Story", "Task"])
def test_assignee_id_has_no_team_members_fk(model_name):
    """assignee_id의 team_members FK 제거 — grant-only 휴먼(org_member.id) 할당 시 실DB FK violation
    500이 나지 않음 (migration 0078). canonical은 assignee_id_v2."""
    import app.models.pm as pm

    model = getattr(pm, model_name)
    col = model.__table__.c.assignee_id
    referred = {fk.column.table.name for fk in col.foreign_keys}
    assert "team_members" not in referred, f"{model_name}.assignee_id still has team_members FK"
