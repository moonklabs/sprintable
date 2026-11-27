import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, Numeric, Text, func, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.base import OrgScopedMixin


class RewardLedger(Base, OrgScopedMixin):
    __tablename__ = "reward_ledger"
    __table_args__ = (
        # story 5041 (0505): a grant made by pressing an agent's card is made once — the replay carries the request's id and the database refuses a second row for it
        Index("uq_reward_ledger_agent_action_request", "agent_action_request_id", unique=True, postgresql_where=text("agent_action_request_id IS NOT NULL")),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # E-MEMBER-SSOT AC3-2: team_members FK 완화(grant-only 리워드 수령/지급 500 해소, 0079). canonical은 canonicalize_member_id(legacy 컬럼) 보유((A)); vestigial member_id_v2/granted_by_v2는 0090 DROP.
    member_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), nullable=False, index=True
    )
    granted_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), nullable=True
    )
    amount: Mapped[float] = mapped_column(Numeric(12, 2), nullable=False)
    currency: Mapped[str] = mapped_column(Text, nullable=False, default="TJSB")
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    reference_type: Mapped[str | None] = mapped_column(Text, nullable=True)
    reference_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    # story 5041 (0505): the agent-action request this grant answers (NULL for every other grant)
    agent_action_request_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
