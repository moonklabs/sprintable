import uuid
from datetime import datetime

from sqlalchemy import DateTime, Index, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.base import OrgScopedMixin


class RejectedRelation(Base, OrgScopedMixin):
    """story #2221 후속(오르테가 판정, 2026-07-30) — 「관계 단위」 기각 기록. 별도 표로 둔
    이유(파울로 승인, 까심 논증): `reference_semantic_candidates`의 유니크는 6컬럼
    (source_type, source_field, source_id, target_type, target_id, form)이고 이건 «후보 행
    중복 방지»가 목적이다(같은 관계라도 field/form이 다르면 snippet이 달라 사람이 확認할
    때 «어느 문장에서 나왔나」를 봐야 한다 — 이 그레인을 좁히면 그 재료를 잃는다). 반면
    기각은 (source_type, source_id, target_type, target_id) «4컬럼, 관계 단위» 판단이다 —
    그레인이 다르므로 candidate.status에 욱여넣지 않고 별도 표로 뺐다(status에 rejected를
    추가하면 같은 관계의 여러 후보 행이 각자 따로 기각될 수 있어 「관계 전체 기각」이 안
    된다).

    ⛔지우기가 아니라 «기록»이다(오르테가 판정) — 산문이 그대로 남아 있는 한 재임포트마다
    같은 후보가 또 뜨는데, 이 표에 있으면 후보 생성 단계에서 걸러진다(아래
    `build_candidate_rows`/`filter_rejected_pairs` 참조). `reason`은 nullable — 지금은 UI가
    안 채워도 되고 값을 안 넣어도 되지만, 나중에 되살릴 때 「왜 기각했더라」를 판단하려면
    컬럼 자체는 있어야 한다(없으면 또 마이그레이션).

    org_id는 유니크 키에 «안 넣는다» — `reference_semantic_candidates`의 6컬럼 유니크 선례를
    그대로 따른다(source_id/target_id가 UUID라 org 간 충돌이 원리적으로 없다).

    되살리기(rejected→proposed로 복귀)는 이 행을 «삭제»한다(오르테가 판정: 지금은 단순한
    쪽으로 — 되살린 기록 자체를 남기지 않는다, 필요해지면 그때 소프트-무효화로 바꾼다).
    """

    __tablename__ = "rejected_relations"

    __table_args__ = (
        UniqueConstraint(
            "source_type", "source_id", "target_type", "target_id",
            name="uq_rejected_relations_pair",
        ),
        Index("ix_rejected_relations_source", "org_id", "source_type", "source_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    source_type: Mapped[str] = mapped_column(Text, nullable=False)
    source_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    target_type: Mapped[str] = mapped_column(Text, nullable=False)
    target_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    rejected_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    rejected_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
