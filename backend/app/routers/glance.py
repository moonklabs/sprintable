"""글랜스 '손이 필요한 것' 예외 스트림 BE (story db7eb049·E-GLANCE 2D).

현 프로젝트의 human-attention **실신호만** 반환한다 — gate_pending(인간 승인 대기)·blocked(의존 대기)·
merge_ready(리뷰/머지 대기). 유나 spec(glance-focus-legible-fe-spec-handoff ⓓ) 계약: 활동량/타임스탬프/
순위 0·감시 아니라 신뢰(주어=프로젝트/팀·예외만)·실신호 없으면 정직 빈배열(FE "손 필요한 것 없음").
3 신호 전부 project_id 직스코프(approval.project_id·story.project_id 직결·조인은 title enrich만).
"""
import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db
from app.models.dependency import ItemDependency
from app.models.evidence import Evidence
from app.models.gate import Gate
from app.models.member import Member
from app.models.pm import Story
from app.models.workflow_line import WorkflowLineStepApproval
from app.services.evidence_service import batch_human_verified
from app.services.project_auth import has_project_access
from app.services.trust_pipeline import batch_unresolved_blocker, batch_verify_fail

router = APIRouter(prefix="/api/v2/glance", tags=["glance"])

# blocked/merge_ready 판정의 "아직 open" = non-done(command_center 규율 재사용).
_OPEN_EXCLUDED_STATUSES = ("done",)
_LIMIT = 100


class AttentionItem(BaseModel):
    # P0-04(doc trust-pipeline-be-design §6): AQ 5신호 계약(attention-queue-fe-spec-handoff §6).
    # scope_violation은 §7 확定②로 이번 스코프 미구현 — 항상 빈 신호(kind로 등장 안 함·정직한 미가용).
    kind: str  # "gate_pending" | "blocked" | "merge_ready" | "needs_input" | "verify_fail"
    story_id: uuid.UUID | None = None
    title: str | None = None
    ref: dict = Field(default_factory=dict)


class AttentionResponse(BaseModel):
    items: list[AttentionItem]


