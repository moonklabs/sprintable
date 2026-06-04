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


# ── 배치1b: write 경로 canonicalize 소스 가드 ──────────────────────────────────────
def test_batch1b_write_routers_canonicalize():
    """1b: 휴먼-보유 컬럼 write 라우터가 canonicalize_member_id 적용(레거시 tm.id→canonical, (A) write).
    agent-context(hitl/file_locks/agent_runs)·policy(no-create)는 0085 no-op이라 제외."""
    import inspect

    from app.routers import invitations, meetings, retros, stories

    for mod, name in [(retros, "retros"), (invitations, "invitations"), (meetings, "meetings"), (stories, "stories")]:
        src = inspect.getsource(mod)
        assert "canonicalize_member_id" in src, f"{name} write canonicalize 누락"
    # retro 4 식별 컬럼 전부 canonicalize(created_by/author_id/voter_id/assignee_id)
    rsrc = inspect.getsource(retros)
    assert rsrc.count("canonicalize_member_id(") >= 4, "retro 4컬럼 canonicalize 미흡"


def test_batch1b_activity_log_uses_lookup_members():
    """1b 노트#1: activity_log actor_type 해소가 raw TeamMember 조회 → lookup_members_by_ids(anchor)로
    전환(0085 후 canonical 휴먼도 정확 해소; 'human' 기본 fallback 의존 제거)."""
    import inspect

    from app.services import activity_log

    src = inspect.getsource(activity_log)
    assert "lookup_members_by_ids" in src, "activity_log lookup_members 전환 누락"
    assert "select(TeamMember)" not in src, "activity_log에 raw TeamMember 조회 잔존"


# ── 배치2(🟡+notif): write canonicalize + notif_prefs canonical 소스 가드 ──────────────────────────
def test_batch2_yellow_write_canonicalize():
    """배치2: 🟡 write 라우터(webhook/reward/docs) + notif_prefs가 canonical 통일(canonicalize_member_id /
    notif _get_member=resolve_member). 휴먼-context body/resolved id의 (A) write."""
    import inspect

    from app.routers import docs, notification_preferences, rewards, webhooks

    for mod, name in [(webhooks, "webhooks"), (rewards, "rewards"), (docs, "docs")]:
        assert "canonicalize_member_id" in inspect.getsource(mod), f"{name} write canonicalize 누락"
    # reward: member_id + granted_by 둘 다
    assert inspect.getsource(rewards).count("canonicalize_member_id(") >= 2, "reward member_id+granted_by 미흡"
    # notif_prefs _get_member: tm-first 제거 + resolve_member(canonical) 통일
    nsrc = inspect.getsource(notification_preferences._get_member)
    assert "resolve_member(" in nsrc, "notif _get_member canonical 전환 누락"
    # JWT 휴먼 tm-first lookup(TeamMember.user_id 매칭) 제거됨 — api_key 분기의 TeamMember.id만 잔존
    assert "TeamMember.user_id" not in nsrc, "notif _get_member에 JWT-휴먼 tm-first 잔존(split-brain 위험)"
