"""story #3312(M1→M3·마케팅자동화) — recipe(사이클형 EventDefinition)의 stage 이벤트 발행이
`stage_metadata[stage].gate` 선언을 가지고 있으면, 그 work item에 게이트를 자동 생성한다.

event_routing_resolver.py와 동형 설계 — `_publish_registry_event_core`(routers/events.py,
#2633 AC2 단일파이프)가 routing 해석 직후 이 모듈을 호출하는 별도 단일목적 서비스(인라인
stage=="approve" 분기 대신). PO 판단(페드루, 2026-09-02) — 이 코드베이스 기존 관례(단일
core + 단일목적 서비스 호출 컴포지션)와 정합, 테스트도 격리됨.

`gate` 선언 shape은 event_definition_registry.validate_stage_metadata가 등록/수정 시점에
이미 강제한다({type: str, approver: APPROVER_ROLE_REFERENCES 소속}) — 이 모듈은 그 계약을
신뢰하고 값 해석만 한다(routing_resolver가 validate_event_routing의 계약을 신뢰하는 것과
동일 원칙, resolve_routing_leg 참조)."""
from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.project import OrgMember
from app.services.event_definition_registry import APPROVER_ROLE_REFERENCES


class UnknownApproverRoleError(ValueError):
    """approver 역할참조를 실 member_id로 못 풀었음 — 어휘는 등록 시점에 이미 검증됐으므로,
    여기서 나오면 "그 org에 role=owner인 org_member가 없다"류의 실제 데이터 결함이다(오타
    클래스 아님 — 조용히 넘기면 게이트가 승인자 없이 붕 떠버리므로 발행 시점에 명시 거부)."""


async def _resolve_org_owner(db: AsyncSession, *, org_id: uuid.UUID) -> uuid.UUID:
    member_id = (await db.execute(
        select(OrgMember.id)
        .where(OrgMember.org_id == org_id, OrgMember.role == "owner", OrgMember.deleted_at.is_(None))
        .order_by(OrgMember.created_at.asc())
        .limit(1)
    )).scalar_one_or_none()
    if member_id is None:
        raise UnknownApproverRoleError(f"org {org_id}에 role=owner인 org_member가 없습니다.")
    return member_id


# APPROVER_ROLE_REFERENCES(event_definition_registry.py, 등록 시점 강제 어휘) 전체를 이
# 모듈이 실제로 풀 수 있는지 로드 시점에 고정 — event_routing_resolver.py의
# _SERVER_DERIVED_RESOLVERS 완결성 assert와 동일 패턴(등록은 통과했는데 발행이 조용히
# 못 푸는 정의가 만들어지는 것을 막는다).
_APPROVER_ROLE_RESOLVERS = {"org_owner": _resolve_org_owner}
assert set(_APPROVER_ROLE_RESOLVERS) == set(APPROVER_ROLE_REFERENCES), (
    "recipe_gate_hooks의 approver role resolver 어휘가 "
    "event_definition_registry.APPROVER_ROLE_REFERENCES와 어긋남"
)


def _parse_work_item_uuid(value: str) -> uuid.UUID | None:
    try:
        return uuid.UUID(value)
    except (ValueError, AttributeError, TypeError):
        return None


async def maybe_create_stage_gate(
    db: AsyncSession,
    *,
    org_id: uuid.UUID,
    definition,
    payload: dict,
    requester_member_id: uuid.UUID,
) -> None:
    """definition.stage_metadata[payload['stage']].gate 선언이 있으면 그 work item에
    pending 게이트를 멱등 생성한다(create_gate 자체가 (work_item_id, work_item_type,
    gate_type) 키로 멱등 — AC2가 이 재사용만으로 충족된다, 신규 멱등 로직 불요).

    stage/work_item 정보가 payload에 없거나, 그 stage에 gate 선언이 없으면 완전 no-op —
    선언 없는 정의(다른 레시피)의 stage 이벤트는 이 함수를 거쳐도 아무 부수효과가 없다
    (AC3 회귀 0)."""
    stage = payload.get("stage")
    work_item_type = payload.get("work_item_type")
    work_item_id_raw = payload.get("work_item_id")
    if not stage or not work_item_type or not work_item_id_raw:
        return

    stage_meta = (definition.stage_metadata or {}).get(stage) or {}
    gate_decl = stage_meta.get("gate")
    if not gate_decl:
        return

    work_item_id = _parse_work_item_uuid(work_item_id_raw)
    if work_item_id is None:
        return

    resolver = _APPROVER_ROLE_RESOLVERS[gate_decl["approver"]]
    approver_id = await resolver(db, org_id=org_id)

    from app.services.gate_service import create_gate
    from app.services.workflow_line_config import _default_role_id

    role_id = await _default_role_id(db, org_id) or uuid.uuid4()
    await create_gate(
        db, org_id, work_item_id, work_item_type, gate_decl["type"],
        requester_member_id, role_id,
        neutral_facts={"triggered_by_event": definition.key, "stage": stage},
        designated_approver_id=approver_id,
    )
