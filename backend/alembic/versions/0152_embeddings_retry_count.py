"""E-LOOP-LEDGER P1-S3f(story 00ff282b): embeddings.retry_count — poison-pill row 종결 정책.

additive·not-null(server_default 0)·백필 불요(기존 pending/failed row는 0부터 시작 — 과거
실패 이력을 소급 카운트하지 않고 이 마이그 이후의 연속 실패만 카운트). embed-backlog cron이
연속 N회(5) 실패 시 status='failed' 유지 + retry_count>=5로 배치 재선정에서 제외되어
terminal 취급된다(신규 status 값·CHECK 변경 없음 — 기존 'failed' 재활용, PO AC 지시).
"""
from alembic import op
import sqlalchemy as sa

revision = "0152"
down_revision = "0151"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    cols = {c["name"] for c in insp.get_columns("embeddings")}
    if "retry_count" not in cols:
        op.add_column(
            "embeddings",
            sa.Column("retry_count", sa.Integer(), nullable=False, server_default="0"),
        )


def downgrade() -> None:
    op.drop_column("embeddings", "retry_count")
