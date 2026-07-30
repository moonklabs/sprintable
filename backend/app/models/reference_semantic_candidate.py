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

  relation_kind — ⛔영문 식별자(PO 지적 2026-07-29: "DB 값은 식별자, 사람이 읽는 말은
    번역"이어야 함 — 미르코군이 같은 병(qa 상태 리터럴이 화면에 날것으로 새는 것)을 겪은
    직후 발견된 자매 사고). 6종 중 하나 또는 NULL(=미분류, AC10 — taxonomy 밖도 버리지
    않고 저장한다). 한글 원표(`story_refcheck_classification_20260728.md`)와의 대조가
    끊기지 않도록 `RELATION_KIND_LABELS_KO` 매핑을 아래 상수로 남긴다:
      spawned(원표: 낳음) · cited_as_evidence(근거인용) · similar_case(동종사례) ·
      followed(잇따름) · explicitly_unrelated(명시적_무관) · superseded(대체)

    ⛔superseded(대체) — story #2223 판정(오르테가군, 2026-07-30) 추가. 다른 5종과 성질이
    다르다(한쪽이 죽는 유일한 관계) — 표본 실측 0건이라 자동분류 규칙(`_KEYWORD_RULES`)에
    안 넣는다. 사람이 직접 골라야만 붙는 값 — declare와는 별도 액션(아래 참조).
  status — estimated(기본, AC3 「추정됨」) | declared(사람이 승격, AC5 「선언됨」).
  declared_by/declared_at — status=declared로 승격한 사람/시각(감사 추적).
  ⛔relation_kind와 status는 서로 «다른 질문»이다(오르테가군 판정, 2026-07-30) — declare는
  "이 연결이 실재하는가"만 확認하고(AC4 계약 그대로, 셋만 바꿈), "무슨 종류인가"는 별도
  엔드포인트(`set_candidate_relation_kind`)가 담당한다. 한 클릭에 두 판단을 묶지 않는다.

⛔범위(AC1·#2269 AC0-3과 동일 모집단 유지): 이 표는 story description/acceptance_criteria의
맨 번호(`#<번호>`)가 다른 story를 가리키는 경우만 다룬다 — bracket 멘션(`entity:type:uuid`
문법)은 여기 후보가 안 된다. 섞으면 57.5% 실측 기준(AC1 재검증 모집단)이 흐려진다.

⛔story #2223(2026-07-30) 판정으로 위 "소급 안 함"이 뒤집혔다 — create_story가
`_reconcile_story_references_and_candidates()`를 한 번도 안 불렀던 버그(오르테가군, 오늘
아침 수정)로 이 표가 선 뒤(2026-07-29 23:18~) 실제로 쌓인 행이 104건뿐(해소된 후보
1349건 대비 7.7%)이었던 것이 실측으로 드러나 "소급"이 사실상 "첫 채우기"였다 — 그래서
`backend/scripts/backfill_reference_semantic_candidates.py`(1회성, Cloud Run Job으로
실행·재실행해도 멱등 — `store_semantic_candidates`의 ON CONFLICT DO NOTHING 그대로 재사용)
가 생겼다. write-path(story 저장 시점)는 여전히 유일한 **상시** 경로다 — 백필은 그 경로를
과거 데이터에 한 번 더 돌리는 것뿐, 별도 로직을 새로 만들지 않는다.

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

RELATION_KINDS = frozenset(
    {
        "spawned", "cited_as_evidence", "similar_case", "followed", "explicitly_unrelated",
        "superseded",
    }
)
# NULL(미분류)은 값이지 부재가 아니다(AC10) — 위 6종 밖이면 저장 시 NULL로 남는다.

# ⛔PO 지적(2026-07-29): DB 값(위 RELATION_KINDS)은 식별자, 사람이 읽는 말은 번역(en.json/
# ko.json) 몫 — 이 매핑은 번역 파일이 아니라 한글 원표(story_refcheck_classification_
# 20260728.md)와의 대조가 끊기지 않게 하는 개발자용 참조표다(화면에 노출 안 함).
RELATION_KIND_LABELS_KO: dict[str, str] = {
    "spawned": "낳음",
    "cited_as_evidence": "근거인용",
    "similar_case": "동종사례",
    "followed": "잇따름",
    "explicitly_unrelated": "명시적_무관",
    "superseded": "대체",
}

STATUSES = frozenset({"estimated", "declared"})


class ReferenceSemanticCandidate(Base, OrgScopedMixin):
    __tablename__ = "reference_semantic_candidates"
    __table_args__ = (
        CheckConstraint(
            "relation_kind IS NULL OR relation_kind IN "
            "('spawned', 'cited_as_evidence', 'similar_case', 'followed', "
            "'explicitly_unrelated', 'superseded')",
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
