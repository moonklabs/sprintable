"""E-MODERN Track C: 커맨드 센터 BE — CC-BE.1 + CC-BE.2 (집계 2 엔드포인트).

운영자 대시보드의 cross-cut 집계. **2 엔드포인트**(FE N+1 차단):
- `GET /api/v2/command-center/my-actions` — ⭐**혼합 scope**: `action_queue`(=caller **member-private**·타 멤버 큐 노출 0)
  + `attention`(=**org-scope** 자동 이상감지). 두 섹션 scope label·배열 분리(산티아고 lock).
- `GET /api/v2/command-center/overview` — **org/team** scope: 헤더 함대 + 프로젝트 현황.

**mock-0 금지선**: 미구현은 `{"status": "pending_data"}`·실데이터 없으면 empty(가짜 수치 0).
**민감 정보 비노출**(산티아고): 이상감지·blocker 는 enum/ids/age 만(raw error/log/blocker text 0). 비용·기여는
org **aggregate only**(개인별 비용/blame/랭킹 노출 0).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from sqlalchemy import exists, func, select
from sqlalchemy.orm import aliased
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext, get_current_user, get_verified_org_id
from app.dependencies.database import get_db, get_read_db
from app.models.activity_event import ActivityEvent
from app.models.agent_run import AgentRun
from app.models.dependency import ItemDependency
from app.models.hypothesis import Hypothesis
from app.models.member import AgentProjectProfile, Member
from app.models.pm import Goal, Story, StoryActivity, Task
from app.models.workflow_line import WorkflowLineStepApproval, WorkflowLineStepRun
from app.services.member_resolver import resolve_member

router = APIRouter(prefix="/api/v2/command-center", tags=["command-center", "Work"])

# 자동 이상감지 임계. step_run pending 정체=에이전트 멈춤·story 무진행=정체·blocker 무응답.
_AGENT_STUCK_MINUTES = 30
_STORY_STALLED_DAYS = 3
_BLOCKER_UNANSWERED_DAYS = 2
# story #2539: 최근 반증(falsified)된 가설 — story_stalled와 동형 시간창 패턴.
# ⛔in-flight 이상감지(측정 중 목표 이탈)가 아니다 — hypothesis_scorer.py 실측 확認:
# outcome_result는 status가 verified/falsified로 "종결"되는 순간에만 채워진다("measuring
# 이면서 outcome_result가 있는" 상태는 데이터 구조상 존재 안 함). 그래서 이 신호는 "방금
# 반증으로 종결된 가설" 결과 통보이지, "진행 중 이상 조짐" 경고가 아니다 — 카피/타입명에
# "이상감지" 뉘앙스를 쓰지 않는다(story_stalled 카피 오라벨링 재발 방지, PO/선생님 결).
_HYPOTHESIS_FALSIFIED_DAYS = 7
_PENDING = {"status": "pending_data"}  # mock-0: 미구현 집계 — 가짜 수치 대신 명시.
# recent_changes 의미 이벤트 allowlist(저신호 conversation.* 등 제외·unknown 기본 제외).
_MEANINGFUL_VERB_PREFIXES = ("story.", "gate.", "pr.", "epic.", "sprint.", "dependency.", "merge")
_OPEN_EXCLUDED_STATUSES = ("done",)  # blocked/stalled 판정의 "open" = non-done.


def _now() -> datetime:
    return datetime.now(timezone.utc)


@router.get("/my-actions")
async def my_actions(
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth: AuthContext = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> JSONResponse:
    """① 지금 내 할 일. `action_queue`=caller member-private·`attention`=org 자동 이상감지(scope 분리)."""
    # ⭐caller member_id 는 **canonical resolver** 로 서버 resolve(API키=team_member·JWT human=org_member).
    # auth.user_id 직사용 금지 — human JWT 는 users.id 라 approver_member_id/assignee_id(member계열)와 불일치.
    member = await resolve_member(auth, org_id, session)
    member_id = member.id
    now = _now()

    # ⛔⛔ story #2288 리뷰(2026-07-29, PO 지적 — my_blockers 누락 버그의 근본): 이 함수가
    # queue.append({"type": ...})로 내보내는 문자열 전수는 **세 곳이 같이 움직여야 하는**
    # 목록의 원천이다 — ①여기(BE, SSOT) ②apps/web/src/components/dashboard/command-center/
    # types.ts의 QueueItem.type union ③같은 디렉터리 derive-action-zone.ts의
    # RENDERABLE_TYPES(Record<QueueItem['type'], true> — TS 컴파일 타임에 ②와는 이미 강제
    # 동기화됨). 여기 새 "type" 값을 추가하면 ②도 같이 늘려야 한다(안 그러면 splitRenderableQueue
    # 가 "표시할 수 없음"으로 조용히 떨어뜨린다).
    #
    # ⛔실측(2026-07-29): OpenAPI→FE 타입 자동생성 파이프라인이 이 레포에 없다(grep 전수 —
    # openapi_tags는 Swagger UI 문서 그룹핑 용도뿐). 이 엔드포인트 자체도 Pydantic response_model
    # 없이 raw dict를 JSONResponse로 반환해(FastAPI 자동 스키마 생성 대상이 아님) 있었다 해도
    # 이 필드는 안 걸렸을 것 — 그래서 "한 정의로 묶기"는 지금 인프라로는 불가능하다는 것이
    # 확인된 사실이다(추측 아님). 진짜 재발 방지(BE↔FE type 집합 parity 테스트)는 PO가 별도
    # 스토리로 세운다 — 이 코멘트는 그 전까지의 "적어 둔 것" 역할(미르코의 types.ts 코멘트와 짝).
    # ⛔만료 조건(PO 지시, 2026-07-29): OpenAPI→FE 자동생성이 서면 이 코멘트 셋(여기+FE 둘)을
    # 지운다 — 이유(자동생성 부재)가 사라진 뒤에도 처방(수동 코멘트 유지)이 남으면 그 자체가
    # 다음 사람에게 "아직도 수동으로 맞춰야 한다"는 거짓 신호가 되어 해가 된다.
    queue: list[dict] = []
    # 게이트 승인 대기 = 내가 approver 인 pending blocking approval(member-private·서버 resolve member_id).
    # story #2288(E-CONNECT) BE 명세3(§3-1㉢·§4-1, 미르코 작성): gate_type 패스스루 —
    # WorkflowLineStepApproval 자체엔 gate_type 필드가 없다(kind는 approver 역할 축, 다른 개념).
    # WorkflowLineStepRun.effective_gate_type이 SSOT(위 stuck 자동감지 쿼리도 이 필드를 그대로
    # 쓴다 — 새 값을 만들지 않는다) — step_run_id로 조인해 그대로 실어 보낸다.
    approvals = (
        await session.execute(
            select(WorkflowLineStepApproval, WorkflowLineStepRun.effective_gate_type)
            .join(WorkflowLineStepRun, WorkflowLineStepRun.id == WorkflowLineStepApproval.step_run_id)
            .where(
                WorkflowLineStepApproval.org_id == org_id,
                WorkflowLineStepApproval.approver_member_id == member_id,
                WorkflowLineStepApproval.status == "pending",
                WorkflowLineStepApproval.blocking.is_(True),
            )
            .order_by(WorkflowLineStepApproval.created_at.asc())
            .limit(50)
        )
    ).all()
    # story #2288(E-CONNECT) BE 명세2(§2③, 무게 — 근사치 OK, 정확 집계는 #2221 별건): 같은
    # approval_group_id(quorum)에 나 말고 몇 명이 더 pending인지. N+1 금지 — group by 배치.
    _approval_group_ids = [a.approval_group_id for a, _gt in approvals]
    approval_group_counts: dict[uuid.UUID, int] = {}
    if _approval_group_ids:
        rows = (
            await session.execute(
                select(WorkflowLineStepApproval.approval_group_id, func.count(WorkflowLineStepApproval.id))
                .where(
                    WorkflowLineStepApproval.org_id == org_id,
                    WorkflowLineStepApproval.approval_group_id.in_(_approval_group_ids),
                    WorkflowLineStepApproval.status == "pending",
                    WorkflowLineStepApproval.blocking.is_(True),
                )
                .group_by(WorkflowLineStepApproval.approval_group_id)
            )
        ).all()
        approval_group_counts = {gid: cnt for gid, cnt in rows}
    for a, gate_type in approvals:
        # 그룹 전체 pending 수 - 나 자신 = "나 말고 몇 명 더" — 음수 방지 max(0, ...).
        # story #2288 리뷰(2026-07-29, PO 지적): 필드명 자체에 "approx"를 박는다 — 정확
        # 집계(#2221 별건)와 헷갈리면 "N건 기다립니다"가 정확한 수로 읽혀 오늘 그 병(수를
        # 내밀면 사람은 정확한 줄 안다)이 재발한다. 응답 밖(코드 주석만)으론 안 드러난다.
        waiting_count_approx = max(0, approval_group_counts.get(a.approval_group_id, 1) - 1)
        queue.append({
            "type": "gate_approval",
            "priority": "warn",
            "context": {"gate_id": str(a.gate_id) if a.gate_id else None,
                        "approval_group_id": str(a.approval_group_id), "kind": a.kind,
                        "gate_type": gate_type, "waiting_count_approx": waiting_count_approx},
            "created_at": a.created_at.isoformat() if a.created_at else None,
        })
    # story #2288(E-CONNECT) BE 명세5(2026-07-29 확定, PO 기준): review_merge를 status==
    # 'in-review' 하나에서 "done 아닌 전체"로 넓힌다 — PO 기준 그대로 "내가 지금 손을 대면
    # 무언가 달라지는가". ⛔단 "선행 대기"(아직 안 풀린 blocks 의존성이 이 story를 막고
    # 있음)는 제외한다 — 손대도 안 바뀌는 것은 waiting 축이지 review_merge 축이 아니다
    # (그 축은 이미 my_blockers/waiting_on_others가 다룬다 — 여기서 새로 안 만든다).
    _ReviewBlocker = aliased(Story)
    _blocked_by_open_dependency = (
        select(ItemDependency.id)
        .select_from(ItemDependency)
        .join(_ReviewBlocker, _ReviewBlocker.id == ItemDependency.from_id)
        .where(
            ItemDependency.org_id == org_id,
            ItemDependency.to_id == Story.id,
            ItemDependency.dep_type == "blocks",
            ItemDependency.item_type == "story",
            _ReviewBlocker.org_id == org_id,
            _ReviewBlocker.status.not_in(_OPEN_EXCLUDED_STATUSES),  # 막는 쪽이 아직 open.
            _ReviewBlocker.deleted_at.is_(None),
        )
        .correlate(Story)
    )
    reviews = (
        await session.execute(
            select(Story)
            .where(
                Story.org_id == org_id,
                Story.assignee_id == member_id,
                Story.status.not_in(_OPEN_EXCLUDED_STATUSES),
                Story.deleted_at.is_(None),
                ~exists(_blocked_by_open_dependency),
            )
            .order_by(Story.updated_at.desc())
            .limit(50)
        )
    ).scalars().all()
    for s in reviews:
        queue.append({
            "type": "review_merge",
            "priority": "info",
            "title": s.title,
            "context": {"story_id": str(s.id), "status": s.status},
            "created_at": s.updated_at.isoformat() if s.updated_at else None,
        })
    # story #2288(E-CONNECT) BE 명세1(§1-1, 태스크 줄): 담당 스토리 소속 여부와 무관하게
    # "내가 담당인 미완료 Task"를 그 자체로 항목화한다 — 스토리는 소속 표시만(미르코 명세
    # 원문 그대로, 스토리를 따로 my_task로 중복 안 냄).
    my_tasks = (
        await session.execute(
            select(Task, Story.title)
            .join(Story, Story.id == Task.story_id)
            .where(
                Task.org_id == org_id,
                Task.assignee_id == member_id,
                # story #2288 리뷰(2026-07-29, PO 지적): "미완료"는 명세5(review_merge)와
                # «같은 자»를 써야 한다 — 안 그러면 같은 화면에 "다른 뜻의 미완료"가 둘 선다.
                # _OPEN_EXCLUDED_STATUSES(파일 상단, 지금은 ("done",) 하나)가 그 SSOT다.
                # ⛔이 상수는 Story 어휘로 지어졌다 — Task에 얹기 전 CHECK 제약을 직접
                # 조회해 어휘가 같은지 실측했다(psql \d+ tasks, 2026-07-29): tasks_status_
                # check = ANY('todo','in-progress','done') — Story와 "done" 하나로 동일하다.
                # Task 전용 완료값이 따로 있었다면 이 재사용은 결함이었을 것(그런 값 없음).
                Task.status.not_in(_OPEN_EXCLUDED_STATUSES),
                Task.deleted_at.is_(None),
                Story.org_id == org_id,
                Story.deleted_at.is_(None),
            )
            .order_by(Task.updated_at.desc())
            .limit(50)
        )
    ).all()
    for t, story_title in my_tasks:
        queue.append({
            "type": "my_task",
            "priority": "info",
            "title": t.title,
            "context": {"task_id": str(t.id), "story_id": str(t.story_id), "story_title": story_title},
            "created_at": t.updated_at.isoformat() if t.updated_at else None,
        })
    # CC-BE.2 내가 풀 블로커(member-private): 내 담당(blocker) 스토리가 막은 open 스토리. caller-bound.
    _Blocker = aliased(Story)
    _Blocked = aliased(Story)
    my_blockers = (
        await session.execute(
            select(ItemDependency.from_id, ItemDependency.to_id)
            .select_from(ItemDependency)
            .join(_Blocker, _Blocker.id == ItemDependency.from_id)
            .join(_Blocked, _Blocked.id == ItemDependency.to_id)
            .where(
                ItemDependency.org_id == org_id,
                ItemDependency.dep_type == "blocks",
                ItemDependency.item_type == "story",
                _Blocker.org_id == org_id,                # defense-in-depth: 조인 story 도 org-scope.
                _Blocked.org_id == org_id,
                _Blocker.assignee_id == member_id,        # 막은 쪽이 내 담당.
                _Blocker.deleted_at.is_(None),
                _Blocked.status.not_in(_OPEN_EXCLUDED_STATUSES),  # 막힌 쪽이 아직 open.
                _Blocked.deleted_at.is_(None),
            )
            .limit(50)
        )
    ).all()
    # story #2288 BE 명세2(§2③, 무게): 같은 blocker_story_id가 총 몇 개의 open story를
    # 막고 있는지 — N+1 금지, group by 배치(위 my_blockers 쿼리와 동일 WHERE 축 재사용).
    _blocker_ids = [blocker_id for blocker_id, _blocked_id in my_blockers]
    blocker_weight_counts: dict[uuid.UUID, int] = {}
    if _blocker_ids:
        rows = (
            await session.execute(
                select(ItemDependency.from_id, func.count(func.distinct(ItemDependency.to_id)))
                .select_from(ItemDependency)
                .join(_Blocked, _Blocked.id == ItemDependency.to_id)
                .where(
                    ItemDependency.org_id == org_id,
                    ItemDependency.dep_type == "blocks",
                    ItemDependency.item_type == "story",
                    ItemDependency.from_id.in_(_blocker_ids),
                    _Blocked.org_id == org_id,
                    _Blocked.status.not_in(_OPEN_EXCLUDED_STATUSES),
                    _Blocked.deleted_at.is_(None),
                )
                .group_by(ItemDependency.from_id)
            )
        ).all()
        blocker_weight_counts = {bid: cnt for bid, cnt in rows}
    for blocker_id, blocked_id in my_blockers:
        queue.append({
            "type": "my_blockers",
            "priority": "danger",  # 내가 푸는 게 남을 막고 있음 — 최우선.
            # story #2288 리뷰(2026-07-29, PO 지적): gate_approval과 동일 이유로
            # waiting_count_approx — 정확 집계(#2221)와 구분되게 필드명 자체에 근사치임을 싣는다.
            "context": {"blocker_story_id": str(blocker_id), "blocked_story_id": str(blocked_id),
                        "waiting_count_approx": blocker_weight_counts.get(blocker_id, 1)},
        })

    # story #2288(E-CONNECT) BE 명세4(§3-1㉢·§4-1, PO 강조 — 이 스토리의 심장): 「내 것인데
    # 남이 잡고 있음」 = 내가 담당(assignee)인 story인데 그 워크플로 라인의 pending blocking
    # 승인 대기가 «내가 아닌» approver에게 있는 경우. §3-1㉢ 정의 그대로 — 발(다음 행동)이
    # 내게 없다. ⛔이 항목엔 버튼을 안 단다(FE 몫 — 여기선 type만 가른다): 목적이 «행동
    # 유도»가 아니라 「내가 놓친 게 아니라 남이 잡고 있다」는 «해소»다.
    # 「나의 것」 정의(AC2 명시 요구): 지금은 **담당(assignee_id)** 하나만 — 결재자·멘션·claim
    # 은 포함 안 함(추측으로 넓히지 않는다, 대조표가 곧 명세라는 PO 지시 그대로).
    _WaitingStory = aliased(Story)
    # story #2527(까심 QA 확認 대기, PO 오르테가 AC 락 2026-08-08): S9 쿼럼 gate(한 approval_group_id에
    # approver row N개)에서 member_id 가 assignee 이면서 동시에 그 gate의 pending blocking 승인자
    # 중 한 명이면, 위 `approver_member_id != member_id` 필터는 «내» row만 걸러낼 뿐 «다른»
    # 승인자 row는 그대로 남아 story가 waiting_on_others로 잡혔다(내 승인 행동이 실제로 남아
    # 있는데도 "행동 없음"으로 오분류 — 그 행동은 이미 위 gate_approval 큐에 별도로 뜬다).
    # NOT EXISTS로 "이 step_run에 내 pending blocking 승인 row가 하나라도 있으면" 그 story
    # 자체를 이 버킷에서 제외한다(단일승인자·비쿼럼 케이스는 기존에도 애초에 이 row가 없어 무회귀).
    # ⚠️outer join이 이미 (별칭 없는) WorkflowLineStepApproval을 FROM에 물고 있어, 이 서브쿼리가
    # 같은 클래스를 맨 클래스 그대로 참조하면 SQLAlchemy 자동상관이 그것까지 상관관계로 착각해
    # FROM 자체를 통째로 비워버린다(`no FROM clauses due to auto-correlation`) — 별도 alias로
    # "이건 다른 row를 찾는 별개 서브쿼리"임을 명시해야 한다.
    _MyApproval = aliased(WorkflowLineStepApproval)
    _my_pending_approval_on_step = select(_MyApproval.id).where(
        _MyApproval.org_id == org_id,
        _MyApproval.step_run_id == WorkflowLineStepRun.id,
        _MyApproval.approver_member_id == member_id,
        _MyApproval.status == "pending",
        _MyApproval.blocking.is_(True),
    )
    waiting_rows = (
        await session.execute(
            select(
                _WaitingStory.id,
                WorkflowLineStepRun.effective_gate_type,
                WorkflowLineStepApproval.approver_member_id,
            )
            .select_from(_WaitingStory)
            .join(
                WorkflowLineStepRun,
                (WorkflowLineStepRun.org_id == org_id)
                & (WorkflowLineStepRun.entity_type == "story")
                & (WorkflowLineStepRun.entity_id == _WaitingStory.id)
                & (WorkflowLineStepRun.status == "pending"),
            )
            .join(
                WorkflowLineStepApproval,
                (WorkflowLineStepApproval.org_id == org_id)
                & (WorkflowLineStepApproval.step_run_id == WorkflowLineStepRun.id)
                & (WorkflowLineStepApproval.status == "pending")
                & (WorkflowLineStepApproval.blocking.is_(True)),
            )
            .where(
                _WaitingStory.org_id == org_id,
                _WaitingStory.assignee_id == member_id,
                _WaitingStory.deleted_at.is_(None),
                WorkflowLineStepApproval.approver_member_id != member_id,
                ~exists(_my_pending_approval_on_step),
            )
            .order_by(_WaitingStory.updated_at.desc())
            .limit(100)
        )
    ).all()
    # ⛔한 story에 승인자가 여럿(quorum)이면 위 join이 story당 여러 행을 낸다 — story는 화면에
    # «한 번»만 뜨는 게 맞다(대기 이유가 여럿이어도 "기다리는 대상"은 하나). story_id로 dedupe.
    seen_waiting_story_ids: set[uuid.UUID] = set()
    for story_id, gate_type, approver_id in waiting_rows:
        if story_id in seen_waiting_story_ids:
            continue
        seen_waiting_story_ids.add(story_id)
        queue.append({
            "type": "waiting_on_others",
            "priority": "info",  # §3-1㉢: 행동 없음 — danger/warn(행동 촉구) 축과 안 섞는다.
            "context": {"story_id": str(story_id), "gate_type": gate_type,
                        "approver_member_id": str(approver_id)},
        })

    # ── 자동 이상감지(org-scope) — enum/ids/age 만(민감 텍스트 0) ──────────────────────
    attention_items: list[dict] = []
    # 1) 에이전트 멈춤(step_run pending 정체·agent-only). raw error/log 비노출.
    stuck = (
        await session.execute(
            select(WorkflowLineStepRun)
            .where(
                WorkflowLineStepRun.org_id == org_id,
                WorkflowLineStepRun.status == "pending",
                WorkflowLineStepRun.started_at < now - timedelta(minutes=_AGENT_STUCK_MINUTES),
                WorkflowLineStepRun.resolved_member_type == "agent",  # HIGH2: agent run 만.
            )
            .order_by(WorkflowLineStepRun.started_at.asc())
            .limit(20)
        )
    ).scalars().all()
    for r in stuck:
        attention_items.append({
            "type": "agent_stuck", "severity": "warn", "auto_detected": True,
            "entity_type": r.entity_type, "entity_id": str(r.entity_id),
            "gate_type": r.effective_gate_type,
            "stuck_since": r.started_at.isoformat() if r.started_at else None,
        })
    # 2) CC-BE.2 스토리 N일 정체(org-visible 필드만).
    # story #2538(2026-08-09): title 추가 — FE ko.json "가설이 예상과 다르게 진행됩니다"
    # 카피가 이 신호(가설과 무관한 제네릭 story 정체 감지)에 잘못 매핑돼 있었다(PO 그라운딩
    # 확認). 카피 정정+dedup+개별 구별("제목+N일")은 FE 몫, 그 구별에 필요한 title을 여기서
    # additive로 채운다.
    stalled = (
        await session.execute(
            select(Story.id, Story.updated_at, Story.title)
            .where(
                Story.org_id == org_id,
                Story.status.not_in(("done", "backlog")),
                Story.deleted_at.is_(None),
                Story.is_excluded.is_(False),
                Story.updated_at < now - timedelta(days=_STORY_STALLED_DAYS),
            )
            .order_by(Story.updated_at.asc())
            .limit(20)
        )
    ).all()
    for sid, updated_at, title in stalled:
        attention_items.append({
            "type": "story_stalled", "severity": "warn", "auto_detected": True,
            "title": title,
            "story_id": str(sid),
            "stalled_days": (now - updated_at).days if updated_at else None,
        })
    # 3) CC-BE.2 답없는 블로커(enum/ids/age — raw blocker text 0).
    # story #2538: story_stalled와 동형으로 title 추가(막힌 story 제목) — FE 구별용.
    _BlockedU = aliased(Story)
    unanswered = (
        await session.execute(
            select(
                ItemDependency.from_id, ItemDependency.to_id, ItemDependency.created_at,
                _BlockedU.title,
            )
            .select_from(ItemDependency)
            .join(_BlockedU, _BlockedU.id == ItemDependency.to_id)
            .where(
                ItemDependency.org_id == org_id,
                ItemDependency.dep_type == "blocks",
                ItemDependency.item_type == "story",
                ItemDependency.created_at < now - timedelta(days=_BLOCKER_UNANSWERED_DAYS),
                _BlockedU.org_id == org_id,               # defense-in-depth: 조인 story 도 org-scope.
                _BlockedU.status.not_in(_OPEN_EXCLUDED_STATUSES),
                _BlockedU.deleted_at.is_(None),
            )
            .order_by(ItemDependency.created_at.asc())
            .limit(20)
        )
    ).all()
    for blocker_id, blocked_id, created_at, blocked_title in unanswered:
        attention_items.append({
            "type": "unanswered_blocker", "severity": "warn", "auto_detected": True,
            "blocked_story_id": str(blocked_id), "blocker_id": str(blocker_id),
            "blocked_story_title": blocked_title,
            "age_days": (now - created_at).days if created_at else None,
        })
    # 4) story #2539: 최근 반증(falsified) 가설 — 결과 통보(in-flight 감지 아님, 위 주석 참조).
    falsified_hyps = (
        await session.execute(
            select(
                Hypothesis.id, Hypothesis.statement, Hypothesis.outcome_result,
                Hypothesis.updated_at, Hypothesis.superseded_by_hypothesis_id,
            )
            .where(
                Hypothesis.org_id == org_id,
                Hypothesis.status == "falsified",
                Hypothesis.updated_at >= now - timedelta(days=_HYPOTHESIS_FALSIFIED_DAYS),
            )
            .order_by(Hypothesis.updated_at.desc())
            .limit(20)
        )
    ).all()
    for hyp_id, statement, outcome_result, updated_at, superseded_by in falsified_hyps:
        attention_items.append({
            "type": "hypothesis_falsified", "severity": "info", "auto_detected": True,
            "hypothesis_id": str(hyp_id), "statement": statement,
            "outcome_result": outcome_result,
            "falsified_days": (now - updated_at).days if updated_at else None,
            "superseded_by_hypothesis_id": str(superseded_by) if superseded_by else None,
        })
    # 5) story #2829(loop-closure P0, doc loop-closure-first-class-signal-design §1·§3
    # 계약=미르코군 doc a8e73bdb 그대로) — 「닫히지 않은 루프」: N에 포함되는 2류(도과+outcome
    # 없이 done). loop_measure_due_notified_at(발행 여부)과 무관하게 항상 실물을 그대로
    # 센다 — 발행 성패가 "닫히지 않았다"는 사실 자체를 안 바꾼다(서비스 모듈독스트링 참조).
    overdue_hyps = (
        await session.execute(
            select(Hypothesis.id, Hypothesis.statement, Hypothesis.measure_after, Hypothesis.owner_member_id)
            .where(
                Hypothesis.org_id == org_id,
                Hypothesis.status.in_(("active", "measuring")),
                Hypothesis.measure_after <= now,
            )
            .order_by(Hypothesis.measure_after.asc())
            .limit(20)
        )
    ).all()
    for hyp_id, statement, measure_after, owner_id in overdue_hyps:
        attention_items.append({
            "type": "loop_overdue_hypothesis", "severity": "warn", "auto_detected": True,
            "hypothesis_id": str(hyp_id), "statement": statement,
            "owner_member_id": str(owner_id) if owner_id else None,
            "overdue_days": (now - measure_after).days if measure_after else None,
        })
    overdue_goals = (
        await session.execute(
            select(Goal.id, Goal.title, Goal.measure_after, Goal.assignee_id)
            .where(
                Goal.org_id == org_id,
                Goal.status == "active",
                Goal.measure_after.isnot(None),
                Goal.measure_after <= now,
            )
            .order_by(Goal.measure_after.asc())
            .limit(20)
        )
    ).all()
    for goal_id, title, measure_after, assignee_id in overdue_goals:
        attention_items.append({
            "type": "loop_overdue_goal", "severity": "warn", "auto_detected": True,
            "goal_id": str(goal_id), "title": title,
            "owner_member_id": str(assignee_id) if assignee_id else None,
            "overdue_days": (now - measure_after).days if measure_after else None,
        })
    done_no_outcome_goals = (
        await session.execute(
            select(Goal.id, Goal.title, Goal.updated_at, Goal.assignee_id)
            .where(
                Goal.org_id == org_id,
                Goal.status == "done",
                Goal.outcome_status == "n_a",
            )
            .order_by(Goal.updated_at.asc())
            .limit(20)
        )
    ).all()
    for goal_id, title, updated_at, assignee_id in done_no_outcome_goals:
        attention_items.append({
            "type": "loop_outcome_missing_goal", "severity": "warn", "auto_detected": True,
            "goal_id": str(goal_id), "title": title,
            "owner_member_id": str(assignee_id) if assignee_id else None,
            "done_days": (now - updated_at).days if updated_at else None,
        })
    # N에서 제외하되 집계는 유지(페드루 PO 보완 지시, doc a8e73bdb §2) — measure_after
    # 자체가 없는 active goal. AC상 클릭 목록 요건이 없어 개별 목록은 안 싣는다(카운트만).
    measure_plan_missing_goal_count = (
        await session.execute(
            select(func.count()).select_from(Goal).where(
                Goal.org_id == org_id,
                Goal.status == "active",
                Goal.measure_after.is_(None),
            )
        )
    ).scalar_one()

    return JSONResponse(content={
        "action_queue": {  # scope: member(caller) — 타 멤버 큐 노출 0.
            "scope": "member",
            "items": sorted(queue, key=lambda x: {"danger": 0, "warn": 1, "info": 2}.get(x["priority"], 9)),
        },
        "attention": {  # scope: org — 자동 이상감지(운영자 visibility).
            "scope": "org",
            "items": attention_items,
            "pending": ["time_sensitive"],  # 잔여 미구현(overdue/스프린트 D-N·due 소스 부재).
            # story #2829 — N 비포함·집계만(doc a8e73bdb §2 PO 보완 지시). 카드 하단 보조
            # 텍스트("+{count}건은 측정계획이 아직 없음")용, items[]엔 개별 목록 없음.
            "measure_plan_missing_goal_count": measure_plan_missing_goal_count,
        },
        "is_clear": len(queue) == 0 and len(attention_items) == 0,
    })


@router.get("/overview")
async def overview(
    org_id: uuid.UUID = Depends(get_verified_org_id),
    _auth: AuthContext = Depends(get_current_user),
    # story #2451(§6 Phase3 A1): 대시보드 집계·create→self-read 흐름 없음 → read replica.
    session: AsyncSession = Depends(get_read_db),
) -> JSONResponse:
    """② 프로젝트 현황 + 헤더 함대. scope=org/team. 비용·기여는 org aggregate only(개인 노출 0)."""
    now = _now()
    # 헤더 — 함대: 총 에이전트(실).
    total_agents = (
        await session.execute(
            select(func.count(Member.id)).where(
                Member.org_id == org_id, Member.type == "agent",
                Member.is_active.is_(True), Member.deleted_at.is_(None),
            )
        )
    ).scalar_one()

    # 에픽 진척(실): org 스토리 epic 별 done/total. is_excluded 제외.
    rows = (
        await session.execute(
            select(
                Story.epic_id,
                func.count(Story.id),
                func.count(Story.id).filter(Story.status == "done"),
            )
            .where(
                Story.org_id == org_id, Story.deleted_at.is_(None),
                Story.epic_id.isnot(None), Story.is_excluded.is_(False),
            )
            .group_by(Story.epic_id)
        )
    ).all()
    counts = {epic_id: (total, done) for epic_id, total, done in rows}
    epics_q = (
        await session.execute(select(Goal).where(Goal.org_id == org_id))
    ).scalars().all()
    epics = []
    for e in epics_q:
        total, done = counts.get(e.id, (0, 0))
        if total == 0:
            continue
        epics.append({
            "epic_id": str(e.id), "title": e.title, "status": e.status,
            "total": total, "done": done,
            "completion_pct": round(done * 100 / total) if total else 0,
        })
    epics.sort(key=lambda x: x["completion_pct"])

    # 성과(가설 적중·실): verified=hit / 전체.
    h_total, h_hit = (
        await session.execute(
            select(
                func.count(Hypothesis.id),
                func.count(Hypothesis.id).filter(Hypothesis.status == "verified"),
            ).where(Hypothesis.org_id == org_id)
        )
    ).one()

    # 최근 중요 변화(실·org): 의미 이벤트만(저신호 conversation.* 등 제외·unknown 기본 제외).
    events = (
        await session.execute(
            select(ActivityEvent)
            .where(ActivityEvent.org_id == org_id)
            .order_by(ActivityEvent.occurred_at.desc())
            .limit(40)
        )
    ).scalars().all()
    recent_changes = [
        {
            "verb": ev.verb,
            "object_type": ev.object_type,
            "object_id": str(ev.object_id) if ev.object_id else None,
            "occurred_at": ev.occurred_at.isoformat() if ev.occurred_at else None,
        }
        for ev in events
        if ev.verb and ev.verb.startswith(_MEANINGFUL_VERB_PREFIXES)
    ][:10]

    # CC-BE.2 기여(에이전트 vs 사람·aggregate only·개인 blame/랭킹 0): done 스토리 assignee type 집계.
    contrib_rows = (
        await session.execute(
            select(Member.type, func.count(Story.id))
            .select_from(Story)
            # outer join + ON 에 org_id — 타 org member 매칭 차단(cross-org → unassigned 으로 떨어짐).
            .join(Member, (Member.id == Story.assignee_id) & (Member.org_id == org_id), isouter=True)
            .where(
                Story.org_id == org_id, Story.status == "done",
                Story.deleted_at.is_(None), Story.is_excluded.is_(False),
            )
            .group_by(Member.type)
        )
    ).all()
    contribution = {"agent": 0, "human": 0, "unassigned": 0}
    for mtype, cnt in contrib_rows:
        if mtype == "agent":
            contribution["agent"] = cnt
        elif mtype == "human":
            contribution["human"] = cnt
        else:  # assignee 없음(None) 또는 미상 type → unassigned.
            contribution["unassigned"] += cnt

    # CC-BE.2 사이클타임(실·org): created→done 평균 일수(최근 30일 done·excluded/deleted 제외).
    avg_secs, cycle_sample = (
        await session.execute(
            select(
                func.avg(func.extract("epoch", StoryActivity.created_at - Story.created_at)),
                func.count(StoryActivity.id),
            )
            .select_from(StoryActivity)
            .join(Story, Story.id == StoryActivity.story_id)
            .where(
                StoryActivity.org_id == org_id,
                StoryActivity.activity_type == "status_changed",
                StoryActivity.new_value == "done",
                StoryActivity.created_at > now - timedelta(days=30),
                Story.deleted_at.is_(None), Story.is_excluded.is_(False),
            )
        )
    ).one()
    cycle_time = {
        "avg_days": round(float(avg_secs) / 86400, 1) if avg_secs is not None else None,
        "sample": int(cycle_sample or 0),
    }

    # CC-BE.2 비용 추세(실·org aggregate only·개인별 비용 노출 0): agent_runs 일별 합. 없으면 honest empty.
    cost_rows = (
        await session.execute(
            select(
                func.date(AgentRun.started_at),
                func.sum(AgentRun.cost_usd),
                func.sum(func.coalesce(AgentRun.input_tokens, 0) + func.coalesce(AgentRun.output_tokens, 0)),
            )
            .where(AgentRun.org_id == org_id, AgentRun.started_at > now - timedelta(days=14))
            .group_by(func.date(AgentRun.started_at))
            .order_by(func.date(AgentRun.started_at))
        )
    ).all()
    points = [
        {"date": str(d), "cost_usd": round(float(c or 0), 4), "tokens": int(t or 0)}
        for d, c, t in cost_rows
    ]
    cost_trend = {
        "points": points,
        "total_cost_usd": round(sum(p["cost_usd"] for p in points), 4),
        "delta_pct": None,  # 직전 기간 대비 증감은 후속(현 14일 합만).
    }

    # CC-BE.2 위험(실): 막힌 open 스토리 수 + 실패 run 수. overdue 는 due 필드 부재 → pending_data.
    _BlockedR = aliased(Story)
    blocked_cnt = (
        await session.execute(
            select(func.count(func.distinct(ItemDependency.to_id)))
            .select_from(ItemDependency)
            .join(_BlockedR, _BlockedR.id == ItemDependency.to_id)
            .where(
                ItemDependency.org_id == org_id,
                ItemDependency.dep_type == "blocks",
                ItemDependency.item_type == "story",
                _BlockedR.org_id == org_id,               # defense-in-depth: 조인 story 도 org-scope.
                _BlockedR.status.not_in(_OPEN_EXCLUDED_STATUSES),
                _BlockedR.deleted_at.is_(None),
            )
        )
    ).scalar_one()
    failed_runs = (
        await session.execute(
            select(func.count(AgentRun.id)).where(
                AgentRun.org_id == org_id, AgentRun.status == "failed",
                AgentRun.started_at > now - timedelta(days=7),
            )
        )
    ).scalar_one()
    risk = {"blocked": int(blocked_cnt or 0), "failed_runs": int(failed_runs or 0), "overdue": _PENDING}

    # CC-BE.2 함대 status breakdown(실·org agent profile). working=online+active_story.
    fleet_rows = (
        await session.execute(
            select(
                AgentProjectProfile.agent_status,
                func.count(func.distinct(AgentProjectProfile.member_id)),
                func.count(func.distinct(AgentProjectProfile.member_id)).filter(
                    AgentProjectProfile.active_story_id.isnot(None)
                ),
            )
            .select_from(AgentProjectProfile)
            .join(Member, Member.id == AgentProjectProfile.member_id)
            .where(
                Member.org_id == org_id, Member.type == "agent",
                Member.is_active.is_(True), Member.deleted_at.is_(None),
            )
            .group_by(AgentProjectProfile.agent_status)
        )
    ).all()
    fleet_breakdown = {"online": 0, "offline": 0, "working": 0}
    for status_val, cnt, working_cnt in fleet_rows:
        if status_val == "online":
            fleet_breakdown["online"] += cnt
            fleet_breakdown["working"] += working_cnt
        elif status_val == "offline":
            fleet_breakdown["offline"] += cnt
        # status NULL(미접속) 등은 online/offline 어디에도 안 셈(보수적).

    return JSONResponse(content={
        "scope": "org",
        "fleet": {
            "total_agents": total_agents,
            "status_breakdown": fleet_breakdown,  # CC-BE.2 실데이터.
        },
        "project_status": {
            "epics": epics,
            "outcome": {"hit": h_hit, "total": h_total},
            "recent_changes": recent_changes,
            "risk": risk,                # CC-BE.2(overdue 만 pending).
            "cycle_time": cycle_time,    # CC-BE.2.
            "contribution": contribution,  # CC-BE.2 aggregate.
            "cost_trend": cost_trend,    # CC-BE.2.
        },
    })
