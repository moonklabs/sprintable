"""story #2259(C-1, E-CONNECT) — 참조를 1급 개념으로. 근본 설계 doc `flow-map-blueprint-v1` §2/§6.

⛔이 파일이 만드는 것은 「가리켰다」는 사실뿐이다(블루프린트 3층: 참조=관찰됨 / 의미 후보=
추정됨 / 실행 관계=선언됨) — 의미(잇따름·필요함 등)를 여기서 저장·판정하지 않는다.

축 정리(오르테가군 2026-07-28 판정):
  자리(source_type, source_field, source_id)  — source_field 는 같은 엔티티 안 여러 텍스트
    필드(예: story description vs acceptance_criteria)를 가르는 서브 위치. **NOT NULL** —
    텍스트 필드가 하나뿐인 소스(chat_message 등)도 "없음"이 아니라 "본문 하나뿐"이 사실이라
    `"body"`를 실제로 적는다(PO 정정: 모르는 것을 NULL로 두지 않고 아는 것을 적는다 —
    "자리가 없다"가 아니라 "자리가 본문이다"가 참).
    ⛔유니크 축에 nullable 컬럼을 넣으면 NULL 행끼리는 "다른 값"으로 취급돼 유니크가 안
    걸린다(Postgres 표준 동작) — source_field를 NOT NULL로 만든 이유가 이것. 오늘 세션에
    같은 병이 두 번 나왔다(uq_stories_project_id_story_number → 여기) — **유니크 축의
    컬럼은 NOT NULL 이거나, NULL 이 진짜 "값"으로 의미가 있어야 한다.**
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

story #2267(C-9, 2026-07-29) — `relation` 신설(오르테가군 판정, 새 컬럼).
⛔`form`(어떻게 보이는가: mention/embed/proof)과 `source_field`(어느 «필드»에서 파싱됐나:
지금 유일값 "body") 둘 다 「왜 생겼는가」(출처) 축을 못 담는다 — 창조 출처는 텍스트 필드에서
파싱된 게 아니라 «생성 행위» 자체에서 온 것이라 애초에 "필드"가 없고, form에 넣으면 "어떻게
그리는가"를 판단하는 코드가 새 값을 못 알아본다(닫힌 렌더링 축에 다른 뜻을 밀어 넣는 것과
같은 사고 — ENTITY_RESOLVERS에 chat_message를 잘못 넣어 CI 13건이 깨졌던 것과 같은 병).

⛔⛔NULL-distinct 함정 두 번째 재발(2026-07-29, 로컬 disposable PG로 직접 재현) — 처음엔
`relation`을 nullable로 두고 NULL=본문참조로 설계했는데, 그러면 relation=NULL인 행끼리
Postgres 기본(NULLS DISTINCT)상 "다른 값"으로 취급돼 **유일성이 아예 안 걸린다**(기존
멘션 전부가 NULL이므로 지금까지 막던 중복이 통째로 풀리는 회귀 — 실PG 테스트 3건이 실제로
이렇게 깨지는 것을 확認했다). `NULLS NOT DISTINCT`(PG15+)로 1차 수정했으나 — 오르테가군
재검토: 특정 PG 버전 기능에 의존하면 로컬·dev·prod 버전 불일치 리스크가 남는다. ⇒ **source_field
가 이미 쓰는 것과 완전히 같은 선례**(NOT NULL + sentinel "body")를 relation에도 그대로 적용
— PG 버전 의존 0, 이 표의 기존 관례와 동형.
⇒ `relation`은 **NOT NULL**, 기본값 `'none'`(=본문 참조, 기존 전부 이 값) 또는
'created_from'(=target이 이 source에서 만들어졌다) 둘 뿐. server_default='none'이 PG11+
에서 상수 기본값 추가를 **메타데이터 연산만으로**(테이블 재작성 0) 처리하므로 — 기존 행
전부에 실제로 'none'이 채워지지만 별도 배치 UPDATE·락 걱정이 필요 없다(로컬 PG로 실측:
138행 표에서 1.1ms).
⛔유일성 인덱스에 `relation`도 포함시켰다 — 안 넣으면 같은 대상에 대한 진짜 멘션(relation=
'none')과 창조-출처 참조(relation='created_from')가 (source_type, source_field, source_id,
target_type, target_id, form) 키만으로 충돌해 서로를 밀어낸다. NOT NULL sentinel이라
NULLS NOT DISTINCT 없이 일반 유니크 인덱스로도 정상 동작한다(source_field와 동형 이유).
"""
import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, Index, Text, func, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.base import OrgScopedMixin

