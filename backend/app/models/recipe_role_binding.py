"""story #3288(축2-ⓐ) — 레시피 apply 계층. `EventDefinition.stage_metadata[stage].role`은
순수 표시 텍스트라(온보딩 가이드 렌더러 전용), 실제로 "이 org/project에서 이 stage는 누구인가"를
routing 해석기(event_routing_resolver.py)가 조회할 자리가 없었다 — 이 얇은 바인딩 테이블이 그
자리다.

⚠️ AgentRoutingRule 재사용은 폐기된 설계(doc axis2-recipe-mechanism-event-definitions-design
§설계정정 참고) — rule_evaluator.py가 trigger_type_slugs/memo_type/event_params(구세대 어휘)만
읽어 EventDefinition.key/stage를 조건에 넣어도 절대 안 읽는다. 신세대 "자동화"는 side-effect
자동집행이 아니라 "알림→에이전트가 action을 지시로 읽고 스스로 행동"이므로, 필요한 건 라우팅
해석기가 참조할 이 바인딩 테이블뿐(자동화 엔진 이식 불요).

story #4090(alembic 0385, 페드루 PO 確定 2026-09-21) — capability.target=
"channel_connection"인 stage(Publisher)는 "알릴 사람"이 아니라 "발행할 채널"을
가리켜야 해 agent_member_id 하나로는 표현이 안 됐다. `channel_connection_id`를 더해
두 target 중 정확히 하나만 채우는 XOR — **DB CHECK(ck_recipe_role_bindings_exactly_
one_target)가 정본**, 여기 모델은 그 제약의 미러일 뿐(sealed_* 클래스 재발 방지 관례 —
애플리케이션 강제만으론 샌다). 어느 쪽을 채울지는 쓰기 경로(events.py::apply_recipe_
role_bindings)가 stage의 capability.target(닫힌 어휘, event_definition_registry.py::
_CAPABILITY_TARGETS)로 판별한다 — capability.kind(열린 값, #3317 PR B)와는 독립된
축이다. 이 모델 자체는 그 판별을 모른다.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, Index, Text, func, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class RecipeRoleBinding(Base):
    __tablename__ = "recipe_role_bindings"
    __table_args__ = (
        # 표준 UNIQUE는 NULL끼리 서로 다르다고 봐(NULLS DISTINCT 기본), project_id=NULL(org
        # 전역) 행이 여러 개 통과해버린다 — 부분 unique index 2개로 분리(EventDefinition의
        # uq_event_definitions_preset_key/org_key와 동형 패턴).
        Index(
            "uq_recipe_role_bindings_org_scope", "org_id", "event_definition_key", "stage",
            unique=True, postgresql_where=text("project_id IS NULL"),
        ),
        Index(
            "uq_recipe_role_bindings_project_scope", "org_id", "project_id", "event_definition_key", "stage",
            unique=True, postgresql_where=text("project_id IS NOT NULL"),
        ),
        Index("ix_recipe_role_bindings_lookup", "org_id", "event_definition_key", "stage"),
        # story #4090(alembic 0385) — 미러, 정본은 마이그의 DB CHECK. 위 docstring 참고.
        CheckConstraint(
            "(agent_member_id IS NOT NULL AND channel_connection_id IS NULL) "
            "OR (agent_member_id IS NULL AND channel_connection_id IS NOT NULL)",
            name="ck_recipe_role_bindings_exactly_one_target",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, index=True)
    # NULL = org 전역 바인딩(모든 project에 적용). NOT NULL = 그 project 전용(우선순위 高).
    project_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True, index=True)
    event_definition_key: Mapped[str] = mapped_column(Text, nullable=False)
    stage: Mapped[str] = mapped_column(Text, nullable=False)
    # story #4090 — 두 target 중 정확히 하나(위 CheckConstraint). 사람 알림 대상(Director
    # 등)은 이것, 발행할 채널(Publisher)은 channel_connection_id.
    agent_member_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    channel_connection_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    created_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )
