"""E-VERIFY V0-S2(story 3fbd048d): evidence-backed 신호 + gate_approval 자동 편입."""
import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.evidence import Evidence
from app.models.gate import Gate

_EVIDENCE_WORK_ITEM_TYPES = frozenset({"story", "task"})


async def batch_has_evidence(
    session: AsyncSession, work_item_ids: list[uuid.UUID], work_item_type: str
) -> set[uuid.UUID]:
    """evidence가 1건이라도 있는 work_item_id 집합(N+1 회피 배치 조회) — story/task 응답의
    has_evidence(positive 단방향) 신호원."""
    if not work_item_ids:
        return set()
    result = await session.execute(
        select(Evidence.work_item_id.distinct()).where(
            Evidence.work_item_type == work_item_type,
            Evidence.work_item_id.in_(work_item_ids),
        )
    )
    return set(result.scalars().all())


async def create_gate_approval_evidence_if_applicable(
    session: AsyncSession, gate: Gate, new_status: str, resolver_id: uuid.UUID | None,
) -> None:
    """HITL gate 승인 → gate_approval evidence 자동 편입(blueprint §2-3, 휴먼이 이미 승인한 것도
    증명의 일부). approved 전이 + work_item_type이 evidence 스코프(story/task) 안일 때만 —
    reject/void/hold나 doc 등 V0 스코프 밖 work_item_type은 no-op(순수 additive, 회귀 0).
    공개 API의 gate_approval 차단(app/routers/evidence.py)과 짝 — 이 경로만 유일한 생성 지점."""
    if new_status != "approved":
        return
    if gate.work_item_type not in _EVIDENCE_WORK_ITEM_TYPES:
        return
    if resolver_id is None:
        # approved 전이는 라우터에서 human-only 강제(agent API키 403)라 정상 경로엔 항상 있음 —
        # 없으면(내부 직호출 등 예외 경로) 귀속시킬 사람이 없으므로 evidence 생성 skip(무회귀).
        return
    session.add(Evidence(
        id=uuid.uuid4(),
        org_id=gate.org_id,
        work_item_id=gate.work_item_id,
        work_item_type=gate.work_item_type,
        type="gate_approval",
        ref=str(gate.id),
        source="gate",
        note=gate.resolution_note,
        created_by=resolver_id,
    ))
