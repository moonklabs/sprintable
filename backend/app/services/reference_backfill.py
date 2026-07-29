"""story #2259(C-1) — 옛 mentions 데이터를 entity_references 로 옮긴다(복사, 삭제 아님).

⛔PO 판정: 이 마이그레이션에 삭제를 섞지 않는다 — 옛 `mentions` 표는 새 표가 라이브로 도는
것을 본 뒤 별건으로 정리한다. 이 백필은 몇 번을 다시 돌려도 안전하다(ON CONFLICT DO NOTHING,
`uq_entity_references_non_proof` 부분 유니크 인덱스가 중복 흡수 — 백필 행은 항상
form="mention"이라 이 인덱스의 `WHERE form <> 'proof'` 조건에 항상 걸린다).

⚠️알려진 손실 하나: 옛 `mentions` 테이블엔 mention(인라인)/embed(카드) 구분 컬럼이 없었다
(source-path 였는지만 알 뿐, 어느 UI 형태였는지는 기록된 적이 없다) — 그래서 백필된 행은
전부 `form="mention"`으로 들어간다. 이건 데이터 손실이 아니라 **원래 없던 정보를 지어내지
않는 것**(안 세는 것과 지어내는 것을 가르는 오늘의 규율 그대로) — 새로 생기는 행부터는
정확한 form 이 기록된다.

`source_field="body"` 로 채운다(PO 정정: NOT NULL·"자리가 본문이다"가 참) — 옛 표의 두
source_type(chat_message·doc) 둘 다 텍스트 필드가 하나뿐이라 이게 유일하게 맞는 값이다.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.mention import Mention
from app.models.reference import Reference


async def backfill_mentions_to_references(session: AsyncSession, *, org_id: uuid.UUID | None = None) -> int:
    """mentions 행을 entity_references 로 복사. org_id 지정 시 그 org 만(부분 재실행용).
    반환값 = 시도한 행 수(중복은 ON CONFLICT DO NOTHING 으로 조용히 흡수 — 정확한 신규
    삽입 건수가 필요하면 호출 전후 count(*) 차분으로 잰다)."""
    stmt = select(Mention)
    if org_id is not None:
        stmt = stmt.where(Mention.org_id == org_id)
    mentions = (await session.execute(stmt)).scalars().all()
    if not mentions:
        return 0

    insert_stmt = pg_insert(Reference).values([
        {
            "id": uuid.uuid4(),
            "org_id": m.org_id,
            "source_type": m.source_type,
            "source_field": "body",  # 옛 표의 두 source_type 다 텍스트 필드가 하나뿐이다.
            "source_id": m.source_id,
            "target_type": m.target_type,
            "target_id": m.target_id,
            "form": "mention",  # ⛔모듈 docstring 참조 — 지어내지 않고 유일하게 아는 값.
            "proof_payload": None,
            "created_by": m.created_by,
            "created_at": m.created_at,
        }
        for m in mentions
    ])
    # 부분 유니크 인덱스라 이름(constraint=)이 아니라 인덱스가 실제로 잡는 컬럼식으로
    # 타겟팅한다(Postgres ON CONFLICT ON CONSTRAINT는 바닥이 CONSTRAINT여야 하고, 이건 바닥이
    # 순수 INDEX다 — index_elements + index_where로 그 인덱스를 정확히 가리킨다).
    insert_stmt = insert_stmt.on_conflict_do_nothing(
        index_elements=[
            Reference.source_type, Reference.source_field, Reference.source_id,
            Reference.target_type, Reference.target_id, Reference.form,
        ],
        index_where=Reference.form != "proof",
    )
    await session.execute(insert_stmt)
    return len(mentions)


@dataclass(frozen=True)
class BackfillVerification:
    old_count: int
    new_count: int

    @property
    def matches(self) -> bool:
        return self.old_count == self.new_count


async def verify_backfill_complete(
    session: AsyncSession, *, org_id: uuid.UUID | None = None,
) -> BackfillVerification:
    """story #2273 AC1 — "돌렸다"가 아니라 **수가 같다**를 보인다. 옛 mentions 행 수와
    이번 백필로 생긴 entity_references 행 수(form='mention'·source_field='body'로 정확히
    필터 — 재배선 후 새로 쓰인 mention/embed 행까지 같이 세면 이 비교 자체가 무의미해진다)를
    비교한다. 다르면 그 차이 자체가 "무엇이 안 옮겨졌는지"의 단서다(이 함수는 진단만 —
    원인 조사는 호출부 몫)."""
    old_stmt = select(func.count()).select_from(Mention)
    new_stmt = select(func.count()).select_from(Reference).where(
        Reference.form == "mention", Reference.source_field == "body",
    )
    if org_id is not None:
        old_stmt = old_stmt.where(Mention.org_id == org_id)
        new_stmt = new_stmt.where(Reference.org_id == org_id)
    old_count = (await session.execute(old_stmt)).scalar_one()
    new_count = (await session.execute(new_stmt)).scalar_one()
    return BackfillVerification(old_count=old_count, new_count=new_count)
