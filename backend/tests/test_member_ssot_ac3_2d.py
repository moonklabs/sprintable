"""E-MEMBER-SSOT AC3-2d 배치1(🔴): 잔여 team_members FK 완화 구조 회귀.

migration 0085가 12컬럼의 team_members FK를 완화(grant-only 휴먼 write 500 해소) + 기존 데이터 canonical
정규화. 실데이터 정규화/백필은 test_member_ssot_parity_realdb.py(실 PG). 여기선 모델 FK 부재 구조회귀.
write 경로 canonicalize는 batch1b(별 PR).
"""
from __future__ import annotations

import pytest


def _red_cols():
    from app.models.agent_run import AgentRun
    from app.models.file_lock import FileLock
    from app.models.hitl_config import MemberGateOverride
    from app.models.invitation import Invitation
    from app.models.meeting import Meeting
    from app.models.policy_document import PolicyDocument
    from app.models.pm import StoryActivity, StoryComment
    from app.models.retro import RetroAction, RetroItem, RetroSession, RetroVote

    return [
        (RetroSession, "created_by"),
        (RetroItem, "author_id"),
        (RetroVote, "voter_id"),
        (RetroAction, "assignee_id"),
        (FileLock, "member_id"),
        (MemberGateOverride, "member_id"),
        (Invitation, "invited_by"),
        (Meeting, "created_by"),
        (PolicyDocument, "created_by"),
        (StoryComment, "created_by"),
        (StoryActivity, "created_by"),
        (AgentRun, "agent_id"),
    ]


@pytest.mark.parametrize("model,col", _red_cols(), ids=lambda v: getattr(v, "__name__", v))
def test_ac3_2d_red_col_has_no_team_members_fk(model, col):
    """0085: 🔴 식별 컬럼 team_members FK 제거 — grant-only 휴먼(canonical members.id) write 시 실DB
    FK violation 500 방지. canonical 정규화는 0085 백필 + batch1b write canonicalize."""
    referred = {fk.column.table.name for fk in model.__table__.c[col].foreign_keys}
    assert "team_members" not in referred, f"{model.__name__}.{col} still has team_members FK"
