import uuid
from datetime import datetime

from sqlalchemy import DateTime, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base

# story #3287([도메인탈고정·축1 Phase1]) — canonical slug 어휘 자체(Phase 2 미착수 상태의 고정
# 목록). entity_type은 이 스토리가 새로 정의(축1 지도의 ITEM_TYPES 중복 통합은 Phase 2 선결
# 과제라 이 슬라이스에서 손 안 댐 — 기존 어느 frozenset도 재사용하지 않고, AC가 명시한 5종만
# 독립 정의). status는 workflow_violation.STATUS_ORDER(기존 SSOT, 무변경 재사용)에서 그대로
# 가져온다.
DOMAINS = frozenset({"entity_type", "status"})

ENTITY_TYPE_SLUGS = frozenset({"story", "task", "epic", "sprint"})
# ⚠️"epic"이 canonical slug다("goal"이 아님) — story #1925가 클래스/테이블명만 Epic→Goal로
# 리네임하고 FK 컬럼(`stories.epic_id`)·ItemDependency.item_type 등 저장값은 그대로 "epic"으로
# 남겨뒀다(축1 지도 참고). 이 스토리의 원칙("라벨과 식별자를 분리") 그대로 — org가
# canonical_slug="epic"에 label="Goal"(또는 다른 어떤 이름)을 얹는 것이지, "goal"이라는 새
# canonical slug를 만들지 않는다.


class OrgDomainLabel(Base):
    """story #3287 — org별 엔티티/상태 canonical slug의 "표시 라벨" 오버라이드.

    canonical_slug(DB에 실제 저장되는 값 — work_item_type="story", status="in-review" 등)는
    이 테이블이 절대 바꾸지 않는다 — workflow_violation.py·advance_story_to_done()·Gate
    회수 등 기존 로직은 이 테이블의 존재 자체를 모른 채(무변경) 계속 canonical_slug만 보고
    동작한다. 이 테이블은 응답 직렬화 경계에서만 소비된다(설계 doc entity:doc:
    1fa7e2a9-c8c2-4a8e-a9da-35bce52a5012 §Phase 1).

    project_id는 후속 확장 훅(AC5) — 이 슬라이스는 항상 NULL(org 단위)만 쓴다. project별
    오버라이드가 실제로 필요해지면 hitl_gate_config(migration 0123)와 동일하게 부분 유니크
    인덱스를 하나 더 추가하는 방식으로 열 수 있다(스키마 자체는 지금부터 그 모양).
    """

    __tablename__ = "org_domain_label"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    # NULL = org 기본값(이 슬라이스가 쓰는 유일한 값) · set = project 오버라이드(후속, 미사용).
    project_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True, index=True)
    domain: Mapped[str] = mapped_column(Text, nullable=False)  # "entity_type" | "status"
    canonical_slug: Mapped[str] = mapped_column(Text, nullable=False)  # "story" | "in-review" 등, 불변
    label_ko: Mapped[str | None] = mapped_column(Text, nullable=True)
    label_en: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
