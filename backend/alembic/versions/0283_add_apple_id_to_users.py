"""story #3118(Sign in with Apple, App Store Guideline 4.8) — add users.apple_id.

google_id/github_id(0005)와 동형 패턴 — oauth_callback()의 getattr(User, f"{provider}_id")
조회가 이 컬럼명 규칙에 의존한다.

Revision ID: 0283
Revises: 0281 (promote-2026-08-27a에서 재지정 — 원래 0282)
Create Date: 2026-08-26

⚠️promote 체인 주의(PR #3539): main엔 결제 revert로 0282(platform_settings_vat_rate_bp)가
없다 — develop 원본은 down_revision="0282"지만 main 파일셋에선 KeyError라 0281로 재지정.
develop 쪽 0283은 그대로 "0282"를 가리키므로 두 브랜치가 이 파일에서 갈린다(의도된 갈림).
훗날 VAT(0282)가 승격되는 회차에는 0281의 자식이 둘(0282·0283)이 되므로 alembic merge
revision으로 합치거나 이 down_revision을 되돌려야 한다 — 그 회차 담당자가 이 주석을 본다.

"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = "0283"
down_revision = "0281"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("apple_id", sa.Text(), nullable=True))
    op.create_unique_constraint("uq_users_apple_id", "users", ["apple_id"])
    op.create_index("ix_users_apple_id", "users", ["apple_id"])


def downgrade() -> None:
    op.drop_index("ix_users_apple_id", table_name="users")
    op.drop_constraint("uq_users_apple_id", "users", type_="unique")
    op.drop_column("users", "apple_id")
