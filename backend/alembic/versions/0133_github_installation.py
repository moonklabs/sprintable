"""E-GHAPP Bot-S: github_installation (per-org GitHub App 설치 매핑).

org 가 GitHub App(봇) 설치 시 installation_id 매핑 저장. additive·신규 테이블·백필 불요(기존 org 는
미설치=행 없음). installation access token 은 단명이라 저장 안 함(서비스가 app JWT 로 mint+캐시).

⚠️baseline schema.sql 미변경(의도): post-0096 신규 테이블(0130~0132 동형). fresh-DB CI(baseline +
alembic upgrade head)가 0133 적용. create_all 금지 — 모델↔마이그 매칭은 migrated-DB 로 검증.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID


revision = "0133"
down_revision = "0132"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    if "github_installation" in insp.get_table_names():
        return
    op.create_table(
        "github_installation",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", UUID(as_uuid=True), nullable=False),
        sa.Column("installation_id", sa.BigInteger(), nullable=False),
        sa.Column("account_login", sa.String(length=255), nullable=True),
        sa.Column("account_type", sa.String(length=32), nullable=True),
        sa.Column("repository_selection", sa.String(length=16), nullable=True),
        sa.Column("suspended_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
    )
    op.create_unique_constraint("uq_github_installation_org", "github_installation", ["org_id"])
    op.create_unique_constraint(
        "uq_github_installation_installation_id", "github_installation", ["installation_id"]
    )
    op.create_index("ix_github_installation_org_id", "github_installation", ["org_id"])


def downgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    if "github_installation" in insp.get_table_names():
        op.drop_table("github_installation")