@router.get("/attention", response_model=AttentionResponse)
async def glance_attention(
    project_id: uuid.UUID = Query(...),
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> AttentionResponse:
    """현 프로젝트 예외 스트림. project-scope 실신호만·활동량/순위 0·없으면 빈배열."""
    # project-scope 가드(resource-actual): 접근권 없는 project의 예외 신호 노출 차단(404·존재 비노출).
    if not await has_project_access(session, uuid.UUID(auth.user_id), project_id, org_id):
        raise HTTPException(status_code=404, detail="Project not found")

    items: list[AttentionItem] = []

    # ① gate_pending = 프로젝트의 pending blocking approval(그 gate의 story title enrich).
    gate_story = aliased(Story)
    gate_rows = (
        await session.execute(
            select(
                WorkflowLineStepApproval.id,
                WorkflowLineStepApproval.gate_id,
                gate_story.id,
                gate_story.title,
            )
            .select_from(WorkflowLineStepApproval)
            .outerjoin(Gate, Gate.id == WorkflowLineStepApproval.gate_id)
            .outerjoin(
                gate_story,
                (gate_story.id == Gate.work_item_id) & (Gate.work_item_type == "story"),
            )
            .where(
                WorkflowLineStepApproval.org_id == org_id,
                WorkflowLineStepApproval.project_id == project_id,
                WorkflowLineStepApproval.status == "pending",
                WorkflowLineStepApproval.blocking.is_(True),
            )
            .limit(_LIMIT)
        )
    ).all()
    for approval_id, gate_id, story_id, title in gate_rows:
        items.append(AttentionItem(
            kind="gate_pending",
            story_id=story_id,
            title=title,
            ref={"approval_id": str(approval_id), "gate_id": str(gate_id) if gate_id else None},
        ))

    # ② blocked = 프로젝트의 open story를 막고 있는 미해소 blocks-dependency(막는 쪽도 미완).
    blocker = aliased(Story)
    blocked = aliased(Story)
    blocked_rows = (
        await session.execute(
            select(blocked.id, blocked.title, blocker.id)
            .select_from(ItemDependency)
            .join(blocker, blocker.id == ItemDependency.from_id)
            .join(blocked, blocked.id == ItemDependency.to_id)
            .where(
                ItemDependency.org_id == org_id,
                ItemDependency.dep_type == "blocks",
                ItemDependency.item_type == "story",
                blocked.project_id == project_id,
                blocked.status.not_in(_OPEN_EXCLUDED_STATUSES),
                blocked.deleted_at.is_(None),
                blocker.status.not_in(_OPEN_EXCLUDED_STATUSES),
                blocker.deleted_at.is_(None),
            )
            .limit(_LIMIT)
        )
    ).all()
    for blocked_id, title, blocker_id in blocked_rows:
        items.append(AttentionItem(
            kind="blocked",
            story_id=blocked_id,
            title=title,
            ref={"blocker_story_id": str(blocker_id)},
        ))

    # ③ merge_ready = 프로젝트의 in-review story 중 **실제 병합 가능**(P0-04 엄격화 — doc
    # trust-pipeline-be-design §2/§3: human_verified + 미해결 blocker 없음 + verify_fail 없음.
    # 기존 완화판(status==in-review만)보다 좁아짐 — 회귀 아닌 의도된 강화(doc §8)).
    review_rows = (
        await session.execute(
            select(Story.id, Story.title)
            .where(
                Story.org_id == org_id,
                Story.project_id == project_id,
                Story.status == "in-review",
                Story.deleted_at.is_(None),
            )
            .limit(_LIMIT)
        )
    ).all()
    review_ids = [r[0] for r in review_rows]
    verified_map = await batch_human_verified(session, review_ids, "story")
    verify_fail_ids = await batch_verify_fail(session, org_id, review_ids)
    blocked_ids = await batch_unresolved_blocker(session, org_id, review_ids)
    for story_id, title in review_rows:
        if story_id in verified_map and story_id not in verify_fail_ids and story_id not in blocked_ids:
            items.append(AttentionItem(kind="merge_ready", story_id=story_id, title=title))

    # ④ needs_input = 프로젝트의 오픈 story 중 사람 판단 대기(§7 확定① — Gate(requires_human, pending)).
    needs_input_rows = (
        await session.execute(
            select(Story.id, Story.title)
            .select_from(Gate)
            .join(Story, (Story.id == Gate.work_item_id) & (Gate.work_item_type == "story"))
            .where(
                Gate.org_id == org_id,
                Gate.status == "pending",
                Gate.requires_human.is_(True),
                Story.project_id == project_id,
                Story.status.not_in(_OPEN_EXCLUDED_STATUSES),
                Story.deleted_at.is_(None),
            )
            .limit(_LIMIT)
        )
    ).all()
    for story_id, title in needs_input_rows:
        items.append(AttentionItem(kind="needs_input", story_id=story_id, title=title))

    # ⑤ verify_fail = 프로젝트의 오픈 story 중 검증(merge gate) 실패(glance/hero의 기존
    # evidence_status=="blocked" 계약 재사용).
    verify_fail_rows = (
        await session.execute(
            select(Story.id, Story.title)
            .select_from(Gate)
            .join(Story, (Story.id == Gate.work_item_id) & (Gate.work_item_type == "story"))
            .where(
                Gate.org_id == org_id,
                Gate.gate_type == "merge",
                Gate.evidence_status == "blocked",
                Story.project_id == project_id,
                Story.status.not_in(_OPEN_EXCLUDED_STATUSES),
                Story.deleted_at.is_(None),
            )
            .limit(_LIMIT)
        )
    ).all()
    for story_id, title in verify_fail_rows:
        items.append(AttentionItem(kind="verify_fail", story_id=story_id, title=title))

    # scope_violation: §7 확定② — 이번 스코프 미구현. 쿼리 자체가 없음(정직한 미가용·항상 빈 신호).

    return AttentionResponse(items=items)


# ── hero ProofCapsule envelope (story b464daa1·E-GLANCE 2D) ─────────────────────
# 현재 에픽 활성 story의 Proof Capsule 소비 계약. no-fiction(계약 doc glance-hero-proofcapsule
# -be-contract): 정직 소스만 — claim·status·proof_count·auto_verify(merge gate)·gate 구조필드·
# trustSeal(self_reported/human_verified·E-VERIFY V0-S2·스푸핑불가). ⛔미포함(발명 금지):
# ac_met/ac_total(acceptance_criteria=freeform Text)·risk(플랫폼 위험도판정 안 함)·diff(미저장).
# PO判定(2026-07-12): BE는 구조화 필드만·표시문자열/라벨 금지(i18n=FE lane)·라벨 합성은 FE가
# decision_basis/auto_decision_reason verbatim으로.
_AUTO_VERIFY_MAP = {"sufficient": "passed", "blocked": "failed"}


class HeroMember(BaseModel):
    member_id: uuid.UUID
    name: str
    role: str | None = None


class HeroTrust(BaseModel):
    self_reported: bool
    human_verified: bool
    human_verified_by: HeroMember | None = None
    human_verified_at: datetime | None = None


class HeroGate(BaseModel):
    status: str
    gate_type: str
    requires_human: bool
    decision_basis: str | None = None  # verbatim(FE가 라벨 합성)
    auto_decision_reason: str | None = None  # verbatim


class HeroResponse(BaseModel):
    story_id: uuid.UUID
    claim: str
    status: str
    proof_count: int
    auto_verify: str | None = None  # "passed" | "failed" | null
    gate: HeroGate | None = None
    trust: HeroTrust


@router.get("/hero", response_model=HeroResponse)
async def glance_hero(
    story_id: uuid.UUID = Query(...),
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
) -> HeroResponse:
    """현재 에픽 활성 story의 Proof Capsule 소비 payload. project-scope 가드·no-fiction 구조필드만."""
    story = (
        await session.execute(
            select(Story).where(
                Story.id == story_id, Story.org_id == org_id, Story.deleted_at.is_(None)
            )
        )
    ).scalar_one_or_none()
    # resolved-resource project-scope 가드(404·존재 비노출·스캐너 PROJECT_PARAM 감시축).
    if story is None or not await has_project_access(
        session, uuid.UUID(auth.user_id), story.project_id, org_id
    ):
        raise HTTPException(status_code=404, detail="Story not found")

    # proof_count = evidence row 개수 → self_reported.
    proof_count = (
        await session.execute(
            select(func.count(Evidence.id)).where(
                Evidence.org_id == org_id,
                Evidence.work_item_id == story_id,
                Evidence.work_item_type == "story",
            )
        )
    ).scalar_one()

    # human_verified = 최신 gate_approval evidence(휴먼 서명·스푸핑불가). by/at + member name/role.
    hv = (
        await session.execute(
            select(Evidence.created_by, Evidence.created_at)
            .where(
                Evidence.org_id == org_id,
                Evidence.work_item_id == story_id,
                Evidence.work_item_type == "story",
                Evidence.type == "gate_approval",
            )
            .order_by(Evidence.created_at.desc())
            .limit(1)
        )
    ).first()
    hv_member: HeroMember | None = None
    hv_at: datetime | None = None
    if hv is not None:
        hv_by, hv_at = hv
        m = (
            await session.execute(
                select(Member.name, Member.org_role).where(Member.id == hv_by)
            )
        ).first()
        hv_member = HeroMember(member_id=hv_by, name=m[0] if m else "", role=m[1] if m else None)

    trust = HeroTrust(
        self_reported=proof_count > 0,
        human_verified=hv is not None,
        human_verified_by=hv_member,
        human_verified_at=hv_at,
    )

    # auto_verify = story의 merge gate evidence_status(없으면 null·대부분 story).
    merge_status = (
        await session.execute(
            select(Gate.evidence_status)
            .where(
                Gate.org_id == org_id,
                Gate.work_item_id == story_id,
                Gate.work_item_type == "story",
                Gate.gate_type == "merge",
            )
            .order_by(Gate.created_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    auto_verify = _AUTO_VERIFY_MAP.get(merge_status) if merge_status else None

    # gate = story의 현재 pending gate(결정점) 구조필드·없으면 null.
    gate_row = (
        await session.execute(
            select(Gate)
            .where(
                Gate.org_id == org_id,
                Gate.work_item_id == story_id,
                Gate.work_item_type == "story",
                Gate.status == "pending",
            )
            .order_by(Gate.created_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    gate = (
        HeroGate(
            status=gate_row.status,
            gate_type=gate_row.gate_type,
            requires_human=gate_row.requires_human,
            decision_basis=gate_row.decision_basis,
            auto_decision_reason=gate_row.auto_decision_reason,
        )
        if gate_row is not None
        else None
    )

    return HeroResponse(
        story_id=story_id,
        claim=story.title,
        status=story.status,
        proof_count=proof_count,
        auto_verify=auto_verify,
        gate=gate,
        trust=trust,
    )
