"""글랜스 '손이 필요한 것' 예외 스트림 BE (story db7eb049·E-GLANCE 2D).

현 프로젝트의 human-attention **실신호만** 반환한다 — gate_pending(인간 승인 대기)·blocked(의존 대기)·
merge_ready(리뷰/머지 대기)·needs_input·verify_fail. 유나 spec(glance-focus-legible-fe-spec-handoff
ⓓ) 계약: 활동량/순위 0·감시 아니라 신뢰(주어=프로젝트/팀·예외만)·실신호 없으면 정직 빈배열(FE
"손 필요한 것 없음"). 5 신호 전부 project_id 직스코프(approval.project_id·story.project_id 직결·
조인은 title enrich만).

story #2249: 「그 상태에 들어간 시각」(entered_state_at) — kind별 소스가 다르다(전수):
  gate_pending → WorkflowLineStepApproval.created_at(row가 매 사이클 새 INSERT라 정확) — exact
  blocked      → 항상 None(아래 참조 — "모름"이지 근사 아님)
  merge_ready  → StoryActivity(status_changed→in-review) 최신 행 — exact(값이 있으면 정확·
                 actor_id 없는 시스템 트리거 시엔 아예 None으로 빠짐. "값의 정밀도"가 아니라
                 "값의 유무" 문제라 approx로 분류하지 않는다 — None 자체가 이미 그 신호다)
  needs_input  → Gate.status_entered_at(신규 컬럼 — updated_at 대체 불가 실측 후 신설, #2249 AC1) — exact
  verify_fail  → Gate.evidence_status_entered_at(위와 동일 사유, status와 별개 축) — exact

⛔blocked는 값을 안 싣는다(오르테가군 리뷰 2026-07-28, 처방 정정 — 최초엔 approx로 실었으나
철회): `ItemDependency.created_at`을 후보로 검토했으나, 막는 쪽 story가 done→(나중에)재오픈되면
실제 "다시 막힌" 시각은 재오픈 시점인데 dependency row는 원래 생성 시각을 그대로 들고 있어
**오차가 유계 지터가 아니라 재오픈까지의 간격만큼(수 시간~수 개월) 임의로 커질 수 있다.**
**유계가 아닌 오차는 근사가 아니다** — "approx" 라벨을 붙이면 어림값이 아니라 라벨 붙인
거짓이 되고, 항상 "더 오래 막힌 것처럼" 과대추정하는 방향이라 유나 설계(체류시간이 위계를
만든다)의 정렬이 거짓으로 서며 #2250의 48h+ 임계에 구조적 false positive를 넣는다.
「모르면 안 준다」— 근본(재진입 시각을 기록하는 것 자체가 없음)은 #2256(「막힘에 재진입한
시각이 기록되지 않는다」)으로 분리한다(그게 있어야 blocked도 exact로 설 수 있다. 지금은
재료가 없어 못 하는 것이 맞는 판단).

정밀도는 `entered_state_at_precision`("exact"|None, 값과 항상 짝)으로 값과 함께 실어 FE가
구분 가능하게 한다(어떻게 다룰지는 FE/디자인 판단 — BE는 구분 가능하게 싣기만 한다).
시맨틱(AC4): 전부 UTC·"마지막으로 이 상태가 된 시각"(재진입 시 갱신, 최초 진입 아님). 둘 다
옵셔널 필드(모르는 필드 무시가 기본 — 회귀 0).
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
from app.models.gate import AUTO_VERIFY_MAP as _GATE_AUTO_VERIFY_MAP
from app.models.gate import Gate
from app.models.member import Member
from app.models.pm import Story, StoryActivity
from app.models.workflow_line import WorkflowLineStepApproval
from app.services.evidence_service import batch_human_verified
from app.services.project_auth import has_project_access
from app.services.trust_pipeline import batch_unresolved_blocker, batch_verify_fail

router = APIRouter(prefix="/api/v2/glance", tags=["glance", "Work"])

# blocked/merge_ready 판정의 "아직 open" = non-done(command_center 규율 재사용).
_OPEN_EXCLUDED_STATUSES = ("done",)
_LIMIT = 100

# story #2249(오르테가군 리뷰): entered_state_at의 정밀도 — 모듈 docstring 참조.
_PRECISION_EXACT = "exact"


async def _batch_story_entered_in_review_at(
    session: AsyncSession, org_id: uuid.UUID, story_ids: list[uuid.UUID],
) -> dict[uuid.UUID, datetime]:
    """merge_ready 신호원 — Story가 **마지막으로** in-review로 전이한 시각(StoryActivity 감사
    로그 최신 행, #2249). best-effort — story_status_events.emit_story_status_changed가
    actor_id 없으면 행을 안 남긴다(시스템 트리거 시 유실 가능, 알려진 한계)."""
    if not story_ids:
        return {}
    rows = (
        await session.execute(
            select(StoryActivity.story_id, func.max(StoryActivity.created_at))
            .where(
                StoryActivity.org_id == org_id,
                StoryActivity.story_id.in_(story_ids),
                StoryActivity.activity_type == "status_changed",
                StoryActivity.new_value == "in-review",
            )
            .group_by(StoryActivity.story_id)
        )
    ).all()
    return {story_id: entered_at for story_id, entered_at in rows}


class AttentionItem(BaseModel):
    # P0-04(doc trust-pipeline-be-design §6): AQ 5신호 계약(attention-queue-fe-spec-handoff §6).
    # scope_violation은 §7 확定②로 이번 스코프 미구현 — 항상 빈 신호(kind로 등장 안 함·정직한 미가용).
    kind: str  # "gate_pending" | "blocked" | "merge_ready" | "needs_input" | "verify_fail"
    story_id: uuid.UUID | None = None
    title: str | None = None
    ref: dict = Field(default_factory=dict)
    # story #2249: 「그 상태에 들어간 시각」(UTC·마지막 진입). 소스는 kind별로 다름(모듈 docstring
    # 참조) — 원천이 아예 없거나(edge case) 조회 실패 시 None(옵셔널·모르는 필드 무시가 기본).
    entered_state_at: datetime | None = None
    # 오르테가군 리뷰(2026-07-28): "근사"가 화면에서 "정확"처럼 보이면 유나 설계(체류시간이
    # 위계를 만든다)의 정렬 신뢰가 무너진다 — 값과 함께 정밀도를 싣는다. "exact"|None만 존재
    # (entered_state_at이 None이면 이 필드도 None) — "approx"는 없다: 유계가 아닌 오차는 근사가
    # 아니라 «모름»이다(blocked가 그 사례 — 값 자체를 안 싣는다, 모듈 docstring 참조).
    entered_state_at_precision: str | None = None


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
                WorkflowLineStepApproval.created_at,
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
    for approval_id, gate_id, story_id, title, entered_at in gate_rows:
        items.append(AttentionItem(
            kind="gate_pending",
            story_id=story_id,
            title=title,
            ref={"approval_id": str(approval_id), "gate_id": str(gate_id) if gate_id else None},
            entered_state_at=entered_at,
            entered_state_at_precision=_PRECISION_EXACT,
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
            # ⛔값을 안 싣는다 — ItemDependency.created_at은 유계가 아닌 오차(재오픈 edge case
            # 시 수 시간~수 개월)를 낼 수 있어 "근사"가 아니라 "모름"이다(모듈 docstring 참조).
            # 재진입 시각을 기록하는 근본 수정 전까지 None으로 정직하게 비운다.
            entered_state_at=None,
            entered_state_at_precision=None,
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
    entered_in_review_map = await _batch_story_entered_in_review_at(session, org_id, review_ids)
    for story_id, title in review_rows:
        if story_id in verified_map and story_id not in verify_fail_ids and story_id not in blocked_ids:
            _entered_at = entered_in_review_map.get(story_id)
            items.append(AttentionItem(
                kind="merge_ready", story_id=story_id, title=title,
                entered_state_at=_entered_at,
                entered_state_at_precision=_PRECISION_EXACT if _entered_at is not None else None,
            ))

    # ④ needs_input = 프로젝트의 오픈 story 중 사람 판단 대기(§7 확定① — Gate(requires_human, pending)).
    needs_input_rows = (
        await session.execute(
            select(Story.id, Story.title, Gate.status_entered_at)
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
    for story_id, title, entered_at in needs_input_rows:
        items.append(AttentionItem(
            kind="needs_input", story_id=story_id, title=title, entered_state_at=entered_at,
            # 배포 前 생성된 기존 Gate 행은 status_entered_at이 아직 None일 수 있다(다음 전이
            # 때 채워짐) — 값 없을 땐 정밀도도 None(값과 정밀도는 항상 짝으로 움직인다).
            entered_state_at_precision=_PRECISION_EXACT if entered_at is not None else None,
        ))

    # ⑤ verify_fail = 프로젝트의 오픈 story 중 검증(merge gate) 실패(glance/hero의 기존
    # evidence_status=="blocked" 계약 재사용).
    verify_fail_rows = (
        await session.execute(
            select(Story.id, Story.title, Gate.evidence_status_entered_at)
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
    for story_id, title, entered_at in verify_fail_rows:
        items.append(AttentionItem(
            kind="verify_fail", story_id=story_id, title=title, entered_state_at=entered_at,
            entered_state_at_precision=_PRECISION_EXACT if entered_at is not None else None,
        ))

    # scope_violation: §7 확定② — 이번 스코프 미구현. 쿼리 자체가 없음(정직한 미가용·항상 빈 신호).

    return AttentionResponse(items=items)


# ── hero ProofCapsule envelope (story b464daa1·E-GLANCE 2D) ─────────────────────
# 현재 에픽 활성 story의 Proof Capsule 소비 계약. no-fiction(계약 doc glance-hero-proofcapsule
# -be-contract): 정직 소스만 — claim·status·proof_count·auto_verify(merge gate)·gate 구조필드·
# trustSeal(self_reported/human_verified·E-VERIFY V0-S2·스푸핑불가). ⛔미포함(발명 금지):
# ac_met/ac_total(acceptance_criteria=freeform Text)·risk(플랫폼 위험도판정 안 함)·diff(미저장).
# PO判定(2026-07-12): BE는 구조화 필드만·표시문자열/라벨 금지(i18n=FE lane)·라벨 합성은 FE가
# decision_basis/auto_decision_reason verbatim으로.
# story #2303: 이 매핑의 단일 소유자는 app/models/gate.py(AUTO_VERIFY_MAP)로 옮겼다 —
# app/repositories/goal.py(`?include=glance`의 focal_story.auto_verify)도 같은 매핑이
# 필요해져, 라우터 전용 상수를 두 곳에 각자 두면 twin-system 갭이 된다.
_AUTO_VERIFY_MAP = _GATE_AUTO_VERIFY_MAP


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
