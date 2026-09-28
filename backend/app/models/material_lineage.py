"""story #4058(E-RECIPE-1 성공기준 4, 페드루 PO 확定 v3 2026-09-19) — 마스터→변주(릴스/
쇼츠/광고) 계보 + 소재·훅 단위 성과 회수의 관계 테이블.

doc(entity:doc:c7991109-4349-485b-8599-d7b886c7a951) v3 확定대로 노드는 둘 다 **기존
엔티티 참조**다(blob을 새로 저장하지 않는다, SaaS 경계):
마스터 = `Evidence.id`(`type="url"`·`ref="live-run:master-cut"`, 크리에이터 emit 계약
3cca821b §8) · 변주 = `channel_post_drafts.id` 또는 `channel_publications.id`(다형,
`derived_kind`로 구분 — `insight_snapshots.publication_kind`+`publication_id`와 동일
관례, 새 다형 표현 방식 발명 안 함). 이 도메인 전역 FK-없음 관례(evidence.py·
insight_snapshots.py와 동형) — org 일치는 서비스 계층이 생성 시점에 검증한다.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base

# derived_kind 허용값 — insight_snapshots.publication_kind와 동일 축(다형 페어).
MATERIAL_LINEAGE_DERIVED_KINDS = frozenset({"channel_post_draft", "channel_publication"})

# relation_kind 허용값 — doc §4③(디디 계보 UI 요구 대조)까지는 잠정, CHECK로 확장형 유지.
MATERIAL_LINEAGE_RELATION_KINDS = frozenset({"platform_cut", "aspect_adapt", "hook_variant"})


class MaterialLineage(Base):
    __tablename__ = "material_lineage"
    __table_args__ = (
        UniqueConstraint(
            "source_evidence_id", "derived_kind", "derived_id", "relation_kind",
            name="uq_material_lineage_source_derived_relation",
        ),
        # migration 0380이 raw SQL로 거는 CHECK 2개의 미러(정본=마이그, 모델=미러 —
        # evidence.py ck_evidence_type 관례 그대로). create_all() 기반 realdb 테스트가
        # 이 제약을 못 보는 「재료 불일치」를 막는다.
        CheckConstraint(
            "derived_kind IN ('channel_post_draft', 'channel_publication')",
            name="ck_material_lineage_derived_kind",
        ),
        CheckConstraint(
            "relation_kind IN ('platform_cut', 'aspect_adapt', 'hook_variant')",
            name="ck_material_lineage_relation_kind",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    project_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True, index=True)
    # 마스터 material — evidence.id(FK 없음, evidence.py 자체 관례 그대로).
    source_evidence_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    # 'channel_post_draft' | 'channel_publication'.
    derived_kind: Mapped[str] = mapped_column(Text, nullable=False)
    derived_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    # 'platform_cut' | 'aspect_adapt' | 'hook_variant'.
    relation_kind: Mapped[str] = mapped_column(Text, nullable=False)
    # relation_kind='platform_cut'일 때만 채움 — 'reels'|'shorts'|'ads' 등.
    variant_axis: Mapped[str | None] = mapped_column(Text, nullable=True)
    # material_collection_sheet evidence payload.hooks[].key 참조(FK 아님, JSONB라 구조상
    # 불가 — 서비스 계층 검증). null=이 변주가 특정 훅에 안 묶임.
    hook_key: Mapped[str | None] = mapped_column(Text, nullable=True, index=True)
    # 이 계보 row가 만들어진 스토리(레시피 apply 인스턴스) — denorm, evidence.work_item_id와
    # 동형 관례(비정규화 조회 축).
    work_item_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    created_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
