"""add workflow_templates table with seed data

Revision ID: 0016
Revises: 0015
Create Date: 2026-05-09
"""
from __future__ import annotations

import json
import uuid

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision = "0016"
down_revision = "0015"
branch_labels = None
depends_on = None

SEED_TEMPLATES = [
    {
        "slug": "solo",
        "name": "Solo",
        "description": "1인 작업자. 할당 → 완료.",
        "chain_length": 1,
        "steps": [
            {"pattern": "assign", "role_ref": "step_1", "default_label": "Worker"},
        ],
        "presets": {
            "developer": {"step_1": "Developer"},
            "designer": {"step_1": "Designer"},
            "writer": {"step_1": "Writer"},
        },
        "rules_template": [
            {
                "role_ref": "step_1",
                "name": "{step_1} auto-assign on kickoff",
                "priority": 10,
                "match_type": "event",
                "conditions": {"memo_type": ["task"], "trigger_type_slugs": ["kickoff"]},
                "action": {"auto_reply_mode": "process_and_report", "side_effects": [{"type": "auto_assign", "assign_to_role": "step_1"}]},
            }
        ],
    },
    {
        "slug": "two-step",
        "name": "Two-Step Review",
        "description": "제출 → 검토. 코드 리뷰, 디자인 검토, 원고 편집, 승인 등.",
        "chain_length": 2,
        "steps": [
            {"pattern": "assign", "role_ref": "step_1", "default_label": "Maker"},
            {"pattern": "submit", "role_ref": "step_1"},
            {"pattern": "review", "role_ref": "step_2", "default_label": "Reviewer"},
        ],
        "presets": {
            "dev-review": {"step_1": "Developer", "step_2": "Tech Lead"},
            "content-edit": {"step_1": "Writer", "step_2": "Editor"},
            "design-review": {"step_1": "Designer", "step_2": "Art Director"},
            "approval": {"step_1": "Requester", "step_2": "Approver"},
        },
        "rules_template": [
            {
                "role_ref": "step_1",
                "name": "{step_1} auto-assign on kickoff",
                "priority": 10,
                "match_type": "event",
                "conditions": {"memo_type": ["task"], "trigger_type_slugs": ["kickoff"]},
                "action": {"auto_reply_mode": "process_and_report", "side_effects": [{"type": "auto_assign", "assign_to_role": "step_1"}]},
            },
            {
                "role_ref": "step_2",
                "name": "{step_1} submit → {step_2} review + status in-review",
                "priority": 20,
                "match_type": "event",
                "conditions": {"trigger_type_slugs": ["review_request"], "event_params": {"reply_author_role": ["step_1"]}},
                "action": {"auto_reply_mode": "process_and_report", "side_effects": [{"type": "update_status", "target_status": "in-review"}]},
            },
            {
                "role_ref": "step_1",
                "name": "{step_2} approve → {step_1} complete notify",
                "priority": 30,
                "match_type": "event",
                "conditions": {"trigger_type_slugs": ["review_request"], "event_params": {"reply_author_role": ["step_2"], "review_type": ["approve"]}},
                "action": {"auto_reply_mode": "process_and_report", "side_effects": [{"type": "update_status", "target_status": "done"}]},
            },
        ],
    },
    {
        "slug": "three-step",
        "name": "Three-Step Pipeline",
        "description": "제출 → 1차 검토 → 2차 검토. PO-Dev-QA, 작성-편집-발행 등.",
        "chain_length": 3,
        "steps": [
            {"pattern": "assign", "role_ref": "step_1", "default_label": "Executor"},
            {"pattern": "submit", "role_ref": "step_1"},
            {"pattern": "review", "role_ref": "step_2", "default_label": "Reviewer"},
            {"pattern": "review", "role_ref": "step_3", "default_label": "Approver"},
        ],
        "presets": {
            "po-dev-qa": {"step_1": "Developer", "step_2": "Product Owner", "step_3": "QA"},
            "content-publish": {"step_1": "Writer", "step_2": "Editor", "step_3": "Publisher"},
            "campaign": {"step_1": "Planner", "step_2": "Executor", "step_3": "Reviewer"},
        },
        "rules_template": [
            {
                "role_ref": "step_1",
                "name": "{step_1} auto-assign on kickoff",
                "priority": 10,
                "match_type": "event",
                "conditions": {"memo_type": ["task"], "trigger_type_slugs": ["kickoff"]},
                "action": {"auto_reply_mode": "process_and_report", "side_effects": [{"type": "auto_assign", "assign_to_role": "step_1"}]},
            },
            {
                "role_ref": "step_2",
                "name": "{step_1} submit → {step_2} review + in-review",
                "priority": 20,
                "match_type": "event",
                "conditions": {"trigger_type_slugs": ["review_request"], "event_params": {"reply_author_role": ["step_1"]}},
                "action": {"auto_reply_mode": "process_and_report", "side_effects": [{"type": "update_status", "target_status": "in-review"}]},
            },
            {
                "role_ref": "step_3",
                "name": "{step_2} approve → {step_3} final review",
                "priority": 30,
                "match_type": "event",
                "conditions": {"trigger_type_slugs": ["review_request"], "event_params": {"reply_author_role": ["step_2"], "review_type": ["approve"]}},
                "action": {"auto_reply_mode": "process_and_report", "side_effects": []},
            },
            {
                "role_ref": "step_2",
                "name": "{step_3} approve → {step_2} complete notify",
                "priority": 40,
                "match_type": "event",
                "conditions": {"trigger_type_slugs": ["qa_request"], "event_params": {"reply_author_role": ["step_3"], "review_type": ["approve"]}},
                "action": {"auto_reply_mode": "process_and_report", "side_effects": [{"type": "update_status", "target_status": "done"}]},
            },
        ],
    },
    {
        "slug": "kanban",
        "name": "Kanban Flow",
        "description": "상태 전이 기반 알림. 역할 구분 없이 상태 변경 시 팀 알림.",
        "chain_length": 0,
        "steps": [
            {"pattern": "assign", "role_ref": "step_1", "default_label": "Member"},
        ],
        "presets": {},
        "rules_template": [
            {
                "role_ref": "step_1",
                "name": "Status in-review → team notify",
                "priority": 10,
                "match_type": "event",
                "conditions": {"trigger_type_slugs": ["status_changed"], "event_params": {"new_status": ["in-review"]}},
                "action": {"auto_reply_mode": "process_and_report", "side_effects": []},
            },
            {
                "role_ref": "step_1",
                "name": "Status done → team notify",
                "priority": 20,
                "match_type": "event",
                "conditions": {"trigger_type_slugs": ["status_changed"], "event_params": {"new_status": ["done"]}},
                "action": {"auto_reply_mode": "process_and_report", "side_effects": []},
            },
        ],
    },
]


