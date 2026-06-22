"""E-GHAPP Bot-L.1: pull_request_story_link (PR↔story canonical 링크).

컨벤션-free 링킹 store — explicit/auto_match/sid/text link_source + confidence + evidence. close-on-merge 는
confident link 에만. additive·신규 테이블·백필 불요(과거 PR 링크 추적 불요).

⚠️baseline schema.sql 미변경(의도): post-0096 신규 테이블(0130~0134 동형). fresh-DB CI 가 0135 적용.
create_all 금지 — 모델↔마이그 매칭은 migrated-DB 로 검증.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB, UUID


revision = "0135"
down_revision = "0134"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    if "pull_request_story_link" in insp.get_table_names():
        return
    op.create_table(
        "pull_request_story_link",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", UUID(as_uuid=True), nullable=False),
        sa.Column("story_id", UUID(as_uuid=True), nullable=False),
        sa.Column("repo_full_name", sa.String(length=255), nullable=False),
        sa.Column("pr_number", sa.Integer(), nullable=False),
        sa.Column("link_source", sa.String(length=16), nullable=False),
        sa.Column("confidence", sa.String(length=8), nullable=False),
        sa.Column("created_by", UUID(as_uuid=True), nullable=True),
        sa.Column("evidence", JSONB(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_unique_constraint(
        "uq_pr_story_link_org_repo_pr", "pull_request_story_link", ["org_id", "repo_full_name", "pr_number"]
    )
    op.create_index("ix_pull_request_story_link_org_id", "pull_request_story_link", ["org_id"])
    op.create_index("ix_pull_request_story_link_story_id", "pull_request_story_link", ["story_id"])
    op.create_foreign_key(
        "fk_pr_story_link_org", "pull_request_story_link", "organizations",
        ["org_id"], ["id"], ondelete="CASCADE",
    )
    op.create_foreign_key(
        "fk_pr_story_link_story", "pull_request_story_link", "stories",
        ["story_id"], ["id"], ondelete="CASCADE",
    )


def downgrade() -> None:
    op.drop_constraint("fk_pr_story_link_story", "pull_request_story_link", type_="foreignkey")
    op.drop_constraint("fk_pr_story_link_org", "pull_request_story_link", type_="foreignkey")
    op.drop_constraint("uq_pr_story_link_org_repo_pr", "pull_request_story_link", type_="unique")
    op.drop_table("pull_request_story_link")
