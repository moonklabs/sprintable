"""story #2259(C-1) — entity type resolver registry.

⛔0-diff 확장 원칙: 대상 종류를 CHECK 로 나열하지 않는 대신, write-time 검증과 read-time
존재판정(§`reference_core.py`)을 이 registry 하나로 몬다. 새 타입을 열려면 여기 항목 하나만
추가하면 되고, `reference.py`/`reference_core.py` 몸통은 손대지 않는다.

⛔PO 판정(2026-07-28): "나열 안 한다"가 "아무거나 받는다"는 아니다 — registry 에 없는
타입은 write 시 거부한다(조용히 통과 금지). 그리고 이미 저장된 행 중 registry 에 없는
타입이 있는지 세는 점검(`count_orphan_types`)을 별도로 둔다(오타 타입이 조용히 쌓여도
DB CHECK 가 안 지켜 주니 이게 유일한 감시망).

⛔지금 실제로 등록하는 것은 **딱 3종**(doc·story·epic) — #2259 착수 시점에 실제로 도는
것만. 블루프린트가 언급한 나머지(sprint·artifact·hypothesis·goal·task·chat message·
evidence)는 "등록되면 열리는" 것이지, 쓰지도 않을 resolver 를 미리 짓는 것은 그 자체가
"만들어졌는데 도는 자리가 없는" 죽은 경로다(#2260이 고친 그 클래스를 재발시키지 않는다).

⛔story #2273(C-1b) 실측으로 발견: source(자리)와 target(대상)은 "존재판정이 필요한가"가
다르다 — chat_message는 정당한 source_type(채팅 write-path가 실제로 매일 쓰는 값)이지만
**target으로 가리켜질 일이 없어 resolver가 없다**(메시지는 불변·삭제돼도 backlinks
read-path의 LEFT JOIN이 자연히 걸러낸다, 별도 존재판정 불필요). 이걸 ENTITY_RESOLVERS
(target 전용 registry)에 없다고 "오타/미등록"으로 취급하면 **정상 데이터를 사고로 오탐**한다
(count_orphan_types 실측에서 직접 걸림 — chat_message가 source로 366건 "orphan"으로
잡혔던 것). `SOURCE_ONLY_TYPES`가 그 구분을 명시한다: source로는 유효하나 target
존재판정은 없는 타입.
"""
from __future__ import annotations

import uuid
from collections.abc import Awaitable, Callable

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

EntityExistsResolver = Callable[[AsyncSession, uuid.UUID, list[uuid.UUID]], Awaitable[set[uuid.UUID]]]


async def _resolve_docs(session: AsyncSession, org_id: uuid.UUID, ids: list[uuid.UUID]) -> set[uuid.UUID]:
    from app.models.doc import Doc

    rows = (
        await session.execute(
            select(Doc.id).where(Doc.org_id == org_id, Doc.id.in_(ids), Doc.deleted_at.is_(None))
        )
    ).scalars().all()
    return set(rows)


async def _resolve_stories(session: AsyncSession, org_id: uuid.UUID, ids: list[uuid.UUID]) -> set[uuid.UUID]:
    from app.models.pm import Story

    rows = (
        await session.execute(
            select(Story.id).where(Story.org_id == org_id, Story.id.in_(ids), Story.deleted_at.is_(None))
        )
    ).scalars().all()
    return set(rows)


async def _resolve_epics(session: AsyncSession, org_id: uuid.UUID, ids: list[uuid.UUID]) -> set[uuid.UUID]:
    from app.models.pm import Goal

    # Goal(epic)엔 SoftDeleteMixin이 없다(하드 삭제) — row 존재 자체가 존재판정.
    rows = (
        await session.execute(select(Goal.id).where(Goal.org_id == org_id, Goal.id.in_(ids)))
    ).scalars().all()
    return set(rows)


# entity_type(str) -> resolver. 각 resolver 는 (session, org_id, ids) -> {존재하는 id 집합}.
# ⛔이 dict 가 유일한 SSOT — write 검증과 read 존재판정이 둘 다 이걸 참조한다(재구현 0).
ENTITY_RESOLVERS: dict[str, EntityExistsResolver] = {
    "doc": _resolve_docs,
    "story": _resolve_stories,
    "epic": _resolve_epics,
}


# source_type으로는 유효하나 target 존재판정(resolver)은 없는 타입 — 위 모듈 docstring
# 참조. write-path(mention_parser.py)가 이 타입들을 source_type으로 직접 씀(하드코딩 리터럴,
# 사용자 입력 아님 — #2260이 이미 검증한 신뢰 경계).
SOURCE_ONLY_TYPES: frozenset[str] = frozenset({"chat_message"})


def is_registered_entity_type(entity_type: str) -> bool:
    """target_type 검증용 — 존재판정(resolver)이 있는 타입인가."""
    return entity_type in ENTITY_RESOLVERS


def is_valid_source_type(entity_type: str) -> bool:
    """source_type 검증용 — target-capable(ENTITY_RESOLVERS) 이거나 source-only 인가."""
    return entity_type in ENTITY_RESOLVERS or entity_type in SOURCE_ONLY_TYPES


async def count_orphan_types(session: AsyncSession, org_id: uuid.UUID | None = None) -> dict[str, int]:
    """⭐PO가 요구한 감시망 — entity_references 에 저장된 행 중 source_type/target_type 이
    registry(+source-only 허용목록)에 없는 것을 종류별로 센다. 0이 정상 — 0이 아니면
    오타/미등록 타입이 조용히 쓰기를 통과한 사고(이 함수가 잡아야 하는 그 사고)다.
    org_id=None(기본) = 전체 org.

    ⛔story #2273(C-1b) AC10: 이 함수는 #2259에서 만들어졌지만 테스트만 불렀다 — "만들어졌는데
    도는 자리가 없는" 그 클래스였다. `app.routers.cron.entity_references_orphan_check`가 이제
    이걸 실제로 호출하는 자리다(Cloud Scheduler → CRON_SECRET 게이트 → 이 함수, 기존
    workflow-* cron 엔드포인트와 같은 배선).

    ⛔source_type과 target_type은 다른 "known" 집합으로 판정한다(SOURCE_ONLY_TYPES 참조) —
    같은 집합으로 재면 chat_message 같은 정상 source가 오탐된다(실측으로 걸린 자리)."""
    from collections import Counter

    from app.models.reference import Reference

    known_targets = set(ENTITY_RESOLVERS)
    known_sources = known_targets | SOURCE_ONLY_TYPES
    stmt = select(Reference.source_type, Reference.target_type)
    if org_id is not None:
        stmt = stmt.where(Reference.org_id == org_id)
    rows = (await session.execute(stmt)).all()
    counts: Counter[str] = Counter()
    for source_type, target_type in rows:
        if source_type not in known_sources:
            counts[f"source:{source_type}"] += 1
        if target_type not in known_targets:
            counts[f"target:{target_type}"] += 1
    return dict(counts)
