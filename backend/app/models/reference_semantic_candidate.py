"""story #2328(C-11 ㉡층, E-CONNECT) — 3단계 승격의 ②③층(「의미 후보」→「실행 관계」). #2259
Reference(entity_references)·reference_core.py 둘 다 스스로 「의미는 여기서 안 다룬다」고
명시한 그 경계를 지키기 위한 별도 표(파울로 판정 2026-07-29, `Judgment`·`Reference` 둘 다
docstring이 스스로 막아 둔 것이 근거).

⛔`entity_references`를 재사용하지 않는 이유(Reference 모듈 docstring 원문): 「이 파일이
만드는 것은 「가리켰다」는 사실뿐이다 ... 의미(잇따름·필요함 등)를 여기서 저장·판정하지
않는다」. `Judgment`도 부적합(QA 판단/철회 추적이 목적이지 관계종류 분류가 아니다).

축 정리(Reference와 같은 자연키 축 — FK by id를 안 쓴다):
  자리(source_type, source_field, source_id) + 대상(target_type, target_id) + form.
  ⛔Reference insert(`reconcile_entity_references`)는 RETURNING을 안 쓴다 — 새로 생긴 행의
  id를 caller가 모른다. 자연키를 그대로 재사용하면 이 표가 Reference의 내부 PK에 결합하지
  않고 독립적으로 재계산 가능하다(재조정 시 두 표 사이 결합을 늘리지 않는다).

  relation_kind — 낳음/근거인용/동종사례/잇따름/명시적_무관 중 하나, 또는 NULL(=미분류,
    규칙 매치 없음 — AC10: taxonomy 밖도 버리지 않고 저장한다, NULL 자체가 그 값이다.
    표본 26번 자기참조 같은 taxonomy 밖 사례가 실제로 존재함을 확認했다).
  status — estimated(기본, AC3 「추정됨」) | declared(사람이 승격, AC5 「선언됨」).
  declared_by/declared_at — status=declared로 승격한 사람/시각(감사 추적).

⛔범위(AC1·#2269 AC0-3과 동일 모집단 유지): 이 표는 story description/acceptance_criteria의
맨 번호(`#<번호>`)가 다른 story를 가리키는 경우만 다룬다 — bracket 멘션(`entity:type:uuid`
문법)은 여기 후보가 안 된다. 섞으면 57.5% 실측 기준(AC1 재검증 모집단)이 흐려진다.

⛔새 참조만(PO 판정 2026-07-29 ③, 소급 안 함) — 이 표에 행이 생기는 유일한 경로는 story
저장(생성·수정) write-path(`app/services/reference_semantic_candidates.py`)뿐이다. 배치
백필 없음 — 옛 1261건(이미 해소된 참조)은 그 story가 다시 저장될 때만(정상 편집) 자연히
후보가 생긴다, 별도 재실행 로직 없음.

⛔미래번호(모집단에 없는 대상, 164건·11.5%)는 행 자체가 없다(PO 판정 ② — 제외, read-time
재수집이라 그 번호가 실제 story로 만들어지면 다음 저장 때 저절로 들어온다).
"""
import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, Index, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.base import OrgScopedMixin

RELATION_KINDS = frozenset({"낳음", "근거인용", "동종사례", "잇따름", "명시적_무관"})
# NULL(미분류)은 값이지 부재가 아니다(AC10) — 위 5종 밖이면 저장 시 NULL로 남는다.

STATUSES = frozenset({"estimated", "declared"})


class ReferenceSemanticCandidate(Base, OrgScopedMixin):
    __tablename__ = "reference_semantic_candidates"
    __table_args__ = (
        CheckConstraint(
            "relation_kind IS NULL OR relation_kind IN "
            "('낳음', '근거인용', '동종사례', '잇따름', '명시적_무관')",
            name="ck_reference_semantic_candidates_relation_kind",
        ),
        CheckConstraint(
            "status IN ('estimated', 'declared')",
            name="ck_reference_semantic_candidates_status",
        ),
        Index(
            "uq_reference_semantic_candidates_key",
            "source_type", "source_field", "source_id", "target_type", "target_id", "form",
            unique=True,
        ),
        Index("ix_reference_semantic_candidates_source", "org_id", "source_type", "source_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    source_type: Mapped[str] = mapped_column(Text, nullable=False)
    source_field: Mapped[str] = mapped_column(Text, nullable=False)
    source_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    target_type: Mapped[str] = mapped_column(Text, nullable=False)
    target_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    form: Mapped[str] = mapped_column(Text, nullable=False)
    relation_kind: Mapped[str | None] = mapped_column(Text, nullable=True)
    matched_keyword: Mapped[str | None] = mapped_column(Text, nullable=True)
    snippet: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="estimated")
    declared_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    declared_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
