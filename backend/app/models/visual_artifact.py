import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Integer, Text, UniqueConstraint, func
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
    # 뷰어 통합 재설계(story 1948d19d·doc artifact-canvas-viewport-spec §4): SSOT는
    # ArtifactVersion.canvas_bounds(버전 단위 — iframe 1개=버전 전체 node 합성 렌더라 프레임
    # 개념이 버전 스코프). 이 필드는 latest_version_number와 동일 목적의 **denorm 캐시**
    # (매 GET/list마다 버전 서브쿼리 회피) — 새 버전 생성마다 그 버전 값과 동기화된다.
    canvas_bounds: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
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
    # E-CANVAS C3-S7(story 940266db): 코멘트→편집 결과 연결(closed-loop) — 이 버전이 어느
    # 코멘트에 응답해 만들어졌는지의 계보만 기록(resolve와 독립·감시 아닌 신뢰 조각).
    # ⚠️ use_alter=True 필수: artifact_versions→artifact_comments(이 FK)→artifact_nodes
    # (comments.node_id)→artifact_versions(nodes.version_id)로 순환 FK가 생겨 Base.metadata.
    # create_all()(destructive_schema 테스트가 씀)가 CircularDependencyError로 실패했다(CI가
    # 실측으로 잡음) — use_alter은 SQLAlchemy가 이 제약만 별도 ALTER TABLE로 뒤늦게 추가해
    # 순환을 깬다(실제 alembic 마이그레이션은 원래도 순차 DDL이라 영향 없음).
    source_comment_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey(
            "artifact_comments.id", ondelete="SET NULL",
            use_alter=True, name="fk_artifact_versions_source_comment_id",
        ),
        nullable=True,
    )
    # 뷰어 통합 재설계(story 1948d19d·doc artifact-canvas-viewport-spec §4): 이 버전이 선언한
    # 프레임 크기(SSOT) — iframe 1개=버전 전체 node 합성 렌더(_render_self_contained_html)라
    # 버전 단위 개념. 0179 additive nullable — 미선언(None)=FE 기본 아트보드 규약 폴백.
    canvas_bounds: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
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
    # E-CANVAS C2-S6(story 0edca31e): description pane — 요소별 스펙 서술(전신 spec_description
    # 유산·"보이는 PRD"). 에이전트가 MCP로 읽어 요소 단위 계약으로 소비.
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class ArtifactComment(Base):
    """E-CANVAS C2-S6(story 0edca31e): 요소/좌표 앵커 코멘트(Figma식 핀·스레드·resolve).

    스토리 코멘트(StoryComment)와 공통 프리미티브(content/created_by/created_at + C0 이벤트
    전파)를 공유하되, artifact 특유의 앵커(node_id 요소단위 또는 anchor_x/y 좌표핀)·스레드
    (parent_id)·resolve 상태를 추가로 가진다.
    """
    __tablename__ = "artifact_comments"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    artifact_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("visual_artifacts.id", ondelete="CASCADE"), nullable=False, index=True
    )
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    project_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    node_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("artifact_nodes.id", ondelete="SET NULL"), nullable=True, index=True
    )
    anchor_x: Mapped[float | None] = mapped_column(nullable=True)
    anchor_y: Mapped[float | None] = mapped_column(nullable=True)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    parent_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("artifact_comments.id", ondelete="SET NULL"), nullable=True, index=True
    )
    resolved: Mapped[bool] = mapped_column(nullable=False, default=False)
    resolved_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_by: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


ARTIFACT_SPEC_PIN_ANCHOR_TYPES = frozenset({"coord", "node"})


class ArtifactSpecPin(Base):
    """편집 캔버스 핀 저작(story 7fe16274·doc artifact-pin-authoring-spec §2) — 요소/좌표 스펙
    앵커(description pane 저작 입구). ArtifactComment(코멘트 핀)와 같은 캔버스 핀 레이어를
    공유하되(FE §4 시각 구분) 별도 엔티티로 분리한 이유(그라운딩·재사용 대신 신설 판단):
      · **버전 스코프**(canvas_bounds·ArtifactNode와 동형) — 코멘트는 artifact 레벨로 버전과
        무관하게 영속되지만(node_id가 있어도 carry-forward 안 됨·구버전 참조로 방치), 스펙 핀은
        그 버전 레이아웃(좌표/노드)의 스냅샷이라 edit마다 함께 carry-forward한다
        (_apply_artifact_edit — 무-mutate 버전 원칙·reflow-safe 계승).
      · **스레드/resolve 없음** — 단일값 description(재편집=덮어씀). 코멘트의 토론형(parent_id
        스레드·resolved 상태)과 근본적으로 다른 생명주기라 같은 테이블에 넣으면 코멘트 전용
        컬럼이 스펙 핀 행마다 의미 없이 방치됨.
      · **anchor_type 명시 판별자** — 코멘트의 암묵적 nullable 타이핑(node_id 있으면 노드,
        anchor_x/y 있으면 좌표)과 달리 명시 컬럼 + CHECK로 고정. anchor 테이블 오타입 no-op
        함정(암묵 타이핑 시 잘못된 조합이 조용히 통과) 회피.
      · **감시금지**(doc §4) — created_by/created_at 등 작성자·시간 속성을 아예 갖지 않는다
        (ArtifactNode와 동형 — attribution 노출 0을 스키마 레벨에서 강제).
    """
    __tablename__ = "artifact_spec_pins"
    __table_args__ = (
        CheckConstraint(
            "(anchor_type = 'coord' AND anchor_x IS NOT NULL AND anchor_y IS NOT NULL AND node_id IS NULL) OR "
            "(anchor_type = 'node' AND node_id IS NOT NULL AND anchor_x IS NULL AND anchor_y IS NULL)",
            name="ck_artifact_spec_pins_anchor_consistency",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    artifact_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("visual_artifacts.id", ondelete="CASCADE"), nullable=False, index=True
    )
    version_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("artifact_versions.id", ondelete="CASCADE"), nullable=False, index=True
    )
    anchor_type: Mapped[str] = mapped_column(Text, nullable=False)
    anchor_x: Mapped[float | None] = mapped_column(nullable=True)
    anchor_y: Mapped[float | None] = mapped_column(nullable=True)
    node_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("artifact_nodes.id", ondelete="CASCADE"), nullable=True, index=True
    )
    # description=null 금지 계보(doc §3 — 빈 스펙 저장 차단, 핸드오프 계약 규율).
    description: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


ARTIFACT_EXPORT_FORMATS = frozenset({"png", "html"})


class ArtifactExport(Base):
    """E-CANVAS C1-S5(story 1f365e33): F6 export(PNG/HTML) 버전 귀속 기록.

    바이너리 자체는 여기 없음 — 기존 assets 레지스트리(S1 IStorageService)의 asset_id 참조만
    보관(storage 좌표는 Asset.container/object_path가 SSOT). PNG는 FE가 캡처해 signed write URL로
    GCS에 직접 PUT하고 BE는 head_object 검증 후 편입만(바이너리가 BE를 경유하지 않음). HTML은
    BE가 nodes 트리를 직렬화해 즉시 생성(렌더 불요·client-trust 이슈 없음).
    """
    __tablename__ = "artifact_exports"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    artifact_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("visual_artifacts.id", ondelete="CASCADE"), nullable=False, index=True
    )
    version_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("artifact_versions.id", ondelete="CASCADE"), nullable=False, index=True
    )
    format: Mapped[str] = mapped_column(Text, nullable=False)
    asset_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("assets.id", ondelete="CASCADE"), nullable=False
    )
    created_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
