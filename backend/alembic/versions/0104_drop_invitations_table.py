"""d3619e80 ③ cutover: 구 invitations 테이블 제거

canonical=org_invites(OrgInvite)+invite_accept 단일 경로로 통합 완료.
#1307에서 invitations.pending 토큰을 org_invites로 이전(token 보존)했으므로
잔여 invitations 행을 더 보존할 필요가 없다.

⚠️ deploy-before-migrate: invitations를 참조하던 코드(라우터/모델/리포지토리/스키마)를
먼저 배포(코드 0건)한 뒤 본 마이그레이션을 실행해야 한다. 코드보다 DROP이 앞서면
잔존 코드가 없는 테이블을 조회해 500이 발생한다.

Revision ID: 0104
Revises: 0103
Create Date: 2026-06-08
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "0104"
down_revision = "0103"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("DROP TABLE IF EXISTS invitations CASCADE")


def downgrade() -> None:
    # invitations 원 정의(app/models/invitation.py 삭제 前 기준) 복원.
    op.create_table(
        "invitations",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", UUID(as_uuid=True), nullable=False, index=True),
        sa.Column(
            "project_id",
            UUID(as_uuid=True),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=True,
            index=True,
        ),
        sa.Column("invited_by", UUID(as_uuid=True), nullable=False),
        sa.Column("email", sa.Text(), nullable=False),
        sa.Column("role", sa.Text(), nullable=False, server_default="member"),
        sa.Column("token", sa.Text(), nullable=False, unique=True),
        sa.Column("status", sa.Text(), nullable=False, server_default="pending"),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("accepted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("email_sent_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("email_error", sa.Text(), nullable=True),
    )
