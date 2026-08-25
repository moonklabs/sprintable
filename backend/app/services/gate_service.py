"""E-CAGE-REFEREE P3: HITL Gate 생성·전이·verdict 해소 서비스.

게이트 생성: resolve_disposition() 호출 → disposition에 따라 초기 status 결정.
  allow_auto → auto_passed (숨김, 자동)
  ask        → pending    (인간 개입 필요)
  deny       → rejected   (차단)

상태기계 전이: 불법 전이 거부 (pending→approved|rejected만 허용).

verdict→게이트 해소: P1 verdict 포착이 대응 게이트를 실제로 해소.
  verdict source='pr'|'ci' → gate_type='pr_review'
  verdict source='qa'       → gate_type='qa'
  verdict source='design'   → gate_type='deploy'
  게이트 없으면 graceful skip.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Literal

from sqlalchemy import and_, case, func, literal, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.models.doc import Doc
from app.models.gate import Gate, is_valid_transition, set_gate_status
from app.models.hitl_config import OrgGatePolicy
from app.models.hypothesis import Hypothesis
from app.services.doc import DOC_GATE_TYPE
from app.models.loop import LoopRun
from app.models.pm import Goal, Sprint, Story, Task
from app.models.visual_artifact import VisualArtifact
from app.models.workflow_line import (
    WorkflowLineStepApproval,
    WorkflowLineStepRun,
    WorkflowLineStepRunEvent,
)
from app.services.gate_resolver import resolve_disposition
from app.services.workflow_line_resolution import _OPEN_STEP_RUN_STATUSES

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# story #1972(P1a-S4): 게이트 위험도 UX 등급 파생.
#
# SSOT: doc `gate-risk-ux-classification-criteria` §2 판정표. ⚠️철학(models/hitl_config.py:3)
# 준수 — "새 위험도 판정"이 아니라 **기존 신호(OrgGatePolicy.posture + Gate.gate_type) 파생**이다.
# 새 risk_level 필드/컬럼/마이그레이션 없음. `resolve_disposition()`(gate_resolver.py)은 member/org
# override까지 태우는 HITL **정책** 해소 함수라 이 UX 등급 파생과는 완전히 별개 축(doc §4 "경계
# 명확화") — 절대 호출하지 않는다. `get_org_posture()`는 org_id 하나로 org_gate_policy 단일 쿼리만
# 수행(gate_resolver.py의 3번째 폴백 단계와 같은 쿼리 형태를 참고했을 뿐, 그 함수를 호출하지는
# 않음).
# ─────────────────────────────────────────────────────────────────────────────

RiskGrade = Literal["low", "high"]

# 2차 축(doc §2.2): posture가 미확定(balanced/미설정)일 때만 참조.
#
# story #6c89e40d(페드루 PO 판정 2026-08-17, ⓐ'): doc_approval은 지금까지 이 세트 어디에도
# 없어 폴백(§2.3 안전판)에 «의존»해서만 high였다 — 실사용 타입이 우연히 폴백과 값이 같다는
# 사실에 기대는 것과 명시 등재는 다르다(폴백은 "미분류 신규 타입"을 위한 것이지 이미 아는
# 타입을 위한 것이 아니다). doc-gate-section.tsx의 note-422 실사고(dev 08-15, gate
# 5a34ef7f)가 정확히 이 간극에서 났다 — FE가 note/evidence_viewed를 안 보내는 채로 배선돼
# 있었는데 그 사실을 아무 코드도 "doc_approval=high"라고 선언하지 않고 있었다. low로
# 등재하지 않는다(신중 결재 취지 훼손, PO 명시 판단) — high로 명시.
_HIGH_RISK_GATE_TYPES: frozenset[str] = frozenset({"merge", "deploy", "workflow_config_publish", DOC_GATE_TYPE})
#
# story #2709(2026-08-17, PO 판정) — agent_decision_request를 명시 low 등재. 미등재=폴백(§2.3
# 보수적 high)에 기대는 게 안전한 기본값이 아니라는 것을 story #6c89e40d(doc_approval 미등재
# 실사고)가 오늘 이미 증명했다. 이 게이트는 되돌릴 수 없는 액션을 그 자신이 트리거하지
# 않는다(에이전트가 이미 자기 가정대로 진행 중인 결정의 사후/병행 확인일 뿐 — 진짜 위험한
# 액션은 merge/deploy/doc_approval 같은 그 자신의 게이트가 따로 막는다) — 신중 결재(서명
# 의식)를 강제하면 "빠른 비동기 확인"이라는 이 기능의 존재 이유와 정면 충돌한다.
_LOW_RISK_GATE_TYPES: frozenset[str] = frozenset({"pr_review", "qa", "agent_decision_request"})


def derive_risk_grade(posture: str | None, gate_type: str) -> RiskGrade:
    """doc `gate-risk-ux-classification-criteria` §2 판정표를 그대로 코드화한 순수 함수.

    입력: org posture 값(``OrgGatePolicy.posture`` 또는 row 없으면 None) + gate_type 문자열.
    출력: UX 등급("low"|"high"). DB 접근 없음(순수 함수) — posture는 호출부가 ``get_org_posture()``
    로 미리 조회해 넘긴다.

    판정 순서(doc §2 그대로):
      1차 축(posture) — conservative→high · permissive→low · balanced/None→2차 축.
      2차 축(gate_type, 1차가 미확定일 때만) — merge/deploy/workflow_config_publish→high ·
        pr_review/qa→low.
      폴백(doc §2.3) — 둘 다 미확定(신규/미분류 gate_type)이면 **보수적 고위험**(안전판).
    """
    if posture == "conservative":
        return "high"
    if posture == "permissive":
        return "low"
    # posture in (None, "balanced") → 2차 축(gate_type)으로.
    if gate_type in _HIGH_RISK_GATE_TYPES:
        return "high"
    if gate_type in _LOW_RISK_GATE_TYPES:
        return "low"
    # 폴백: 신규/미분류 gate_type — 보수적 고위험(doc §2.3 안전판).
    return "high"


async def get_org_posture(session: AsyncSession, org_id: uuid.UUID) -> str | None:
    """org_id 단일 값으로 ``OrgGatePolicy.posture`` 직접 조회(org당 1행). row 없으면 None(미설정).

    ⚠️`resolve_disposition()`(gate_resolver.py)을 호출하지 않는다 — 그 함수는 member_gate_override →
    org_gate_override → org_gate_policy → 시스템 기본값 순 **전체 precedence**를 태우는 HITL disposition
    해소 함수고, 이 헬퍼는 story #1972 위험도 UX 등급 파생 전용 별개 경로(doc §4)다. 쿼리 형태만
    gate_resolver.py의 3번째 폴백 단계(org posture 조회)를 참고했다."""
    row = await session.execute(
        select(OrgGatePolicy.posture).where(OrgGatePolicy.org_id == org_id).limit(1)
    )
    return row.scalar_one_or_none()


# ─────────────────────────────────────────────────────────────────────────────
# story #1973(P1a-S4): ?sort=urgency ORDER BY 절 조립 — 결재함 통합 큐(#1960) 기본 정렬 근거.
#
# ⚠️SQL 레벨 정렬만(파이썬 후처리 정렬 금지) — 페이지네이션/필터와 조합 가능해야 하고 DB가
# 하는 게 맞다. overdue 판정은 gate당 correlated EXISTS 서브쿼리 하나로 목록 전체를 커버한다
# (find_active_step_run_for_gate가 gate 1건 조회하는 gate_id OR h1_gate_id·open status 패턴을
# 재사용하되, 리스트 전체에 대해 단일 SQL statement로 — N+1 0. session.execute 호출 수는 여전히
# 1회, DB 플래너가 correlated subquery를 gate별로 평가하는 것뿐).
# 우선순위(스토리 AC 그대로): 1) held(향후 만료)=최하단 2) SLA overdue=최상위 3) created_at
# ASC(오래된 것 상위 — "노화"). 3번째 키는 overdue/non-overdue 그룹 내부에도 동일 적용된다
# (전역 ORDER BY 절이라 그룹별로 별도 지정할 필요 없음 — 상위 키가 이미 그룹을 가른 뒤 그
# 안에서 created_at ASC가 자연히 작동).
# ─────────────────────────────────────────────────────────────────────────────


def apply_gate_urgency_sort(query, *, now: Any | None = None):
    """``?sort=urgency`` ORDER BY 절을 query(Select[Gate])에 덧붙여 반환한다.

    ``now``는 테스트 결정성용 override(기본 ``func.now()`` — DB 시계 기준, 앱-DB 시계 차이 회피).
    overdue 판정: gate에 연결된(``gate_id`` OR ``h1_gate_id``, 동일 org) open
    ``WorkflowLineStepRun``(``_OPEN_STEP_RUN_STATUSES``) 중 ``sla_due_at``이 now 이전인 게 하나라도
    있으면 그 gate는 overdue(EXISTS correlated subquery — gate 개수와 무관하게 SQL 1개).
    """
    now_expr = func.now() if now is None else now
    step_run = aliased(WorkflowLineStepRun)
    overdue_exists = (
        select(literal(1))
        .where(
            or_(step_run.gate_id == Gate.id, step_run.h1_gate_id == Gate.id),
            step_run.org_id == Gate.org_id,
            step_run.status.in_(_OPEN_STEP_RUN_STATUSES),
            step_run.sla_due_at.isnot(None),
            step_run.sla_due_at < now_expr,
        )
        .correlate(Gate)
        .exists()
    )
    # 1차: held(향후 만료)=1(최하단)·그 외=0(상위). 2차: overdue=0(최상위)·그 외=1. 3차: created_at
    # ASC(오래된 것 상위).
    held_rank = case(
        (and_(Gate.held_until.isnot(None), Gate.held_until > now_expr), 1), else_=0,
    )
    overdue_rank = case((overdue_exists, 0), else_=1)
    return query.order_by(held_rank.asc(), overdue_rank.asc(), Gate.created_at.asc())


async def _resolve_gate_notification_targets(session: AsyncSession, org_id: uuid.UUID) -> list[uuid.UUID]:
    """story 1934: gate 생성 알림 대상 = org owner/admin 전원(수신자를 org_members에서 직접
    해소 — team_members VIEW는 grant-only 휴먼을 탈락시키므로 쓰지 않는다, feedback_team_
    members_view_human_drop 교훈).

    ⚠️휴먼은 `members.id == org_members.id`(E-MEMBER-SSOT AC2-1 앵커 백필 불변식)라 org_members.id
    를 그대로 dispatch_notification의 target_member_ids(member_id 공간)로 쓸 수 있다 — 별도
    JOIN/변환 불필요."""
    from sqlalchemy import text

    rows = await session.execute(
        text(
            """
            SELECT id FROM org_members
            WHERE org_id = :org_id AND deleted_at IS NULL AND role IN ('owner', 'admin')
            """
        ),
        {"org_id": org_id},
    )
    return [row[0] for row in rows.all()]

# verdict source → gate_type 매핑
_SOURCE_TO_GATE_TYPE: dict[str, str] = {
    "pr": "pr_review",
    "ci": "pr_review",
    "qa": "qa",
    "design": "deploy",
}

_DISPOSITION_TO_STATUS: dict[str, str] = {
    "allow_auto": "auto_passed",
    "ask": "pending",
    "deny": "rejected",
}

# #2237(오르테가 PO 판정 2026-07-27, ①→②): create_gate() 실 호출부 6곳을 전부 읽어 만든 「전량」 —
# DB에도 Pydantic에도 work_item_type 정본이 없다(gate_type만 GATE_TYPES로 검증됨, 비대칭 — 그 갭은
# 별도 스토리로 오르테가군이 등재). 아래 8개는 각 모델의 project_id 컬럼을 기계적으로 확認해 project-
# scoped로 분류한 것(새 규칙 발명 0 — 그냥 「project_id가 NOT NULL FK로 있는가」를 본 것):
#   story·task·doc·visual_artifact(원래 4개) + loop(LoopRun.project_id)·hypothesis(Hypothesis.
#   project_id)·epic(Goal.project_id — B1 rename 前 이름 그대로 남은 work_item_type 리터럴, 실체는
#   Goal)·sprint(Sprint.project_id) — 전부 NOT NULL FK(app/models/{loop,hypothesis,pm}.py 확認).
# 진짜 project-무관은 workflow_line_config의 'wf_line_version' 뿐(version.project_id가 nullable —
# 구조적으로 project 경계가 없을 수 있음, 그 호출부가 이미 로드된 엔티티의 project_id를 직접 넘김).
PROJECT_SCOPED_WORK_ITEM_TYPES: frozenset[str] = frozenset(
    {"story", "task", "doc", "visual_artifact", "loop", "hypothesis", "epic", "sprint"}
)
KNOWN_PROJECT_AGNOSTIC_WORK_ITEM_TYPES: frozenset[str] = frozenset({
    "wf_line_version",
    # story #2709(2026-08-17) — self-referencing standalone anchor(work_item_id==gate.id, work
    # item 없는 순수 질문). resolve_work_item_project_id()가 이 타입에 대응하는 실 테이블이
    # 없어 항상 None을 준다 — 여기 미등재였다면 gates.py의 fail-closed 분기(#2237)가 모든
    # GET /gates/{id}를 404로 거부했을 것(전수 grep으로 발견, 실제 배선 전 확認).
    "agent_decision",
})


def is_project_scoped_work_item_type(work_item_type: str) -> bool:
    """호출부가 resolve_work_item_project_id()의 None을 «project-무관 타입이라 통과»와
    «project-scoped 타입인데 해소 실패라 거부» 로 갈라 판단할 때 쓴다. 새 타입 발명이 아니라
    resolve_work_item_project_id가 이미 아는 분기를 그대로 드러낸 것(SSOT 재사용)."""
    return work_item_type in PROJECT_SCOPED_WORK_ITEM_TYPES


def is_known_project_agnostic_work_item_type(work_item_type: str) -> bool:
    """#2237(②, fail-closed 전환): resolve_work_item_project_id()가 None을 반환했을 때 «통과»는
    이 명시적 allowlist에 있는 타입에만 허용한다 — PROJECT_SCOPED_WORK_ITEM_TYPES에도 이 집합에도
    없는 미분류 타입(오타·미래에 추가될 새 타입)은 기본값이 «거부»다(과거엔 기본값이 «통과»라
    fail-open이었다 — 새 work_item_type이 조용히 다시 뚫리는 재발 클래스였다)."""
    return work_item_type in KNOWN_PROJECT_AGNOSTIC_WORK_ITEM_TYPES


async def resolve_work_item_project_id(
    session: AsyncSession, org_id: uuid.UUID, work_item_type: str, work_item_id: uuid.UUID,
) -> uuid.UUID | None:
    """story #1968: work_item_type/work_item_id → project_id 타입별 조회(신규 쿼리).

    ⚠️호출 전 먼저 확인: 그 함수 스코프에 이미 로드된 엔티티(story/doc/task/loop/artifact 등
    객체)가 있으면 이 헬퍼를 쓰지 말고 그 객체의 ``.project_id``를 직접 재사용할 것(신규 쿼리
    최소 원칙 — doc.py/loop.py/visual_artifacts.py/workflow_parallel_approval.py가 이미 이렇게
    한다). 이 헬퍼는 work_item_id(uuid)만 있고 엔티티가 아직 로드 안 된 호출부 전용
    (routers/gates.py 제네릭 생성 엔드포인트·merge_verdict_gate.py evaluate_merge_gate)과
    override_gate()의 sr(step_run)=None 폴백용.

    PROJECT_SCOPED_WORK_ITEM_TYPES 8종은 project_id가 NOT NULL이라 row가 있으면 항상 값이 있다.
    Task는 project_id 컬럼이 없어 story JOIN. 미지원/미인식 work_item_type(예: workflow_line_config의
    org-level 'wf_line_version' — 실제로 project-무관일 수 있음)은 None(best-effort — silent
    실패가 아니라 구조적으로 project-scoped가 아닐 수 있다는 정직한 신호). #2237: 호출부는 이 None을
    그대로 "통과"로 읽지 말고 is_known_project_agnostic_work_item_type()으로 한 번 더 갈라야 한다
    (project-scoped 타입의 해소 실패=거부, 진짜 무관 타입=통과 — 같은 None을 뭉개면 전자가 새는 것을
    #2237이 create_gate_endpoint에서 실측으로 확認했다).

    story #2082: visual_artifact 분기는 이 함수 신설 시(story #1968) 누락돼 있었다 —
    artifact_canonicalize 게이트(work_item_type="visual_artifact")의 project_id가 항상
    None으로 해소돼 assigned_to_me=true 인박스에서 project-level owner/admin에게 안 보이는
    (org owner/admin에게만 노출되는) 회귀였다. VisualArtifact.project_id는 NOT NULL이라
    Story/Doc과 동형으로 항상 해소 가능.

    #2237: loop(workflow_parallel_approval.py 병렬승인·loop.py 자체 결정 게이트)·hypothesis/epic/
    sprint(workflow_parallel_approval.py가 WorkflowLineStepRun.entity_type을 work_item_type으로
    그대로 넘긴다 — app/models/workflow_line.py ENTITY_TYPES={story,doc,hypothesis,epic,sprint})
    4종 신규 — 전부 project_id NOT NULL FK 확認 후 추가(기계적 확認, 새 규칙 아님)."""
    if work_item_type == "story":
        return (await session.execute(
            select(Story.project_id).where(Story.id == work_item_id, Story.org_id == org_id)
        )).scalar_one_or_none()
    if work_item_type == "task":
        return (await session.execute(
            select(Story.project_id)
            .join(Task, Task.story_id == Story.id)
            .where(Task.id == work_item_id, Task.org_id == org_id)
        )).scalar_one_or_none()
    if work_item_type == "doc":
        return (await session.execute(
            select(Doc.project_id).where(Doc.id == work_item_id, Doc.org_id == org_id)
        )).scalar_one_or_none()
    if work_item_type == "visual_artifact":
        return (await session.execute(
            select(VisualArtifact.project_id).where(
                VisualArtifact.id == work_item_id, VisualArtifact.org_id == org_id,
            )
        )).scalar_one_or_none()
    if work_item_type == "loop":
        return (await session.execute(
            select(LoopRun.project_id).where(LoopRun.id == work_item_id, LoopRun.org_id == org_id)
        )).scalar_one_or_none()
    if work_item_type == "hypothesis":
        return (await session.execute(
            select(Hypothesis.project_id).where(
                Hypothesis.id == work_item_id, Hypothesis.org_id == org_id,
            )
        )).scalar_one_or_none()
    if work_item_type == "epic":  # 실체=Goal(B1 rename 前 work_item_type 리터럴이 그대로 남음).
        return (await session.execute(
            select(Goal.project_id).where(Goal.id == work_item_id, Goal.org_id == org_id)
        )).scalar_one_or_none()
    if work_item_type == "sprint":
        return (await session.execute(
            select(Sprint.project_id).where(Sprint.id == work_item_id, Sprint.org_id == org_id)
        )).scalar_one_or_none()
    return None


# doc-gate v2 갭1: deliberate 인간 결재 gate — org allow_auto/deny posture 무관하게 항상 manual(pending).
# disposition auto-pass/auto-deny 제외(인간 deliberation 이 정책 자동결정보다 우선).
# 'loop_decision'(E-LOOP-LEDGER S5): variant 선택도 동일 이유로 항상 human pending — GATE_TYPES에도
# 미등록(doc_approval과 동일 선례. org gate override 설정 대상에서 제외=애초에 자동화 불가 명시).
# 'artifact_canonicalize'(E-CANVAS C4-S8): 정본화=계약(§1) — org auto posture 무관 항상 HITL.
# 'hypothesis_outcome_confirm'(story #2857): 측정 판정 초안=에이전트·확定=휴먼 계약 그 자체가
# 존재 이유라 org posture 무관 항상 HITL(agent_decision_request와 동형 근거).
_ALWAYS_MANUAL_GATE_TYPES: frozenset[str] = frozenset(
    {
        "doc_approval", "loop_decision", "artifact_canonicalize", "agent_decision_request",
        "hypothesis_outcome_confirm",
    }
)
# ⚠️story #2709 — agent_decision_request가 항상 manual(=posture 무관 항상 pending)인 이유:
# 이 게이트는 "사람의 판단"이 존재 이유인데, org posture가 permissive라고 자동 allow_auto가
# 걸리면 질문 자체가 응답 없이 자동 승인돼 버린다 — 애초에 물을 이유가 없어진다.


async def _reopen_rejected_gate(
    session: AsyncSession,
    gate: Gate,
    *,
    org_id: uuid.UUID,
    member_id: uuid.UUID,
    role_id: uuid.UUID,
    gate_type: str,
    neutral_facts: dict[str, Any] | None,
    project_id: uuid.UUID | None,
    notify: bool = True,
    designated_approver_id: uuid.UUID | None = None,
) -> Gate:
    """story #2150(P1) 근본수정 — create_gate()의 멱등 조회에 status 필터가 없어 rejected
    게이트를 그대로 반환했다(merge_verdict_gate.py의 ``gate_status=="rejected"`` 체크와
    합쳐져, 한 번 반려되면 그 작업 항목은 재제출해도 영구 BLOCK — 반려는 결재 게이트의
    정상 경로인데 "한 번 쓰고 버리는 스위치"가 되는 결함이었다).

    ⚠️approved/voided는 이 함수에 오지 않는다(호출부에서 status=="rejected"일 때만 호출) —
    각각 판단 근거(#2150 AC5):
      · approved — 이미 landed 작업의 재보고는 무해하므로 불변 유지(재오픈하면 이미 확정된
        승인이 최신 CI/PR 이벤트만으로 흔들리는 쪽이 오히려 위험).
      · voided   — void는 "이 게이트가 애초에 잘못 생성됐다"는 admin의 명시 무효화(S30)다.
        reject처럼 "평가했고 아니라고 했다"가 아니라 "이 평가 자체가 없었던 일"이라는
        선언이라, 자동 재오픈 대상이 아니다(admin이 다시 판단할 문제 — 이 스토리 스코프 밖).

    감사축 보존(AC④): 이전 결재(누가·언제·왜 반려했는지)를 지우지 않고 neutral_facts.
    decision_history에 append한다 — 게이트 row는 재사용(신규 row 생성 안 함, void/hold와
    동일하게 기존 row를 상태기계로 계속 쓰는 관례를 따른다).

    새 disposition은 **현재** org/member/role 정책을 다시 조회해 결정한다(과거에 사람이
    무슨 이유로 반려했는지가 아니라) — 그래서 정책이 여전히 deny면 재오픈해도 다시
    rejected로 떨어지고(정책이 안 바뀌었으니 정확한 동작), ask/allow_auto로 바뀌었으면
    pending/auto_passed로 새 사이클이 열린다(AC③)."""
    history_entry = {
        "status": gate.status,
        "resolver_id": str(gate.resolver_id) if gate.resolver_id else None,
        "resolved_at": gate.resolved_at.isoformat() if gate.resolved_at else None,
        "resolution_note": gate.resolution_note,
        "neutral_facts": gate.neutral_facts,
    }
    prior_history = list((gate.neutral_facts or {}).get("decision_history") or [])
    prior_history.append(history_entry)

    disposition, _source = await resolve_disposition(session, org_id, member_id, role_id, gate_type)
    new_status = _DISPOSITION_TO_STATUS.get(disposition, "pending")
    if gate_type in _ALWAYS_MANUAL_GATE_TYPES:
        new_status = "pending"

    set_gate_status(gate, new_status, now=datetime.now(timezone.utc))
    # story #2524(2026-08-08, codex 지적·#2520 QA 파생) — create_gate()의 신규 생성 분기는
    # requires_human=(status=="pending")을 채우는데(#2156 AC3), 이 재오픈 분기는 여태 status만
    # 갱신하고 requires_human은 안 건드렸다. rejected 게이트는 항상 requires_human이 "그
    # rejected가 되던 시점의" 값을 그대로 물려받으므로(대개 창설 시 deny 정책이면 애초에
    # False) — 정책이 그 사이(deny→ask 등) 바뀌어 재오픈이 pending으로 열리면 「status=pending
    # (사람 승인 필요)인데 requires_human=False(안 필요로 표기)」로 어긋난다. merge-type은
    # evaluate_merge_gate가 재오픈 직후 이 필드를 다시 정확히 덮어써(decision 기반) 이 갭이
    # 안 보였지만(#2520 조사로 non-issue 확인), qa 등 non-merge gate_type은 이 재오픈이
    # requires_human의 유일한 갱신 지점이라 여기서 직접 재기록한다(create_gate와 동일 규칙).
    gate.requires_human = (new_status == "pending")
    gate.resolver_id = None
    gate.resolution_note = None
    gate.resolved_at = datetime.now(timezone.utc) if new_status != "pending" else None
    # story #2985 — 재제출(새 결재 사이클)이면 이번 상신의 결재선으로 재stamp(doc.py의
    # requested_by_member_id 재stamp와 동일 관례 — 옛 사이클의 지정을 그대로 물려받지 않는다).
    gate.designated_approver_id = designated_approver_id
    merged_facts = dict(neutral_facts or {})
    merged_facts["decision_history"] = prior_history
    gate.neutral_facts = merged_facts

    logger.info(
        "gate_reopened_from_rejected org=%s gate=%s new_status=%s work=%s/%s",
        org_id, gate.id, new_status, gate.work_item_type, gate.work_item_id,
    )

    await session.flush()
    await session.refresh(gate)

    if new_status == "pending" and notify:
        try:
            target_ids = await _resolve_gate_notification_targets(session, org_id)
            if target_ids:
                from app.services.notification_dispatch import dispatch_notification
                await dispatch_notification(
                    session, org_id=org_id, event_type="gate.pending_approval",
                    target_member_ids=target_ids,
                    title="결재 대기 중인 게이트가 있습니다",
                    body=f"{gate_type} 게이트가 재제출되어 다시 승인/거부를 기다리고 있습니다.",
                    reference_type="gate", reference_id=gate.id,
                    source_project_id=project_id,
                    # story #2688: create_gate()의 신규-gate 경로(:475 부근)와 동일 결함 —
                    # 재상신(rejected→pending re-open) 경로도 동기 웹훅이 트랜잭션을 물었다.
                    via_outbox=True,
                )
        except Exception:
            logger.warning(
                "gate.pending_approval(reopen) notification failed gate_id=%s (swallowed·best-effort)",
                gate.id, exc_info=True,
            )
    return gate


async def find_gate_slot_with_pr_fallback(
    session: AsyncSession,
    *,
    org_id: uuid.UUID,
    work_item_id: uuid.UUID,
    work_item_type: str,
    gate_type: str,
    pr_number: int | None,
    repo_full_name: str | None = None,
) -> Gate | None:
    """story #2893(§2 A1, 0271) 후속 — 카디르 QA(PR#3349 CI 실 실패 2건, 2026-08-22):
    pr_number를 멱등 키에 편입한 것(정확매치 only)이 「PR 컨텍스트가 나중에 밝혀지는」
    정상 케이스까지 «다른 PR»과 똑같이 취급해 새 행을 만들며 옛 행을 고아화시켰다 —
    ①line-engine/board-preflight self-report shell(pr_number 모름, NULL) 後 실 PR이
    연결되는 경우 ②legacy/백필 누락 행의 재제출(rejected reopen). A1의 취지는 «서로
    다른 PR 간 격리»지 「PR 컨텍스트가 나중에 채워지는 같은 게이트의 분열」이 아니다
    (PO 확定).

    pr_number가 주어지면(실 PR 문맥) 먼저 그 PR 전용 슬롯을 정확매치로 찾는다. 없으면
    아직 pr_number를 모르던 시절의 NULL-슬롯이 있는지 찾아 **승격**(pr_number+
    repo_full_name을 채워 재사용 — flush까지 이 함수 책임, 호출자가 추가로 flush 안 해도
    이후 조회에 반영됨)한다. 승격 後엔 그 행이 이 PR(과 이 repo)에 귀속되므로(정확매치
    슬롯으로 편입) 다른 PR이 같은 NULL-슬롯을 다시 가로챌 길이 없다 — 실사고1/2가 막던
    축(서로 다른 PR의 SHA가 같은 슬롯을 공유)은 그대로 보존된다(승격은 "미상→특정 PR"
    1회성 전이일 뿐, "PR A→PR B" 전이는 이 함수가 만들어내지 않는다).

    repo_full_name: story #2932(HIGH1, 0272) — pr_number 단독은 repo 경계가 없어(같은
    스토리에 다른 repo의 동일 번호 PR이 링크되면 슬롯을 공유) SHA/evidence가 섞일 수
    있었다(카디르 소스 직접확認). repo_full_name이 주어지면 정확매치가 (pr_number,
    repo_full_name) 둘 다로 스코프된다 — 다른 repo의 같은 pr_number는 별개 슬롯.

    ⛔카디르 QA(PR#3359 3라운드, codex 발견) — repo_full_name이 **주어지지 않으면**
    (호출부가 정말 모름 — report-done류 self-report의 실 경로, workflow_report.py) "repo
    무관 아무 행이나 매치"로 물러나면 안 된다. 이 PR이 정당하게 허용한 「같은 pr_number·
    다른 repo 2행 이상」 상태에서 그런 조회가 `MultipleResultsFound`(500)로 죽었다(실사고).
    `pr_number IS NULL`(PR 컨텍스트 자체 미상)과 대칭으로, repo_full_name=None 조회는
    **repo도 마찬가지로 모르는 행**(`repo_full_name IS NULL`)만 매치한다 — 그 조건을
    만족하는 행은 구조적으로 최대 1개뿐이라(`uq_gate_work_item_gate_type_pr_no_repo`)
    모호성이 원천적으로 없다. repo를 아는 기존 행과는 별개 identity로 남는다(멋대로
    병합하지 않는다 — 어느 쪽이 "진짜"인지 여기서 판단할 근거가 없다).

    **동시성**(story #2932 HIGH2): NULL-슬롯 승격은 read-then-write라 동시 웹훅 2개가
    같은 NULL-슬롯을 서로 다른 PR로 경쟁 승격할 수 있었다(나중 커밋이 조용히 덮어씀).
    NULL-슬롯 조회에 `SELECT ... FOR UPDATE`를 걸어 두 번째 트랜잭션이 첫 번째의 커밋을
    기다리게 한다 — 커밋 後 재평가되는 WHERE(`pr_number IS NULL`)가 더는 참이 아니므로
    두 번째는 자연히 None을 받아(이미 승격된 슬롯을 못 봄) 새 실 INSERT 경로로 빠진다
    (row가 이미 존재하는 UPDATE류 경합이라 SELECT FOR UPDATE가 유효 — row 자체가 없는
    check-then-insert TOCTOU와는 다른 축, feedback_check_then_insert_toctou 참고).

    pr_number가 None(PR 컨텍스트가 원래 없는 gate_type 또는 board-preflight no-substance)
    이면 옛 계약 그대로 NULL-슬롯만 찾는다 — 승격 대상 자체가 없다("PR 컨텍스트 있음"으로
    바꿀 근거가 없다).

    카디르 QA(story #2932 HIGH1, 2026-08-22, 이 PR 자체 재재verdict) — repo_full_name을
    대소문자/공백 그대로 비교하면 `Acme/Repo`≠`acme/repo`로 같은 실 repo가 다른 슬롯으로
    분열한다(DB 유니크 인덱스도 case-sensitive). 기존 SSOT `pr_story_link.py::normalize_repo`
    (strip+lower)를 여기(읽기·쓰기 둘 다의 단일 관문)서 관통시킨다 — 호출부가 원본 대소문자를
    그대로 넘겨도 이 함수 안에서 항상 정규화되므로 4개 호출부 전부를 개별 수정할 필요가
    없다(단일 chokepoint)."""
    if repo_full_name is not None:
        from app.services.pr_story_link import normalize_repo
        repo_full_name = normalize_repo(repo_full_name) or None
    if pr_number is not None:
        exact_conditions = [
            Gate.org_id == org_id, Gate.work_item_id == work_item_id,
            Gate.work_item_type == work_item_type, Gate.gate_type == gate_type,
            Gate.pr_number == pr_number,
        ]
        # 카디르 QA(story #2932, PR#3359 3라운드, codex 발견) — repo_full_name이 없을 때
        # (호출부가 정말 모름 — report-done류 self-report의 실 경로) repo 필터를 아예
        # 안 걸면, 이 PR이 정당하게 허용한 「같은 pr_number·다른 repo 2행 이상」 상태를
        # 만나 scalar_one_or_none()이 MultipleResultsFound로 500을 낸다(실사고). repo를
        # 모른다는 것을 "아무 repo나 매치"로 지어내지 않는다 — `Gate.pr_number.is_(None)`
        # (아래 NULL-슬롯 매치)과 대칭으로, repo_full_name=None 조회는 **repo도 마찬가지로
        # 모르는 행**(repo_full_name IS NULL, 이 함수 자신이 승격시켜 둔 행 포함)만 매치한다
        # — 정확히 한 행만 있을 수 있는 조건(uq_gate_work_item_gate_type_pr_no_repo)이라
        # 구조적으로 모호성이 없다. repo를 아는 기존 행과는 다른 identity로 남는다(멋대로
        # 병합하지 않는다 — 어느 쪽이 "진짜"인지 여기서 판단할 근거가 없다).
        exact_conditions.append(
            Gate.repo_full_name == repo_full_name if repo_full_name is not None
            else Gate.repo_full_name.is_(None)
        )
        exact = (
            await session.execute(select(Gate).where(*exact_conditions))
        ).scalar_one_or_none()
        if exact is not None:
            return exact

        # story #2932(HIGH1 잔여) — pr_number는 이미 정확히 아는데 repo만 몰랐던 legacy/
        # 미백필 행이 있으면(0272 백필 누락·neutral_facts.repo 부재 등) 「repo가 나중에
        # 밝혀지는」 같은 클래스의 정상 케이스다 — NULL-슬롯 승격과 대칭: pr_number 대신
        # repo_full_name 하나만 미상인 슬롯을 찾아 승격한다(고아화 방지, 새 규칙 발명 0).
        if repo_full_name is not None:
            repo_unknown_slot = (
                await session.execute(
                    select(Gate).where(
                        Gate.org_id == org_id, Gate.work_item_id == work_item_id,
                        Gate.work_item_type == work_item_type, Gate.gate_type == gate_type,
                        Gate.pr_number == pr_number, Gate.repo_full_name.is_(None),
                    ).with_for_update()  # story #2932 HIGH2와 동일 이유 — 동시 승격 경쟁 직렬화.
                )
            ).scalar_one_or_none()
            if repo_unknown_slot is not None:
                repo_unknown_slot.repo_full_name = repo_full_name
                await session.flush()
                return repo_unknown_slot

        null_slot = (
            await session.execute(
                select(Gate).where(
                    Gate.org_id == org_id, Gate.work_item_id == work_item_id,
                    Gate.work_item_type == work_item_type, Gate.gate_type == gate_type,
                    Gate.pr_number.is_(None),
                ).with_for_update()  # story #2932 HIGH2 — 동시 승격 경쟁 직렬화.
            )
        ).scalar_one_or_none()
        if null_slot is not None:
            null_slot.pr_number = pr_number
            null_slot.repo_full_name = repo_full_name
            await session.flush()
        return null_slot
    return (
        await session.execute(
            select(Gate).where(
                Gate.org_id == org_id, Gate.work_item_id == work_item_id,
                Gate.work_item_type == work_item_type, Gate.gate_type == gate_type,
                Gate.pr_number.is_(None),
            )
        )
    ).scalar_one_or_none()


async def find_pending_merge_gates_by_head_sha(
    session: AsyncSession, *, org_id: uuid.UUID, head_sha: str,
) -> list[Gate]:
    """story #3033(2026-08-24, PO 판정) — CI verdict는 PR의 속성이 아니라 SHA의 속성이다.

    실사고 그라운딩(#3350 MERGED·#3307 CLOSED, 2/2 실물): 스택형 형제 PR이 같은 head SHA를
    공유하면(브랜치를 다른 PR에 이어 붙이는 관례), 원 PR이 머지된 뒤 도착하는 CI-완료 웹훅
    (check_suite/workflow_run/status)의 `pull_requests[]`에서 GitHub이 그 PR을 빼버린다
    (머지된 PR은 더는 그 SHA의 "현재 head"가 아니므로) — 남는 건 그 SHA를 여전히 물고 있는
    형제 PR뿐이다. `_extract_pr_ci`가 그 페이로드에서 뽑는 pr_number는 그래서 **원 PR이
    아니라 형제 PR**을 가리키고, `find_gate_slot_with_pr_fallback`(work_item_id=story_id
    스코프)는 애초에 "다른 story일 수도 있는" 그 형제 게이트를 찾을 근거가 없다(순환 —
    story 자체를 pr_number 경유로 아는데, 그 pr_number가 이미 틀렸다).

    그래서 이 폴백은 **story 스코프를 걷어내고 org+SHA로만** 찾는다 — `gate.github_check_run_sha`
    는 그 게이트가 생성될 때 찍힌 실 head SHA(anchor)라 「이 SHA의 CI가 완료됐다」는 사실을
    story 경계 없이 그대로 반영할 수 있다(SHA는 조직 전역에서 유일). 일치가 여럿(형제 PR
    각자의 게이트, 같은 story든 다른 story든)이면 **전부** 후보 — 같은 SHA의 CI 결과는
    사실 그 자체로 공유되는 것이지 임의 선택이 아니다.

    ⛔pending/auto_passed만: `find_gate_slot_with_pr_fallback`과 동일 이유(rejected/voided/
    held는 사람이 이미 명시 결정했거나 일시정지한 것 — CI 이벤트로 조용히 재오픈/간섭 금지).
    ⛔pr_result는 이 함수의 관심사가 아니다 — 호출자(`reconcile_merge_gate_with_real_evidence`)
    가 ci_result만 갱신하고 pr_result는 각 게이트의 기존 값을 보존한다(머지/클로즈 여부는
    PR별 사실이라 SHA로 공유될 근거가 없다 — PO 명시 구분)."""
    # 순환 import 회피(merge_verdict_gate.py가 이 모듈을 모듈 레벨에서 import) — 이 파일의
    # 1444행 기존 관례와 동일하게 함수 안에서 지역 import.
    from app.services.merge_verdict_gate import MERGE_GATE_TYPE

    return list((
        await session.execute(
            select(Gate).where(
                Gate.org_id == org_id, Gate.gate_type == MERGE_GATE_TYPE,
                Gate.github_check_run_sha == head_sha,
                Gate.status.in_(("pending", "auto_passed")),
            )
        )
    ).scalars().all())


async def create_gate(
    session: AsyncSession,
    org_id: uuid.UUID,
    work_item_id: uuid.UUID,
    work_item_type: str,
    gate_type: str,
    member_id: uuid.UUID,
    role_id: uuid.UUID,
    neutral_facts: dict[str, Any] | None = None,
    project_id: uuid.UUID | None = None,
    notify: bool = True,
    gate_id: uuid.UUID | None = None,
    pr_number: int | None = None,
    repo_full_name: str | None = None,
    designated_approver_id: uuid.UUID | None = None,
) -> Gate:
    """config 기반 게이트 생성 (멱등: 이미 있으면 기존 반환).

    pr_number: story #2893(설계안 §2 A1) — merge-type만 실제로 쓴다(호출부는
    evaluate_merge_gate 하나뿐, 그라운딩 확認). 나머지 7개 호출부는 인자를 안 넘겨
    기본값 None 그대로 — 멱등 키가 `(work_item_id, work_item_type, gate_type)` 옛
    계약대로 유지된다(무회귀). None이면 "PR 컨텍스트 없음"을 지어내지 않고 그대로 둔다
    (0 같은 sentinel로 바꾸지 않음 — DB 컬럼 자체가 nullable Integer).

    repo_full_name: story #2932(HIGH1) — pr_number와 짝. pr_number 단독은 repo 경계가
    없어 다른 repo의 같은 번호 PR이 슬롯을 공유할 수 있었다(cross-repo 충돌). pr_number를
    넘기는 유일 호출부(evaluate_merge_gate)가 항상 실 repo를 알고 있어 함께 넘긴다.

    gate_id: story #2709(2026-08-17, PO 판정) — self-referencing standalone anchor(work_item이
    없는 순수 질문류 gate_type)를 위한 파라미터. 호출측(MCP 도구)이 uuid4를 미리 만들어
    이 인자와 work_item_id 둘에 **같은 값**을 넣으면, 별도 UPDATE 없이 1 INSERT로 gate.id==
    gate.work_item_id가 성립(생성 後 2단계 갱신 금지, 원자성). 미지정 시(기존 18곳 전부)
    기존 그대로 내부에서 uuid.uuid4() 생성 — 무회귀.

    project_id: story #1953(P1a-S3)이 처음 배선·story #1968(P1a-S3 잔여)이 완성 — gate.pending_
    approval 알림 payload의 project_id 보강용(선택적). create_gate()는 gate_type/work_item_type을
    가리지 않는 공용 chokepoint라 work_item_type별 project_id 해소 로직을 여기 내장하지 않는다 —
    호출부가 이미 로드된 엔티티에서 알고 있으면(artifact_canonicalize·doc_approval·loop_decision·
    parallel merge 등) 그대로 넘기고, work_item_id만 갖고 엔티티가 없는 호출부(범용 gates.py
    직접생성·merge 게이트)는 ``resolve_work_item_project_id()``로 조회해 넘긴다(story #1968).
    workflow_line_config(wf_line_version)처럼 진짜 org-level(project 무관)일 수 있는 work_item은
    ``version.project_id``(nullable)를 그대로 넘겨 None이 나올 수 있다 — 이건 미해결이 아니라
    구조적으로 project-scoped가 아니라는 정직한 값이다.

    notify: story #373cfaa1 — 호출부가 이미 자기 전용의 리치 알림(제목/본문+카드 등)을 별도로
    보낼 때, 이 generic "gate.pending_approval" 벨과의 중복을 끄는 opt-out(기본값 True=기존
    全 호출부 무회귀). gate_type/work_item_type별 하드코딩 대신 호출부 판단으로 남겨 이 함수의
    공용 chokepoint 성격을 유지한다.

    designated_approver_id: story #2985(PO 설계 확定 2026-08-24) — 상신 시 지정한 결재선(선택).
    None(기본값, 기존 全 호출부 무회귀)이면 지정 없음 — dispatch_approval_request_cards가
    권한자 전원에게 액션 카드를 보내는 현행 그대로. 지정하면 그 1인만 액션·나머지는 정보성
    (호출부가 이 값을 실 dispatch_approval_request_cards 호출에도 같이 넘겨야 실제로
    갈린다 — 여기서는 Gate 행에 저장만).
    """
    # 카디르 QA(story #2932 HIGH1, 2026-08-22) — repo_full_name도 find_gate_slot_with_pr_
    # fallback과 동일하게 여기서 정규화한다: 이 함수의 Gate(...) INSERT는 그 헬퍼를 거치지
    # 않으므로(조회만 거침) 별도로 정규화해야 저장값 자체가 일관된다(대소문자 다른 두
    # 호출이 같은 실 repo인데 다른 슬롯으로 분열하는 것 방지).
    if repo_full_name is not None:
        from app.services.pr_story_link import normalize_repo
        repo_full_name = normalize_repo(repo_full_name) or None

    # 멱등: 이미 존재하면 기존 반환. story #2893 — pr_number도 키에 편입(0271 부분
    # 유니크 인덱스와 동형 조건). find_gate_slot_with_pr_fallback가 정확매치 우선+
    # NULL-슬롯 승격 폴백까지 처리(카디르 QA, PR#3349 CI 실패 2건 후속 — pr_number가
    # 나중에 밝혀지는 정상 케이스를 다른 PR과 혼동해 고아 행을 만들던 결함).
    existing = await find_gate_slot_with_pr_fallback(
        session, org_id=org_id, work_item_id=work_item_id,
        work_item_type=work_item_type, gate_type=gate_type, pr_number=pr_number,
        repo_full_name=repo_full_name,
    )
    if existing is not None:
        # story #2150 근본수정: rejected는 재제출 시 새 결재 사이클을 연다(그 외 terminal
        # status는 기존 그대로 불변 반환 — 판단 근거는 _reopen_rejected_gate 참조).
        if existing.status != "rejected":
            return existing
        return await _reopen_rejected_gate(
            session, existing, org_id=org_id, member_id=member_id, role_id=role_id,
            gate_type=gate_type, neutral_facts=neutral_facts, project_id=project_id,
            notify=notify, designated_approver_id=designated_approver_id,
        )

    # SID 301ee45d/#2047: 반환값이 (disposition, source) — 이 범용 생성기는 disposition→status
    # 매핑만 필요해 source는 버린다(explicit-ask 판정은 merge_verdict_gate.py의 no-substance
    # 체크에서만 쓰인다).
    disposition, _source = await resolve_disposition(session, org_id, member_id, role_id, gate_type)
    status = _DISPOSITION_TO_STATUS.get(disposition, "pending")
    # doc-gate v2 갭1(선생님 실 Web): doc_approval 류 deliberate gate 는 disposition auto-pass 무관하게
    # 항상 pending. auto_passed 면 수동 결재가 Gate inbox 에 안 떠 결재 불능(인간 결재 의도 우선).
    if gate_type in _ALWAYS_MANUAL_GATE_TYPES:
        status = "pending"

    gate = Gate(
        id=gate_id or uuid.uuid4(),
        org_id=org_id,
        work_item_id=work_item_id,
        work_item_type=work_item_type,
        gate_type=gate_type,
        pr_number=pr_number,
        repo_full_name=repo_full_name,
        status=status,
        # #2156 AC3(2026-08-07) — merge-type만 evaluate_merge_gate가 이후 이 필드를 정확히
        # 채웠고(decision 기반), 그 외 gate_type(qa·pr_review·deploy 등)은 create_gate가 여태
        # requires_human을 아예 대입하지 않아 DB 컬럼 기본값 False가 그대로 남았다 — status는
        # disposition대로 정확히 pending인데 requires_human=False가 "안 봐도 됨"으로 잘못
        # 신호를 내 인박스에 안 뜨는 원인이었다(유나 실측 "축 없음 4건"). status==pending이면
        # 사람 결재가 필요하다는 뜻이니 그대로 반영 — merge-type은 evaluate_merge_gate가 바로
        # 뒤에서 더 정확한 값(decision != AUTO_MERGE)으로 덮어써 이 기본값은 초기값일 뿐이다.
        requires_human=(status == "pending"),
        # #2249: 신규 행이라 값 비교(set_gate_status)가 필요 없다 — 생성 시점이 곧 최초 진입 시각.
        status_entered_at=datetime.now(timezone.utc),
        neutral_facts=neutral_facts,
        resolved_at=datetime.now(timezone.utc) if status != "pending" else None,
        designated_approver_id=designated_approver_id,
    )
    session.add(gate)
    await session.flush()
    await session.refresh(gate)

    # story 1934(선생님 앱 done-gate: "디스코드 떼고 승인게이트 실시간 알림+즉시 액션"):
    # pending 상태(진짜 결재 대기)일 때만 알림 — auto_passed/rejected는 즉시 확정이라 결재
    # 액션이 없다. best-effort(알림 실패가 게이트 생성 자체를 롤백하면 안 됨 — deliver_expo_
    # push/override 알림과 동일 관례).
    if status == "pending" and notify:
        try:
            target_ids = await _resolve_gate_notification_targets(session, org_id)
            if target_ids:
                from app.services.notification_dispatch import dispatch_notification
                await dispatch_notification(
                    session, org_id=org_id, event_type="gate.pending_approval",
                    target_member_ids=target_ids,
                    title="결재 대기 중인 게이트가 있습니다",
                    body=f"{gate_type} 게이트가 승인/거부를 기다리고 있습니다.",
                    reference_type="gate", reference_id=gate.id,
                    source_project_id=project_id,
                    # story #2688: 동기 개인 webhook 실POST가 create_gate() 호출부(예:
                    # docs/{id}/transition draft→pending)의 열린 트랜잭션 커넥션을 붙잡아
                    # 요청을 초 단위로 지연시켰다(실측 2.7s→220ms). story #2460 §6 봉합②
                    # outbox 경로 재사용.
                    via_outbox=True,
                )
        except Exception:
            logger.warning(
                "gate.pending_approval notification failed gate_id=%s (swallowed·best-effort)",
                gate.id, exc_info=True,
            )

    return gate


async def transition_gate(
    session: AsyncSession,
    org_id: uuid.UUID,
    gate_id: uuid.UUID,
    new_status: str,
    resolver_id: uuid.UUID | None = None,
    note: str | None = None,
    *,
    pending_deliveries: list[dict[str, Any]] | None = None,
) -> Gate:
    """게이트 상태 전이 — 불법 전이 시 ValueError 발생.

    ``pending_deliveries``(ccbcd9da A-1, additive): 넘기면 line resolution(doc/epic 자동재개)이 만든
    wake/delivery 페이로드를 append — 호출자가 자기 commit 후 wake_agent/webhook 스케줄(#1364 선례
    동형). 생략(기존 호출자 전부)은 무변경(수집 안 함·이 함수 자체는 commit 하지 않음)."""
    gate_r = await session.execute(
        select(Gate).where(Gate.id == gate_id, Gate.org_id == org_id)
    )
    gate = gate_r.scalar_one_or_none()
    if gate is None:
        raise ValueError(f"Gate {gate_id} not found")

    if not is_valid_transition(gate.status, new_status):
        raise ValueError(
            f"불법 전이: {gate.status} → {new_status}. "
            f"pending에서만 approved|rejected로 전이 가능."
        )

    # P0-04(doc trust-pipeline-be-design §4 훅①): trust_stage mutation 전 스냅샷(story 대상 게이트만).
    _trust_before = None
    if gate.work_item_type == "story":
        from app.services.trust_pipeline import compute_trust_facts

        _trust_before = await compute_trust_facts(session, org_id, gate.work_item_id)

    set_gate_status(gate, new_status, now=datetime.now(timezone.utc))
    gate.resolver_id = resolver_id
    gate.resolved_at = datetime.now(timezone.utc)
    # story #2027: 이전엔 rejected 에만 저장 — approved 도 note 를 받을 수 있는데(override 의
    # reason·이번 고위험 강제 사유 포함) 조용히 버려졌다(감사 추적 훼손). status 무관 note 있으면 저장.
    if note:
        gate.resolution_note = note

    # story #2631(PO 판정 ①, 2026-08-15): 게이트 해소 계열 액션(approve/reject/undo/
    # discuss-request)을 ActivityLog(immutable)에 처음으로 구조화 기록 — 지금까지 gate 행
    # (resolver_id/resolved_at/resolution_note)이 "현재 상태"만 담아, 취소(undo_gate_resolution
    # 참조) 시 원 액션의 흔적이 통째로 사라지는 감사 갭이 있었다(취소 기능이 없어도 이미
    # 결함이었음). 범위 절제: 게이트 해소 계열만 — 결재 감사 프레임워크 일반화는 이 스토리
    # 밖(PO 판정).
    from app.services.activity_log import ActivityLogService

    await ActivityLogService(session).record(
        org_id=org_id,
        action=f"gate_{new_status}",
        actor_id=resolver_id,
        actor_type="human",  # authz(router)가 human만 통과시킨다 — 93fc7aeb.
        entity_type="gate",
        entity_id=gate.id,
        context={
            "gate_type": gate.gate_type,
            "work_item_type": gate.work_item_type,
            "work_item_id": str(gate.work_item_id),
            "note": note,
            # story #2975 AC4(PO 확定 2026-08-24) — 「이 액션이 어느 SHA에 대한 것이었나」를
            # 이 시점의 gate.github_check_run_sha로 스냅샷. gate.approved_head_sha 컬럼은
            # 이후 재-pending 시 null로 되돌아가(gate_github_check.py::reopen_gate_if_new_sha)
            # 그 시점의 역사가 사라지므로, append-only인 이 context가 유일한 영속 기록이 된다.
            # merge 게이트가 아니면 애초에 None(무관 필드 — 조용히 무해).
            "head_sha": gate.github_check_run_sha,
        },
    )

    # H1-S7: 사람 게이트 해소(approve/reject)를 verdict로 기록 — trust로 환류.
    await _record_gate_review_verdict(session, org_id, gate, new_status, resolver_id)

    # HO-S7: cold-start(outcome 표본 부족)에서 사람의 keep/kill 결정을 seed로 기록(trust 본점수
    # 미포함·outcome 해소 후 calibration). merge·cold-start가 아니면 no-op.
    from app.services.cold_start_seed import record_cold_start_seed  # 순환 회피 lazy import.

    await record_cold_start_seed(session, org_id, gate, new_status, resolver_id)

    # story #2985 AC2(PO 계약 확定 2026-08-24) — 원 카드(액션+정보성 무관) 받았던 전원의 열린
    # 화면이 새로고침 없이 "처리됨"으로 갱신되게. gate_type/line-bound 여부와 무관하게 항상
    # (아래 line-resolution 분기 이전) — best-effort(실패해도 해소 자체는 막지 않음, 다른
    # notify_* 형제들과 동일 관례). Event 행 자체는 pending_deliveries 유무와 무관하게 항상
    # 남긴다(재연결 backfill로도 도달 — durable). 즉시(live) push는 호출부가
    # pending_deliveries를 넘겼을 때만 추가로 시도(호출부가 이미 commit-후-push 계약을 쓰고
    # 있다는 뜻 — 없으면 backfill 경로로만 도달, 무강제).
    if new_status in ("approved", "rejected"):
        try:
            from app.services.approval_delivery import notify_gate_card_recipients_resolved
            _sse_pushes = await notify_gate_card_recipients_resolved(
                session, org_id=org_id, gate_id=gate.id, status=new_status,
                resolver_id=resolver_id, resolved_at=gate.resolved_at,
            )
            if pending_deliveries is not None:
                for _pid_str, _sse_payload in _sse_pushes:
                    pending_deliveries.append({"sse_push": {"pid_str": _pid_str, "payload": _sse_payload}})
        except Exception:  # noqa: BLE001 — best-effort, 실시간 반영 실패가 게이트 해소를 막지 않음.
            logger.warning("gate_resolved 카드 실시간 반영 배선 실패 gate=%s", gate.id, exc_info=True)

    # story #1715(PO 판정 2026-08-24) — 상신자(requested_by_member_id) 회신은 gate_type/
    # line-bound 분기와 무관하게 **이 한 자리에서만** 부른다(아래 if/else 갈리기 전) — 두
    # 경로 양쪽에 각자 호출을 심으면 "구조적으로 배타적"이라는 주장이 코드 두 곳의 일치에
    # 의존하게 된다(다음 사람이 한쪽만 고치면 조용히 깨지는 자리). 단일 호출점이면 이중발송
    # 자체가 원리적으로 불가능 — _notify_doc_gate_requester 내부가 gate_type 스위치가 아니라
    # neutral_facts.requested_by_member_id **유무**로 자기 자신을 게이트한다(PO 지적 — 판별축
    # 정정: gate_type이 아니라 "상신자가 실제로 있는가"가 맞는 축).
    await _notify_doc_gate_requester(session, gate, new_status)

    # E-DG S6: gate 전이를 범용 line resolution 에 배선. gate 에 묶인 active line step_run 이 있으면
    # apply_workflow_line_resolution(H1/line approve 동일 status side-effect 경로)·없으면 legacy
    # _advance_story_on_merge_approve 유지(무회귀). 신규 승인경로 0.
    from app.services.workflow_line_resolution import (
        apply_workflow_line_resolution,
        find_active_step_run_for_gate,
    )

    _line_step_run_id = await find_active_step_run_for_gate(session, org_id, gate.id)
    if _line_step_run_id is not None:
        _wake_payload = await apply_workflow_line_resolution(
            session, _line_step_run_id, new_status, resolver_id=resolver_id
        )
        if _wake_payload is not None and pending_deliveries is not None:
            pending_deliveries.append(_wake_payload)
    else:
        # story #2965(PO 판정 2026-08-23) — H1-FIX-2가 여기서 story를 done으로 자동전진시키던
        # 것을 제거했다. merge 게이트 approve는 이 이벤트 자체가 "머지됐다"는 뜻이 아니다(PR이
        # 아직 미머지인 채 approve만 된 상태가 정상 경로 — design 라벨·CLEAN 대기 등) — approve
        # 순간 done이 되면 배포되지 않은 것을 "완료"라 말하는 no-fiction 위반이었다(2933→2931
        # →2952→2958에서 하루 4회 재발, 매번 PO가 in-review로 수동 되돌림).
        # ⛔되살리기 前 반드시 확認할 것 — story #2327(2026-07-30, PO 판정)이 같은 문제를 다른
        # 트리거(PR merge 웹훅 close-on-merge)로 이미 겪고 정지시켰다: "머지 ≠ done, done은 사람
        # 확認 後"가 이 조직의 규율이다. 트리거를 gate-approve든 PR-merge든 무엇으로 바꿔도, 사람의
        # AC 전량 대조 확認 없이 이벤트 하나로 done을 미는 것 자체가 그 판정의 대상이다. done은
        # 오직 사람이 board에서 명시 PATCH하는 경로 하나로 통일한다(그 경로는 그대로 살아있다).
        # advance_story_to_done()(story_status_events.py) 자체는 삭제하지 않는다 — 조직 단위
        # auto-done on/off 설정이 생기면(#2327이 남긴 되살리기 조건, 아직 없음) 그 설정을 읽어
        # 조건부로 재배선할 단일 idempotent 헬퍼로 의도적으로 남겨둔다.
        # E-DG doc-gate(48f064e5): doc 결재 게이트 approve→confirmed·reject→denied.
        await _resolve_doc_gate(session, gate, new_status)
        # story #2624 — 상신자 회신은 이제 이 if/else 진입 前 단일 호출점(위 story #1715 주석
        # 참조)에서 이미 처리됨. doc.status 변경 순서와 무관(회신 내용은 gate 필드에서만
        # 유도 — _notify_doc_gate_requester가 아래서 다시 안 불림, 여기 있던 호출 제거).
        # E-CANVAS C4-S8(story a5118cb0): 정본화 게이트 approve→anchor_version set·reject→재논의 코멘트.
        await _resolve_artifact_canonicalize_gate(session, gate, new_status)
        # HITL crux(story 7726a003) — A2A task INPUT_REQUIRED 복귀. writer 미배선이라 오늘은 no-op.
        await _resume_a2a_task_on_gate_resolve(session, gate, new_status)
        # story #2857(loop-closure P2-B): 측정 판정 초안=에이전트·확定=휴먼 — approve 시만
        # hypothesis 실 전이(via_gate=True). 새 gate_type 외 no-op(기존 함수들과 동형 자리).
        from app.services.hypothesis_outcome_confirm import resolve_hypothesis_outcome_confirm_gate

        await resolve_hypothesis_outcome_confirm_gate(session, gate, new_status, resolver_id)

    # E-VERIFY V0-S2(story 3fbd048d): 휴먼 gate 승인 → gate_approval evidence 자동 편입(순수
    # additive — approved+story/task work_item_type 아니면 no-op).
    from app.services.evidence_service import create_gate_approval_evidence_if_applicable

    await create_gate_approval_evidence_if_applicable(session, gate, new_status, resolver_id)

    await session.flush()
    await session.refresh(gate)

    if _trust_before is not None:
        from app.services.trust_pipeline import maybe_emit_trust_stage_changed

        await maybe_emit_trust_stage_changed(
            session, org_id, gate.work_item_id, _trust_before, actor_id=resolver_id
        )

    return gate


# story #2631(2026-08-15, 선생님 실사용 발견 08-13 19:49): 반려 의도로 승인을 오클릭 —
# 해소를 되돌릴 경로도, 「승인도 반려도 아닌」 상태도 없었다. 두 축을 더한다:
# ① undo_gate_resolution — 해소자 본인이 짧은 창 안에서 자기 해소를 취소.
# ② request_gate_discussion — 승인/반려 옆 3안, 게이트는 pending 유지한 채 상신자에게 회신.
GATE_UNDO_WINDOW = timedelta(minutes=5)


class GateUndoNotSelfError(Exception):
    """취소 시도자가 원 해소자 본인이 아님 — 라우터가 403으로 매핑."""


class GateUndoWindowExpiredError(Exception):
    """취소 창(GATE_UNDO_WINDOW) 경과 — 라우터가 403으로 매핑."""


async def undo_gate_resolution(
    session: AsyncSession,
    org_id: uuid.UUID,
    gate_id: uuid.UUID,
    actor_id: uuid.UUID,
    *,
    now: datetime | None = None,
) -> Gate:
    """AC1/AC3 — 해소(approved/rejected) 직후 짧은 창 안에서 **해소자 본인만** 취소해
    pending으로 되돌린다. 오클릭 정정용이지 재심 경로가 아니다(SoD 불변 — 인가는 "본인
    해소를 본인이 되돌린다"는 사실 하나로 성립, 새 권한을 안 연다).

    ⛔범위 절제(PO 판정 ③, doc_approval이 1차 실증 대상): `_resolve_doc_gate`가 건 doc
    status(confirmed/denied)는 여기서 되돌린다(안 되돌리면 gate=pending인데 doc=confirmed
    인 화면 모순이 생긴다). **다른 부수효과**(workflow_line_resolution의 line 전진·
    _advance_story_on_merge_approve의 story 진행·trust_pipeline stage 등)는 이 스토리
    스코프 밖 — 되돌리지 않는다(가드가 못 잡는 것으로 명시. line-bound 게이트는 line이
    이미 다음 스텝으로 넘어갔을 수 있어 "pending 복귀"가 그 자체로 안전을 보장 못 한다).
    """
    now = now or datetime.now(timezone.utc)
    gate = (await session.execute(
        select(Gate).where(Gate.id == gate_id, Gate.org_id == org_id)
    )).scalar_one_or_none()
    if gate is None:
        raise ValueError(f"Gate {gate_id} not found")
    if gate.status not in ("approved", "rejected"):
        raise ValueError(
            f"취소 불가: 게이트가 {gate.status} 상태입니다 (승인/반려된 게이트만 취소 가능)."
        )
    if gate.resolver_id != actor_id:
        raise GateUndoNotSelfError("본인이 해소한 게이트만 취소할 수 있습니다.")
    if gate.resolved_at is None or now - gate.resolved_at > GATE_UNDO_WINDOW:
        raise GateUndoWindowExpiredError(
            f"취소 창({int(GATE_UNDO_WINDOW.total_seconds() // 60)}분)이 지났습니다."
        )

    # 취소 전 원 액션 스냅샷 — status 를 pending 으로 되돌리면 gate 행 자체에선 사라지는 값이라
    # ActivityLog context 에 남겨야 "원 액션이 무엇이었는지"가 취소 이력에서도 보인다.
    _prev_status = gate.status
    _prev_resolver_id = gate.resolver_id
    _prev_resolved_at = gate.resolved_at
    _prev_note = gate.resolution_note
    # story #2975 AC4 — approved_head_sha(무엇이 승인됐었나)도 취소로 곧 사라질 값이라 스냅샷.
    _prev_approved_head_sha = gate.approved_head_sha

    from app.services.doc import DOC_GATE_TYPE, DOC_GATE_WORK_ITEM_TYPE
    if gate.work_item_type == DOC_GATE_WORK_ITEM_TYPE and gate.gate_type == DOC_GATE_TYPE:
        _expected_doc_status = "confirmed" if _prev_status == "approved" else "denied"
        doc = (await session.execute(
            select(Doc).where(
                Doc.id == gate.work_item_id, Doc.org_id == org_id, Doc.deleted_at.is_(None),
            )
        )).scalar_one_or_none()
        if doc is not None and doc.status == _expected_doc_status:
            doc.status = "pending"  # 멱등 가드: 그 사이 다른 경로로 이미 바뀌었으면 안 건드림.

    set_gate_status(gate, "pending", now=now)
    gate.resolver_id = None
    gate.resolved_at = None
    gate.resolution_note = None

    from app.services.activity_log import ActivityLogService

    await ActivityLogService(session).record(
        org_id=org_id,
        action="gate_resolution_undone",
        actor_id=actor_id,
        actor_type="human",
        entity_type="gate",
        entity_id=gate.id,
        context={
            "gate_type": gate.gate_type,
            "work_item_type": gate.work_item_type,
            "work_item_id": str(gate.work_item_id),
            "previous_status": _prev_status,
            "previous_resolver_id": str(_prev_resolver_id) if _prev_resolver_id else None,
            "previous_resolved_at": _prev_resolved_at.isoformat() if _prev_resolved_at else None,
            "previous_note": _prev_note,
            # story #2975 AC4 — 무엇이 취소됐는지(어느 SHA에 대한 승인이었는지)의 스냅샷.
            "previous_approved_head_sha": _prev_approved_head_sha,
        },
    )

    await session.flush()
    await session.refresh(gate)
    return gate


async def request_gate_discussion(
    session: AsyncSession,
    org_id: uuid.UUID,
    gate_id: uuid.UUID,
    actor_id: uuid.UUID,
    reason: str,
    *,
    now: datetime | None = None,
) -> Gate:
    """AC2 — 승인/변경요청 옆 3안. 게이트는 **pending 그대로**(전이 없음) — 순수 회신+감사
    기록 액션. 사유는 `gate.neutral_facts["discussion_requested"]`에 얹는다(신규 컬럼/
    마이그 없이 기존 JSONB 확장 — requested_by_member_id와 같은 자리에 쌓는 관례 재사용).

    ⛔PO 판정 ③ — 액션 자체는 게이트 타입 무관(결재함 단일 UX). 회신은 requester 개념이
    있는 타입(doc_approval)만 실제 전달되고, 없는 타입은 회신 스킵을 ActivityLog context에
    명시(`requester_notified=False` + 사유) — 조용한 no-op 금지."""
    now = now or datetime.now(timezone.utc)
    if not (reason or "").strip():
        raise ValueError("논의 요청 사유(reason)는 필수입니다.")

    gate = (await session.execute(
        select(Gate).where(Gate.id == gate_id, Gate.org_id == org_id)
    )).scalar_one_or_none()
    if gate is None:
        raise ValueError(f"Gate {gate_id} not found")
    if gate.status != "pending":
        raise ValueError(f"논의 요청 불가: 게이트가 {gate.status} 상태입니다 (pending만 가능).")

    facts = dict(gate.neutral_facts or {})
    facts["discussion_requested"] = {
        "reason": reason,
        "requested_by_member_id": str(actor_id),
        "requested_at": now.isoformat(),
    }
    gate.neutral_facts = facts

    requester_notified = await _notify_gate_discussion_requester(session, gate, actor_id, reason)

    from app.services.activity_log import ActivityLogService

    await ActivityLogService(session).record(
        org_id=org_id,
        action="gate_discussion_requested",
        actor_id=actor_id,
        actor_type="human",
        entity_type="gate",
        entity_id=gate.id,
        context={
            "gate_type": gate.gate_type,
            "work_item_type": gate.work_item_type,
            "work_item_id": str(gate.work_item_id),
            "reason": reason,
            "requester_notified": requester_notified,
        },
    )

    await session.flush()
    await session.refresh(gate)
    return gate


async def _notify_gate_discussion_requester(
    session: AsyncSession, gate: Gate, actor_id: uuid.UUID, reason: str,
) -> bool:
    """`_notify_doc_gate_requester`의 「논의 요청」 자매 함수 — doc_approval만 실제 회신
    (requester 개념이 있는 유일한 타입, PO 판정 ③ 1차 실증 대상). 다른 타입은 회신 대상이
    없다는 사실 자체를 반환값으로 명시(호출부가 ActivityLog에 `requester_notified` 로
    남겨 "조용한 no-op"이 되지 않게 한다). best-effort — 실패해도 논의 요청 자체는 막지 않는다."""
    try:
        from app.services.doc import DOC_GATE_TYPE, DOC_GATE_WORK_ITEM_TYPE
        if gate.work_item_type != DOC_GATE_WORK_ITEM_TYPE or gate.gate_type != DOC_GATE_TYPE:
            return False

        facts = gate.neutral_facts or {}
        requester_raw = facts.get("requested_by_member_id")
        if not requester_raw:
            return False
        requester_id = uuid.UUID(str(requester_raw))

        doc = (await session.execute(
            select(Doc).where(Doc.id == gate.work_item_id, Doc.org_id == gate.org_id)
        )).scalar_one_or_none()
        if doc is None:
            return False

        from app.services.approval_delivery import dispatch_approval_discussion_reply

        await dispatch_approval_discussion_reply(
            session, org_id=gate.org_id, doc=doc, gate_id=gate.id,
            requester_id=requester_id, resolver_id=actor_id, reason=reason,
        )
        return True
    except Exception:  # noqa: BLE001 — best-effort, 회신 실패가 논의 요청 자체를 막지 않는다.
        logger.warning(
            "approval-discussion 상신자 회신 실패 gate=%s", gate.id, exc_info=True,
        )
        return False


async def void_gate(
    session: AsyncSession,
    org_id: uuid.UUID,
    gate_id: uuid.UUID,
    voider_id: uuid.UUID,
    reason: str,
    *,
    actor_type: str = "human",
    void_reason_label: str = "admin",
) -> Gate:
    """⭐S30 admin recovery: 잘못 생성된 **pending** gate 를 무효화(voided).

    ⚠️void ≠ approval: 묶인 line step_run 을 ``skipped`` 로 해소해 엔티티가 unblock(re-route 가능)되되
    "승인됨"으로 전진하지 않는다(전이 미적용). voider 는 인증 caller(라우터가 강제·body 신뢰 금지·
    S23 RC① 패턴). audit = gate 행(status='voided'·resolver_id·resolution_note)이 distinct 추적
    (approve/reject 와 **status 로 구분**) + ActivityLog(story #2975 AC4, approve/reject/undo와
    동형 — 이전엔 logger.info뿐이라 DB 조회 불가였음). void=복구 액션이라 strict SoD 불요(PO Q4).

    actor_type: story #2789(2026-08-24) — 이전엔 이 함수의 유일한 호출자(admin-only `/void`
    엔드포인트)가 항상 사람이라 ActivityLog에 `actor_type="human"`을 하드코딩해도 참이었다.
    이 스토리가 새 호출자(요청자 자기-철회 `/withdraw`, 에이전트도 호출 가능)를 추가하며
    그 전제가 깨진다 — 호출부가 실제 caller 타입(agent_gateway.py 등에서 이미 쓰는
    `app_metadata.api_key_id` 신호와 동형 판별)을 명시로 넘긴다. 기본값 "human"은 기존
    admin `/void` 경로의 무회귀만 보존한다.

    void_reason_label: 카디르 QA(#3462, 2026-08-25) — 최초 구현이 이 값을 `actor_type`과
    같은 변수로 합쳐 썼다가, 그 결과 step_run.routing_reason 리터럴이 기존 admin `/void`
    경로에서도 "gate voided by admin: ..."(항상 이 고정 문구였음, git blame 확認)에서
    "gate voided by human: ..."로 바뀌어버려 `test_edg_s30_void_recovery`가 실 PG에서
    깨졌다(disposable PG 재현). `actor_type`(ActivityLog 감사축)과 `void_reason_label`
    (routing_reason 표시축)은 서로 다른 축이라 분리한다 — 전자는 "누가"(agent/human),
    후자는 "어떤 경로로"(admin 복구 vs 요청자 철회)를 나타낸다. 기본값 "admin"은 기존
    admin `/void` 호출자의 출력을 byte-동일 보존한다.
    """
    gate = (await session.execute(
        select(Gate).where(Gate.id == gate_id, Gate.org_id == org_id)
    )).scalar_one_or_none()
    if gate is None:
        raise ValueError(f"Gate {gate_id} not found")
    if not is_valid_transition(gate.status, "voided"):
        raise ValueError(f"불법 전이: {gate.status} → voided. pending 게이트만 무효화 가능.")
    if not (reason or "").strip():
        raise ValueError("void 사유(reason)는 필수입니다.")

    set_gate_status(gate, "voided", now=datetime.now(timezone.utc))
    gate.resolver_id = voider_id
    gate.resolution_note = reason
    gate.resolved_at = datetime.now(timezone.utc)

    # ⭐라인 복구: 묶인 미해소 step_run 을 skipped 로 해소 → 엔티티 unblock(applied 아님=전이 미적용·
    # re-route 가능). find_active_step_run_for_gate 는 _OPEN 상태만 반환·skipped 는 _OPEN 밖이라 닫힘.
    from app.services.workflow_line_resolution import find_active_step_run_for_gate
    sr_id = await find_active_step_run_for_gate(session, org_id, gate_id)
    if sr_id is not None:
        sr = (await session.execute(
            select(WorkflowLineStepRun).where(WorkflowLineStepRun.id == sr_id)
        )).scalar_one_or_none()
        if sr is not None:
            sr.status = "skipped"
            # story #2789 — "by admin"이 더는 항상 참이 아니다(요청자 자기-철회 경로 추가).
            # 카디르 QA(#3462): actor_type과 혼용하면 기존 admin 경로 출력이 바뀐다 — 별도 축.
            sr.routing_reason = f"gate voided by {void_reason_label}: {reason}"[:500]
            sr.resolved_at = datetime.now(timezone.utc)

    # story #2975 AC4(PO 확定 2026-08-24) — 위 주석이 남긴 이유(permission_audit_logs=member 전용·
    # HitlGateAudit=enforce-coverage 전용)로 여태 logger.info() 뿐이었다(Cloud Logging 한정,
    # DB 비영속·조회불가) — 진짜 감사 갭이었다. approve/reject/undo와 동형으로 ActivityLog에
    # 옮긴다(신규 테이블 불요, 기존 표 재사용).
    from app.services.activity_log import ActivityLogService

    await ActivityLogService(session).record(
        org_id=org_id,
        action="gate_voided",
        actor_id=voider_id,
        actor_type=actor_type,
        entity_type="gate",
        entity_id=gate.id,
        context={
            "gate_type": gate.gate_type,
            "work_item_type": gate.work_item_type,
            "work_item_id": str(gate.work_item_id),
            "reason": reason,
            "head_sha": gate.github_check_run_sha,
        },
    )
    logger.info(
        "gate_voided org=%s gate=%s voider=%s work=%s/%s step_run=%s reason=%s",
        org_id, gate_id, voider_id, gate.work_item_type, gate.work_item_id, sr_id, reason,
    )
    await session.flush()
    await session.refresh(gate)
    return gate


async def void_pending_doc_gate(
    session: AsyncSession,
    org_id: uuid.UUID,
    doc_id: uuid.UUID,
    voider_id: uuid.UUID,
) -> bool:
    """b13352c2: doc 삭제 cascade — 그 doc 의 pending doc_approval 게이트를 system void(orphan Gate inbox
    항목 방지). 삭제 권한자가 트리거하는 **system cascade**라 human-gate authz(can_approve·human-only) 우회
    정당(별도 결재 아님·actor=삭제자·자기승인 아님·산티아고 검토). 스코핑=`doc_approval` 만(타 gate_type 무접촉)·
    멱등(pending 아니면 no-op)·begin_nested 격리 best-effort(void 실패가 doc 삭제 비중단). 반환=void 수행 여부."""
    from app.services.doc import DOC_GATE_TYPE, DOC_GATE_WORK_ITEM_TYPE
    gate = (await session.execute(
        select(Gate).where(
            Gate.org_id == org_id,
            Gate.work_item_id == doc_id,
            Gate.work_item_type == DOC_GATE_WORK_ITEM_TYPE,
            Gate.gate_type == DOC_GATE_TYPE,
            Gate.status == "pending",
        )
    )).scalar_one_or_none()
    if gate is None:
        return False  # pending doc-gate 없음(terminal/held/부재) → no-op(멱등).
    try:
        async with session.begin_nested():
            await void_gate(
                session, org_id, gate.id, voider_id,
                "doc 삭제 cascade — pending 결재 게이트 자동 무효화",
            )
        return True
    except Exception:
        logger.warning(
            "doc 삭제 cascade void 실패(비중단) doc=%s gate=%s", doc_id, gate.id, exc_info=True
        )
        return False


async def _set_linked_step_run(session, org_id, gate_id, *, status, held_until, reason):
    """gate 에 묶인 미해소 step_run 의 status/held_until 갱신(없으면 no-op·legacy/비-라인 gate)."""
    from app.services.workflow_line_resolution import find_active_step_run_for_gate
    sr_id = await find_active_step_run_for_gate(session, org_id, gate_id)
    if sr_id is None:
        return None
    sr = (await session.execute(
        select(WorkflowLineStepRun).where(WorkflowLineStepRun.id == sr_id)
    )).scalar_one_or_none()
    if sr is not None:
        sr.status = status
        sr.held_until = held_until
        if reason is not None:
            sr.routing_reason = reason[:500]
    return sr_id


async def hold_gate(
    session: AsyncSession,
    org_id: uuid.UUID,
    gate_id: uuid.UUID,
    holder_id: uuid.UUID,
    reason: str | None = None,
    held_until: datetime | None = None,
) -> Gate:
    """⭐S31 admin hold: pending gate 를 일시 보류(held). void(종료)와 달리 **가역**(unhold 재개).

    묶인 step_run.status='held'+held_until 세팅 → SLA processor 가 reminder/escalation 일시정지(pause).
    holder=인증 caller(라우터 강제·body 신뢰 0·S23 RC①). audit=gate 행(status='held'·resolver_id=holder·
    resolution_note=reason·held_until)이 현 상태(status='held' 가 disambiguate·unhold 시 clear)+app-log
    `gate_held`(durable 이력·S30 void 패턴). 사유는 선택(가역적 일시정지라 마찰↓).
    """
    gate = (await session.execute(
        select(Gate).where(Gate.id == gate_id, Gate.org_id == org_id)
    )).scalar_one_or_none()
    if gate is None:
        raise ValueError(f"Gate {gate_id} not found")
    if not is_valid_transition(gate.status, "held"):
        raise ValueError(f"불법 전이: {gate.status} → held. pending 게이트만 보류 가능.")

    set_gate_status(gate, "held", now=datetime.now(timezone.utc))
    gate.resolver_id = holder_id          # status='held' 가 holder 로 해석(approve/reject 아님)
    gate.resolution_note = reason          # 선택
    gate.held_until = held_until           # 무기한이면 None
    sr_id = await _set_linked_step_run(
        session, org_id, gate_id, status="held", held_until=held_until,
        reason=f"gate held by admin{(': ' + reason) if reason else ''}",
    )
    logger.info(
        "gate_held org=%s gate=%s holder=%s work=%s/%s step_run=%s until=%s reason=%s",
        org_id, gate_id, holder_id, gate.work_item_type, gate.work_item_id, sr_id, held_until, reason,
    )
    await session.flush()
    await session.refresh(gate)
    return gate


async def unhold_gate(
    session: AsyncSession,
    org_id: uuid.UUID,
    gate_id: uuid.UUID,
    actor_id: uuid.UUID,
) -> Gate:
    """⭐S31 admin unhold: held gate 를 재개(→pending). SLA 재개(step_run→gate_pending·다음 스캔서 처리).

    held 상태 audit 필드(resolver_id/resolution_note/held_until)를 **clear**(재개된 pending 깨끗)·이력은
    app-log `gate_unheld`. holder/actor=인증 caller(라우터 강제).
    """
    gate = (await session.execute(
        select(Gate).where(Gate.id == gate_id, Gate.org_id == org_id)
    )).scalar_one_or_none()
    if gate is None:
        raise ValueError(f"Gate {gate_id} not found")
    if not is_valid_transition(gate.status, "pending"):
        raise ValueError(f"불법 전이: {gate.status} → pending. 보류(held) 게이트만 재개 가능.")

    set_gate_status(gate, "pending", now=datetime.now(timezone.utc))
    gate.resolver_id = None
    gate.resolution_note = None
    gate.held_until = None
    sr_id = await _set_linked_step_run(
        session, org_id, gate_id, status="gate_pending", held_until=None,
        reason="gate unheld by admin (resumed)",
    )
    logger.info(
        "gate_unheld org=%s gate=%s actor=%s work=%s/%s step_run=%s",
        org_id, gate_id, actor_id, gate.work_item_type, gate.work_item_id, sr_id,
    )
    await session.flush()
    await session.refresh(gate)
    return gate


async def _resolve_doc_gate(session: AsyncSession, gate: Gate, new_status: str) -> None:
    """E-DG doc-gate(48f064e5): doc 결재 게이트 해소 → doc status 전이(merge-approve 의 doc 아날로그).

    approve→confirmed · reject→denied. **pending doc 만**(멱등·非pending no-op·이미 결정/취소면 무시).
    human-only 결재(AC4)는 게이트 전이 엔드포인트 authz 에서 강제 — 여기는 status 반영만.
    """
    from app.services.doc import DOC_GATE_TYPE, DOC_GATE_WORK_ITEM_TYPE
    if gate.work_item_type != DOC_GATE_WORK_ITEM_TYPE or gate.gate_type != DOC_GATE_TYPE:
        return
    if new_status not in ("approved", "rejected"):
        return
    from app.models.doc import Doc

    # 방어심층(산티아고): PK get 대신 org_id + soft-delete 가드(타org/삭제 doc 무영향).
    doc = (await session.execute(
        select(Doc).where(
            Doc.id == gate.work_item_id,
            Doc.org_id == gate.org_id,
            Doc.deleted_at.is_(None),
        )
    )).scalar_one_or_none()
    if doc is None or doc.status != "pending":
        return  # 멱등·pending 아니면 no-op(double-resolve/취소 방어).
    doc.status = "confirmed" if new_status == "approved" else "denied"
    await session.flush()


async def _resolve_designatable_gate_context(
    session: AsyncSession, gate: Gate,
) -> tuple[str, uuid.UUID, uuid.UUID] | None:
    """story #3001 — 위임(delegate) 대상 카드 배달용 (title, project_id, requester_id) 해소.
    _notify_doc_gate_requester의 doc_approval/agent_decision_request 두 분기와 같은 근원
    (Doc row·neutral_facts) — merge는 여기 없다(#2985가 designated_approver_id 배선 자체를
    보류해 뒀으므로 delegate 엔드포인트가 애초에 merge gate에 도달 못 함, 별도 분기 불요).
    해소 못 하면(doc 없음·필드 없음 등) None(지어내지 않음, 호출부가 no-op 처리)."""
    from app.services.doc import DOC_GATE_TYPE, DOC_GATE_WORK_ITEM_TYPE

    facts = gate.neutral_facts or {}
    requester_raw = facts.get("requested_by_member_id")
    if not requester_raw:
        return None
    requester_id = uuid.UUID(str(requester_raw))

    if gate.work_item_type == DOC_GATE_WORK_ITEM_TYPE and gate.gate_type == DOC_GATE_TYPE:
        from app.models.doc import Doc
        doc = (await session.execute(
            select(Doc).where(Doc.id == gate.work_item_id, Doc.org_id == gate.org_id)
        )).scalar_one_or_none()
        if doc is None or not doc.project_id:
            return None
        return doc.title, doc.project_id, requester_id
    if gate.gate_type == "agent_decision_request":
        project_id_raw = facts.get("project_id")
        question = facts.get("question")
        if not project_id_raw or not question:
            return None
        return str(question), uuid.UUID(str(project_id_raw)), requester_id
    return None


async def dispatch_gate_delegation(
    session: AsyncSession, gate: Gate, *, old_approver_id: uuid.UUID, new_approver_id: uuid.UUID,
) -> None:
    """story #3001(선생님 정책 확定 2026-08-24) — 위임 실행: 새 지정자에게 실 액션 카드
    배달(dispatch_approval_request_cards 재사용, 신규 카드 메커니즘 0) + 원 지정자(호출자)
    카드가 "위임됨"으로 실시간 갱신되도록 conversation.gate_delegated 이벤트 전파(오늘
    #2985가 만든 conversation.gate_resolved 형제 — 새 ConversationMessage는 안 만든다,
    같은 이유로 챗버블 스팸 방지).

    best-effort(카드/이벤트 배달 실패가 위임 자체 — gate.designated_approver_id 갱신+
    ActivityLog — 를 막지 않는다, 라우터가 이미 그 둘을 먼저 commit한 後 이 함수를 부른다)."""
    ctx = await _resolve_designatable_gate_context(session, gate)
    if ctx is None:
        logger.warning("gate delegate 컨텍스트 해소 실패 gate=%s — 카드/이벤트 배달 스킵", gate.id)
        return
    title, project_id, requester_id = ctx

    try:
        from app.services.approval_delivery import dispatch_approval_request_cards
        _new_card_pushes = await dispatch_approval_request_cards(
            session, org_id=gate.org_id, work_item_type=gate.work_item_type, work_item_id=gate.work_item_id,
            project_id=project_id, title=title, gate_id=gate.id,
            requester_id=requester_id, approver_ids=[new_approver_id],
            designated_approver_id=new_approver_id,
        )
        # story #3044 — 새 지정자의 결재함 목록도 새로고침 없이 이 게이트를 즉시 봐야 한다
        # (notify_gate_created_to_recipients, dispatch_approval_request_cards 내부에서 이미
        # 계산·반환). 아래 gate_delegated 커밋과 같은 자리에서 함께 push(별도 커밋 불요 —
        # 이 함수는 이미 caller가 gate.designated_approver_id 갱신을 먼저 commit했다는 전제).
        await session.commit()
        for _pid_str, _payload in _new_card_pushes:
            from app.routers.events import _push_to_agent
            _push_to_agent(_pid_str, _payload)
    except Exception:  # noqa: BLE001 — best-effort, 신규 카드 배달 실패가 위임 자체를 막지 않음.
        logger.warning("gate delegate 신규 카드 배달 실패 gate=%s new_approver=%s", gate.id, new_approver_id, exc_info=True)

    try:
        from app.services.approval_delivery import notify_gate_delegated_to_old_approver
        pushes = await notify_gate_delegated_to_old_approver(
            session, org_id=gate.org_id, gate_id=gate.id,
            old_approver_id=old_approver_id, new_approver_id=new_approver_id,
        )
        await session.commit()
        for pid_str, payload in pushes:
            from app.routers.events import _push_to_agent
            _push_to_agent(pid_str, payload)
    except Exception:  # noqa: BLE001 — best-effort, 실시간 반영 실패가 위임 자체를 막지 않음.
        logger.warning("gate delegate 실시간 반영 배선 실패 gate=%s", gate.id, exc_info=True)


async def _notify_doc_gate_requester(session: AsyncSession, gate: Gate, new_status: str) -> None:
    """story #2624: doc 결재 게이트 해소 결과를 상신자에게 회신 —
    dispatch_approval_request_cards(상신→승인자)의 반대 방향. P2(#3007)는 전방 경로만
    만들었고 해소→상신자 회신 후방 경로가 없어, 상신자가 게이트를 폴링해야만 결과를
    알 수 있었다(선생님 직접 지적, 실사례 2026-08-13 07:20 반려·상신자 무통지).

    story #2709(2026-08-17) — agent_decision_request도 이 함수를 탄다(함수명은 이력 보존을
    위해 유지·내부만 gate_type 분기, 새 함수 발명 0). doc은 Doc row에서 title/project_id를
    읽지만, agent_decision_request는 work_item이 곧 gate 자기참조(standalone anchor)라 Doc
    row가 없다 — title=neutral_facts["question"], project_id=neutral_facts["project_id"](발행
    시점에 넣어 둠, Gate 모델 자체엔 project_id 컬럼이 없어 이 필드에만 존재).

    best-effort — 이 함수의 실패가 게이트 해소 자체를 막지 않는다(호출부 transition_gate
    가 이 함수를 await만 하고 별도 격리는 하지 않으므로, 예외를 여기서 전부 삼킨다 —
    approval_delivery.dispatch_approval_result_reply 자체도 내부에서 SAVEPOINT로 이미
    격리하지만, requester_id 파싱 등 그 앞 단계도 안전해야 한다)."""
    try:
        from app.services.doc import DOC_GATE_TYPE, DOC_GATE_WORK_ITEM_TYPE
        from app.services.merge_verdict_gate import MERGE_GATE_TYPE
        if new_status not in ("approved", "rejected") or gate.resolver_id is None:
            return

        facts = gate.neutral_facts or {}
        requester_raw = facts.get("requested_by_member_id")
        if not requester_raw:
            return
        requester_id = uuid.UUID(str(requester_raw))

        from app.services.approval_delivery import dispatch_approval_result_reply

        if gate.work_item_type == DOC_GATE_WORK_ITEM_TYPE and gate.gate_type == DOC_GATE_TYPE:
            from app.models.doc import Doc
            doc = (await session.execute(
                select(Doc).where(Doc.id == gate.work_item_id, Doc.org_id == gate.org_id)
            )).scalar_one_or_none()
            if doc is None or not doc.project_id:
                return
            await dispatch_approval_result_reply(
                session, org_id=gate.org_id, work_item_type="doc", work_item_id=doc.id,
                project_id=doc.project_id, title=doc.title, gate_id=gate.id,
                requester_id=requester_id, resolver_id=gate.resolver_id,
                decision=new_status, resolution_note=gate.resolution_note,
                # story #2709 — 딥링크 계약 정적 스캐너(deeplink_contract_lib)가 event_type을
                # 파라미터 default가 아니라 매 호출부 명시 리터럴로만 정적 해석한다 — default
                # 값에 기대면 UnresolvedDispatchCallError. 값 자체는 원래 default와 동일(무회귀).
                event_type="doc_approval_resolved",
            )
        elif gate.gate_type == "agent_decision_request":
            project_id_raw = facts.get("project_id")
            question = facts.get("question")
            if not project_id_raw or not question:
                return
            await dispatch_approval_result_reply(
                session, org_id=gate.org_id, work_item_type=gate.work_item_type,
                work_item_id=gate.work_item_id, project_id=uuid.UUID(str(project_id_raw)),
                title=str(question), gate_id=gate.id,
                requester_id=requester_id, resolver_id=gate.resolver_id,
                decision=new_status, resolution_note=gate.resolution_note,
                event_type="agent_decision_resolved",
            )
        elif gate.gate_type == MERGE_GATE_TYPE:
            # story #1715(PO 판정 2026-08-24) — merge gate(work_item_type="story")도 상신자
            # 회신 대상에 편입. requested_by_member_id는 evaluate_merge_gate()가 이미 계산해
            # 두던 participation.member_id(누가 실작업했는지)를 neutral_facts에 stash만 추가한
            # 것(merge_verdict_gate.py) — 새 식별 로직 0.
            from app.models.pm import Story
            story_title = (await session.execute(
                select(Story.title).where(Story.id == gate.work_item_id, Story.org_id == gate.org_id)
            )).scalar_one_or_none() or f"#{str(gate.work_item_id)[:8]}"
            project_id = await resolve_work_item_project_id(session, gate.org_id, "story", gate.work_item_id)
            if not project_id:
                return
            await dispatch_approval_result_reply(
                session, org_id=gate.org_id, work_item_type="story", work_item_id=gate.work_item_id,
                project_id=project_id, title=story_title, gate_id=gate.id,
                requester_id=requester_id, resolver_id=gate.resolver_id,
                decision=new_status, resolution_note=gate.resolution_note,
                event_type="merge_gate_resolved",
            )
    except Exception:  # noqa: BLE001 — best-effort, 회신 실패가 게이트 해소를 막지 않는다.
        logger.warning(
            "approval-result 상신자 회신 실패 gate=%s", gate.id, exc_info=True,
        )


async def _resolve_artifact_canonicalize_gate(session: AsyncSession, gate: Gate, new_status: str) -> None:
    """E-CANVAS C4-S8(story a5118cb0): 정본화 게이트 해소.

    approve → anchor_version = 제안된 버전 번호(neutral_facts.version_number)·artifact.canonicalized
    이벤트 전파. reject → **destructive 색 금지, info "재논의"** — resolution_note(사유)가 있으면
    제안자에게 C2 앵커 스레드로 코멘트 전파(§5: 반려=학습 신호·죽은 반려 금지). anchor_version은
    변경 안 함(멱등 no-op이 정답 — 재논의는 새 제안 사이클에서 다시 결정).
    """
    if gate.work_item_type != "visual_artifact" or gate.gate_type != "artifact_canonicalize":
        return
    if new_status not in ("approved", "rejected"):
        return

    from app.models.visual_artifact import ArtifactComment, VisualArtifact

    artifact = (await session.execute(
        select(VisualArtifact).where(
            VisualArtifact.id == gate.work_item_id,
            VisualArtifact.org_id == gate.org_id,
            VisualArtifact.deleted_at.is_(None),
        )
    )).scalar_one_or_none()
    if artifact is None:
        return  # 멱등·삭제된 artifact no-op(방어심층).

    facts = gate.neutral_facts or {}
    version_number = facts.get("version_number")
    requested_by = facts.get("requested_by_member_id")

    if new_status == "approved":
        if version_number is not None:
            artifact.anchor_version = int(version_number)
            await session.flush()
        target_ids = {artifact.created_by}
        if requested_by:
            target_ids.add(uuid.UUID(str(requested_by)))
        if gate.resolver_id:
            target_ids.discard(gate.resolver_id)  # 승인자 본인 알림 제외
        target_ids.discard(None)
        if target_ids:
            from app.services.notification_dispatch import dispatch_notification
            await dispatch_notification(
                session, org_id=gate.org_id, event_type="artifact.canonicalized",
                target_member_ids=list(target_ids),
                title=f"정본 확定: {artifact.title}",
                body=f"v{version_number}이(가) 정본으로 확定됐습니다." if version_number else None,
                reference_type="visual_artifact", reference_id=artifact.id,
                source_project_id=artifact.project_id,
                # story #2694: #2688(create_gate 2콜)과 동일 결함 클래스 — 이 호출부(transition_gate
                # → _resolve_artifact_canonicalize_gate)도 요청의 열린 트랜잭션 커넥션 안에서
                # 동기 개인 webhook 재시도(최대 3회·1s/2s backoff)를 그대로 문다. outbox 이관.
                via_outbox=True,
            )
    else:  # rejected — info 재논의(§5: destructive 색 절대 금지). 사유=코멘트로 제안자에게 전파.
        if gate.resolution_note and requested_by:
            session.add(ArtifactComment(
                id=uuid.uuid4(), artifact_id=artifact.id, org_id=gate.org_id,
                project_id=artifact.project_id, content=gate.resolution_note,
                created_by=gate.resolver_id or artifact.created_by,
            ))
            await session.flush()


async def _resume_a2a_task_on_gate_resolve(session: AsyncSession, gate: Gate, new_status: str) -> None:
    """HITL crux(story 7726a003, 문서 `a2a-hitl-input-auth-required-mapping-crux`, PO GO
    2026-07-07 옵션 B) + S-A5(story c140977f, auth 변형): `A2ATask.task_metadata.linked_gate_id`
    로 이 게이트에 연결된 task를 복귀시킨다. INPUT_REQUIRED든 AUTH_REQUIRED든(S-A3 writer의
    `linked_gate_reason` 선언에 따라 갈린 상태) 복귀 트리거는 동일 — approve→
    `TASK_STATE_WORKING`(재개, 이후 기존 reply-thread 폴링이 COMPLETED까지 캐리) ·
    reject→`TASK_STATE_REJECTED`(기존 terminal state, 신규 처리 불요).
    """
    if new_status not in ("approved", "rejected"):
        return
    from app.models.a2a_task import A2ATask  # 순환 회피 lazy import.

    task = (await session.execute(
        select(A2ATask).where(
            A2ATask.task_metadata["linked_gate_id"].astext == str(gate.id),
            A2ATask.state.in_(["TASK_STATE_INPUT_REQUIRED", "TASK_STATE_AUTH_REQUIRED"]),
        )
    )).scalar_one_or_none()
    if task is None:
        return  # 링크 없음(writer 미배선) 또는 이미 다른 경로로 해소됨 — no-op.
    task.state = "TASK_STATE_WORKING" if new_status == "approved" else "TASK_STATE_REJECTED"
    await session.flush()


# gate_type → verdict source (qa→qa·merge→merge·deploy→design·pr_review→pr).
_GATE_TYPE_TO_VERDICT_SOURCE: dict[str, str] = {
    "qa": "qa",
    "deploy": "design",
    "merge": "merge",
    "pr_review": "pr",
}
# 이 시간(초) 이하 approve는 rubber stamp(고무도장) 후보로 관측 표시.
_RUBBER_STAMP_SECONDS = 30


async def _record_gate_review_verdict(
    session: AsyncSession,
    org_id: uuid.UUID,
    gate: Gate,
    new_status: str,
    resolver_id: uuid.UUID | None,
) -> None:
    """사람 게이트 해소를 verdict로 환류(H1-S7).

    approve→result=pass / reject→result=fail. resolver_id 없으면 skip(AC③·시스템 auto-transition은
    resolver 없으니 자동 제외 = 루프 가드 겸용). verdict는 work item의 implementation participation에
    gate_type-매핑 source로 기록(uq(participation,source) upsert 멱등). 30초 이하 approve는
    neutral_facts.rubber_stamp_candidate=true로 관측(AC⑤).
    """
    if new_status not in ("approved", "rejected") or resolver_id is None:
        return
    source = _GATE_TYPE_TO_VERDICT_SOURCE.get(gate.gate_type)
    if source is None or gate.work_item_type != "story":
        return

    # lazy import — verdict_capture/recorder가 gate_service를 import하므로 순환 회피.
    from app.services.verdict_capture import resolve_implementation_participation
    from app.services.verdict_recorder import record_verdict

    participation = await resolve_implementation_participation(session, org_id, gate.work_item_id)
    if participation is None:
        return  # participation 없으면 거짓기록 금지(skip).

    result = "pass" if new_status == "approved" else "fail"  # AC①②
    await record_verdict(session, org_id, participation.id, source, result)

    # AC⑤: 30초 이하 approve = rubber stamp 후보 관측(neutral_facts 추가·판정 아님).
    if (
        new_status == "approved"
        and gate.created_at is not None
        and gate.resolved_at is not None
        and (gate.resolved_at - gate.created_at).total_seconds() <= _RUBBER_STAMP_SECONDS
    ):
        facts = dict(gate.neutral_facts or {})
        facts["rubber_stamp_candidate"] = True
        gate.neutral_facts = facts

    # story #2791(P0, event-workflow-unification-design-2790) — preset.gate.verdict 서버
    # 자동발행. 위 record_verdict와 동일 게이팅(participation 존재·work_item_type=story)
    # 스코프 그대로 — best-effort 격리는 호출자(여기) 몫.
    try:
        from app.routers.events import publish_preset_event

        await publish_preset_event(
            session, org_id, "preset.gate.verdict",
            {
                "work_item_type": gate.work_item_type,
                "work_item_id": str(gate.work_item_id),
                "gate_type": gate.gate_type,
                "verdict": new_status,
                "resolver_member_id": str(resolver_id),
            },
        )
    except Exception:
        logger.warning(
            "preset.gate.verdict 자동발행 실패(gate=%s org=%s)", gate.id, org_id, exc_info=True,
        )


async def resolve_gate_from_verdict(
    session: AsyncSession,
    org_id: uuid.UUID,
    work_item_id: uuid.UUID,
    work_item_type: str,
    verdict_source: str,
    verdict_result: str | None,
    resolver_id: uuid.UUID | None = None,
) -> Gate | None:
    """verdict 포착 결과를 대응 게이트 해소로 연결.

    verdict source → gate_type 매핑 후 pending 게이트 탐색.
    없으면 graceful skip (None 반환).
    result=None → pending 유지 (미측정 거짓해소 금지).
    """
    gate_type = _SOURCE_TO_GATE_TYPE.get(verdict_source)
    if gate_type is None:
        return None

    if verdict_result is None:
        return None  # 미측정 → 강제 해소 금지

    gate_r = await session.execute(
        select(Gate).where(
            Gate.org_id == org_id,
            Gate.work_item_id == work_item_id,
            Gate.work_item_type == work_item_type,
            Gate.gate_type == gate_type,
            Gate.status == "pending",
        ).limit(1)
    )
    gate = gate_r.scalar_one_or_none()
    if gate is None:
        return None  # 게이트 없음 → graceful

    new_status = "approved" if verdict_result == "pass" else "rejected"
    set_gate_status(gate, new_status, now=datetime.now(timezone.utc))
    gate.resolver_id = resolver_id
    gate.resolved_at = datetime.now(timezone.utc)
    await session.flush()
    await session.refresh(gate)
    return gate


async def override_gate(
    session: AsyncSession,
    org_id: uuid.UUID,
    gate_id: uuid.UUID,
    owner_id: uuid.UUID,
    decision: str,
    reason: str,
    *,
    pending_deliveries: list[dict[str, Any]] | None = None,
) -> Gate:
    """⭐E-DG S33 owner force-resolve: owner(최종권한자)가 막힌/긴급 gate 를 **강제 결정**한다.

    ⚠️void(종료)/hold(정지)/reassign(교체)와 달리 **gate 결정 자체를 강제**(approved|rejected)·정상 결재
    경로(quorum·SoD)를 **우회**한다 → 가장 강력·민감한 액션. 권한=owner-only(라우터 `is_org_owner`·admin
    제외)·reason 필수·owner_id 는 인증 caller 강제(body 신뢰 0·S23 RC①).

    메커니즘: ``transition_gate`` 재사용(FSM pending→approved|rejected·S6 hook 가 라인전이 자동 적용).
    parallel gate 면 남은 pending approver row 를 ``status="overridden"`` 로 닫는다(approved 와 distinct·
    강제 닫힘이지 승인 아님·dangling/SLA 방지). audit(최중) = ``WorkflowLineStepRunEvent(gate_overridden·
    bypassed_sod=True·decision·reason)`` + ``logger.warning`` + 영향받은 requester·bypass된 approver 재-notify
    (자기 gate 가 강제결정된 걸 알아야·안 하면 깜깜).
    """
    if decision not in ("approved", "rejected"):
        raise ValueError("decision 은 approved|rejected 만 가능합니다.")
    if not (reason and reason.strip()):
        raise ValueError("override 는 reason(사유)이 필수입니다.")
    gate = (await session.execute(
        select(Gate).where(Gate.id == gate_id, Gate.org_id == org_id)
    )).scalar_one_or_none()
    if gate is None:
        raise ValueError(f"Gate {gate_id} not found")
    if gate.status != "pending":
        raise ValueError(f"override 는 pending gate 만 가능합니다 (현재 {gate.status}).")

    # 영향받은 pending approver row(parallel) — overridden 마킹 + notify 대상. 단일 gate 면 빈 리스트.
    appr_rows = (await session.execute(
        select(WorkflowLineStepApproval).where(
            WorkflowLineStepApproval.gate_id == gate_id,
            WorkflowLineStepApproval.org_id == org_id,
            WorkflowLineStepApproval.status == "pending",
        )
    )).scalars().all()
    bypassed = [a.approver_member_id for a in appr_rows]
    requester_id = appr_rows[0].requested_by_member_id if appr_rows else None

    # 라인 step_run(audit anchor·project_id) — transition_gate 가 _OPEN 밖으로 보내기 전에 캡처.
    from app.services.workflow_line_resolution import find_active_step_run_for_gate
    sr_id = await find_active_step_run_for_gate(session, org_id, gate_id)
    sr = None
    if sr_id is not None:
        sr = (await session.execute(
            select(WorkflowLineStepRun).where(WorkflowLineStepRun.id == sr_id)
        )).scalar_one_or_none()

    # ⭐force-resolve: quorum/SoD 우회·S6 hook 라인전이 자동 적용.
    await transition_gate(
        session, org_id, gate_id, decision, resolver_id=owner_id, note=reason,
        pending_deliveries=pending_deliveries,
    )

    # parallel approver row 닫기(overridden·강제 닫힘이지 승인 아님·dangling/SLA 방지).
    now = datetime.now(timezone.utc)
    for a in appr_rows:
        a.status = "overridden"
        a.resolved_at = now

    # ⭐gate 행에 override 마커(FE cheap 신호·event fetch 없이 "강제 결정됨" 배지). story #2027 이전엔
    # transition_gate 가 resolution_note 를 rejected 에만 세팅해 approved override 사유가 누락됐었다 —
    # 지금은 resolution_note 에도 저장되지만(status 무관), neutral_facts 마커는 override 전용 배지·
    # bypassed_sod 등 override 고유 메타 보존 목적으로 유지(중복 저장 무해·용도 분리).
    # 전체 audit/메타(owner·시각·bypassed_sod)는 gate_overridden 이벤트가 SSOT(S32 reassign 동형).
    gate.neutral_facts = {
        **(gate.neutral_facts or {}),
        "overridden": True,
        "override_decision": decision,
        "override_reason": reason,
        "overridden_by_member_id": str(owner_id),
    }

    # audit(최중): bypassed_sod 플래그가 감사 추적 핵심. 라인 step_run 있을 때만 이벤트(없으면 gate행+log).
    if sr is not None:
        session.add(WorkflowLineStepRunEvent(
            org_id=org_id, project_id=sr.project_id, step_run_id=sr.id,
            event_type="gate_overridden", actor_member_id=owner_id,
            payload={
                "decision": decision, "reason": reason, "bypassed_sod": True,
                "bypassed_approver_ids": [str(x) for x in bypassed],
            },
            correlation_id=sr.correlation_id,
        ))
    # story #2975 AC4(PO 확定 2026-08-24, ㉮) — 위 WorkflowLineStepRunEvent는 sr(line step_run)이
    # 있을 때만 쓰인다. line-less override는 지금까지 gate.neutral_facts(위)뿐이었는데 그건
    # mutable이라 다음 전이가 덮어써 감사 기록이 못 된다 — line 유무 무관하게 ActivityLog에도
    # 항상 남긴다(transition_gate가 이미 base gate_approved/rejected를 쓰지만, override 고유
    # 메타(bypassed_sod·override_reason)는 그 안 담기므로 별개 action으로 append).
    from app.services.activity_log import ActivityLogService

    await ActivityLogService(session).record(
        org_id=org_id,
        action="gate_overridden",
        actor_id=owner_id,
        actor_type="human",
        entity_type="gate",
        entity_id=gate.id,
        context={
            "decision": decision, "reason": reason, "bypassed_sod": True,
            "bypassed_approver_ids": [str(x) for x in bypassed],
            "head_sha": gate.github_check_run_sha,
        },
    )
    logger.warning(
        "gate_overridden org=%s gate=%s decision=%s owner=%s bypassed_approvers=%d reason=%s",
        org_id, gate_id, decision, owner_id, len(bypassed), reason,
    )

    # notify requester + bypass된 approver들(Q4·자기 gate 강제결정 통보). best-effort·중복 제거.
    targets: dict[str, uuid.UUID] = {}
    for t in [requester_id, *bypassed]:
        if t is not None:
            targets[str(t)] = t
    if targets:
        try:
            from app.services.notification_dispatch import dispatch_notification
            await dispatch_notification(
                session, org_id=org_id, event_type="gate_overridden",
                target_member_ids=list(targets.values()),
                title="게이트가 강제 결정되었습니다",
                body=f"owner 가 게이트를 {decision} 로 강제 결정했습니다: {reason}",
                reference_type="gate", reference_id=gate_id,
                # story #1953: sr(라인 step_run)이 해소된 경우 project_id는 그 값 그대로(신규
                # 쿼리 0). story #1968: sr=None(단일 gate·활성 step_run 없음) 케이스는
                # resolve_work_item_project_id()로 gate.work_item_type/work_item_id에서
                # 폴백 조회 — best-effort(실패해도 이 알림 전체가 try 블록 안이라 비중단).
                source_project_id=(
                    sr.project_id if sr is not None
                    else await resolve_work_item_project_id(
                        session, org_id, gate.work_item_type, gate.work_item_id,
                    )
                ),
                # story #2694: #2688과 동일 결함 클래스 — override_gate() 호출부도 요청의 열린
                # 트랜잭션 커넥션 안에서 동기 개인 webhook 재시도를 문다. outbox 이관.
                via_outbox=True,
            )
        except Exception:  # noqa: BLE001 — notification 실패는 비중단(override 자체는 성공).
            pass

    await session.flush()
    await session.refresh(gate)
    return gate
