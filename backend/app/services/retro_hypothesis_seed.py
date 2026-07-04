"""E-SPRINT-LOOP ecc531ce: 다음가설 채택→시드.

design-first crux 반영(2026-07-03): 신규 hypothesis 서비스 로직은 0줄 — 기존
`create_hypothesis`(proposed 생성)와 `link_hypothesis`(sprint_id+link_type="seeded")를
그대로 두 번 호출해 조합한다(라우터에서). 이 모듈은 "다음 sprint" 해소와 candidate 탐색만
담당 — 둘 다 순수 조회/헬퍼라 hypothesis 서비스를 건드리지 않는다.
"""
from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.pm import Sprint


async def resolve_next_sprint(
    session: AsyncSession, org_id: uuid.UUID, project_id: uuid.UUID
) -> Sprint | None:
    """§2 PO 결(2026-07-03) — planning 상태 sprint 중 가장 이른 start_date(없으면
    created_at)를 "다음 sprint"로 본다. `SprintRepository.activate()`의 1-active 제약과
    달리 planning은 다건 공존 가능해 deterministic 선택 규칙이 필요했다. 없으면 None
    (호출부는 backlog proposed로 그대로 둔다 — sprint 링크 생략).

    까심 QA MINOR(2026-07-03) — start_date와 created_at까지 완전히 동일한 sprint가
    여럿이면(같은 배치로 생성된 케이스) 여전히 비결정적이었다. `Sprint.id.asc()`를 최종
    tie-break로 추가 — id는 uuid4라 값 자체엔 의미 없지만, 같은 세션 안에서 매번 같은
    행을 고른다는 순수 결정성만 보장하면 된다(어느 것이 뽑히든 product 의미는 동일)."""
    return (await session.execute(
        select(Sprint)
        .where(Sprint.org_id == org_id, Sprint.project_id == project_id, Sprint.status == "planning")
        .order_by(Sprint.start_date.asc().nulls_last(), Sprint.created_at.asc(), Sprint.id.asc())
        .limit(1)
    )).scalar_one_or_none()


def find_candidate(next_hypotheses: Any, candidate_id: uuid.UUID) -> dict[str, Any] | None:
    """next_hypotheses(retro_sessions JSONB) 중 candidate_id 항목을 찾는다. 동시에 shape
    검증도 겸한다 — malformed 캐시(list가 아니거나 item이 dict가 아님)는 못 믿으므로
    안전하게 None을 반환해 라우터가 404로 처리하게 한다(연산 계속 X)."""
    if not isinstance(next_hypotheses, list):
        return None
    for item in next_hypotheses:
        if not isinstance(item, dict):
            continue
        if str(item.get("id")) == str(candidate_id):
            return item
    return None
