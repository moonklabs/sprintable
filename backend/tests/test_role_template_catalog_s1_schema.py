"""~300직군 카탈로그 트랙 S1(문서 role-template-crud-api-crux): division·emoji·skills 스키마 확장.

실 Postgres 검증(마이그 적용 + 기존 24 seed 무회귀)은 별도 스크립트로 수행 — 여기는 마이그
파일 자체의 정적 검증(체인·컬럼 정의)과 스키마/모델 shape 검증.
"""
from __future__ import annotations

import importlib.util
from pathlib import Path

_MIGRATION = Path(__file__).parent.parent / "alembic" / "versions" / "0161_role_templates_catalog_schema_ext.py"


def _load_migration():
    spec = importlib.util.spec_from_file_location("rev_0161", _MIGRATION)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_migration_0161_chains_off_0160():
    mod = _load_migration()
    assert mod.revision == "0161"
    assert mod.down_revision == "0160"
    assert callable(mod.upgrade) and callable(mod.downgrade)


def test_model_has_new_nullable_or_defaulted_fields():
    from app.models.role_template import RoleTemplate

    cols = RoleTemplate.__table__.columns
    assert cols["division"].nullable is True
    assert cols["emoji"].nullable is True
    assert cols["skills"].nullable is False
    assert cols["skills"].default is not None  # ORM-side default(list) — 어느 한쪽이라도 있으면 됨


def test_role_template_summary_schema_exposes_new_fields_with_safe_defaults():
    """기존 24개 seed(division/emoji/skills 값 미설정 시나리오)에서도 응답 직렬화가 깨지지 않는지 —
    division/emoji=None·skills=[] 기본값으로 유효한지."""
    from app.routers.role_templates import RoleTemplateSummary

    payload = {
        "id": "11111111-1111-1111-1111-111111111111",
        "slug": "backend",
        "name": "Backend Engineer",
        "category": "engineering",
        "description": None,
        "default_tool_groups": ["stories", "tasks"],
        "default_workflow_recipe_slug": None,
        "is_builtin": True,
        "tier": "free",
        "version": 1,
    }
    summary = RoleTemplateSummary.model_validate(payload)
    assert summary.division is None
    assert summary.emoji is None
    assert summary.skills == []


def test_skills_field_reuses_a2a_agent_skill_schema():
    """신규 스키마 발명 안 함 — role_templates.skills가 app.schemas.a2a.AgentSkill 그대로인지."""
    from app.routers.role_templates import RoleTemplateSummary
    from app.schemas.a2a import AgentSkill

    payload = {
        "id": "11111111-1111-1111-1111-111111111111",
        "slug": "qa",
        "name": "QA Engineer",
        "category": "qa",
        "description": None,
        "default_tool_groups": ["stories"],
        "default_workflow_recipe_slug": None,
        "is_builtin": True,
        "tier": "free",
        "version": 1,
        "division": "Quality",
        "emoji": "\U0001f41b",
        "skills": [{"id": "qa", "name": "QA", "description": "quality assurance", "tags": ["qa", "testing"]}],
    }
    summary = RoleTemplateSummary.model_validate(payload)
    assert len(summary.skills) == 1
    assert isinstance(summary.skills[0], AgentSkill)
    assert summary.skills[0].id == "qa"
    assert summary.skills[0].tags == ["qa", "testing"]
