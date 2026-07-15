"""E-AUTH-REBUILD M2 Phase 1(story b07ad526·doc firebase-auth-identity-platform-migration-poc
§3.2): Firebase/Identity Platform 신원 매핑 — additive, 기존 users.id가 여전히 business identity.

ID 토큰/세션쿠키/legacy 평문 비밀번호/provider access token/TOTP 시크릿은 이 테이블에 저장
금지(doc §3.2 명시)."""
import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, Text, UniqueConstraint, func, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class AuthIdentity(Base):
    __tablename__ = "auth_identities"
    __table_args__ = (
        UniqueConstraint("issuer", "subject", name="uq_auth_identities_issuer_subject"),
        Index(
            "uq_auth_identities_issuer_provider_subject",
            "issuer", "provider_id", "provider_subject",
            unique=True,
            postgresql_where=text("unlinked_at IS NULL"),
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    issuer: Mapped[str] = mapped_column(Text, nullable=False)
    tenant_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    subject: Mapped[str] = mapped_column(Text, nullable=False)
    provider_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    provider_subject: Mapped[str | None] = mapped_column(Text, nullable=True)
    email_at_link: Mapped[str | None] = mapped_column(Text, nullable=True)
    email_verified_at_link: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    linked_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    unlinked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class AuthMigration(Base):
    """user 1행 — 현재 마이그 상태(doc §3.2). state: legacy|provisioning|firebase|reset_required|
    rollback_hold. method: forced_reset|provider_import|new_user|rollback."""
    __tablename__ = "auth_migrations"

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    state: Mapped[str] = mapped_column(Text, nullable=False, default="legacy", server_default="legacy")
    method: Mapped[str | None] = mapped_column(Text, nullable=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    firebase_uid: Mapped[str | None] = mapped_column(Text, nullable=True)
    legacy_auth_allowed_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    mfa_reenroll_required: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    last_error_code: Mapped[str | None] = mapped_column(Text, nullable=True)
    attempt_count: Mapped[int] = mapped_column(nullable=False, default=0)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )


class AuthMigrationEvent(Base):
    """auth_migrations 상태 전이 감사 로그 — append-only(doc §3.2 optional table)."""
    __tablename__ = "auth_migration_events"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    from_state: Mapped[str | None] = mapped_column(Text, nullable=True)
    to_state: Mapped[str] = mapped_column(Text, nullable=False)
    method: Mapped[str | None] = mapped_column(Text, nullable=True)
    reason_code: Mapped[str | None] = mapped_column(Text, nullable=True)
    request_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
