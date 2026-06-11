"""E1-S2: Hypothesis service — CRUD·전이·링크 (블루프린트 §2.5·§2.7·§3.1).

권한 규칙(§3.1):
- owner_member_id는 반드시 type='human' resolved member(§3.1.4·§3.3.6 HUMAN_OWNER_REQUIRED).
- 휴먼 caller: owner 기본값 = 자기 resolved member id(§3.1.6).
- agent/API key caller: owner 명시 필수 + status는 'proposed'로 강제(§3.1.5·§3.3.5).
- 'active' 전이는 휴먼만(§2.5.2).
상태 전이는 모델의 is_valid_transition(§2.5)을 단일 출처로 쓴다. status/outcome_result
직접 수정은 update에서 금지 — transition endpoint 전용(§3.5.3).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.hypothesis import HYPOTHESIS_STATUSES, is_valid_transition
from app.repositories.hypothesis import HypothesisRepository
from app.schemas.hypothesis import (
    HypothesisCreate,
    HypothesisLinkRequest,
    HypothesisResponse,
    HypothesisTransition,
    HypothesisUnlinkRequest,
    HypothesisUpdate,
)
from app.services.member_resolver import ResolvedMember, lookup_members_by_ids

# 생성 시 허용 상태 — lifecycle 상태(measuring+)는 transition 전용.
_CREATE_STATUSES = ("proposed", "active")

# §2.7.10 legacy outcome_status → hypothesis status (조회/마이그레이션 전용). n_a → None.
_LEGACY_OUTCOME_TO_STATUS: dict[str, str] = {
    "pending": "active",
    "hit": "verified",
    "miss": "falsified",
}


class HypothesisServiceError(Exception):
    """도메인 오류 — 라우터(S3)가 code/message를 HTTPException dict-detail로 매핑한다."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def map_legacy_outcome_status(outcome_status: str | None) -> str | None:
    """§2.7.10 — legacy embedded outcome status를 hypothesis lifecycle 상태로 매핑.

    조회/마이그레이션에서만 사용. n_a(또는 미지정) → None(승격할 가설 없음).
    pending → active(실행 앵커 확정 상태로 진입), hit → verified, miss → falsified.
    """
    if outcome_status is None:
        return None
    return _LEGACY_OUTCOME_TO_STATUS.get(outcome_status)


async def _verify_human_owner(session: AsyncSession, owner_id: uuid.UUID) -> None:
    members = await lookup_members_by_ids({owner_id}, session)
    rm = members.get(owner_id)
    if rm is None or rm.type != "human":
        raise HypothesisServiceError(
            "HUMAN_OWNER_REQUIRED", "owner_member_id는 type='human' 멤버여야 합니다."
        )


async def _to_response(
    repo: HypothesisRepository, hyp
) -> HypothesisResponse:
    epic_ids = await repo.get_epic_ids(hyp.id)
    story_ids = await repo.get_story_ids(hyp.id)
    return HypothesisResponse.from_model(hyp, epic_ids, story_ids)


async def create_hypothesis(
    session: AsyncSession,
    org_id: uuid.UUID,
    caller: ResolvedMember,
    payload: HypothesisCreate,
) -> HypothesisResponse:
    # owner 결정 — 휴먼 caller는 self 기본, agent caller는 명시 필수.
    owner_id = payload.owner_member_id
    if owner_id is None:
        if caller.type != "human":
            raise HypothesisServiceError(
                "HUMAN_OWNER_REQUIRED", "agent caller는 휴먼 owner_member_id를 명시해야 합니다."
            )
        owner_id = caller.id
    await _verify_human_owner(session, owner_id)

    # 상태 — agent/API key는 proposed로 강제(에러 아님). 생성 허용 상태는 proposed|active.
    status = payload.status or "proposed"
    if caller.type != "human":
        status = "proposed"
    if status not in _CREATE_STATUSES:
        raise HypothesisServiceError(
            "INVALID_CREATE_STATUS", "생성 시 status는 proposed|active만 허용됩니다."
        )

    repo = HypothesisRepository(session, org_id)
    hyp = await repo.create(
        project_id=payload.project_id,
        owner_member_id=owner_id,
        created_by_member_id=caller.id,
        confirmed_by_member_id=caller.id if status == "active" else None,
        drafted_by_member_id=caller.id if caller.type == "agent" else None,
        statement=payload.statement,
        metric_definition=payload.metric_definition,
        measure_after=payload.measure_after,
        status=status,
        source_type=payload.source_type,
        source_id=payload.source_id,
        draft_metadata=payload.draft_metadata,
    )
    await repo.add_epic_links(hyp.id, payload.epic_ids, "primary")
    await repo.add_story_links(hyp.id, payload.story_ids, "supports")
    return await _to_response(repo, hyp)


async def get_hypothesis(
    session: AsyncSession, org_id: uuid.UUID, hypothesis_id: uuid.UUID
) -> HypothesisResponse:
    repo = HypothesisRepository(session, org_id)
    hyp = await repo.get(hypothesis_id)
    if hyp is None:
        raise HypothesisServiceError("HYPOTHESIS_NOT_FOUND", "가설을 찾을 수 없습니다.")
    return await _to_response(repo, hyp)


