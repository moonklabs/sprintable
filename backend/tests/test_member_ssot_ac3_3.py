"""E-MEMBER-SSOT AC3-3: standup author/feedback canonical 이행 — 구조 + 헬퍼 가드.

실데이터 기능(canonical missing 단일신원·0081 병합/정규화)은 test_member_ssot_parity_realdb.py(실 PG).
여기선 항상 도는 구조회귀 + standups write 경로가 canonical resolver로 전환됐는지.
"""
from __future__ import annotations

import pytest


def test_standups_write_uses_canonical_resolver():
    """PUT self-save가 resolve_auth_member(team_member-first) → resolve_member(canonical)로 전환되고,
    POST/feedback가 canonicalize_member_id로 정규화하는지(소스 가드)."""
    import inspect

    from app.routers import standups

    src = inspect.getsource(standups)
    assert "resolve_auth_member" not in src, "PUT가 아직 team_member-first(#1167 회귀 위험)"
    assert "resolve_member(" in src, "canonical resolver 미사용"
    assert src.count("canonicalize_member_id") >= 2, "POST author + feedback canonicalize 누락(트랩#9)"


def test_get_missing_uses_effective_access_not_team_member_enum():
    """missing 산정이 TeamMember 열거가 아닌 effective access(project_access/alias) 기반인지(소스 가드)."""
    import inspect

    from app.repositories import standup

    src = inspect.getsource(standup)
    assert "member_identity_aliases" in src and "project_access" in src, "effective-access 미반영"
    assert "TeamMember.type" not in src, "여전히 team_member 열거(멀티프로젝트 중복 미해소)"
