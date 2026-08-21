"""story #2813(Gate→GitHub required check) — check 발행/재-pending/해소 원장(AC④).

기존 audit 테이블 3종(permission_audit_logs/login_audit_log/deletion_audit)은 전부 목적이 달라
(권한변경·로그인·삭제 전용 스키마) 이번 목적(check 발행+SHA)에 재사용 부적합(그라운딩 doc
gate-github-required-check-grounding-design-2813 §1) — 이 테이블이 정본.

append-only(update/delete 없음) — 매 이벤트가 1행. `gates.github_check_run_id`/
`gates.approved_head_sha`는 "현재값"만 담고, 이 테이블이 그 값들이 어떻게 여기까지 왔는지의 이력이다.
"""
import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class GateGithubCheckEvent(Base):
    __tablename__ = "gate_github_check_event"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    gate_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("gate.id", ondelete="CASCADE"), nullable=False, index=True
    )
    story_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    repo_full_name: Mapped[str] = mapped_column(Text, nullable=False)
    pr_number: Mapped[int] = mapped_column(Integer, nullable=False)
    head_sha: Mapped[str] = mapped_column(Text, nullable=False)
    # story #2819 — re_pending 행 전용: 무효화된 승인이 귀속됐던 SHA(reopen_gate_if_new_sha가
    # 이미 계산해 둔 prior_sha 지역변수를 여기 같이 남긴다 — 이전엔 로그로만 나가고 원장엔
    # head_sha(새 SHA)만 남아 "어느 SHA에서" 무효화됐는지가 조회 시점엔 이미 사라져 있었다).
    # published/resolved 행이나 마이그레이션 이전 행은 NULL(소급 불가 — no-fiction).
    prior_sha: Mapped[str | None] = mapped_column(Text, nullable=True)
    # published(최초/재-pending 발행) | re_pending(SHA 불일치로 게이트를 되돌림) | resolved(success/failure).
    event_type: Mapped[str] = mapped_column(Text, nullable=False)
    # GitHub check-run conclusion — pending 발행이면 NULL(status=in_progress).
    check_conclusion: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
