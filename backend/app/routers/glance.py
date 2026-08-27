"""글랜스 '손이 필요한 것' 예외 스트림 BE (story db7eb049·E-GLANCE 2D).

현 프로젝트의 human-attention **실신호만** 반환한다 — gate_pending(인간 승인 대기)·blocked(의존 대기)·
merge_ready(리뷰/머지 대기)·needs_input·verify_fail·stalled(침묵의 정체, story #2250). 유나 spec
(glance-focus-legible-fe-spec-handoff ⓓ) 계약: 활동량/순위 0·감시 아니라 신뢰(주어=프로젝트/팀·예외만)·
실신호 없으면 정직 빈배열(FE "손 필요한 것 없음"). 6 신호 전부 project_id 직스코프(approval.
project_id·story.project_id 직결·조인은 title enrich만).

story #2250(⛔"침묵의 정체", doc `flow-board-blocked-taxonomy`) — 1~5(여기선 표시상 6종 중
gate_pending/blocked/merge_ready/needs_input/verify_fail)는 전부 "스스로를 선언"하는 막힘이다.
그 무엇도 아니면서 오랫동안 무변화인 항목은 화면에서 완전히 사라졌다(1~5만 그리면 "막힌 것
없음"이라 거짓말하게 됨) — 그 빈자리를 stalled가 메운다. 정의(오르테가군 확定, 페드루 GO
2026-08-27): `StoryActivity(activity_type=status_changed)` 최신 시각(㉠좁은 정의) 기준 48h+
무변화. 모집단은 backlog 제외 활성(in-review/in-progress/ready-for-dev만 — backlog은 "아직
시작 안 함"이지 "멈춰 섬"이 아니다, #2250 §6-1 실측) 중 위 5종에 이미 잡힌 story_id는 제외
(AC5 — 7번을 1~6과 섞지 않는다). ⛔BE는 이 신호를 자르지 않는다(top-N 없음, 전량 반환) —
"8~12건 표시"는 화면 설계(유나) 몫이지 신호의 정의가 아니다(페드루 판정 2026-08-27, #2250
재실측이 분포에 깨끗한 단층이 없음을 보여줌 — 자르면 그 잘림 자체가 새로운 침묵이 된다).

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
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_read_db
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

# story #2250 — stalled 모집단(backlog은 "아직 시작 안 함"이지 "멈춰 섬"이 아니라 별도 제외 —
# _OPEN_EXCLUDED_STATUSES와 다른 축이라 이름을 안 겹친다).
_STALLED_EXCLUDED_STATUSES = ("done", "backlog")

# ⛔⛔story #2250 AC3-1(유나 발견·규율, 2026-07-28) — "N은 한 번 정하면 고정한다":
# 8~12건이 뜨는 지점을 계속 "유지"하려고 이 값을 계속 올리면, 막힘이 늘어도 임계가 따라
# 올라가 화면은 늘 비슷한 건수만 보여주게 되고 그 순간 이 지표는 자기충족이 되어 "막힘을
# 감추는 손잡이"가 된다. 48h는 페드루 확定값(2026-08-27, #2250 재실측 — 모집단 123건 중
# 48h+ 81건·분포에 깨끗한 단층 없음을 근거로 「자르지 않고 전량 낸다」로 판정. 표시 단의
# top-N/집계 배지는 유나 몫). 이 값을 다시 재는 사유는 "건수가 많아져서"가 아니라 "작업
# 방식이 바뀌어서"여야 한다.
_STALLED_THRESHOLD_HOURS = 48


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


async def _batch_latest_status_changed_at(
    session: AsyncSession, org_id: uuid.UUID, story_ids: list[uuid.UUID],
) -> dict[uuid.UUID, datetime]:
    """story #2250 stalled 신호원 — `_batch_story_entered_in_review_at`과 동형이나 `new_value`
    필터가 없다(어느 상태로 전이했든 "가장 최근 상태 변화" 그 자체가 관심사 — ㉠좁은 정의,
    #2250 §"측정 준비" 오르테가군 확定). 행이 아예 없는 story는 반환 dict에서 빠진다 —
    "그 story는 언제 마지막으로 바뀌었는지 모른다"는 뜻이라 호출부가 별도로 None 취급한다
    (created_at 등으로 대체해 추측하지 않는다 — blocked 신호와 동일 "모르면 안 준다" 원칙)."""
    if not story_ids:
        return {}
    rows = (
        await session.execute(
            select(StoryActivity.story_id, func.max(StoryActivity.created_at))
            .where(
                StoryActivity.org_id == org_id,
                StoryActivity.story_id.in_(story_ids),
                StoryActivity.activity_type == "status_changed",
            )
            .group_by(StoryActivity.story_id)
        )
    ).all()
    return {story_id: latest for story_id, latest in rows}


class AttentionItem(BaseModel):
    # P0-04(doc trust-pipeline-be-design §6): AQ 5신호 계약(attention-queue-fe-spec-handoff §6).
    # scope_violation은 §7 확定②로 이번 스코프 미구현 — 항상 빈 신호(kind로 등장 안 함·정직한 미가용).
    # stalled(story #2250, 2026-08-27)는 6번째 신호 — 위 5종과 달리 "스스로를 선언"하지 않는
    # 무변화 항목이라 AC5(섞지 않는다)에 따라 kind로 명확히 구분해 낸다.
    kind: str  # "gate_pending" | "blocked" | "merge_ready" | "needs_input" | "verify_fail" | "stalled"
    story_id: uuid.UUID | None = None
    title: str | None = None
    ref: dict = Field(default_factory=dict)
    # story #2249: 「그 상태에 들어간 시각」(UTC·마지막 진입). 소스는 kind별로 다름(모듈 docstring
    # 참조) — 원천이 아예 없거나(edge case) 조회 실패 시 None(옵셔널·모르는 필드 무시가 기본).
    # stalled: 「마지막으로 무언가 바뀐 시각」(StoryActivity status_changed 최신) — 소비자가
    # `now - entered_state_at`으로 무변화 일수를 직접 계산한다(페드루 판정 2026-08-27 —
    # 별도 "일수" 필드를 새로 만들지 않는다, 기존 필드 재사용).
    entered_state_at: datetime | None = None
    # 오르테가군 리뷰(2026-07-28): "근사"가 화면에서 "정확"처럼 보이면 유나 설계(체류시간이
    # 위계를 만든다)의 정렬 신뢰가 무너진다 — 값과 함께 정밀도를 싣는다. "exact"|None만 존재
    # (entered_state_at이 None이면 이 필드도 None) — "approx"는 없다: 유계가 아닌 오차는 근사가
    # 아니라 «모름»이다(blocked가 그 사례 — 값 자체를 안 싣는다, 모듈 docstring 참조).
    entered_state_at_precision: str | None = None


class AttentionResponse(BaseModel):
    items: list[AttentionItem]
    # story #2250 AC6 — "0건일 때의 의미를 정한다: 정말 없음인가 못 세고 있음인가." stalled가
    # 0건이어도 이 필드가 항상 채워져 있으면 "계산이 실제로 돌았다"는 증거가 된다(계산 자체가
    # 실패했다면 이 응답을 만들 수 없었을 것이므로 — 이 필드는 항상 datetime.now(UTC), None을
    # 반환할 일이 없다. 다른 5종 신호와 달리 이 값이 필요한 이유: stalled만 "무신호=진짜 0건"과
    # "무신호=계산 자체가 안 도는 중"을 구분할 별도 근거가 없다).
    stalled_computed_at: datetime


@router.get("/attention", response_model=AttentionResponse)
async def glance_attention(
    project_id: uuid.UUID = Query(...),
    # story #2451(§6 Phase3 A1): 대시보드 집계·create→self-read 흐름 없음 → read replica.
    session: AsyncSession = Depends(get_read_db),
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
    # ⛔story #2232(2026-07-30, PO 판정 — 실측으로 "degraded로 접을 이유 없음" 확認 후 지금 굴림):
    # gate_type·evidence_status를 ref에 싣는다 — «있는데 안 나르던» 값. FE(derive-exception-
    # signals.ts:96)가 지금은 ref.approval_id만 다음 마디로 넘겨 이 값들이 죽었으나, 그건
    # FE 몫(미르코)이라 여기서는 BE 계약에만 싣는다.
    needs_input_rows = (
        await session.execute(
            select(
                Story.id, Story.title, Gate.status_entered_at, Gate.id,
                Gate.gate_type, Gate.evidence_status,
            )
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
    for story_id, title, entered_at, gate_id, gate_type, evidence_status in needs_input_rows:
        items.append(AttentionItem(
            kind="needs_input", story_id=story_id, title=title, entered_state_at=entered_at,
            ref={
                "gate_id": str(gate_id), "gate_type": gate_type, "evidence_status": evidence_status,
            },
            # 배포 前 생성된 기존 Gate 행은 status_entered_at이 아직 None일 수 있다(다음 전이
            # 때 채워짐) — 값 없을 땐 정밀도도 None(값과 정밀도는 항상 짝으로 움직인다).
            entered_state_at_precision=_PRECISION_EXACT if entered_at is not None else None,
        ))

    # ⑤ verify_fail = 프로젝트의 오픈 story 중 검증(merge gate) 실패(glance/hero의 기존
    # evidence_status=="blocked" 계약 재사용).
    #
    # 카디르 QA(PR#3349, 2026-08-22) — story #2893(§2 A1)부터 merge gate가 스토리당 여러 개일
    # 수 있다(PR마다 1행). 예전(gate-row 기준 select, dedup 없음)엔 같은 스토리가 blocked인
    # merge gate 수만큼 중복 노출됐고, LIMIT이 gate-row를 세다 보니 실제로는 서로 다른
    # 스토리인데 화면에 못 뜨는(밀리는) 사용자 도달 실갭이었다. Story.id/title로 GROUP BY해
    # ①중복 제거 ②LIMIT을 "스토리 수" 기준으로 되돌린다. entered_at은 MIN(가장 먼저
    # blocked에 들어간 시각) — 유나 설계(체류시간이 위계를 만든다)와 같은 축: 스토리가
    # blocked로 «가장 오래» 묶여 있던 시점을 보여줘야 밀린 순서가 거짓으로 짧아지지 않는다.
    # 나머지 3곳(trust_pipeline/merge_gate_metrics/goal 리포지토리)은 동일 갭이 있을 수 있으나
    # PR① 스코프 밖 후속으로 유지(PR① 본문 명기).
    verify_fail_rows = (
        await session.execute(
            select(Story.id, Story.title, func.min(Gate.evidence_status_entered_at))
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
            .group_by(Story.id, Story.title)
            .limit(_LIMIT)
        )
    ).all()
    for story_id, title, entered_at in verify_fail_rows:
        items.append(AttentionItem(
            kind="verify_fail", story_id=story_id, title=title, entered_state_at=entered_at,
            entered_state_at_precision=_PRECISION_EXACT if entered_at is not None else None,
        ))

    # scope_violation: §7 확定② — 이번 스코프 미구현. 쿼리 자체가 없음(정직한 미가용·항상 빈 신호).

    # ⑥ stalled = story #2250 "침묵의 정체" — 위 1~5(gate_pending/blocked/merge_ready/
    # needs_input/verify_fail) 중 무엇도 아니면서 오래 무변화인 항목. AC5(섞지 않는다)에 따라
    # 위에서 이미 만든 항목의 story_id는 후보에서 뺀다 — 같은 story가 stalled와 다른 kind로
    # 동시에 뜨면 "할 일 목록"이 "사정 나열"이 된다(유나 규칙, 모듈 docstring 참조).
    _already_signaled_ids = {item.story_id for item in items if item.story_id is not None}
    stalled_population_rows = (
        await session.execute(
            select(Story.id, Story.title)
            .where(
                Story.org_id == org_id,
                Story.project_id == project_id,
                Story.status.not_in(_STALLED_EXCLUDED_STATUSES),
                Story.deleted_at.is_(None),
            )
        )
    ).all()
    stalled_candidates = [
        (story_id, title) for story_id, title in stalled_population_rows
        if story_id not in _already_signaled_ids
    ]
    latest_changed_map = await _batch_latest_status_changed_at(
        session, org_id, [story_id for story_id, _ in stalled_candidates],
    )
    _now = datetime.now(timezone.utc)
    stalled_items: list[AttentionItem] = []
    for story_id, title in stalled_candidates:
        latest_changed = latest_changed_map.get(story_id)
        # 「모르면 안 준다」(blocked와 동일 원칙, 모듈 docstring 참조) — 이 story가 언제
        # 마지막으로 바뀌었는지 자체를 모르면(status_changed 행이 아예 없음) 48h+ 여부를
        # 판정할 근거가 없다 — created_at 등으로 대체 추측하지 않고 stalled 후보에서 뺀다.
        if latest_changed is None:
            continue
        if (_now - latest_changed).total_seconds() < _STALLED_THRESHOLD_HOURS * 3600:
            continue
        stalled_items.append(AttentionItem(
            kind="stalled", story_id=story_id, title=title,
            entered_state_at=latest_changed, entered_state_at_precision=_PRECISION_EXACT,
        ))
    # ⛔BE는 top-N으로 자르지 않는다(모듈 docstring·#2250 페드루 판정 2026-08-27) — 무변화
    # 내림차순(=entered_state_at 오름차순, 가장 오래 안 바뀐 것 먼저)으로 전량 정렬만 한다.
    stalled_items.sort(key=lambda item: item.entered_state_at)
    items.extend(stalled_items)

    return AttentionResponse(items=items, stalled_computed_at=_now)


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
    # story #2451(§6 Phase3 A1): 대시보드 집계·create→self-read 흐름 없음 → read replica.
    session: AsyncSession = Depends(get_read_db),
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
