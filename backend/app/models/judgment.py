"""story #2268(D단계, E-CONNECT — "판단 칸") — 판정/철회/정련/측정법오류를 Evidence 옆에
1급으로 세운다. Evidence type 확장이 아니다(오르테가 판정, 2026-07-29): batch_has_evidence·
GET /evidence·glance proof_count 등 무필터 카운트 자리가 셋 실재해, Evidence에 얹으면
「못 쟀다」가 「증거 있음」으로 잘못 읽힌다.

두 층(유나 판정):
  ㉠원래 낸 말   judgment(판정+근거) · unmeasurable(못 잰 것과 왜) — 스스로 서므로 target_id 불요.
  ㉡앞선 말에 대한 말 retraction(철회) · refinement(정련) · method_error(세는 법이 틀림)
    — target_id 필수(무엇에 대한 말인지 없는 메타-말은 저장 자체를 막는다).

work_item_ids는 오늘 실측 근거 셋 위에 설계(대화 스레드 7256d5cc, 2026-07-29):
  (a) 여러 story에 «걸치는» 교훈(twin-system drift류) — 단일 FK로는 못 세운다.
  (b) 특정 story와 무관한 일반 프로세스 교훈(예: "부분 체크만 보고 끝났다 판단") — 「어디에도
      안 붙는」 것이 정당한 상태.
  (c) 특정 하나에만 붙는 사례.
`scope`(items|general)을 명시 필드로 두는 이유: 빈 배열이 "어디에도 안 붙는 것"(b)과
"아직 안 붙인 것"(입력 누락)을 구별 못 하는 함정 — 추론 금지, 선언으로 받는다.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, Index, String, Text, func
from sqlalchemy.dialects.postgresql import ARRAY, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base

JUDGMENT_KINDS = frozenset({"judgment", "unmeasurable", "retraction", "refinement", "method_error"})
# ㉡ — 앞선 말에 대한 말. target_id NOT NULL을 요구하는 축(스키마 레벨 강제 — "무엇을
# 철회하는지 모르는 철회"가 저장되는 것을 원천 차단).
TARGET_REQUIRED_KINDS = frozenset({"retraction", "refinement", "method_error"})
JUDGMENT_SCOPES = frozenset({"items", "general"})


class Judgment(Base):
    __tablename__ = "judgments"

    __table_args__ = (
        CheckConstraint(f"kind IN {tuple(sorted(JUDGMENT_KINDS))}", name="ck_judgments_kind"),
        CheckConstraint(f"scope IN {tuple(sorted(JUDGMENT_SCOPES))}", name="ck_judgments_scope"),
        # scope='general'이면 work_item_ids는 반드시 빈 배열(=진짜로 어디에도 안 붙음),
        # scope='items'면 반드시 비어있지 않음(=붙이는 걸 깜빡한 상태를 CHECK가 즉시 거절).
        CheckConstraint(
            "(scope = 'general' AND work_item_ids = '{}') OR "
            "(scope = 'items' AND work_item_ids <> '{}')",
            name="ck_judgments_scope_work_item_ids_pairing",
        ),
        CheckConstraint(
            "(kind NOT IN ('retraction', 'refinement', 'method_error')) OR (target_id IS NOT NULL)",
            name="ck_judgments_target_required_for_meta_kinds",
        ),
        Index("ix_judgments_org", "org_id"),
        Index("ix_judgments_work_item_ids", "work_item_ids", postgresql_using="gin"),
        Index("ix_judgments_target", "target_id"),
        Index("ix_judgments_method", "org_id", "method"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    scope: Mapped[str] = mapped_column(String(20), nullable=False)
    work_item_ids: Mapped[list[uuid.UUID]] = mapped_column(
        ARRAY(UUID(as_uuid=True)), nullable=False, server_default="{}"
    )
    kind: Mapped[str] = mapped_column(String(20), nullable=False)
    # 자기참조(judgments.id) — ㉡의 "앞선 말". FK는 마이그레이션에서 건다(모델은 컬럼만
    # 선언 — 순환 자기참조 FK는 SQLAlchemy Core에서 문자열 타겟으로도 표현 가능하나, 이
    # 프로젝트 관례(entity_references 등)가 폴리모픽 대상엔 FK를 안 거는 쪽이라 여기도
    # 같은 테이블 자기참조는 명시 FK로 마이그레이션에 남긴다).
    target_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    # "어떤 방법으로 쟀는가" — method_error가 "같은 방법으로 낸 다른 말들"을 역추적하는 축
    # (오르테가 명시 요구, 2026-07-29). 자유 텍스트(방법 taxonomy는 아직 없음 — 과확장 금지).
    method: Mapped[str | None] = mapped_column(Text, nullable=True)
    statement: Mapped[str] = mapped_column(Text, nullable=False)
    created_by: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
