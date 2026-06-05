"""disable row level security on all FastAPI-managed tables

Revision ID: 0002
Revises: 0001
Create Date: 2026-04-30

C-S5: PostgREST RLS 의존 제거. FastAPI 레이어에서 org_id/project_id 스코핑 및
owner/role 검증을 수행하므로 DB 레벨 RLS 불필요.
DROP은 C-S9 데이터 마이그레이션 시 일괄 처리.
"""
from __future__ import annotations

from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None

# FastAPI backend가 접근하는 모든 테이블 목록
_TABLES = [
    "agent_api_keys",
    "agent_audit_logs",
    "agent_deployments",
    "agent_hitl_policies",
    "agent_hitl_requests",
    "agent_personas",
    "agent_routing_rules",
    "agent_runs",
    "agent_sessions",
    "docs",
    "epics",
    "inbox_items",
    "invitations",
    "meetings",
    "memo_assignees",
    "memo_doc_links",
    "memo_mentions",
    "memo_reads",
    "memo_replies",
    "memos",
    "messaging_bridge_channels",
    "messaging_bridge_users",
    "mockup_components",
    "mockup_pages",
    "mockup_scenarios",
    "mockup_versions",
    "notification_settings",
    "notifications",
    "org_members",
    "org_subscriptions",
    "organizations",
    "permission_audit_logs",
    "policy_documents",
    "project_settings",
    "projects",
    "retro_actions",
    "retro_items",
    "retro_sessions",
    "retro_votes",
    "reward_ledger",
    "sprints",
    "standup_entries",
    "standup_feedback",
    "stories",
    "tasks",
    "team_members",
    "usage_meters",
    "webhook_configs",
    "workflow_versions",
]


def upgrade() -> None:
    for table in _TABLES:
        op.execute(
            f"ALTER TABLE IF EXISTS {table} DISABLE ROW LEVEL SECURITY"
        )


def downgrade() -> None:
    for table in _TABLES:
        op.execute(
            f"ALTER TABLE IF EXISTS {table} ENABLE ROW LEVEL SECURITY"
        )
