"""story cbd578d4(E-AUTH-REBUILD 활성화게이트][C4]·doc §7.5): auth_native_bootstrap_codes를
per-installation 챌린지-assertion 흐름에 맞게 재구성.

§7.0 명시 삭제: `device_binding_hash`(문자열 비교 device binding, S5의 임시 스킴)를 완전
제거 — C1~C4의 challenge-bound cryptographic attestation이 대체한다. `installation_id`+
`key_version`+`redeem_challenge_id`를 추가해 코드가 등록된 설치·redeem 챌린지에 정확히
바인딩되게 한다.

이 테이블은 FIREBASE_AUTH_MOBILE_ISSUE가 모든 non-test 환경에서 계속 off라 실 행이 전혀
없다 — device_binding_hash DROP은 안전(파괴적이지만 사용된 적 없는 컬럼).

Revision ID: 0193
Revises: 0192
Create Date: 2026-07-16
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0193"
down_revision = "0192"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_column("auth_native_bootstrap_codes", "device_binding_hash")
    op.add_column(
        "auth_native_bootstrap_codes",
        sa.Column(
            "installation_id", postgresql.UUID(as_uuid=True),
            sa.ForeignKey("device_installations.id", ondelete="CASCADE"), nullable=True,
        ),
    )
    op.add_column("auth_native_bootstrap_codes", sa.Column("key_version", sa.Integer(), nullable=True))
    op.add_column(
        "auth_native_bootstrap_codes",
        sa.Column(
            "redeem_challenge_id", postgresql.UUID(as_uuid=True),
            sa.ForeignKey("device_proof_challenges.id", ondelete="CASCADE"), nullable=True,
        ),
    )
    op.create_index(
        "ix_auth_native_bootstrap_codes_installation_id", "auth_native_bootstrap_codes", ["installation_id"]
    )


def downgrade() -> None:
    op.drop_index("ix_auth_native_bootstrap_codes_installation_id", table_name="auth_native_bootstrap_codes")
    op.drop_column("auth_native_bootstrap_codes", "redeem_challenge_id")
    op.drop_column("auth_native_bootstrap_codes", "key_version")
    op.drop_column("auth_native_bootstrap_codes", "installation_id")
    op.add_column("auth_native_bootstrap_codes", sa.Column("device_binding_hash", sa.Text(), nullable=True))
