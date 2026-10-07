"""story #4533 (E-DESKTOP-2 B-2 · alembic 0433) — an agent's permission request sent from its desktop to the person who decides
it, and the phones that can answer. Contract: doc «E-DESKTOP-2 B-1 — 기기 줄 계약 v1» §9 · §10 (02d2cf71 v1.7).

The server carries a phone's signed decision as it is — it never makes, changes or checks one (the daemon trusts only the phone
key it pinned from a QR code). What is kept here is what a person sees, who the request went to and its state; a phone key
kept here is for counting, showing and matching a pairing, never for trust. The lists below are the code side of 0433's CHECKs
— a test holds the two together."""
import uuid
from datetime import datetime

from sqlalchemy import Boolean, CheckConstraint, DateTime, ForeignKey, Index, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.desktop_relay import SESSION_RUNTIMES, _in

PERMISSION_STATES = ("pending", "answered", "withdrawn", "expired", "rejected")
PERMISSION_DECISIONS = ("allow", "deny")
# why the request went to its recipient: a person with a phone paired to that device, or (no one in the chain has one) the
# chain's head, who can only look (contract §9 ② · PO 13:21Z)
RECIPIENT_REASONS = ("paired", "no_paired_phone")
# story #4580 AC2 (B · Kadir ⓐ): a network question's request answered «allow…» comes back for a second answer with the host the
# daemon read from Claude's own hook text — `ask` → `confirm`
PERMISSION_STAGES = ("ask", "confirm")
WITHDRAW_REASONS = ("answered_locally", "session_ended", "expired")


class AgentPermissionRequest(Base):
    """One permission prompt on a device, reported by its daemon (masked summary only — no raw input, no full path, no key)."""

    __tablename__ = "agent_permission_requests"
    __table_args__ = (
        UniqueConstraint("setup_id", "request_id", name="uq_agent_permission_requests_setup_request"),
        CheckConstraint(_in("state", PERMISSION_STATES), name="ck_agent_permission_requests_state"),
        CheckConstraint(_in("runtime", SESSION_RUNTIMES), name="ck_agent_permission_requests_runtime"),
        CheckConstraint(
            f"decision IS NULL OR {_in('decision', PERMISSION_DECISIONS)}", name="ck_agent_permission_requests_decision",
        ),
        CheckConstraint(_in("recipient_reason", RECIPIENT_REASONS), name="ck_agent_permission_requests_recipient_reason"),
        CheckConstraint(_in("stage", PERMISSION_STAGES), name="ck_agent_permission_requests_stage"),
        Index("ix_agent_permission_requests_recipient_state", "recipient_member_id", "state"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    setup_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("desktop_setups.id", ondelete="CASCADE"), nullable=False,
    )
    request_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    session_key: Mapped[str] = mapped_column(Text, nullable=False)
    agent_member_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    runtime: Mapped[str] = mapped_column(Text, nullable=False)
    tool: Mapped[str] = mapped_column(Text, nullable=False)
    summary: Mapped[str] = mapped_column(Text, nullable=False)
    masked: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="false")
    truncated: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="false")
    workdir: Mapped[str | None] = mapped_column(Text, nullable=True)
    input_hash: Mapped[str] = mapped_column(Text, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    state: Mapped[str] = mapped_column(Text, nullable=False, server_default="pending")
    recipient_member_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    recipient_reason: Mapped[str] = mapped_column(Text, nullable=False)
    answered_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    answered_phone_key_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    decision: Mapped[str | None] = mapped_column(Text, nullable=True)
    answered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    result_code: Mapped[str | None] = mapped_column(Text, nullable=True)
    stage: Mapped[str] = mapped_column(Text, nullable=False, server_default="ask")
    host: Mapped[str | None] = mapped_column(Text, nullable=True)  # story #4580: set with stage «confirm» only (the daemon's value)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class RemoteDevice(Base):
    """A phone key a person registered while logged in on that phone (at most three each · 4535 AC2). Shown and counted; the
    daemon never takes a key from here."""

    __tablename__ = "remote_devices"
    __table_args__ = (UniqueConstraint("fingerprint", name="uq_remote_devices_fingerprint"),)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    member_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("members.id", ondelete="CASCADE"), nullable=False, index=True,
    )
    org_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True,
    )
    label: Mapped[str] = mapped_column(Text, nullable=False)
    public_key: Mapped[str] = mapped_column(Text, nullable=False)
    fingerprint: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class RemoteDevicePairing(Base):
    """A device ↔ phone pair as the device's daemon reports it (its QR-pinned keys). Removing one takes effect at once on the
    server (an answer with that key → 409 phone_not_paired) and is sent down as `pairing_removed` until the daemon's snapshot
    drops it (`removal_acked_at`)."""

    __tablename__ = "remote_device_pairings"
    __table_args__ = (UniqueConstraint("remote_device_id", "setup_id", name="uq_remote_device_pairings_device_setup"),)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    remote_device_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("remote_devices.id", ondelete="CASCADE"), nullable=False,
    )
    setup_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("desktop_setups.id", ondelete="CASCADE"), nullable=False, index=True,
    )
    paired_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    reported_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    removed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    removed_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    removal_acked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class RemoteDevicePairingOffer(Base):
    """story #4531 (contract 02d2cf71 v1.11 §10 ⑤) — a phone's answer to a desktop's pairing QR, carried down as `pairing_offer`
    until it expires, and the desktop's random value carried back to that phone. The server holds no secret and checks no MAC: the QR's secret never leaves the desktop and the phone, so a
    key swapped here fails the daemon's MAC (and the two screens' confirmation number is the second door). Kept only to send it
    again on the next connection."""

    __tablename__ = "remote_device_pairing_offers"
    __table_args__ = (UniqueConstraint("setup_id", "offer_id", name="uq_remote_device_pairing_offers_setup_offer"),)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    setup_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("desktop_setups.id", ondelete="CASCADE"), nullable=False, index=True,
    )
    offer_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    remote_device_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("remote_devices.id", ondelete="CASCADE"), nullable=False,
    )
    offered_by: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    # v1.11: the name the phone sent (inside its MAC — the server cannot rename the phone a person sees on the desktop)
    label: Mapped[str] = mapped_column(Text, nullable=False)
    mac: Mapped[str] = mapped_column(Text, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    # v1.11: the desktop's random value, drawn after the key was bound — the phone that sent the offer reads it to show the same
    # pairing number (public: what makes it safe is that it came after the MAC, not that it is hidden)
    reveal: Mapped[str | None] = mapped_column(Text, nullable=True)
    revealed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
