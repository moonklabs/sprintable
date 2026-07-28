"""story #2259(C-1, E-CONNECT) — 참조를 1급 개념으로. 근본 설계 doc `flow-map-blueprint-v1` §2/§6.

⛔이 파일이 만드는 것은 「가리켰다」는 사실뿐이다(블루프린트 3층: 참조=관찰됨 / 의미 후보=
추정됨 / 실행 관계=선언됨) — 의미(잇따름·필요함 등)를 여기서 저장·판정하지 않는다.

축 정리(오르테가군 2026-07-28 판정):
  자리(source_type, source_field, source_id)  — source_field 는 같은 엔티티 안 여러 텍스트
    필드(예: story description vs acceptance_criteria)를 가르는 서브 위치. 텍스트 필드가
    하나뿐인 소스(chat_message 등)는 None.
  대상(target_type, target_id)                — source 와 동일 폴리모픽 원칙.
  형태(form)   — mention(인라인)·embed(카드)·proof(범위 스냅샷) **3값 CHECK로 닫는다**
    (유한하고 안 늘어나는 축 — entity type 과 다른 성격이라 여기만 CHECK).
    ⛔proof 의 저장 모양(무엇을 잘랐는지)은 #2265(유나 lane, 범위 선택 설계 미확定) 몫 —
    여기선 `proof_payload` nullable 칸만 남기고 굳히지 않는다.

⛔entity type(source_type/target_type)은 CHECK로 나열하지 않는다(#2260과 같은 원칙 —
0-diff 확장) — 대신 `app.services.reference_registry`의 resolver registry 가 열어 준
타입만 write-time 에 허용한다(등록 안 된 타입은 조용히 통과 아니라 거부, registry.py 참조).
⛔"나열 안 한다"가 "아무거나 받는다"는 아니다 — write 헬퍼가 registry 검증을 강제한다.

양방향 조회: 같은 표에서 축만 바꿔 조회한다(`backlinks.py`의 기존 패턴 재사용 — 재발명 0).

끊어진 참조: PO 판정(b) — 삭제 시점 훅이 아니라 **읽는 시점에 대상 존재를 판정**한다(콜사이트가
없어 "하나 빠뜨려 조용히 안 남는" 실패모드가 구조적으로 없다 — 늦게 아는 것과 영영 모르는
것은 다르다). 순서 불변식: 권한 필터(C-3, #2261) → 존재 판정(이 순서를 뒤집으면 "못 보는 것"과
"끊어진 것"이 섞인다). N+1 금지 — 존재 판정은 target_type 별로 묶어 한 번씩(reference_core.py
참조).

기존 `mentions`(story #1993) 테이블은 이 스토리에서 지우지 않는다 — 백필로 이 표에 옮기고,
write-path(`insert_chat_mentions`/`reconcile_doc_mentions`)는 저장 타깃만 재배선한다(추출층은
#2260에서 이미 범용화돼 손대지 않는다). 옛 표 삭제는 새 표가 라이브로 도는 것을 본 뒤 별건.
"""
import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, Index, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.base import OrgScopedMixin

FORMS = frozenset({"mention", "embed", "proof"})


class Reference(Base, OrgScopedMixin):
    __tablename__ = "entity_references"
    __table_args__ = (
        Index("ix_entity_references_source", "org_id", "source_type", "source_id"),
        Index("ix_entity_references_target", "org_id", "target_type", "target_id"),
        CheckConstraint("form IN ('mention', 'embed', 'proof')", name="ck_entity_references_form"),
        # mentions 테이블의 uq_mentions_source_target 과 동일 SSOT 원칙(같은 이유: insert-only
        # write-path 의 ON CONFLICT DO NOTHING 방어 + 백필 재실행 시 idempotent 보장).
        # ⛔form 도 키에 포함 — 같은 (source,target) 쌍이라도 mention/embed 는 다른 사실.
        UniqueConstraint(
            "source_type", "source_id", "target_type", "target_id", "form",
            name="uq_entity_references_source_target_form",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    source_type: Mapped[str] = mapped_column(Text, nullable=False)
    # story #2259: 같은 엔티티 안 복수 텍스트 필드를 가르는 서브 위치(예: "description" vs
    # "acceptance_criteria") — 필드가 하나뿐인 source_type 은 None.
    source_field: Mapped[str | None] = mapped_column(Text, nullable=True)
    source_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    target_type: Mapped[str] = mapped_column(Text, nullable=False)
    target_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    form: Mapped[str] = mapped_column(Text, nullable=False)
    # #2265(유나 lane) 몫 — 이 스토리에서 모양을 굳히지 않는다. proof 가 아니면 항상 None.
    proof_payload: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    created_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
