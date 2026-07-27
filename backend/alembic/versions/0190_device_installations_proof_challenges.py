"""story 822817a0(E-AUTH-REBUILD 활성화게이트][C1]·doc e-mobile-per-install-proof-feasibility
§7.1/§7.2·산티아고 §7 SSOT 2026-07-16): per-installation attestation protocol v1 스키마.

`device_installations` — 서버-authoritative 설치별 공개키/attestation 메타데이터.
`device_proof_challenges` — 1회용 챌린지(raw nonce 미저장, SHA-256 hash만). purpose:
register|bootstrap_issue|bootstrap_redeem.

additive — 기존 스키마 무회귀. FIREBASE_AUTH_MOBILE_ISSUE는 여전히 모든 non-test 환경에서
off 유지(§7.7 활성화 게이트 미완— C1은 스키마+챌린지 발급만, 검증기는 C2/C3, 배선은 C4).

Revision ID: 0190
Revises: 0189
Create Date: 2026-07-16
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0190"
down_revision = "0189"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "device_installations",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("firebase_uid", sa.Text(), nullable=False),
        # 산티아고 §7.1: exact project/tenant/environment/app 바인딩 — 크로스 환경 설치 재생 방지.
        sa.Column("project_id", sa.Text(), nullable=False),
        sa.Column("tenant_id", sa.Text(), nullable=True),
        sa.Column("environment", sa.Text(), nullable=False),
        sa.Column("platform", sa.Text(), nullable=False),  # ios|android
        sa.Column("app_id", sa.Text(), nullable=False),  # exact bundle id / package name
        sa.Column("release_cert_digest", sa.Text(), nullable=True),  # Android 서명 인증서 digest
        sa.Column("key_version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("key_id", sa.Text(), nullable=True),  # iOS App Attest keyId
        sa.Column("public_key_fingerprint", sa.Text(), nullable=False),
        sa.Column("public_key_der", sa.LargeBinary(), nullable=False),
        sa.Column("attestation_type", sa.Text(), nullable=False),  # app_attest|key_attestation
        sa.Column("attestation_environment", sa.Text(), nullable=True),  # iOS AAGUID env(production|sandbox)
        sa.Column("security_level", sa.Text(), nullable=True),  # Android: tee|strongbox
        sa.Column("last_sign_count", sa.BigInteger(), nullable=True),  # iOS assertion signCount CAS
        sa.Column("last_server_seq", sa.BigInteger(), nullable=True),  # Android server_seq CAS
        sa.Column("status", sa.Text(), nullable=False, server_default="active"),  # active|revoked|quarantined
        sa.Column("attested_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoke_reason", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
    )
    op.create_index("ix_device_installations_user_id", "device_installations", ["user_id"])
    op.create_unique_constraint(
        "uq_device_installations_key_fingerprint",
        "device_installations",
        ["project_id", "public_key_fingerprint"],
    )
    # §7.3: bounded N(초기 5) active installations/user — 애플리케이션 레벨 카운트 가드(C4)를
    # 위한 부분 인덱스. status='active' 행만 빠르게 카운트.
    op.create_index(
        "ix_device_installations_user_active",
        "device_installations",
        ["user_id"],
        postgresql_where=sa.text("status = 'active'"),
    )

    op.create_table(
        "device_proof_challenges",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        # raw nonce는 절대 저장하지 않는다(§7.2) — SHA-256 hex만.
        sa.Column("nonce_hash", sa.Text(), nullable=False),
        sa.Column("purpose", sa.Text(), nullable=False),  # register|bootstrap_issue|bootstrap_redeem
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("firebase_uid", sa.Text(), nullable=False),
        sa.Column("project_id", sa.Text(), nullable=False),
        sa.Column("tenant_id", sa.Text(), nullable=True),
        sa.Column("environment", sa.Text(), nullable=False),
        sa.Column("app_id", sa.Text(), nullable=False),
        sa.Column("platform", sa.Text(), nullable=False),
        # register 챌린지 발급 시점엔 설치가 아직 없으므로 NULL 허용.
        sa.Column(
            "installation_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("device_installations.id", ondelete="CASCADE"),
            nullable=True,
        ),
        sa.Column("key_version", sa.Integer(), nullable=True),
        sa.Column("server_seq", sa.BigInteger(), nullable=True),  # Android CAS 챌린지 바인딩
        sa.Column("web_origin", sa.Text(), nullable=False),
        sa.Column("request_body_hash", sa.Text(), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("consumed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
    )
    op.create_unique_constraint(
        "uq_device_proof_challenges_nonce_hash", "device_proof_challenges", ["nonce_hash"]
    )
    op.create_index("ix_device_proof_challenges_user_id", "device_proof_challenges", ["user_id"])
    op.create_index("ix_device_proof_challenges_installation_id", "device_proof_challenges", ["installation_id"])
    # §7.1: purpose당 설치당 active challenge 1개 — register는 installation_id NULL이라
    # user_id+purpose로, 이후 구매/redeem류는 installation_id+purpose로 부분 유니크.
    op.create_index(
        "uq_device_proof_challenges_active_by_installation",
        "device_proof_challenges",
        ["installation_id", "purpose"],
        unique=True,
        postgresql_where=sa.text("consumed_at IS NULL AND installation_id IS NOT NULL"),
    )
    op.create_index(
        "uq_device_proof_challenges_active_register_by_user",
        "device_proof_challenges",
        ["user_id", "purpose"],
        unique=True,
        postgresql_where=sa.text("consumed_at IS NULL AND installation_id IS NULL AND purpose = 'register'"),
    )


def downgrade() -> None:
    op.drop_index("uq_device_proof_challenges_active_register_by_user", table_name="device_proof_challenges")
    op.drop_index("uq_device_proof_challenges_active_by_installation", table_name="device_proof_challenges")
    op.drop_index("ix_device_proof_challenges_installation_id", table_name="device_proof_challenges")
    op.drop_index("ix_device_proof_challenges_user_id", table_name="device_proof_challenges")
    op.drop_constraint("uq_device_proof_challenges_nonce_hash", "device_proof_challenges", type_="unique")
    op.drop_table("device_proof_challenges")

    op.drop_index("ix_device_installations_user_active", table_name="device_installations")
    op.drop_constraint("uq_device_installations_key_fingerprint", "device_installations", type_="unique")
    op.drop_index("ix_device_installations_user_id", table_name="device_installations")
    op.drop_table("device_installations")