FORMS = frozenset({"mention", "embed", "proof"})
# story #2267(C-9): relation의 전체 값 집합 — NOT NULL, 'none'이 "본문 참조"(옛 전부+새
# 멘션) sentinel이다(source_field가 "body"를 쓰는 것과 동형 — NULL로 "없음"을 표현하지 않는다).
RELATIONS = frozenset({"none", "created_from"})
NO_RELATION = "none"


class Reference(Base, OrgScopedMixin):
    __tablename__ = "entity_references"
    __table_args__ = (
        Index("ix_entity_references_source", "org_id", "source_type", "source_id"),
        Index("ix_entity_references_target", "org_id", "target_type", "target_id"),
        CheckConstraint("form IN ('mention', 'embed', 'proof')", name="ck_entity_references_form"),
        # story #2267(C-9): relation은 「본문 참조」('none')와 「생성 출처」('created_from') 둘
        # 뿐인 별도 축 — form/source_field와 안 섞는다(위 모듈 docstring 참조). NOT NULL +
        # sentinel(source_field와 동형) — NULL-distinct 함정을 원천 차단한다.
        CheckConstraint("relation IN ('none', 'created_from')", name="ck_entity_references_relation"),
        # mentions 테이블의 uq_mentions_source_target 과 동일 SSOT 원칙(insert-only write-path의
        # ON CONFLICT DO NOTHING 방어 + 백필 재실행 시 idempotent 보장).
        # ⛔PO 판정(2026-07-28): proof 는 이 제약에서 뺀다 — proof 는 "대화의 다른 범위"를
        # 각각 박는 정상 쓰임이 있어(같은 자리·같은 대상을 두 조각으로 인용) mention/embed 와
        # 유일성 축이 다르다. proof 의 진짜 유일성은 proof_payload(어느 범위인가)까지 있어야
        # 서는데, 그 모양은 #2265(유나 lane) 몫이라 아직 모른다 — 지금 굳히면 그때 마이그를
        # 또 파야 하니 **모르는 것을 지금 단정하지 않는다**(부분 유니크로 proof만 열어 둠).
        # source_field 는 NOT NULL(위 모듈 docstring 참조) — COALESCE 없이도 그대로 유니크
        # 비교가 성립한다(기억에 의존하는 가드를 만들지 않는다).
        # ⛔story #2267: relation도 유니크 축에 포함 — 안 넣으면 진짜 멘션(relation='none')과
        # 창조-출처 참조(relation='created_from')가 같은 (source·target·form) 키로 충돌한다.
        # relation이 NOT NULL sentinel이라(source_field와 동형) NULL-distinct 함정 자체가
        # 없다 — 'none'끼리도 'created_from'끼리도 전부 구체값 비교라 정상적으로 유일성이 걸린다.
        Index(
            "uq_entity_references_non_proof",
            "source_type", "source_field", "source_id", "target_type", "target_id", "form", "relation",
            unique=True,
            postgresql_where=text("form <> 'proof'"),
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    source_type: Mapped[str] = mapped_column(Text, nullable=False)
    # story #2259: 같은 엔티티 안 복수 텍스트 필드를 가르는 서브 위치(예: "description" vs
    # "acceptance_criteria") — 필드가 하나뿐인 source_type 도 "body"를 적는다(모듈 docstring
    # 참조 — NOT NULL, NULL로 "없음"을 표현하지 않는다).
    source_field: Mapped[str] = mapped_column(Text, nullable=False)
    source_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    target_type: Mapped[str] = mapped_column(Text, nullable=False)
    target_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    form: Mapped[str] = mapped_column(Text, nullable=False)
    # story #2267(C-9): 'none'(기본, 기존 행 전부)=본문 참조 · 'created_from'=target이 이
    # source에서 만들어졌다("출처"). NOT NULL + sentinel(source_field와 동형, NULL-distinct
    # 함정 회피) — form/source_field와 다른 축이다(위 모듈 docstring 참조).
    relation: Mapped[str] = mapped_column(Text, nullable=False, server_default=NO_RELATION, default=NO_RELATION)
    # #2265(유나 lane) 몫 — 이 스토리에서 모양을 굳히지 않는다. proof 가 아니면 항상 None.
    proof_payload: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    created_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
