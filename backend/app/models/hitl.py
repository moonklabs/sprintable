import uuid
from datetime import datetime

from sqlalchemy import DateTime, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class HitlPolicy(Base):
    __tablename__ = "agent_hitl_policies"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    project_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, unique=True)
    config: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    created_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    updated_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class HitlRequest(Base):
    __tablename__ = "agent_hitl_requests"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    project_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    agent_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    deployment_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    session_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    run_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    request_type: Mapped[str] = mapped_column(Text, nullable=False, default="approval")
    title: Mapped[str] = mapped_column(Text, nullable=False)
    prompt: Mapped[str] = mapped_column(Text, nullable=False)
    requested_for: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, default="pending")
    response_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    responded_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    responded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    hitl_metadata: Mapped[dict] = mapped_column("metadata", JSONB, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class HitlGateConfig(Base):
    """E-HITL-GATING S-GATE-1: 게이트 레벨 config (정책 hitl-gating-policy-v1 §3).

    org 기본값(project_id NULL) → project 오버라이드 계층. (work_type × actor_type) → level.
    유니크: 부분 인덱스 2(org 기본값 / project 오버라이드) — migration 0123. 안전 하한·집행은
    S-GATE-3/2. dev 전용 가치 실험(prod 미영향).
    """
    __tablename__ = "hitl_gate_config"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    # NULL = org 기본값 · set = project 오버라이드
    project_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True, index=True)
    work_type: Mapped[str] = mapped_column(Text, nullable=False)   # 'done' | 'merge'
    actor_type: Mapped[str] = mapped_column(Text, nullable=False)  # 'agent' | 'human'
    level: Mapped[str] = mapped_column(Text, nullable=False)       # 'auto' | 'ask' | 'block'
    created_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class HitlGateAudit(Base):
    """E-HITL-GATING S-GATE-5.1: enforce_gate 1건당 audit 1행 — coverage/outcome 분포 측정용.

    auto/block 은 미persist(HitlRequest 는 ask 만)라 coverage·auto-pass 카운트가 DB 불가이던 한계 해소.
    ⚠️ §2: block/ask 같은 raise outcome 은 409→세션 rollback 이라 enforce_gate 가 raise 전 독립 commit
    해야 보존된다(return outcome=auto/resumed 는 전이와 함께 commit). flag-gated(enforce active) 시에만.
    """

    __tablename__ = "hitl_gate_audit"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    project_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    work_type: Mapped[str] = mapped_column(Text, nullable=False)        # 'done' | 'merge'
    actor_type: Mapped[str | None] = mapped_column(Text, nullable=True)  # 'agent' | 'human' | None
    resolved_level: Mapped[str] = mapped_column(Text, nullable=False)    # 'auto' | 'ask' | 'block'
    # outcome: auto | blocked | ask_queued | resumed | rejected_blocked | self_blocked
    outcome: Mapped[str] = mapped_column(Text, nullable=False)
    work_item_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    actor_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False, index=True
    )
