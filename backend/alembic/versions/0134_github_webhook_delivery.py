"""E-GHAPP Bot-M.2: github_webhook_delivery (웹훅 멱등 dedup store).

App/legacy 웹훅 통합 ingress의 멱등 — uq(source, delivery_id). HMAC 검증 後 insert + business
side-effect + status 갱신을 동일 트랜잭션으로(실패=rollback→GitHub retry 보존). 중복=2xx no-op.
additive·신규 테이블·백필 불요(과거 delivery 추적 불요).

⚠️baseline schema.sql 미변경(의도): post-0096 신규 테이블(0130~0133 동형). fresh-DB CI(baseline +
alembic upgrade head)가 0134 적용. create_all 금지 — 모델↔마이그 매칭은 migrated-DB 로 검증.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID


revision = "0134"
down_revision = "0133"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    if "github_webhook_delivery" in insp.get_table_names():
        return
    op.create_table(
        "github_webhook_delivery",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("source", sa.String(length=16), nullable=False),       # legacy | app
        sa.Column("delivery_id", sa.String(length=128), nullable=False),  # X-GitHub-Delivery
        sa.Column("event", sa.String(length=64), nullable=True),
        sa.Column("installation_id", sa.BigInteger(), nullable=True),
        sa.Column("org_id", UUID(as_uuid=True), nullable=True),
        sa.Column("status", sa.String(length=16), nullable=False, server_default="received"),
        sa.Column("error_code", sa.String(length=64), nullable=True),
        sa.Column("error_message", sa.String(length=512), nullable=True),
        sa.Column("received_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("processed_at", sa.DateTime(timezone=True), nullable=True),
    )
    # 멱등 핵심: 같은 (source, delivery_id) 중복 → 2xx no-op. source 다르면 별도(spoof 방지).
    op.create_unique_constraint(
        "uq_github_webhook_delivery_src_delivery", "github_webhook_delivery", ["source", "delivery_id"]
    )


def downgrade() -> None:
    op.drop_constraint(
        "uq_github_webhook_delivery_src_delivery", "github_webhook_delivery", type_="unique"
    )
    op.drop_table("github_webhook_delivery")
