"""plan_features 테이블 생성 + 기본 피처코드 시딩 (E-OA1:S4)

Revision ID: 0049
Revises: 0048
"""
import uuid
from datetime import datetime, timezone

from alembic import op
import sqlalchemy as sa

revision = "0049"
down_revision = "0048"
branch_labels = None
depends_on = None

SEED_DATA = [
    # free tier
    {
        "id": str(uuid.uuid4()),
        "code": "open_api_read",
        "name": "Open API Read",
        "tier": "free",
        "description": "Read-only access to Open API endpoints",
        "is_active": True,
        "rate_limit_per_min": 30,
    },
    # team tier
    {
        "id": str(uuid.uuid4()),
        "code": "open_api_write",
        "name": "Open API Write",
        "tier": "team",
        "description": "Read/write access to Open API endpoints",
        "is_active": True,
        "rate_limit_per_min": 60,
    },
    {
        "id": str(uuid.uuid4()),
        "code": "open_api_webhook",
        "name": "Open API Webhook",
        "tier": "team",
        "description": "Webhook integration via Open API",
        "is_active": True,
        "rate_limit_per_min": 60,
    },
    # pro tier
    {
        "id": str(uuid.uuid4()),
        "code": "open_api_admin",
        "name": "Open API Admin",
        "tier": "pro",
        "description": "Full administrative access to Open API endpoints",
        "is_active": True,
        "rate_limit_per_min": 120,
    },
    {
        "id": str(uuid.uuid4()),
        "code": "open_api_bulk",
        "name": "Open API Bulk Operations",
        "tier": "pro",
        "description": "Bulk create/update operations via Open API",
        "is_active": True,
        "rate_limit_per_min": 120,
    },
]


def upgrade() -> None:
    op.create_table(
        "plan_features",
        sa.Column("id", sa.dialects.postgresql.UUID(as_uuid=False), primary_key=True),
        sa.Column("code", sa.Text(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("tier", sa.String(16), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("rate_limit_per_min", sa.Integer(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index("ix_plan_features_code", "plan_features", ["code"], unique=True)
    op.create_index("ix_plan_features_tier", "plan_features", ["tier"])

    plan_features = sa.table(
        "plan_features",
        sa.column("id", sa.Text),
        sa.column("code", sa.Text),
        sa.column("name", sa.Text),
        sa.column("tier", sa.Text),
        sa.column("description", sa.Text),
        sa.column("is_active", sa.Boolean),
        sa.column("rate_limit_per_min", sa.Integer),
    )
    op.bulk_insert(plan_features, SEED_DATA)


def downgrade() -> None:
    op.drop_index("ix_plan_features_tier", table_name="plan_features")
    op.drop_index("ix_plan_features_code", table_name="plan_features")
    op.drop_table("plan_features")
