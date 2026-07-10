import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base

ARTIFACT_SOURCES = frozenset({"created", "imported"})


class VisualArtifact(Base):
    """E-CANVAS C1-S3(story 8bace49e) — 시각 산출물 1급 객체.

    전신 `/mockups`(MockupPage) 계승. story/epic/doc 中 최대 1개에 연결(nullable 3종 — 어디에도
    안 붙는 독립 artifact도 허용, blueprint §2가 story 종속을 강제하지 않음).
    """
    __tablename__ = "visual_artifacts"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    project_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    story_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True, index=True)
    epic_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True, index=True)
    doc_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True, index=True)
    # "created"(에이전트/휴먼 생성) | "imported"(Figma/HTML붙여넣기/이미지) — 유나 iframe sandbox
    # 분기 근거(untrusted=sandbox="").
    source: Mapped[str] = mapped_column(Text, nullable=False, default="created", server_default="created")
    # denorm(mockup의 MockupPage.version 패턴) — 매 GET /{id}마다 버전 서브쿼리 피함.
    latest_version_number: Mapped[int] = mapped_column(Integer, nullable=False, default=1, server_default="1")
    # 유나 §11 field-level 대조 갭①: 정본 버전 — set은 C4(승인 게이트)의 몫, C1은 컬럼만 마련
    # (null=정본 없음=뷰어 무표시·초안 중립). C4 착수 시 스키마 변경 없이 값만 채우면 됨.
    anchor_version: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class ArtifactVersion(Base):
    __tablename__ = "artifact_versions"
    __table_args__ = (
        UniqueConstraint("artifact_id", "version_number", name="uq_artifact_versions_artifact_number"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    artifact_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("visual_artifacts.id", ondelete="CASCADE"), nullable=False, index=True
    )
    version_number: Mapped[int] = mapped_column(Integer, nullable=False)
    created_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    # 유나 §11 field-level 대조 갭②: 변경 이유(커밋 요약) — raw diff가 아닌 lineage 서사(§6
    # 감시-게이트 핵심). C1은 POST body로 선택 set, C3 커밋 시 본격 사용.
    summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class ArtifactNode(Base):
    """버전마다 자기 소유 node row 세트 — mockup의 "live+snapshot blob 이중구조"가 아니라 버전
    전환이 단순 조회(무-mutate)가 되도록 설계(미르코 §6-1 갭 지적 대응)."""
    __tablename__ = "artifact_nodes"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    artifact_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("visual_artifacts.id", ondelete="CASCADE"), nullable=False, index=True
    )
    version_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("artifact_versions.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # 컴포넌트 타입(mockup componentCatalog 계승) | "html_blob"(캐치올 — 임포트된 raw HTML/이미지).
    type: Mapped[str] = mapped_column(Text, nullable=False)
    props: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    parent_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
