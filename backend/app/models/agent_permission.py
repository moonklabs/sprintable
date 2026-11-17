"""story #4533 (E-DESKTOP-2 B-2 · alembic 0433) — an agent's permission request sent from its desktop to the person who decides
it, and the phones that can answer. Contract: doc «E-DESKTOP-2 B-1 — 기기 줄 계약 v1» §9 · §10 (02d2cf71 v1.7).

The server carries a phone's signed decision as it is — it never makes, changes or checks one (the daemon trusts only the phone
key it pinned from a QR code). What is kept here is what a person sees, who the request went to and its state; a phone key
kept here is for counting, showing and matching a pairing, never for trust. The lists below are the code side of 0433's CHECKs
— a test holds the two together."""
import uuid
from datetime import datetime

from sqlalchemy import Boolean, CheckConstraint, DateTime, ForeignKey, Index, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
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
# story #4580 AC2 (D4 · PO 02:05Z): `host_unread` — a network question answered «allow…» whose host the daemon could not read from
# Claude's own hook text (F2): nothing is allowed, the phone says so
WITHDRAW_REASONS = ("answered_locally", "session_ended", "expired", "host_unread", "terminal_only")


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
        # story #4590 (0445): a terminal-only row carries no hash (nothing to sign) and may lack tool · summary (not read); every
        # other row keeps all three
        # story 4972 (0479): an answerable row's words are text (tool · summary) OR sealed (reported as one envelope, kept only while its question waits); an envelope is only on a sealed row; a terminal-only row never has a hash — sealed (0480) or not
        CheckConstraint(
            "(envelope IS NULL OR (sealed AND jsonb_typeof(envelope) = 'object')) AND "
            "(NOT sealed OR (tool IS NULL AND summary IS NULL AND workdir IS NULL AND host IS NULL AND (preview IS NULL OR preview = 'null'::jsonb) AND stage = 'ask')) AND ("
            "(terminal_only AND input_hash IS NULL) OR "
            "(NOT terminal_only AND (input_hash IS NOT NULL OR (sealed AND state <> 'pending')) AND ((tool IS NOT NULL AND summary IS NOT NULL) OR sealed))) AND "
            "(state = 'pending' OR envelope IS NULL) AND (NOT sealed OR state <> 'pending' OR envelope IS NOT NULL)",
            name="ck_agent_permission_requests_terminal_only_fields",
        ),
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
    tool: Mapped[str | None] = mapped_column(Text, nullable=True)  # story #4590: absent only on a terminal-only row whose tool was not read
    summary: Mapped[str | None] = mapped_column(Text, nullable=True)  # story #4590: likewise
    masked: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="false")
    truncated: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="false")
    workdir: Mapped[str | None] = mapped_column(Text, nullable=True)
    # story 4949: what a file tool is about to write / change — the Mac's masked, cut lines (never the original). Held while the request is pending only
    preview: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    # story 4972: the words (tool · summary · folder · preview) as ONE envelope the phone opens and the server cannot — kept as it came, served to the phone, gone from the row with its question
    sealed: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="false")  # story 4972: reported sealed — no tool · summary as text, ever (stays true after the envelope is gone)
    envelope: Mapped[dict | None] = mapped_column(JSONB(none_as_null=True), nullable=True)  # none_as_null: «no envelope» is SQL NULL, never a JSON null (the CHECK reads IS NULL)
    input_hash: Mapped[str | None] = mapped_column(Text, nullable=True)  # story #4590: never on a terminal-only row (nothing to sign)
    # story #4590: a question only that computer's terminal can answer — shown as a card with no buttons, no notice (no push)
    terminal_only: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="false")
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
    # story #4629 (0446): the refresh token the phone was logged in with when it registered this key (the row id — never the
    # token) · removing the key revokes that session (its rotation chain's live end). NULL: registered before 0446, or no token sent
    session_token_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("refresh_tokens.id", ondelete="SET NULL", name="fk_remote_devices_session_token_id"),
        nullable=True,
    )


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


class RemoteDevicePairingSession(Base):
    """story 4972 (design ② §5-2) — one pairing on the new procedure: the host registers the QR's offer; the phone's commitment, the host's signed nonce and the phone's reveal are carried between them,
    in that order and each once (the CHECKs of 0481 say the order too). Nothing here is secret (the QR's secret never comes to the server) and the server checks no cryptography of it — the two screens' 8-digit
    number is the check; it only enforces who may send, the order and the «one» (`burned_at`: a second commitment, a second reveal or a refusal by either side ends the offer for good)."""

    __tablename__ = "remote_device_pairing_sessions"
    __table_args__ = (
        UniqueConstraint("setup_id", "offer_id", name="uq_remote_device_pairing_sessions_setup_offer"),
        Index("ix_pairing_sessions_setup", "setup_id"),  # the migration's name (0481)
        CheckConstraint(
            "(commitment IS NULL) = (committed_by IS NULL) AND (commitment IS NULL) = (phone_key_id IS NULL) AND (commitment IS NULL) = (committed_at IS NULL)",
            name="ck_pairing_sessions_commit_whole",
        ),
        CheckConstraint(
            "(n_m IS NULL) = (nonce_sig IS NULL) AND (n_m IS NULL) = (nonced_at IS NULL) AND (n_m IS NULL OR commitment IS NOT NULL)",
            name="ck_pairing_sessions_nonce_after_commit",
        ),
        CheckConstraint(
            "(reveal IS NULL) = (revealed_at IS NULL) AND (reveal IS NULL OR (n_m IS NOT NULL AND jsonb_typeof(reveal) = 'object'))",
            name="ck_pairing_sessions_reveal_after_nonce",
        ),
        CheckConstraint("(burned_at IS NULL) = (burn_reason IS NULL)", name="ck_pairing_sessions_burn_has_reason"),
        CheckConstraint("commitment IS NULL OR char_length(commitment) = 43", name="ck_pairing_sessions_commit_size"),
        CheckConstraint("n_m IS NULL OR char_length(n_m) = 22", name="ck_pairing_sessions_nonce_size"),
        CheckConstraint("nonce_sig IS NULL OR char_length(nonce_sig) BETWEEN 16 AND 100", name="ck_pairing_sessions_sig_size"),
        # story 4972 (wiring 4a): the computer's signed receipt «I confirmed THIS offer» — carried, never checked here; only after a reveal, whole, one size like the nonce's signature
        CheckConstraint("(confirmed_sig IS NULL) = (confirmed_at IS NULL)", name="ck_pairing_sessions_confirm_whole"),
        CheckConstraint("confirmed_sig IS NULL OR reveal IS NOT NULL", name="ck_pairing_sessions_confirm_after_reveal"),
        CheckConstraint("confirmed_sig IS NULL OR char_length(confirmed_sig) BETWEEN 16 AND 100", name="ck_pairing_sessions_confirm_size"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    setup_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("desktop_setups.id", ondelete="CASCADE"), nullable=False)
    offer_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    commitment: Mapped[str | None] = mapped_column(Text, nullable=True)
    committed_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    phone_key_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("remote_devices.id", ondelete="CASCADE"), nullable=True)
    committed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    n_m: Mapped[str | None] = mapped_column(Text, nullable=True)
    nonce_sig: Mapped[str | None] = mapped_column(Text, nullable=True)
    nonced_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    reveal: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    revealed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    burned_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    burn_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    confirmed_sig: Mapped[str | None] = mapped_column(Text, nullable=True)  # story 4972 (4a): the computer's signature over «this offer, these keys, these nonces, this number» — the phone verifies it, the server only carries it
    confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
