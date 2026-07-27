"""story 91404248(C2a): member×role 신뢰 스냅샷 — org-c2-trust-persistence-design §1.

append-only(entity_slug_history와 동형: update 없음·upsert 없음). metrics는
compute_member_trust_scores()의 role별 score dict를 verbatim 저장(산식 불변·
저장만 추가 — 산식이 바뀌어도 이 테이블은 컬럼 마이그 불요)."""
import uuid
from datetime import datetime

from sqlalchemy import DateTime, Index, Integer, String, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.base import OrgScopedMixin


class OrgMemberTrustSnapshot(Base, OrgScopedMixin):
    __tablename__ = "org_member_trust_snapshots"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # FK 없음 — Participation.member_id와 동일하게 canonicalize 패턴(team_members=VIEW, 직접 FK 불가).
    member_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    role_key: Mapped[str] = mapped_column(String(50), nullable=False)
    window_days: Mapped[int] = mapped_column(Integer, nullable=False, default=90)
    metrics: Mapped[dict] = mapped_column(JSONB, nullable=False)
    computed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False, index=True
    )

    __table_args__ = (
        Index("ix_trust_snapshot_member_role_time", "org_id", "member_id", "role_key", "computed_at"),
    )
