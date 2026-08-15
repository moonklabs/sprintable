"""story #2536(E-FLOW-V4 S4): 프로젝트별 unattached_count 일별 스냅샷.

append-only(org_member_trust_snapshots·entity_slug_history와 동형: update 없음·
upsert 없음). v4 강제(S2)가 신규 story에 가설/목표 부착을 요구하므로 기존
미매달림(unattached) 총량이 시간에 걸쳐 줄어야 하고, 그 추세를 그리는 «측정
도구»가 이 테이블이다 — 오늘부터 쌓여야 하는 시계열(과거 소급 불가)."""
import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, Integer, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.base import OrgScopedMixin


class UnattachedStorySnapshot(Base, OrgScopedMixin):
    __tablename__ = "unattached_story_snapshots"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    unattached_count: Mapped[int] = mapped_column(Integer, nullable=False)
    computed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False, index=True
    )

    __table_args__ = (
        Index(
            "ix_unattached_snapshot_org_project_time",
            "org_id", "project_id", "computed_at",
        ),
    )
