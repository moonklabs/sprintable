"""E-GHAPP Bot-L.1: PR ↔ story 링크(컨벤션-free 링킹의 canonical store).

유저가 PR 제목에 `[SID:uuid]` 를 박는 대신, 봇이 PR↔story 링크를 관리한다. link_source 로 어떻게 링크됐는지
(explicit 명시연결 / auto_match 휴리스틱 / sid 텍스트태그 / text fallback)와 confidence(high|medium|low)를
보존한다. **close-on-merge 는 confident link(explicit·auto high·sid exact)에만** 적용된다(오매치 done 방지).

per-org 격리: 모든 read/write 는 org_id 스코프(anti-IDOR). PR 당 canonical 단일 링크 — uq(org_id,
repo_full_name, pr_number). 재링크는 우선순위에 따라 upsert. evidence 는 auto-match 근거(matched tokens·
field·후보 수)를 담아 오매치 사후 조사를 가능케 한다.
"""
import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class PullRequestStoryLink(Base):
    __tablename__ = "pull_request_story_link"
    __table_args__ = (
        UniqueConstraint("org_id", "repo_full_name", "pr_number", name="uq_pr_story_link_org_repo_pr"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # per-org 격리 — org 삭제 시 cascade. story 도 같은 org(앱 레벨서 항상 재검증).
    org_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    story_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("stories.id", ondelete="CASCADE"), nullable=False, index=True
    )
    repo_full_name: Mapped[str] = mapped_column(String(255), nullable=False)  # lowercase 정규화 저장.
    pr_number: Mapped[int] = mapped_column(Integer, nullable=False)
    link_source: Mapped[str] = mapped_column(String(16), nullable=False)  # explicit | auto_match | sid | text
    confidence: Mapped[str] = mapped_column(String(8), nullable=False)     # high | medium | low
    created_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)  # explicit=member
    evidence: Mapped[dict | None] = mapped_column(JSONB, nullable=True)     # matched tokens/field/후보수/reason
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