async def list_hypotheses(
    session: AsyncSession,
    org_id: uuid.UUID,
    project_id: uuid.UUID,
    *,
    status: str | None = None,
    owner_member_id: uuid.UUID | None = None,
    epic_id: uuid.UUID | None = None,
    story_id: uuid.UUID | None = None,
    limit: int = 100,
) -> list[HypothesisResponse]:
    repo = HypothesisRepository(session, org_id)
    rows = await repo.list_filtered(
        project_id=project_id,
        status=status,
        owner_member_id=owner_member_id,
        epic_id=epic_id,
        story_id=story_id,
        limit=limit,
    )
    ids = [r.id for r in rows]
    emap = await repo.get_epic_ids_map(ids)
    smap = await repo.get_story_ids_map(ids)
    return [HypothesisResponse.from_model(r, emap[r.id], smap[r.id]) for r in rows]


async def update_hypothesis(
    session: AsyncSession,
    org_id: uuid.UUID,
    caller: ResolvedMember,
    hypothesis_id: uuid.UUID,
    payload: HypothesisUpdate,
) -> HypothesisResponse:
    repo = HypothesisRepository(session, org_id)
    hyp = await repo.get(hypothesis_id)
    if hyp is None:
        raise HypothesisServiceError("HYPOTHESIS_NOT_FOUND", "가설을 찾을 수 없습니다.")

    fields = payload.model_dump(exclude_unset=True)
    if not fields:
        raise HypothesisServiceError("NO_VALID_FIELDS", "수정할 필드가 없습니다.")
    new_owner = fields.get("owner_member_id")
    if new_owner is not None:
        await _verify_human_owner(session, new_owner)

    updated = await repo.update(hypothesis_id, **fields)
    return await _to_response(repo, updated)


async def transition_hypothesis(
    session: AsyncSession,
    org_id: uuid.UUID,
    caller: ResolvedMember,
    hypothesis_id: uuid.UUID,
    payload: HypothesisTransition,
) -> HypothesisResponse:
    repo = HypothesisRepository(session, org_id)
    hyp = await repo.get(hypothesis_id)
    if hyp is None:
        raise HypothesisServiceError("HYPOTHESIS_NOT_FOUND", "가설을 찾을 수 없습니다.")

    target = payload.status
    if target not in HYPOTHESIS_STATUSES:
        raise HypothesisServiceError("INVALID_STATUS", f"알 수 없는 상태: {target}")
    if not is_valid_transition(hyp.status, target):
        raise HypothesisServiceError(
            "INVALID_HYPOTHESIS_TRANSITION", f"불법 전이: {hyp.status} → {target}"
        )
    # 'active' 확정은 휴먼만(§2.5.2). org admin/owner 검증은 라우터(S3)에서 보강.
    if target == "active" and caller.type != "human":
        raise HypothesisServiceError(
            "HUMAN_CONFIRM_REQUIRED", "active 전이는 휴먼만 가능합니다."
        )

    updates: dict = {"status": target}
    if target == "active":
        updates["confirmed_by_member_id"] = caller.id
    if target in ("verified", "falsified") and payload.outcome_result is not None:
        updates["outcome_result"] = payload.outcome_result
    if target == "killed" and payload.note:
        updates["outcome_result"] = {**(hyp.outcome_result or {}), "reason": payload.note}
    if target == "archived":
        updates["archived_at"] = datetime.now(timezone.utc)

    updated = await repo.update(hypothesis_id, **updates)
    return await _to_response(repo, updated)


async def link_hypothesis(
    session: AsyncSession,
    org_id: uuid.UUID,
    hypothesis_id: uuid.UUID,
    payload: HypothesisLinkRequest,
) -> HypothesisResponse:
    repo = HypothesisRepository(session, org_id)
    hyp = await repo.get(hypothesis_id)
    if hyp is None:
        raise HypothesisServiceError("HYPOTHESIS_NOT_FOUND", "가설을 찾을 수 없습니다.")
    # cross-project 링크 금지(§3.7.2)는 대상 epic/story 조회가 필요 — 라우터(S3)에서 보강.
    await repo.add_epic_links(hypothesis_id, payload.epic_ids, payload.link_type or "primary")
    await repo.add_story_links(hypothesis_id, payload.story_ids, payload.link_type or "supports")
    return await _to_response(repo, hyp)


async def unlink_hypothesis(
    session: AsyncSession,
    org_id: uuid.UUID,
    hypothesis_id: uuid.UUID,
    payload: HypothesisUnlinkRequest,
) -> HypothesisResponse:
    repo = HypothesisRepository(session, org_id)
    hyp = await repo.get(hypothesis_id)
    if hyp is None:
        raise HypothesisServiceError("HYPOTHESIS_NOT_FOUND", "가설을 찾을 수 없습니다.")
    await repo.remove_epic_links(hypothesis_id, payload.epic_ids)
    await repo.remove_story_links(hypothesis_id, payload.story_ids)
    return await _to_response(repo, hyp)


async def archive_hypothesis(
    session: AsyncSession, org_id: uuid.UUID, hypothesis_id: uuid.UUID
) -> None:
    """§3.10 — hard delete가 아니라 archive(status='archived'·archived_at=now)."""
    repo = HypothesisRepository(session, org_id)
    hyp = await repo.get(hypothesis_id)
    if hyp is None:
        raise HypothesisServiceError("HYPOTHESIS_NOT_FOUND", "가설을 찾을 수 없습니다.")
    await repo.update(
        hypothesis_id, status="archived", archived_at=datetime.now(timezone.utc)
    )
