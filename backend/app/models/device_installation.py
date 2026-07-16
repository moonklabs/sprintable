"""story 822817a0(E-AUTH-REBUILD 활성화게이트][C1]·doc e-mobile-per-install-proof-feasibility
§7.1/§7.2·산티아고 §7 SSOT 2026-07-16): per-installation attestation protocol v1 스키마.

`DeviceInstallation` — 서버-authoritative. public_key는 서버가 attestation에서 추출한 값만
신뢰(클라이언트 제공 공개키는 절대 그대로 신뢰하지 않는다 — §7.3). `DeviceProofChallenge` —
raw nonce는 어디에도 저장하지 않는다(hash만)."""
import uuid
from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, Integer, LargeBinary, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class DeviceInstallation(Base):
    __tablename__ = "device_installations"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    firebase_uid: Mapped[str] = mapped_column(Text, nullable=False)
    project_id: Mapped[str] = mapped_column(Text, nullable=False)
    tenant_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    environment: Mapped[str] = mapped_column(Text, nullable=False)
    platform: Mapped[str] = mapped_column(Text, nullable=False)
    app_id: Mapped[str] = mapped_column(Text, nullable=False)
    release_cert_digest: Mapped[str | None] = mapped_column(Text, nullable=True)
    key_version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    key_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    public_key_fingerprint: Mapped[str] = mapped_column(Text, nullable=False)
    public_key_der: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    attestation_type: Mapped[str] = mapped_column(Text, nullable=False)
    attestation_environment: Mapped[str | None] = mapped_column(Text, nullable=True)
    security_level: Mapped[str | None] = mapped_column(Text, nullable=True)
    last_sign_count: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    last_server_seq: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    status: Mapped[str] = mapped_column(Text, nullable=False, default="active", server_default="active")
    attested_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    revoke_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class DeviceProofChallenge(Base):
    __tablename__ = "device_proof_challenges"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    nonce_hash: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    purpose: Mapped[str] = mapped_column(Text, nullable=False)
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    firebase_uid: Mapped[str] = mapped_column(Text, nullable=False)
    project_id: Mapped[str] = mapped_column(Text, nullable=False)
    tenant_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    environment: Mapped[str] = mapped_column(Text, nullable=False)
    app_id: Mapped[str] = mapped_column(Text, nullable=False)
    platform: Mapped[str] = mapped_column(Text, nullable=False)
    installation_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("device_installations.id", ondelete="CASCADE"), nullable=True, index=True
    )
    key_version: Mapped[int | None] = mapped_column(Integer, nullable=True)
    server_seq: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    web_origin: Mapped[str] = mapped_column(Text, nullable=False)
    request_body_hash: Mapped[str | None] = mapped_column(Text, nullable=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
