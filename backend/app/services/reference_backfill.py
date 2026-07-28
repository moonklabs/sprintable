"""story #2259(C-1) — 옛 mentions 데이터를 entity_references 로 옮긴다(복사, 삭제 아님).

⛔PO 판정: 이 마이그레이션에 삭제를 섞지 않는다 — 옛 `mentions` 표는 새 표가 라이브로 도는
것을 본 뒤 별건으로 정리한다. 이 백필은 몇 번을 다시 돌려도 안전하다(ON CONFLICT DO NOTHING,
`uq_entity_references_source_target_form` 이 중복 흡수).

⚠️알려진 손실 하나: 옛 `mentions` 테이블엔 mention(인라인)/embed(카드) 구분 컬럼이 없었다
(source-path 였는지만 알 뿐, 어느 UI 형태였는지는 기록된 적이 없다) — 그래서 백필된 행은
전부 `form="mention"`으로 들어간다. 이건 데이터 손실이 아니라 **원래 없던 정보를 지어내지
않는 것**(안 세는 것과 지어내는 것을 가르는 오늘의 규율 그대로) — 새로 생기는 행부터는
정확한 form 이 기록된다.
"""
from __future__ import annotations

import uuid

from sqlalchemy import select
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
            "source_field": None,  # 옛 표엔 서브 위치 개념이 없었다.
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
    insert_stmt = insert_stmt.on_conflict_do_nothing(constraint="uq_entity_references_source_target_form")
    await session.execute(insert_stmt)
    return len(mentions)
