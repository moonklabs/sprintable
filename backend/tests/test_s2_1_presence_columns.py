"""S2-1: team_members presence 컬럼 추가 검증.

AC1: Alembic migration 0038 파일 존재 + revision 구조 정상
AC2: last_seen_at TIMESTAMPTZ NULL
AC3: active_story_id UUID NULL FK stories(id) ON DELETE SET NULL
AC4: agent_status VARCHAR(20) NULL
AC5: TeamMember 모델에 3개 Mapped 필드
AC6: TeamMemberResponse 스키마에 3개 필드
AC7: 기존 데이터 손상 없음 (기본값 NULL)
"""
from __future__ import annotations

import inspect
import uuid
from datetime import datetime, timezone
from pathlib import Path

import pytest


MIGRATION_PATH = Path(__file__).parent.parent / "alembic/versions/0038_add_presence_columns_to_team_members.py"


# ─── AC1: migration 파일 구조 ─────────────────────────────────────────────────

def test_migration_file_exists():
    """0038 migration 파일 존재."""
    assert MIGRATION_PATH.exists()


def test_migration_revision():
    """revision=0038, down_revision=0037."""
    content = MIGRATION_PATH.read_text()
    assert 'revision = "0038"' in content
    assert 'down_revision = "0037"' in content


def test_migration_has_upgrade():
    """upgrade() 함수에 3개 add_column 포함."""
    content = MIGRATION_PATH.read_text()
    assert "last_seen_at" in content
    assert "active_story_id" in content
    assert "agent_status" in content
    assert "op.add_column" in content


def test_migration_has_downgrade():
    """downgrade() 함수에 3개 drop_column 포함."""
    content = MIGRATION_PATH.read_text()
    assert "op.drop_column" in content


def test_migration_fk_on_delete_set_null():
    """active_story_id FK ON DELETE SET NULL 설정."""
    content = MIGRATION_PATH.read_text()
    assert "SET NULL" in content or "ondelete" in content


# ─── AC2~AC4: 컬럼 정의 검증 ─────────────────────────────────────────────────

def test_migration_last_seen_at_timestamptz():
    """last_seen_at TIMESTAMP(timezone=True) 타입."""
    content = MIGRATION_PATH.read_text()
    assert "TIMESTAMP" in content or "timezone=True" in content


def test_migration_agent_status_varchar20():
    """agent_status String(20) 타입."""
    content = MIGRATION_PATH.read_text()
    assert "String(20)" in content or "VARCHAR(20)" in content


# ─── AC5: TeamMember 모델 ────────────────────────────────────────────────────

def test_model_has_last_seen_at():
    """TeamMember.last_seen_at Mapped 필드 존재."""
    from app.models.team import TeamMember
    assert hasattr(TeamMember, "last_seen_at")


def test_model_has_active_story_id():
    """TeamMember.active_story_id Mapped 필드 존재."""
    from app.models.team import TeamMember
    assert hasattr(TeamMember, "active_story_id")


def test_model_has_agent_status():
    """TeamMember.agent_status Mapped 필드 존재."""
    from app.models.team import TeamMember
    assert hasattr(TeamMember, "agent_status")


# ─── AC6: TeamMemberResponse 스키마 ─────────────────────────────────────────

def test_schema_includes_last_seen_at():
    """TeamMemberResponse.last_seen_at 필드 존재."""
    from app.schemas.team_member import TeamMemberResponse
    assert "last_seen_at" in TeamMemberResponse.model_fields


def test_schema_includes_active_story_id():
    """TeamMemberResponse.active_story_id 필드 존재."""
    from app.schemas.team_member import TeamMemberResponse
    assert "active_story_id" in TeamMemberResponse.model_fields


def test_schema_includes_agent_status():
    """TeamMemberResponse.agent_status 필드 존재."""
    from app.schemas.team_member import TeamMemberResponse
    assert "agent_status" in TeamMemberResponse.model_fields


# ─── AC7: 기본값 NULL 검증 ───────────────────────────────────────────────────

def test_schema_presence_fields_default_none():
    """presence 3개 필드 기본값 None — 기존 레코드 호환."""
    from app.schemas.team_member import TeamMemberResponse
    fields = TeamMemberResponse.model_fields
    for field_name in ("last_seen_at", "active_story_id", "agent_status"):
        field = fields[field_name]
        assert field.default is None, f"{field_name} 기본값이 None이어야 함"


def test_model_presence_fields_nullable():
    """TeamMember 모델의 presence 컬럼이 nullable=True."""
    from app.models.team import TeamMember
    from sqlalchemy import inspect as sa_inspect
    mapper = sa_inspect(TeamMember)
    for col_name in ("last_seen_at", "active_story_id", "agent_status"):
        col = mapper.columns[col_name]
        assert col.nullable is True, f"{col_name} nullable=True 필요"
