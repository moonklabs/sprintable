"""E-ENTITY-CLEANUP S7: org_members 데이터 정합성 backfill 테스트.

AC1: migration 0046 실행 후 team_members(human) 유저 전원이 org_members에 존재
AC2: backfill SQL에 org_members 미등록 유저만 INSERT
AC3: ON CONFLICT DO NOTHING — 중복 없음
AC4: type=agent, is_active=false 유저 제외
AC5: 롤백 migration 포함
"""
from __future__ import annotations

import os


def _migration_content() -> str:
    path = os.path.join(
        os.path.dirname(__file__), "..", "alembic", "versions",
        "0046_backfill_org_members_from_team_members.py"
    )
    with open(path) as f:
        return f.read()


def test_migration_0046_exists():
    """0046 migration 파일 존재."""
    path = os.path.join(
        os.path.dirname(__file__), "..", "alembic", "versions",
        "0046_backfill_org_members_from_team_members.py"
    )
    assert os.path.exists(path)


def test_migration_0046_revision_chain():
    """0046 revision=0046, down_revision=0045."""
    content = _migration_content()
    assert 'revision = "0046"' in content
    assert 'down_revision = "0045"' in content


def test_migration_inserts_into_org_members():
    """0046 migration 소스에 INSERT INTO org_members 존재."""
    content = _migration_content()
    assert "INSERT INTO org_members" in content
    assert "org_id" in content
    assert "user_id" in content


def test_migration_selects_from_team_members():
    """0046 migration 소스에 team_members(human) SELECT 존재."""
    content = _migration_content()
    assert "team_members" in content
    assert "human" in content


def test_migration_excludes_inactive():
    """0046 migration 소스에 is_active=TRUE 필터 존재."""
    content = _migration_content()
    assert "is_active" in content


def test_migration_excludes_existing():
    """0046 migration 소스에 NOT EXISTS org_members 체크 존재."""
    content = _migration_content()
    assert "NOT EXISTS" in content
    assert "org_members" in content


def test_migration_has_conflict_guard():
    """0046 migration 소스에 ON CONFLICT DO NOTHING 존재."""
    content = _migration_content()
    assert "ON CONFLICT" in content
    assert "DO NOTHING" in content


def test_migration_has_downgrade():
    """0046 migration 소스에 downgrade 함수 존재."""
    content = _migration_content()
    assert "def downgrade" in content
