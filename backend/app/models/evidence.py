"""E-VERIFY V0-S1(story 5a5ba27b): Evidence 1급 객체 — 에이전트 자기증명.

done의 검사지가 아니라 에이전트가 자기 완결을 표현하는 서명(blueprint `e-verify-v0-blueprint`
§0 제1원칙: 감시가 아니라 신뢰). Gate(app/models/gate.py)의 검증된 polymorphic 패턴을 그대로
재사용 — work_item_id/work_item_type에 FK 없음(Story/Task 양쪽 커버), org_id만 인덱스.
"""
import uuid
from datetime import datetime

from sqlalchemy import DateTime, String, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base

EVIDENCE_TYPES = frozenset({"url", "file", "pr", "deploy", "metric", "report", "gate_approval"})

# gate_approval은 시스템(V0-S2 게이트 승인 훅)만 생성 — 공개 API/MCP로 직접 생성 시 스푸핑
# 위험(에이전트가 "이거 승인됐음" 허위 서명 가능)이라 라우터 레벨에서 별도 차단.
_CLIENT_CREATABLE_TYPES = EVIDENCE_TYPES - {"gate_approval"}


class Evidence(Base):
    __tablename__ = "evidence"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    work_item_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    work_item_type: Mapped[str] = mapped_column(String(20), nullable=False)
    type: Mapped[str] = mapped_column(String(20), nullable=False)
    ref: Mapped[str] = mapped_column(Text, nullable=False)
    source: Mapped[str | None] = mapped_column(Text, nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_by: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
