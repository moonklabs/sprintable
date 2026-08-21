"""story #2632(이벤트 레지스트리 P1a) — 「정의=데이터」. doc event-registry-core-p1-plan §2-1.

`event_definitions`는 발행 가능한 이벤트 타입의 카탈로그다 — 플랫폼 프리셋(`preset.*`,
org_id NULL)과 org 커스텀(`org.{slug}.*`, org_id NOT NULL)이 한 테이블에 공존한다.
`key` 유일성 축은 org_id 유무에 따라 갈린다(WebhookConfig의 project_id-nullable-scope
패턴과 동형 — 부분 unique index 2개로 "전역 1개 vs org당 1개"를 각각 강제):
- org_id IS NULL: `key` 전역 유일(프리셋끼리 이름 충돌 금지).
- org_id IS NOT NULL: `(org_id, key)` 유일(다른 org가 같은 커스텀 key를 써도 무관).

CHECK 제약은 네임스페이스 접두사의 "모양"만 방어선으로 건다(preset.*는 org_id NULL과만,
org.*는 org_id NOT NULL과만 짝지어짐) — **"org.{slug}.*"의 slug가 실제로 그 org 자신의
slug인지는 DB가 모르는 사실이라 여기서 못 잡는다**(cross-org 도용 방지는 app 레이어,
event_definition_registry.py의 validate_event_definition_key가 진짜 강제 지점 — AC2).

`payload_schema`(JSON Schema)는 발행 시 payload를 검증한다 — 모르는 필드 거부는 스키마가
`additionalProperties: false`를 선언해야 실제로 걸린다(선언 안 하면 JSON Schema 기본값이
관대해 조용히 통과한다 — 시드 4종 전부 명시 선언, event_definition_registry.py 참조).

`routing`(상신선·전파선 선언)은 **선언**일 뿐 해석기가 아니다 — 실제 도달 계산(누구에게
무엇으로)은 story #2633(발행 API + 도달 3층 해석기)의 몫. 단 각 target의 **부류**는 여기서
확定(페드루 판정 2026-08-13, doc event-registry-core-p1-plan §2-1 갱신):

- `kind="payload_field"`: 역할을 payload의 특정 필드에서 직접 뽑는다 — `member_id_field`
  필수(예: `{"kind":"payload_field","target":"assignee","member_id_field":
  "assignee_member_id"}`). **org 커스텀(P1b, story #2636)이 등록 가능한 유일한 부류** —
  스키마가 매핑을 선언하니 해석기가 제네릭으로 돈다("정의=데이터" 철학의 연장).
- `kind="server_derived"`: payload 필드로 못 뽑는 파생 역할(예: `work_item_stakeholders`
  — work_item_type+id로 그 타입별 이해관계자를 서버가 조회, `goal_owner`) — `member_id_
  field` 없음. 해석기(#2633)의 **닫힌 어휘**로만 존재한다 — 그 어휘 밖 target 레이블은
  발행 시 명시 오류(조용한 무해석 금지, event_definition_registry.py의 SERVER_DERIVED_
  TARGETS 참조). org 커스텀은 이 부류를 등록할 수 없다(서버가 모르는 파생 역할이라 해석
  불가능한 정의를 만들게 되므로).

시드 4종의 실 예시는 alembic/versions/0245_event_definitions.py의 _SEED 참조.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Boolean, CheckConstraint, DateTime, Index, Integer, Text, func, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class EventDefinition(Base):
    __tablename__ = "event_definitions"
    __table_args__ = (
        CheckConstraint(
            r"(org_id IS NULL AND key ~ '^preset\.[a-z0-9_]+(\.[a-z0-9_]+)+$')"
            r" OR (org_id IS NOT NULL AND key ~ '^org\.[a-z0-9-]+\.[a-z0-9_]+(\.[a-z0-9_]+)*$')",
            name="ck_event_definitions_key_namespace",
        ),
        Index(
            "uq_event_definitions_preset_key", "key", unique=True,
            postgresql_where=text("org_id IS NULL"),
        ),
        Index(
            "uq_event_definitions_org_key", "org_id", "key", unique=True,
            postgresql_where=text("org_id IS NOT NULL"),
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    key: Mapped[str] = mapped_column(Text, nullable=False)
    org_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True, index=True)
    # story #2792(2790 P1, PO 확定 2026-08-19 ①) — 사람용 표시(드롭다운 등). key는 기계용
    # 식별자로 그대로 둔다. i18n 오버레이(role_templates류)는 신설 안 함(이번 스코프 밖).
    # server_default는 진짜 데이터 경로(마이그 백필·API가 name 필수)를 위한 게 아니라
    # create_all+구 시드 리터럴 직삽입(0245._SEED, name 없음) 같은 레거시/테스트 경로의
    # 안전망 — enabled/version/stage_metadata와 동일 컨벤션.
    name: Mapped[str] = mapped_column(Text, nullable=False, server_default="")
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    payload_schema: Mapped[dict] = mapped_column(JSONB, nullable=False)
    routing: Mapped[dict] = mapped_column(JSONB, nullable=False)
    # P2(story #2637)가 소비 — nullable=없으면 제네릭 카드 폴백(블루프린트 §2-1 표).
    block_template: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    action_auth: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    # story #2792(2790 P1) — 사이클형(payload_schema.properties.stage.enum 有) 정의의 stage별
    # 카탈로그 메타(role/action) — "기대 행동은 정의 레벨 데이터"(발행 payload 아님). 키 집합은
    # stage.enum의 부분집합이어야 한다(event_definition_registry.validate_stage_metadata가 등록/
    # 수정 시점에 강제 — 오타 slug가 조용히 죽는 클래스 차단, 페드루 판정 2026-08-19).
    stage_metadata: Mapped[dict] = mapped_column(JSONB, nullable=False, server_default=text("'{}'::jsonb"))
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="true")
    version: Mapped[int] = mapped_column(Integer, nullable=False, server_default="1")
    created_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )
