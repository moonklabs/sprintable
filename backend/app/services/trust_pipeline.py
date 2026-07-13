"""Trust Pipeline 파생 오버레이 (P0-04 impl·design SSOT: doc `trust-pipeline-be-design`).

핵심 판정(doc §1): 신규 상태 컬럼 0. story.status(보조 뷰·완전 무변경) + Gate + Evidence +
ItemDependency에서 매 요청/훅 지점마다 파생한다 — E-VERIFY(has_evidence/human_verified)·
glance/attention·glance/hero와 동일한 기존 파생 패턴의 확장(이중 SSOT 금지).

오픈 질문 4건 확定(오르테가·선생님 GO 2026-07-13):
①needs_input = 기존 Gate(requires_human=True, status=pending) — 신규 gate_type 없이 시작.
②scope_violation = 이번 스코프 미구현·항상 빈 신호(정직한 미가용·후속 스토리 174be6bc 분리).
③신규 이벤트 = dot 표기(story.trust_stage_changed) — 기존 dot/underscore 혼재 정리는 별건(ab9de360).
④done = 파이프라인 뷰 스코프 밖(None).
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass, replace
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.models.dependency import ItemDependency
from app.models.gate import Gate
from app.models.pm import Story
from app.services.evidence_service import batch_human_verified

TRUST_STAGES = ("queued", "running", "needs_input", "claimed_done", "verified", "merge_ready")

_QUEUED_STATUSES = frozenset({"backlog", "ready-for-dev"})


@dataclass(frozen=True)
class TrustFacts:
    status: str
    project_id: uuid.UUID
    human_verified: bool
    has_pending_human_gate: bool  # needs_input 신호원(§7 확定①)
    has_verify_fail: bool  # verify_fail 신호원
    has_unresolved_blocker: bool  # blocked 신호원


def derive_trust_stage(facts: TrustFacts) -> str | None:
    """doc §2 표 그대로 — 6단계 파생. done/미지 status는 파이프라인 스코프 밖(None·§7 확定④)."""
    if facts.status in _QUEUED_STATUSES:
        return "queued"
    if facts.status == "in-progress":
        return "needs_input" if facts.has_pending_human_gate else "running"
    if facts.status == "in-review":
        if not facts.human_verified:
            return "claimed_done"
        if facts.has_unresolved_blocker or facts.has_verify_fail:
            return "verified"
        return "merge_ready"
    return None


def derive_exception_signals(facts: TrustFacts) -> dict[str, bool]:
    """doc §3·§6 — AQ 5신호(attention-queue-fe-spec-handoff §6 계약). scope_violation은 §7 확定②로
    이번 스코프 미구현·항상 False(정직한 미가용 — 실체화는 후속 스토리)."""
    return {
        "blocked": facts.has_unresolved_blocker,
        "verify_fail": facts.has_verify_fail,
        "needs_input": facts.has_pending_human_gate,
        "scope_violation": False,
        "merge_ready": derive_trust_stage(facts) == "merge_ready",
    }


async def batch_pending_human_gate(
    session: AsyncSession, org_id: uuid.UUID, story_ids: list[uuid.UUID]
) -> set[uuid.UUID]:
    """needs_input 신호원(§7 확定①) — Gate(requires_human, pending) 존재 story_id 집합(배치)."""
    if not story_ids:
        return set()
    result = await session.execute(
        select(Gate.work_item_id).where(
            Gate.org_id == org_id,
            Gate.work_item_type == "story",
            Gate.work_item_id.in_(story_ids),
            Gate.status == "pending",
            Gate.requires_human.is_(True),
        )
    )
    return set(result.scalars().all())


async def batch_verify_fail(
    session: AsyncSession, org_id: uuid.UUID, story_ids: list[uuid.UUID]
) -> set[uuid.UUID]:
    """verify_fail 신호원 — merge gate evidence_status=="blocked"(glance/hero의 기존
    auto_verify=="failed" 계약과 동일 소스 재사용 — FE derive-attention-queue.ts의
    neutral_facts.ci_result 클라이언트 휴리스틱보다 BE 기존 필드가 근본)."""
    if not story_ids:
        return set()
    result = await session.execute(
        select(Gate.work_item_id).where(
            Gate.org_id == org_id,
            Gate.work_item_type == "story",
            Gate.work_item_id.in_(story_ids),
            Gate.gate_type == "merge",
            Gate.evidence_status == "blocked",
        )
    )
    return set(result.scalars().all())


async def batch_unresolved_blocker(
    session: AsyncSession, org_id: uuid.UUID, story_ids: list[uuid.UUID]
) -> set[uuid.UUID]:
    """blocked 신호원 — glance.py 기존 blocked 판정과 동형(막는 쪽도 미완인 미해소 blocks-dep)."""
    if not story_ids:
        return set()
    blocker = aliased(Story)
    result = await session.execute(
        select(ItemDependency.to_id)
        .select_from(ItemDependency)
        .join(blocker, blocker.id == ItemDependency.from_id)
        .where(
            ItemDependency.org_id == org_id,
            ItemDependency.dep_type == "blocks",
            ItemDependency.item_type == "story",
            ItemDependency.to_id.in_(story_ids),
            blocker.status != "done",
            blocker.deleted_at.is_(None),
        )
    )
    return set(result.scalars().all())


async def compute_trust_facts(
    session: AsyncSession, org_id: uuid.UUID, story_id: uuid.UUID
) -> TrustFacts | None:
    """1개 story의 현재 trust facts를 실시간 파생(신규 쓰기 0 — 순수 조회). story 없으면 None."""
    row = (
        await session.execute(
            select(Story.status, Story.project_id).where(
                Story.id == story_id, Story.org_id == org_id, Story.deleted_at.is_(None)
            )
        )
    ).first()
    if row is None:
        return None
    status, project_id = row
    ids = [story_id]
    verified_map = await batch_human_verified(session, ids, "story")
    pending_gate_ids = await batch_pending_human_gate(session, org_id, ids)
    verify_fail_ids = await batch_verify_fail(session, org_id, ids)
    blocker_ids = await batch_unresolved_blocker(session, org_id, ids)
    return TrustFacts(
        status=status,
        project_id=project_id,
        human_verified=story_id in verified_map,
        has_pending_human_gate=story_id in pending_gate_ids,
        has_verify_fail=story_id in verify_fail_ids,
        has_unresolved_blocker=story_id in blocker_ids,
    )


async def _maybe_emit(
    session: AsyncSession,
    org_id: uuid.UUID,
    story_id: uuid.UUID,
    before: TrustFacts,
    after: TrustFacts,
    *,
    actor_id: uuid.UUID | None = None,
) -> None:
    old_stage = derive_trust_stage(before)
    new_stage = derive_trust_stage(after)
    old_signals = derive_exception_signals(before)
    new_signals = derive_exception_signals(after)
    if old_stage == new_stage and old_signals == new_signals:
        return  # 변경 없음 — 이벤트 폭주 방지(doc §4).
    from app.routers.events import publish_event  # lazy import — service→router 순환 회피.

    publish_event(str(org_id), "story.trust_stage_changed", {
        "story_id": str(story_id),
        "project_id": str(after.project_id),
        "org_id": str(org_id),
        "old_stage": old_stage,
        "new_stage": new_stage,
        "exception_signals": new_signals,
        "actor_id": str(actor_id) if actor_id else None,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    })


async def maybe_emit_trust_stage_changed(
    session: AsyncSession,
    org_id: uuid.UUID,
    story_id: uuid.UUID,
    before: TrustFacts,
    *,
    actor_id: uuid.UUID | None = None,
) -> None:
    """§4 훅①·② 공용 — gate 전이·dependency create/delete 후 호출. `before`는 호출자가 mutation **전**
    compute_trust_facts()로 떠 둔 스냅샷(호출자는 스냅샷이 None이면 애초에 이 함수를 안 부른다).

    story.status 자체가 같은 트랜잭션 중 바뀐 경우(예: merge-approve gate가 _advance_story_on_merge_
    approve로 story를 done까지 자동전진)는 skip — 그 경로는 emit_story_status_changed 내부의 훅③
    (emit_on_story_status_change)이 old_status 파라미터로 이미 정확히 처리했으므로, 여기서 또 잡으면
    같은 전이가 두 번 emit된다(이벤트 폭주 방지 — doc §4)."""
    after = await compute_trust_facts(session, org_id, story_id)
    if after is None or before.status != after.status:
        return
    await _maybe_emit(session, org_id, story_id, before, after, actor_id=actor_id)


async def emit_on_story_status_change(
    session: AsyncSession,
    org_id: uuid.UUID,
    story_id: uuid.UUID,
    old_status: str | None,
    *,
    actor_id: uuid.UUID | None = None,
) -> None:
    """§4 훅③ — story.status 변경 전용. old_status만 다르고 나머지 facts(gate/evidence/blocker)는
    이 호출 시점 현재값을 '이전' 값으로도 재사용해 근사(같은 트랜잭션 내 그 facts들의 변화는 훅①·②가
    별도로 커버하므로 이 훅 단독으론 status만 유효하게 다르다)."""
    if old_status is None:
        return
    after = await compute_trust_facts(session, org_id, story_id)
    if after is None:
        return
    before = replace(after, status=old_status)
    await _maybe_emit(session, org_id, story_id, before, after, actor_id=actor_id)
