"""story #2259(C-1) — 참조 write/read 코어.

⛔이 파일은 「가리켰다」는 사실만 다룬다 — 의미(잇따름·필요함 등) 판정은 다른 층(#2261+)의 몫.

write: `insert_reference` — form 은 app-level 로도 검증(DB CHECK 와 이중 방어, 빠른 명확한
에러), entity_type(source/target 둘 다)은 `reference_registry.ENTITY_RESOLVERS`에 없으면
**거부**한다(조용히 통과 금지, PO 판정).

read: `list_references` — 양방향(outgoing/incoming)을 같은 함수가 축만 바꿔 처리(재구현 0).
끊어진 참조는 **읽는 시점에** 판정한다(PO 판정 (b) — 삭제 콜사이트 훅 없음, 실패해도 "늦게
안다"이지 "영영 모른다"가 아니다). 두 불변식을 지킨다:
  ㉠순서   permission 필터 → 존재 판정(거꾸로 하면 "못 보는 것"과 "끊어진 것"이 섞인다).
           ⛔C-3(#2261·안전핀)이 아직 없어 `visible_ids_by_type`는 지금 None 기본값(무필터)
           — #2261이 이 파라미터를 채워 호출하면 되고, 이 함수 몸통은 안 바뀐다.
  ㉡N+1 금지  존재 판정은 반대편 entity_type 별로 묶어 **한 번씩만** 조회한다.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Literal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.reference import FORMS, NO_RELATION, RELATIONS, Reference
from app.services.reference_registry import (
    ENTITY_RESOLVERS,
    TARGET_ONLY_RESOLVERS,
    TARGET_ONLY_TYPES,
    is_valid_source_type,
    is_valid_target_type,
)

Direction = Literal["outgoing", "incoming"]


class UnregisteredEntityTypeError(ValueError):
    """source_type/target_type 이 reference_registry 에 없다 — write 거부(조용히 통과 금지)."""


@dataclass(frozen=True)
class ResolvedReference:
    id: uuid.UUID
    source_type: str
    source_field: str
    source_id: uuid.UUID
    target_type: str
    target_id: uuid.UUID
    form: str
    # story #2267(C-9): 'none'(본문 참조, 기존 전부) 또는 'created_from'(target이 이 source
    # 에서 만들어졌다 — "출처"). NOT NULL sentinel — form/source_field와 다른 축
    # (app/models/reference.py 참조).
    relation: str
    created_at: object
    # PO (b) — 읽는 시점 판정. **direction 에 따라 무엇을 가리키는지 달라진다** —
    # outgoing 이면 target 의 존재, incoming 이면 source 의 존재("반대편"이 항상 이 값의
    # 대상). 필드명을 target_still_exists 로 고정하지 않은 이유가 이것 — incoming 조회에서
    # "target" 은 이미 entity_id 자신(항상 존재)이라 의미가 없다. None = 아직 안 밝혀짐
    # (반대편 entity_type 이 registry 밖이라 존재판정 자체를 못 한 경우 — count_orphan_types
    # 가 잡는 그 케이스). True/False 만 신뢰.
    still_exists: bool | None
    # story #2263(C-7, 2026-07-29 · PO 정정): 그대로 싣는다 — proof 소비처(C-7 섹션)가 카드를
    # 여럿 펼쳐 보이는 자리라 단건 상세 라우트를 따로 지으면 N+1이 된다(PO 자기정정 — 소비
    # 패턴을 안 보고 "무거우니 목록엔 빼자"로 먼저 갈랐던 것). 내부 구조는 안 읽는다(그대로
    # 통과) — 크기 문제는 응답 shape이 아니라 저장 시점 범위 상한으로 막는다(#2263 AC).
    proof_payload: dict | None = None


async def insert_reference(
    session: AsyncSession,
    *,
    org_id: uuid.UUID,
    source_type: str,
    source_field: str,
    source_id: uuid.UUID,
    target_type: str,
    target_id: uuid.UUID,
    form: str,
    created_by: uuid.UUID | None,
    proof_payload: dict | None = None,
    relation: str = NO_RELATION,
) -> Reference:
    if form not in FORMS:
        raise ValueError(f"form must be one of {sorted(FORMS)}, got {form!r}")
    if relation not in RELATIONS:
        raise ValueError(f"relation must be one of {sorted(RELATIONS)}, got {relation!r}")
    # ⛔source/target은 다른 기준 — source는 SOURCE_ONLY_TYPES(예: chat_message, 채팅
    # write-path의 정당한 source지만 완전지원 엔티티는 아니다)도 허용하지만 target은
    # ENTITY_RESOLVERS(완전지원) 또는 TARGET_ONLY_TYPES(target 전용, 예: chat_message가
    # proof의 대상이 되는 자리 — story #2263)만 허용한다(reference_registry.py 모듈
    # docstring 참조, #2273 실측 발견 + #2263 PO 판정).
    if not is_valid_source_type(source_type):
        raise UnregisteredEntityTypeError(f"source_type {source_type!r} not in reference_registry")
    if not is_valid_target_type(target_type):
        raise UnregisteredEntityTypeError(f"target_type {target_type!r} not in reference_registry")

    ref = Reference(
        id=uuid.uuid4(), org_id=org_id, source_type=source_type, source_field=source_field,
        source_id=source_id, target_type=target_type, target_id=target_id, form=form,
        proof_payload=proof_payload, created_by=created_by, relation=relation,
    )
    session.add(ref)
    return ref


async def _batch_resolve_existence(
    session: AsyncSession, org_id: uuid.UUID, ids_by_type: dict[str, set[uuid.UUID]],
) -> dict[str, set[uuid.UUID]]:
    """㉡N+1 금지 — entity_type 별로 묶어 resolver 를 **한 번씩만** 호출한다.

    ⛔story #2263: ENTITY_RESOLVERS(완전지원)뿐 아니라 TARGET_ONLY_RESOLVERS(target 전용,
    예: chat_message)도 본다 — 둘 다 "존재판정 가능"이라는 같은 질문에 답하지만, 완전지원
    여부(검색·MCP 등)는 이 함수의 관심사가 아니다."""
    existing_by_type: dict[str, set[uuid.UUID]] = {}
    for entity_type, ids in ids_by_type.items():
        resolver = ENTITY_RESOLVERS.get(entity_type) or TARGET_ONLY_RESOLVERS.get(entity_type)
        if resolver is None:
            # registry 밖 타입 — 존재판정 불가(count_orphan_types 가 별도로 이 사고를 잡는다).
            existing_by_type[entity_type] = set()
            continue
        existing_by_type[entity_type] = await resolver(session, org_id, list(ids))
    return existing_by_type


async def list_references(
    session: AsyncSession,
    *,
    org_id: uuid.UUID,
    entity_type: str,
    entity_id: uuid.UUID,
    direction: Direction,
    visible_ids_by_type: dict[str, set[uuid.UUID]] | None = None,
) -> list[ResolvedReference]:
    """direction="outgoing" — entity_id 가 가리키는 것(내가 가리키는 것).
    direction="incoming" — entity_id 를 가리키는 것(나를 가리키는 것).
    같은 표에서 축만 바꿔 조회한다(backlinks.py 기존 패턴 재사용)."""
    # story #2679(BE): origin='auto'(서버가 caller 의도 확인 없이 승격한 참조)는 참조
    # 카운트/목록에서 제외 — backlinks.py list_entity_backlinks와 동일 근거·동일 패턴.
    if direction == "outgoing":
        stmt = select(Reference).where(
            Reference.org_id == org_id, Reference.source_type == entity_type,
            Reference.source_id == entity_id, Reference.origin == "explicit",
        )
    else:
        stmt = select(Reference).where(
            Reference.org_id == org_id, Reference.target_type == entity_type,
            Reference.target_id == entity_id, Reference.origin == "explicit",
        )
    rows = (await session.execute(stmt)).scalars().all()

    # ㉠순서: 권한 필터 먼저 — 반대편(outgoing 이면 target, incoming 이면 source)이 보이지
    # 않으면 여기서 걸러낸다(존재판정 이전에). #2261 붙기 전엔 무필터(모두 통과).
    if visible_ids_by_type is not None:
        def _other_side_visible(r: Reference) -> bool:
            other_type = r.target_type if direction == "outgoing" else r.source_type
            other_id = r.target_id if direction == "outgoing" else r.source_id
            return other_id in visible_ids_by_type.get(other_type, set())

        rows = [r for r in rows if _other_side_visible(r)]

    # ㉡존재 판정 — 반대편 id 를 entity_type 별로 묶어 배치 조회(N+1 금지).
    ids_by_type: dict[str, set[uuid.UUID]] = {}
    for r in rows:
        other_type = r.target_type if direction == "outgoing" else r.source_type
        other_id = r.target_id if direction == "outgoing" else r.source_id
        ids_by_type.setdefault(other_type, set()).add(other_id)
    existing_by_type = await _batch_resolve_existence(session, org_id, ids_by_type)

    resolved: list[ResolvedReference] = []
    for r in rows:
        other_type = r.target_type if direction == "outgoing" else r.source_type
        other_id = r.target_id if direction == "outgoing" else r.source_id
        still_exists: bool | None
        if other_type not in ENTITY_RESOLVERS and other_type not in TARGET_ONLY_TYPES:
            still_exists = None  # registry 밖 타입 — 판정 불가(orphan 점검이 별도로 잡음).
        else:
            still_exists = other_id in existing_by_type.get(other_type, set())
        resolved.append(
            ResolvedReference(
                id=r.id, source_type=r.source_type, source_field=r.source_field,
                source_id=r.source_id, target_type=r.target_type, target_id=r.target_id,
                form=r.form, relation=r.relation, created_at=r.created_at, still_exists=still_exists,
                proof_payload=r.proof_payload,
            )
        )
    return resolved
