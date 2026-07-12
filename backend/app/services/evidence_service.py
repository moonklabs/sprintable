"""E-VERIFY V0-S2(story 3fbd048d): evidence-backed 신호 + gate_approval 자동 편입."""
import logging
import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.evidence import Evidence
from app.models.gate import Gate

logger = logging.getLogger(__name__)

_EVIDENCE_WORK_ITEM_TYPES = frozenset({"story", "task"})


async def batch_has_evidence(
    session: AsyncSession, work_item_ids: list[uuid.UUID], work_item_type: str
) -> set[uuid.UUID]:
    """evidence가 1건이라도 있는 work_item_id 집합(N+1 회피 배치 조회) — story/task 응답의
    self_reported(구 has_evidence, positive 단방향) 신호원. gate_approval 타입도 포함(휴먼
    서명도 그 자체로 evidence 존재 사실이므로 self_reported의 상위집합 — human_verified가
    true면 self_reported도 항상 true)."""
    if not work_item_ids:
        return set()
    result = await session.execute(
        select(Evidence.work_item_id.distinct()).where(
            Evidence.work_item_type == work_item_type,
            Evidence.work_item_id.in_(work_item_ids),
        )
    )
    return set(result.scalars().all())


async def batch_human_verified(
    session: AsyncSession, work_item_ids: list[uuid.UUID], work_item_type: str
) -> dict[uuid.UUID, Evidence]:
    """Claimed vs Verified(doc claimed-vs-verified-spec-handoff §3): human_verified 신호원 —
    gate_approval 타입 evidence(휴먼 책임자 gate 승인 시에만 시스템이 생성·스푸핑 불가,
    create_gate_approval_evidence_if_applicable 참고)만 필터링해 work_item_id별 **최신 1건**
    반환. "같은 증거, 다른 주어"(§1.5) — self_reported/human_verified가 같은 evidence 테이블을
    공유하되 type=gate_approval만 인간 서명으로 승격. created_by=who(member_id)·
    created_at=when — 검토자 서명."""
    if not work_item_ids:
        return {}
    result = await session.execute(
        select(Evidence).where(
            Evidence.work_item_type == work_item_type,
            Evidence.work_item_id.in_(work_item_ids),
            Evidence.type == "gate_approval",
        ).order_by(Evidence.created_at.desc())
    )
    latest: dict[uuid.UUID, Evidence] = {}
    for ev in result.scalars().all():
        if ev.work_item_id not in latest:
            latest[ev.work_item_id] = ev
    return latest


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
    # E-SECURITY e1063967 (human_verified SOUL-LOCK choke-point 가드): gate_approval evidence는
    # human_verified 신호의 유일 신호원(batch_human_verified가 type=gate_approval만 인간 서명으로
    # 승격)이라, resolver가 실제 휴먼일 때만 생성한다. approved 전이의 human-only 강제가 현재는
    # gates.py 라우터에만 있고(agent API키 403) 이 심층함수는 그 강제를 신뢰만 했다 — 그 경로는
    # 지금은 dead code지만 parallel-approval 등 새 라우터가 배선되는 순간 에이전트가 인간 검증
    # 신호를 위조할 수 있다. 신뢰 대신 choke-point에서 선착 검증(트리거 게이트): resolver를 org
    # 범위에서 신원해소해 휴먼이 아니거나(에이전트) 해소 불가면 fail-closed로 evidence 생성 skip.
    # (gate 전이 자체는 무영향 — 여기선 SOUL-LOCK 신호만 게이팅. 정상 휴먼 resolver는 항상 통과.)
    from app.services.member_resolver import resolve_member_identity

    resolver = await resolve_member_identity(resolver_id, gate.org_id, session)
    if resolver is None or resolver.type != "human":
        logger.warning(
            "gate_approval evidence skipped — resolver %s is not a verified human "
            "(gate=%s, work_item=%s, resolved_type=%s). SOUL-LOCK: human_verified 신호는 휴먼만 생성.",
            resolver_id, gate.id, gate.work_item_id, resolver.type if resolver else "unresolved",
        )
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