def upgrade() -> None:
    # Guard: create table only if it doesn't already exist (dev envs may have it from create_all)
    conn = op.get_bind()
    table_exists = conn.execute(
        sa.text("SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='workflow_templates')")
    ).scalar()

    if not table_exists:
        op.create_table(
            "workflow_templates",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("slug", sa.String(100), unique=True, nullable=False, index=True),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("description", sa.Text, nullable=False, server_default=""),
        sa.Column("chain_length", sa.Integer, nullable=False),
        sa.Column("steps", JSONB, nullable=False, server_default="[]"),
        sa.Column("presets", JSONB, nullable=False, server_default="{}"),
        sa.Column("rules_template", JSONB, nullable=False, server_default="[]"),
        sa.Column("is_system", sa.Boolean, nullable=False, server_default="true"),
        sa.Column("is_enabled", sa.Boolean, nullable=False, server_default="true"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        )
    else:
        # Table exists from create_all — ensure slug column is present
        col_exists = conn.execute(
            sa.text("SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='workflow_templates' AND column_name='slug')")
        ).scalar()
        if not col_exists:
            op.add_column("workflow_templates", sa.Column("slug", sa.String(100), nullable=True))
            op.execute("UPDATE workflow_templates SET slug = id::text WHERE slug IS NULL")
            op.alter_column("workflow_templates", "slug", nullable=False)
            op.create_index("ix_workflow_templates_slug", "workflow_templates", ["slug"], unique=True)

    for tmpl in SEED_TEMPLATES:
        conn.execute(
            sa.text(
                "INSERT INTO workflow_templates (id, slug, name, description, chain_length, steps, presets, rules_template, is_system, is_enabled) "
                "VALUES (:id, :slug, :name, :description, :chain_length, :steps::jsonb, :presets::jsonb, :rules_template::jsonb, true, true) "
                "ON CONFLICT (slug) DO NOTHING"
            ),
            {
                "id": str(uuid.uuid4()),
                "slug": tmpl["slug"],
                "name": tmpl["name"],
                "description": tmpl["description"],
                "chain_length": tmpl["chain_length"],
                "steps": json.dumps(tmpl["steps"]),
                "presets": json.dumps(tmpl["presets"]),
                "rules_template": json.dumps(tmpl["rules_template"]),
            },
        )


def downgrade() -> None:
    op.drop_table("workflow_templates")
