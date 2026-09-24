"""E-CAGE-REFEREE P3: HITL Gate CRUD + 전이 엔드포인트."""
import logging
import re
import uuid
from datetime import datetime, timezone
from typing import Annotated, Any, Literal

from fastapi import APIRouter, BackgroundTasks, Depends, Header, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.error_envelope import human_error
from app.services.gate_service import RecipeReviewedDraftChangedError
from app.dependencies.auth import get_current_user, get_scope_context, get_verified_org_id
from app.dependencies.database import get_db
from app.services.agent_onboarding_config import resolve_locale_from_request
from app.services.i18n_catalog import t
from app.models.doc import Doc
from app.models.gate import Gate, is_valid_transition
from app.models.gate_github_check_event import GateGithubCheckEvent
from app.models.github_installation import GithubInstallation
from app.models.hitl import HitlRequest
from app.models.pm import Story, Task
from app.models.workflow_line import WorkflowLineStepApproval
from app.routers.agent_gateway import wake_agent
from app.routers.events import _push_to_agent
from app.services.gate_github_check import is_repo_check_enforced, publish_gate_check, resolve_pr_link
from app.services.github_app import get_installation_token, get_pull_request
from app.services.merge_verdict_gate import MERGE_GATE_TYPE, reconcile_merge_gate_with_real_evidence
from app.services.verdict_capture import fetch_status_check_rollup
from app.services.gate_service import (
    GateUndoNotSelfError,
    resolve_work_item_project_ids_batch,
    self_anchored_gate_project_id,
    GateUndoWindowExpiredError,
    RiskGrade,
    apply_gate_urgency_sort,
    create_gate,
    derive_risk_grade,
    get_org_posture,
    hold_gate,
    is_known_project_agnostic_work_item_type,
    request_gate_discussion,
    resolve_work_item_project_id,
    transition_gate,
    undo_gate_resolution,
    unhold_gate,
    void_gate,
)
from app.services.member_resolver import resolve_member
from app.services.reference_token import build_reference_token
from app.services.project_auth import (
    accessible_project_ids_in_org,
    get_project_role,
    has_project_access,
    is_org_owner,
    is_org_owner_or_admin,
    require_project_access,
)


def _schedule_pending_deliveries(
    background_tasks: BackgroundTasks, pending_deliveries: list[dict],
) -> None:
    """ccbcd9da(A-1): transition_gate/override_gate 가 모은 wake/delivery 페이로드를 commit 후
    발화(#1364/relay_agent_handoff 선례 동형 — recipient_seq 확정 commit 후 wake 불변식)."""
    from app.services.conversation_webhook import deliver_injected_event_webhook

    for payload in pending_deliveries:
        agent_wake = payload.get("agent_wake")
        if agent_wake:
            wake_agent(agent_wake["recipient_id"], agent_wake["recipient_seq"])
        delivery = payload.get("delivery")
        if delivery:
            background_tasks.add_task(deliver_injected_event_webhook, **delivery)
        # story #2985 AC2 — notify_gate_card_recipients_resolved가 모은 SSE push(Event는 이미
        # DB에 커밋된 상태 — conversations.py::_dispatch_conversation_event와 동일 레이스 방지
        # 원칙, commit 後에만 _push_to_agent 호출).
        sse_push = payload.get("sse_push")
        if sse_push:
            _push_to_agent(sse_push["pid_str"], sse_push["payload"])

logger = logging.getLogger(__name__)

# 사람 검증 행위(approve/reject) — "human-validated" 웨지 integrity상 휴먼 member만 허용.
_HUMAN_REVIEW_STATUSES = frozenset({"approved", "rejected"})

router = APIRouter(prefix="/api/v2/gates", tags=["gates", "Trust"])


# story #4080 — `list_gates`의 gate_type 조회 필터가 검증하는 형식(소속이 아니라 모양만,
# 아래 list_gates 본문 주석 참조). 실존 gate_type 전수(GATE_TYPES + generation_budget +
# support_escalation_review + org 자작 recipe gate.type)가 전부 lower_snake_case라 그
# 관례를 패턴화한다 — 새 gate_type이 이 패턴 밖(대문자·공백·기호 등)이면 그게 오히려
# 이례적이라 422로 잡는 편이 맞다.
_GATE_TYPE_FILTER_PATTERN = re.compile(r"^[a-z][a-z0-9_]{0,63}$")


class GateCreateRequest(BaseModel):
    work_item_id: uuid.UUID
    work_item_type: str
    gate_type: str
    member_id: uuid.UUID
    role_id: uuid.UUID
    neutral_facts: dict[str, Any] | None = None

    @field_validator("gate_type")
    @classmethod
    def validate_gate_type(cls, v: str) -> str:
        from app.models.hitl_config import GATE_TYPES
        if v not in GATE_TYPES:
            raise ValueError(f"gate_type must be one of {sorted(GATE_TYPES)}")
        return v


class GateTransitionRequest(BaseModel):
    status: str
    resolver_id: uuid.UUID | None = None  # ⚠️RC#1: 무시됨(서버가 인증 caller 로 강제)·하위호환 잔류.
    note: str | None = None
    # story #2027 AC2(까심 QA 적출·2026-07-20, 페드루 PO 처방 2026-08-16): 고위험 게이트의
    # "근거 열람" 요건도 note와 동형으로 서버가 강제한다 — 클라이언트가 「봤다」고 선언한
    # 값을 그대로 신뢰하는 것뿐이라 완전한 증명은 아니지만(서버는 실제 열람 여부를 관측할
    # 수 없다), 최소한 「보냈다」는 사실 자체가 UI 경유를 강제한다(직접 API 호출은 이 필드를
    # 몰라 기본값 False로 막힌다 — AC1의 note 강제와 같은 방어선). 기본값 False = 안 보내면
    # 고위험에서 막힘(저위험은 아래 강제 블록이 risk_grade=="high"일 때만 돌아 무관).
    evidence_viewed: bool = False
    # story #2975(HIGH, 게이트 신선도 구멍) — merge 게이트 승인의 anchor SHA 레이스 근본 처방.
    # PO가 화면에서 review한 SHA를 여기 실어 보내야, 서버가 「지금 이 순간의 github_check_run_sha」
    # (승인 클릭~서버 커밋 사이 웹훅 레이스로 이미 딴 SHA일 수 있음)를 review-time SHA와 대조할
    # 수 있다. Optional 유지 이유: 이 엔드포인트는 merge 게이트 전용이 아니라 doc_approval·
    # artifact_canonicalize 등 SHA 개념이 없는 gate_type도 함께 처리(공유 계약) — 그쪽엔 강제 불가.
    # merge 게이트 승인 시의 fail-closed 강제는 transition_gate_endpoint 본문에서(None도 「안 보냄」
    # 취급돼 known SHA와 불일치로 거부됨 — "안 보내면 조용히 통과"라는 구멍 자체가 생기지 않는다).
    reviewed_head_sha: str | None = None
    # story #4190(PO 판정 2026-09-23 11:49Z) — 레시피 external_publish 게이트 승인 화면이 보여 준 초안
    # (`linked_channel_draft`의 draft_id·version). 위 reviewed_head_sha와 같은 원리: 화면을 연 뒤·클릭 전에 새 버전이
    # 커밋되면 옛 화면 클릭이 본 적 없는 새 버전을 봉인하던 창을 닫는다. 보여 준 초안이 있는 승인에서 미전송·불일치면
    # 409(fail-closed · gate_service.RecipeReviewedDraftChangedError). 다른 gate_type엔 무관(무시).
    reviewed_draft_id: uuid.UUID | None = None
    reviewed_draft_version: int | None = None

    @field_validator("status")
    @classmethod
    def validate_status(cls, v: str) -> str:
        # ⭐RC#1(body-trust 봉인): generic transition 은 **사람 결재(approved/rejected)만** 허용.
        # voided/held/pending(S30/S31)은 전용 엔드포인트(/void·/hold·/unhold)로만 — 그쪽이 admin
        # 게이트(_require_gate_admin)+actor 강제+side-effect 를 보유. generic 으로 보내면 그 가드
        # 3중 우회(비-admin voided/held·voider/holder body-trust·step_run 미해소)되므로 차단.
        if v not in _HUMAN_REVIEW_STATUSES:
            raise ValueError(
                f"generic transition 은 {sorted(_HUMAN_REVIEW_STATUSES)} 만 허용합니다. "
                "voided/held/unhold 는 전용 엔드포인트(/void·/hold·/unhold)를 사용하세요."
            )
        return v


class WorkItemSummary(BaseModel):
    """doc-side 결재 UX(24f5ae18): 인박스 gate 가 work_item 을 렌더/링크하도록 title/slug 동봉.
    현재 doc gate 에 채움(향후 타 work_item_type 확장 여지)."""
    title: str
    slug: str | None = None


class LinkedChannelDraft(BaseModel):
    """story #4098([E-RECIPE-1], 페드루 PO 確定 2026-09-21) — 레시피 unscoped
    external_publish 게이트(scope_key="")를 승인하면 #4090 AC2가 자동으로 발행하는
    그 채널 초안의 실물. `channel_posts.py::find_ready_recipe_channel_drafts`(#4090의
    실제 자동발행 실행 선택 규칙과 **같은 함수** — 두 표면이 다른 draft를 가리키는
    드리프트 방지)가 고르는 draft만 싣는다."""
    draft_id: uuid.UUID
    # story #4190 — 화면이 보여 주는 이 초안의 버전. 승인 요청이 `reviewed_draft_id`·`reviewed_draft_version`으로
    # 그대로 돌려보내고, 서버가 승인 순간(초안 잠금 뒤) 최신과 대조한다(«사람 승인은 본 내용에만»).
    version: int
    channel: str
    account_id: str
    account_label: str | None = None
    text: str | None = None
    image_urls: list[str] = []
    video_url: str | None = None
    # scoped(초안 자체) external_publish 게이트 상태 — "approved"(승인하면 즉시 자동발행)
    # | "pending"(#4069 자동충족 대기 中, 이 unscoped 게이트 승인과 함께 승계-승인된다).
    scoped_gate_status: str
    sealed_scheduled_at: datetime | None = None


class LinkedSiteDraft(BaseModel):
    """story #4190(PO 판정 2026-09-23 12:03Z · 유나 site 초안 카드) — `LinkedChannelDraft`의 블로그(site) 짝. 레시피 게이트
    승인 화면이 그리는 블로그 초안(`gate_service.find_recipe_shown_draft`가 고른 것 — 봉인·캐스케이드와 같은 답).
    목적지 연결 필드(channel·account_*)는 외부 블로그일 때만 값이 있다 — 자사(호스팅) 블로그면 None(카드가 그 줄을 생략).
    `body_preview`는 마크다운 기호를 걷은 평문 앞부분(`text_preview.markdown_plain_text_preview`) — FE는 파싱하지 않는다."""
    draft_id: uuid.UUID
    version: int
    title: str
    body_preview: str
    channel: str | None = None
    account_id: str | None = None
    account_label: str | None = None
    scoped_gate_status: str
    sealed_scheduled_at: datetime | None = None


class LinkedEvidenceItem(BaseModel):
    """story #4135(PO 실측 2026-09-22) — «이것을 가리키는 것들» 0건 실사고 처방. neutral_
    facts.draft_doc_*은 게이트 *생성* 시점 스냅샷이라(recipe_gate_hooks.py 참조) 생성
    뒤 핀된 evidence는 거기 절대 안 실린다 — 이 필드는 조회 시점마다 다시 계산해 그
    갭을 메운다(`_enrich_linked_evidence`). reference_token이 None인 항목도 남긴다 —
    "이 evidence가 존재는 하는데 무엇을 가리키는지 확認 불가"를 "이 evidence 자체가
    없음"과 구분해서 보여준다(지어내지 않되 침묵하지도 않는다)."""
    id: uuid.UUID
    kind: str
    ref: str
    reference_token: str | None = None


class NewsletterSendCommandSummary(BaseModel):
    """story #4262 — 발송 게이트의 발송 명령(가장 최근 1) 요약. 사람이 멈춘 발송을 다시 시도하려면 명령 id가 필요하다(공용 재시도
    `POST /organizations/{org}/publication-commands/{id}/retry`)."""

    id: uuid.UUID
    status: str
    failure_kind: str | None = None
    reason_code: str | None = None
    # 유나 4262 표 — «{time}에 자동으로 다시 시도해요»(재시도 대기) · 제공자 한도 풀리는 시각.
    next_attempt_at: datetime | None = None
    reason_reset_at: datetime | None = None


class GateResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    # story #2054: 결재함 통합 인박스(/gates/inbox)에서 Gate/HitlRequest 두 출처를 구분하는
    # discriminator. 기존 단독 엔드포인트(list_gates/get_gate/transition 등)는 항상 "gate"
    # 고정값 — additive, 기존 응답 shape 비파괴.
    source: Literal["gate"] = "gate"
    id: uuid.UUID
    org_id: uuid.UUID
    # story #1970(P1a-S4): GET /{id} 단건 조회 신규 enrich(Gate 모델 자체엔 project_id 컬럼이
    # 없다 — resolve_work_item_project_id()로 조회해 채운다). additive·nullable(project-무관
    # work_item은 None — 정직한 값, feedback_infra_value 류 fallback 아님). 기존 create/list/
    # transition 등 타 엔드포인트는 Gate ORM 객체에 이 속성이 없어 from_attributes 기본값
    # None으로 조용히 통과(work_item_summary/can_approve와 동일 선례).
    project_id: uuid.UUID | None = None
    work_item_id: uuid.UUID
    work_item_type: str
    # doc-side 결재 UX(24f5ae18): gate row 는 work_item_id 만이라 인박스가 doc 를 못 그림 → enrich.
    # additive·nullable(비-doc/미존재 시 None·하위호환). FE 는 별도 doc fetch 제거.
    work_item_summary: "WorkItemSummary | None" = None
    # decider 가시성(89484c8c): doc_approval 게이트에 **per-caller** can_approve(rule A) — FE in-doc
    # decider 버튼 게이팅 소스(parallel-approver 목록 아님). 비-doc/무자격/비-휴먼은 False(fail-closed·
    # additive 하위호환). ⚠️실 authz 는 BE transition 강제(이 필드는 가시성뿐). [[can_approve_doc_gate_reason]]
    can_approve: bool = False
    # story #2893(설계안 §2 A1, 0271) — merge-type만 실제 값을 갖는다(PR 컨텍스트 없는
    # 평가·PR 개념이 없는 타 gate_type은 None). FE가 "이 스토리의 여러 merge 게이트 중
    # 어느 PR 것인지" 고르는 축. additive·Gate ORM 컬럼과 이름 일치라 from_attributes로
    # 자동 채워짐(github_check_run_sha와 동일 선례).
    pr_number: int | None = None
    # story #1972(P1a-S4): 게이트 위험도 UX 등급 — **새 위험도 판정 필드가 아니다**. 기존
    # OrgGatePolicy.posture + Gate.gate_type을 순수 파생(gate_service.derive_risk_grade)한 UX
    # 힌트일 뿐(doc `gate-risk-ux-classification-criteria` §2 SSOT). "risk_level" 이름은 의도적으로
    # 피했다 — 플랫폼이 위험도를 판정한다는 오인을 부르기 때문(models/hitl_config.py:3 철학과
    # 정면충돌). nullable(선언 자체는 유지 — Gate ORM에 이 컬럼이 없다). **정정(story #3874)**:
    # 한때 list_gates·get_gate_endpoint·create_decision_request 3곳만 채우고 나머지 14곳은
    # None으로 새던(같은 API가 호출 경로에 따라 거짓말하는 계약 결함) 자리였다 — 이제
    # GateResponse를 만드는 모든 자리가 `to_gate_response()` 하나를 거쳐 예외 0으로 채운다.
    risk_grade: "RiskGrade | None" = None
    # story #3860(customer-zero·BE·게이트 답하기) — 「일감」 우패널 주 액션 「답하기」의
    # 데이터 소스. Gate ORM엔 이 컬럼이 없다(work_item_summary/can_approve와 동일
    # 선례 — from_attributes 기본값 None으로 조용히 통과, list_gates·get_gate_endpoint
    # 둘 다 배치로 채운다). **per-caller**(같은 gate라도 caller가 그 work_item을 태그한
    # 대화의 참여자가 아니면 None — 대화 존재 자체를 비참여자에게 노출하지 않는다, PR
    # #4253 원칙과 동형). additive·하위호환(신규 필드, 기존 소비처 무변).
    conversation_id: uuid.UUID | None = None
    gate_type: str
    # story #4098 — FE가 "이 게이트가 레시피 unscoped external_publish(scope_key="")인지"
    # 를 직접 판별해야 linked_channel_draft/_pending의 "값 없음"과 "이 카드 자체가 대상이
    # 아님"을 구분할 수 있다(둘 다 null/false로 같아 보이는 값이라 별도 신호 필요). Gate
    # ORM 컬럼과 이름 일치 — from_attributes로 자동 채워짐(resolution_note와 동일 선례).
    #
    # ⛔페드루 PO REQUIRED(2026-09-21, PR #4475 리뷰, CI RED — test_1970/1972/1973 9건) —
    # DB 컬럼은 `NOT NULL DEFAULT ''`(0328)지만, 아직 flush/refresh 안 된 in-memory Gate
    # ORM 객체(또는 이 필드를 안 세팅한 옛 테스트 픽스처)는 Python 값이 `None`이라 model_
    # validate(from_attributes=True)가 그대로 터진다 — 코드 곳곳의 `gate.scope_key or ""`
    # 방어가 바로 그 증거. 응답 필드도 그 실태를 그대로 받아 `str | None`(FE는 이미
    # `gate.scope_key ?? ''`로 처리 — gate-evidence.tsx). 기본값 ""는 "명시로 안 준 신규
    # 필드는 무해한 기본값" 관례일 뿐 실제 None 유입을 못 막는다 — 타입 자체를 넓힌다.
    scope_key: str | None = None
    status: str
    resolver_id: uuid.UUID | None = None
    resolved_at: datetime | None = None
    resolution_note: str | None = None
    # story #4090([E-RECIPE-1] Publisher 슬롯) AC2, migration 0388 — 레시피 자동발행 훅의
    # 기계 소유 결과(스킵 사유|"published"|"scheduled"). `resolution_note`(승인자 본인
    # 문장)와 절대 안 섞는다(페드루 PO 確定 2026-09-21) — Gate ORM 컬럼과 이름 일치라
    # from_attributes로 자동 채워짐(resolution_note와 동일 선례). external_publish
    # (scope_key="") 게이트가 아니면 항상 None.
    publish_outcome: str | None = None
    # story #4098([E-RECIPE-1], 페드루 PO 確定 2026-09-21) — 레시피 unscoped external_
    # publish 게이트(scope_key="") 상세에 "이 승인으로 발행될 채널 초안" 실물을 싣는다.
    # Gate ORM 컬럼이 아니라(`work_item_summary`/`can_approve`와 동일 선례) `to_gate_
    # response()`가 매 응답마다 배선 — 다른 gate_type·scoped 게이트는 항상 None/False.
    linked_channel_draft: "LinkedChannelDraft | None" = None
    # linked_channel_draft가 None인 이유가 "제출된 게 없음"(문구 A)인지 "제출은 됐지만
    # scoped 게이트가 아직 pending, #4069 자동충족 대기 中"(문구 B — 이 unscoped 게이트
    # 승인과 함께 승계-승인된다)인지 FE가 갈라야 해서 별도 플래그(같은 조회 한 번의
    # 부산물, 새 쿼리 0 — find_ready_recipe_channel_drafts의 still_pending 그대로).
    linked_channel_draft_pending: bool = False
    # story #4190(PO 판정 2026-09-23 12:03Z) — 레시피 게이트가 보여 주는 초안이 블로그(site)일 때의 카드. 채널 카드와
    # 둘 중 하나만 채워진다(어느 카드인지 BE가 가른다 — `find_recipe_shown_draft`). `_pending`은 채널 짝과 같은 뜻
    # (제출은 됐지만 멀티목적지 pending이라 이 승인이 승계하지 않음).
    linked_site_draft: "LinkedSiteDraft | None" = None
    linked_site_draft_pending: bool = False
    # story #4190(PO 12:16Z · 유나 빈 상태 절) — 보여 줄 초안이 **없을 때만** 채운다: 레시피 정의 capability로 가른 초안 종류
    # (`events.recipe_draft_kind`). FE는 빈 상태 문구 고르기에만 쓴다(channel_post → 채널 · site_post → 블로그 · null → 중립).
    linked_draft_kind: Literal["channel_post", "site_post"] | None = None
    # story #4135(PO 실측 2026-09-22) — concept_approval·structure_approval 게이트의
    # «확定 대상 실물». `_enrich_linked_evidence()`가 매 응답마다 배선(linked_channel_draft와
    # 동일 선례) — 그 gate_type이 아니거나(_GATE_TYPE_EXPECTED_EVIDENCE_KINDS 미등재)
    # evidence가 0건이면 항상 빈 리스트(None 아님 — "아직 안 봄"과 "0건 확認"을 같은 값으로
    # 안 섞는다).
    linked_evidence: list[LinkedEvidenceItem] = []
    # story #4139([E-RECIPE-1] Phase3 폴리시, 페드루 PO 確定 2026-09-22) — 이 게이트 자신이
    # draft-scoped(scope_key≠"") external_publish이고, 같은 work_item의 레시피 unscoped
    # (scope_key="") external_publish 게이트가 아직 pending 中이며, 이 게이트가 그 work_item의
    # 유일한 pending scoped 게이트(단일 목적지 — #4069/#3478 규칙과 동일 기준)면 그 레시피
    # 게이트의 id를 싣는다. "이 게이트는 레시피 게이트가 대신 결재한다"는 **파생값**(저장
    # 컬럼 0·마이그 0) — Gate ORM에 이 필드가 없다(work_item_summary/can_approve와 동일
    # 선례, `_enrich_deferred_to_gate_id`가 매 응답마다 계산). None이면 이 게이트가 사람
    # 결재함에 정상적으로 뜬다(레시피 무관·비-scoped·다중목적지·레시피 게이트 이미 결정됨
    # 등 전부 여기 포함). FE는 이 값이 있으면 액션 버튼을 숨기고 「레시피 게이트에서 함께
    # 결재돼요」+링크를 보인다(직접 transition 호출 자체는 안 막는다 — 멱등이라 위험 없음).
    deferred_to_gate_id: uuid.UUID | None = None
    # story #3001(선생님 정책 확定 2026-08-24) — FE가 "이 카드 원 수신자==나인데 지금은 다른
    # 사람이 지정돼 있다"(위임됨)를 로컬 판단하는 데 필요. Gate ORM 컬럼과 이름 일치라
    # from_attributes로 자동 채워짐(resolver_id와 동일 선례) — 오늘(#2985) 이 필드 자체를
    # 빠뜨렸던 걸 여기서 보강.
    designated_approver_id: uuid.UUID | None = None
    # story #d9c09f4b(2026-08-27, customer-zero) — 카드가 어디로도 실패하지 않고 「엉뚱한
    # 실사람」에게 정확히 배달된 실사고(호출자가 approver_member_id를 오지정·배달층 자체는
    # 무결)의 해독제. 배달 성공/실패와 무관하게 "이 게이트가 실제로 누구를 가리키는지"를
    # 응답에서 즉시 에코 — 호출자가 원탭 자가검증 가능. create_decision_request만 채움
    # (additive·nullable, risk_grade/project_id와 동일 선례 — 타 엔드포인트는 이 속성이
    # ORM에 없어 from_attributes 기본값 None으로 조용히 통과).
    designated_approver_name: str | None = None
    held_until: datetime | None = None  # S31: status='held' 시 시한부 만료(무기한이면 None)·additive
    neutral_facts: dict[str, Any] | None = None
    # H1-S3: merge verdict gate evidence metadata (0118)·additive·하위호환 default.
    requires_human: bool = False
    evidence_status: str | None = None
    decision_basis: str | None = None
    auto_decision_reason: str | None = None
    # story #2813/#2814 계약 ①(미르코군 그라운딩 doc gate-github-check-fe-grounding-2814 §5) —
    # GitHub check-run 상태를 FE가 읽을 수 있게 raw passthrough(신규 엔드포인트 불요). Gate ORM에
    # 이미 있는 컬럼 그대로 — additive·nullable(merge 게이트 아니거나 아직 미발행이면 None).
    github_check_run_id: int | None = None
    # 카디르 QA(PR#3244) — Gate ORM엔 3243이 이미 이 컬럼을 추가했는데(카디르 QA③-c 신설) 이
    # 응답 스키마에 누락돼 있어 FE의 SHA 배지가 실 API에선 영원히 undefined였다. from_attributes라
    # ORM 컬럼명과 일치시키기만 하면 다른 construction site 변경 없이 그대로 채워진다.
    github_check_run_sha: str | None = None
    approved_head_sha: str | None = None
    # story #2815(§5-④, 관측모드 판별) — `github_check_run_id`가 계속 null인 이유를 FE가
    # 구분하게: True면 "이 repo는 required check 등록됨(발행 대기/진행 중)", False/None이면
    # "이 repo는 애초에 관측모드"로 해석. additive·기본 None(get_gate_endpoint만 채움 — list_gates
    # 등 타 엔드포인트는 PR 링크 N+1 조회 비용 때문에 스코프 밖, risk_grade/can_approve와 동일
    # 선례 — Gate ORM에 이 속성이 없어 from_attributes 기본값으로 조용히 통과).
    github_check_enforced: bool | None = None
    # story #3367(Phase0 S2, 페드루 PO 리뷰 2026-09-03 05:59Z) — external_publish 전용 sealing.
    # S4 승인 카드(본문 전문·버전·해시)·재승인 배지(봉인 해시 vs 현재 해시 파생)가 이걸 읽는다.
    # github_check_run_sha/approved_head_sha와 동일 선례 — Gate ORM 컬럼명과 일치라
    # from_attributes로 자동 채워짐(다른 gate_type은 전부 None, additive·하위호환).
    sealed_content_version: int | None = None
    sealed_content_sha256: str | None = None
    sealed_content_body: str | None = None
    # story #3414(Phase1·마케팅운영, 페드루 PO 確定 2026-09-04) — external_publish 예약
    # 발행 두 번째 봉인 축(sealed_content_*와 같은 관례, 예약 없는 다른 gate_type은
    # 항상 null). story #4073(카디르 QA④ 실측, 2026-09-19) — 이 컬럼(models/gate.py)은
    # channel_posts.py 발행 실행 경로엔 이미 쓰이는데(gate_service.py:1097/1137)
    # 이 응답 스키마 등재를 빠뜨려 승인카드에서 예약시각이 안 보였다 — sealed_ads_*·
    # sealed_newsletter_*·sealed_estimated_cost_minor(#4072)에 이어 같은 클래스의
    # 마지막 인스턴스. Gate ORM 컬럼명과 일치라 from_attributes로 자동 채워짐.
    sealed_scheduled_at: datetime | None = None
    # story #3367(3자기점검, 페드루 지적 2026-09-10) — AC7("결재 카드에서... 목적지를
    # 확認할 수 있고")의 입력. Gate ORM 컬럼명과 일치라 from_attributes로 자동 채워짐
    # (sealed_content_*와 동일 선례). null=hosted_site(site_posts.py::_reseal_gate_on_
    # new_version 관례 그대로), 그 외는 ChannelConnection.id.
    sealed_destination_connection_id: uuid.UUID | None = None
    # story #3367(유나 CHANGES, 페드루 재검토 2026-09-10) — sealed_destination_
    # connection_id 하나만으론 FE가 uuid 원문 꼬리를 승인자에게 보여줄 수밖에 없다
    # (확認 불가능한 값으로 서명을 요구하는 결함). 그 연결의 channel(예: "wordpress")을
    # 같이 실어 FE가 집안 정본 lib/channel-label.ts::channelLabel()로 표시명을 낸다 —
    # null(hosted_site)은 그 자체가 이미 목적지 신호라 이 필드도 항상 null. list_gates()
    # 가 sealed_destination_connection_id와 같은 배치(N+1 0)로 채운다.
    sealed_destination_channel: str | None = None
    # story #3367(3자기점검, 페드루 지적 2026-09-10) — AC7의 나머지 축("마지막 수정
    # 주체"). sealed_content_body의 작성자가 아니라(그건 «봉인 당시» 작성자·approved
    # 뒤 편집이면 옛 버전에 묶여 있다) draft의 **지금** 최신 버전 author_kind — list_
    # gates()가 neutral_facts.draft_id로 배치 enrich(N+1 0, sealed_doc_id와 동일 선례).
    # 다른 gate_type·draft_id 없는 옛 external_publish 행은 None(지어내지 않는다).
    latest_author_kind: str | None = None
    # story #3569(Phase2·BE·소형, 페드루 PO 確定 2026-09-06) — concept_approval 전용
    # sealing(story #3561/#3922). sealed_content_*와 동일 선례 — Gate ORM 컬럼명과
    # 일치라 from_attributes로 자동 채워짐(다른 gate_type은 전부 None).
    sealed_doc_id: uuid.UUID | None = None
    sealed_doc_body_sha256: str | None = None
    # story #3569 — sealed_doc_id 하나로는 FE가 «봉인 doc 링크(글자=doc 제목)»를 못
    # 그린다(3560 FE (b), 미르코 그라운딩). Gate ORM엔 이 컬럼이 없다 — **봉인 시점이
    # 아니라 「지금」 doc 제목**(제목은 봉인 대상이 아니다, 본문 sha만 봉인 — PO 明示)을
    # list_gates/get_gate_endpoint가 각자 배치/단건 조회해 채운다. 삭제된 doc·
    # sealed_doc_id 자체가 없으면 null(지어내지 않는다).
    sealed_doc_title: str | None = None
    # story #3806(Phase3·3-2 PR5, 3자기점검 — PR2가 Gate ORM 컬럼(models/gate.py:179-190)만
    # 추가하고 이 응답 스키마 등재를 빠뜨려 API가 항상 None을 냈다) — ads_boost 전용 sealing.
    # sealed_content_*/sealed_doc_*와 동일 선례 — Gate ORM 컬럼명과 일치라 from_attributes로
    # 자동 채워짐(다른 gate_type은 전부 None, additive·하위호환). 유나 §절 §1 「결재 카드
    # 봉인 5필드」(총예산·통화·기간·목표) + connection_id(표시는 안 하나 감사용 봉인 축).
    sealed_ads_budget_minor: int | None = None
    sealed_ads_currency: str | None = None
    sealed_ads_starts_at: datetime | None = None
    sealed_ads_ends_at: datetime | None = None
    sealed_ads_objective: str | None = None
    sealed_ads_connection_id: uuid.UUID | None = None
    # story #3813(Phase3·3-4 PR4, 3자기점검 — PR2가 Gate ORM 컬럼(models/gate.py:204-205)만
    # 추가하고 이 응답 스키마 등재를 빠뜨려 API가 항상 None을 냈다, sealed_ads_* PR2 재발
    # 클래스와 동형) — newsletter_send 전용 sealing. Gate ORM 컬럼명과 일치라
    # from_attributes로 자동 채워짐(다른 gate_type은 전부 None).
    sealed_newsletter_segment_name: str | None = None
    sealed_newsletter_scheduled_at: datetime | None = None
    # story #3813(Phase3·3-4 PR4, 페드루 PO 確定 2026-09-12) — 승인 카드 전용 계산값
    # (Gate ORM 컬럼 아님·봉인 안 함, 수신자는 ESP 소유라 우리가 얼리면 드리프트).
    # get_gate_endpoint가 gate_type=="newsletter_send"일 때만 어댑터 수준 조회
    # (describe_segment)로 채운다 — 실 stibee는 미구현이라 None(「미확인」), sandbox는
    # 고정 4,200. 조회 실패는 카드 전체를 죽이지 않고 이 필드만 None(fail-closed,
    # warning 로그 — get_gate_endpoint 본문 참고).
    estimated_recipient_count: int | None = None
    # story #3813(Phase3·3-4 PR4, 페드루 PO CHANGES 2026-09-12, 라이브 캡처 실측) —
    # 승인 카드가 「무엇을」 보내는지(subject)를 안 보여줘 세그먼트·시각·수신수만 보고
    # 승인하던 결함. Gate ORM 컬럼 아님(봉인 축이 아니다, PR2 설계 그대로 유지) —
    # publication.version_id가 가리키는 ChannelPostVersion.channel_payload에서
    # 「지금」 값을 읽는다(estimated_recipient_count와 동일 계산값 선례).
    newsletter_subject: str | None = None
    # story #4262(PO 13:39Z) — 발송 게이트의 발송 명령 상태(dead_letter · blocked면 게이트 화면이 사람 재시도 자리를 연다).
    # 단건 `GET /gates/{id}`만 채운다(목록은 None — 게이트마다 조회하는 N+1을 만들지 않는다). 뉴스레터 게이트가 아니거나
    # 아직 명령이 없으면 None.
    newsletter_send_command: NewsletterSendCommandSummary | None = None
    # story #4044(0333)가 Gate ORM 컬럼(models/gate.py)만 추가하고 이 응답 스키마 등재를
    # 빠뜨려 API가 항상 None을 냈다 — sealed_ads_*/sealed_newsletter_* PR2 재발 클래스와
    # 동형(story #4072가 그 클래스 자체를 회귀가드로 봉인). generation_budget 전용 sealing —
    # Gate ORM 컬럼명과 일치라 from_attributes로 자동 채워짐(다른 gate_type은 전부 None).
    sealed_estimated_cost_minor: int | None = None
    reapproval_required: bool = False
    created_at: datetime
    updated_at: datetime


# rule-A can_approve 단일 규칙(48f064e5 transition 인라인 → 89484c8c 추출·DRY). transition 강제(403
# 분기)와 list_gates decider 가시성(can_approve bool) 이 공용 — 거동 분기 0.
_DOC_UNSET: Any = object()


async def can_approve_doc_gate_reason(
    session: AsyncSession,
    gate: Gate,
    resolved: Any,
    user_id: uuid.UUID,
    org_id: uuid.UUID,
    *,
    doc_project_id: Any = _DOC_UNSET,
) -> str | None:
    """doc_approval 게이트 rule A(PO) 판정. None=승인 가능·else 거부사유 코드("not_human"/"self_or_unverified"/
    "no_project_access"). rule A = human + 대상 doc project has_project_access + not-author(resolver≠
    requester·미기록=fail-closed). ⚠️single source: transition self-approval/can_approve 강제와 list_gates
    per-caller can_approve enrich 가 공용(분기 일치 보장). ``doc_project_id`` 미지정 시 대상 doc 직접 조회
    (transition 단건)·list_gates 는 배치 조회한 project_id 주입(N+1 0)·None 주입=삭제/미존재 doc."""
    if resolved.type != "human":
        return "not_human"
    requester = (gate.neutral_facts or {}).get("requested_by_member_id")
    # SoD: 상신자 본인 금지 + 미기록(forged/이상 게이트)=fail-closed.
    if requester is None or str(resolved.id) == str(requester):
        return "self_or_unverified"
    if doc_project_id is _DOC_UNSET:
        _doc = (await session.execute(
            select(Doc).where(
                Doc.id == gate.work_item_id, Doc.org_id == org_id, Doc.deleted_at.is_(None)
            )
        )).scalar_one_or_none()
        doc_project_id = _doc.project_id if _doc is not None else None
    if doc_project_id is None or not await has_project_access(
        session, user_id, doc_project_id, org_id
    ):
        return "no_project_access"
    return None


_POSTURE_UNSET: Any = object()


async def to_gate_response(
    session: AsyncSession, org_id: uuid.UUID, gate: Gate, *, posture: Any = _POSTURE_UNSET,
) -> GateResponse:
    """story #3874 — GateResponse 직렬화 단일 통로. model_validate + risk_grade enrich
    (story #1972 SSOT — gate_service.derive_risk_grade)를 한 자리로 묶는다.

    이 헬퍼 도입 前엔 model_validate 직접 호출 15곳 中 3곳(list_gates·get_gate_endpoint·
    create_decision_request)만 risk_grade를 채웠고 나머지 12곳(transition 포함 — 고위험
    note 필수 검증 때문에 risk_grade를 이미 계산해 놓고도 응답엔 안 실었다)은 늘 None을
    냈다(story #3868 AC0 실측). FE는 지금 이 필드를 transition 등 그 12곳 응답에서 직접
    읽지 않아(3곳 다 재조회하거나 바디 자체를 안 읽음) 렌더 버그로 드러나진 않았지만,
    API 계약 자체가 거짓이라 새 소비처(FE는 물론 MCP 에이전트 포함)가 그 바디를 그대로
    믿으면 즉시 오판한다 — 그래서 개별 12곳 패치가 아니라 통로를 하나로 좁힌다(gates.py에
    `GateResponse.model_validate(` 직접 호출이 이 함수 밖에 남아있으면 안 된다 — 그 불변식은
    tests/test_3874_gate_response_serialization_guard.py의 AST 정적 스캔이 고정한다).

    posture 미지정(기본, `_POSTURE_UNSET`)이면 이 호출이 org posture를 1쿼리로 직접 조회
    한다(단건 엔드포인트 전부 이 경로 — get/create/transition/void 등, 매 호출 1쿼리는
    기존 get_gate_endpoint/create_decision_request와 동일 비용, 새 비용 0). list_gates처럼
    다건을 한 번에 낼 때는 호출부가 posture를 미리 1회 조회해 이 인자로 넘겨(story #1972
    N+1 회피 선례 그대로 유지) 매 gate마다 재조회하지 않는다."""
    resp = GateResponse.model_validate(gate)
    if posture is _POSTURE_UNSET:
        posture = await get_org_posture(session, org_id)
    resp.risk_grade = derive_risk_grade(posture, gate.gate_type)
    await _enrich_linked_channel_draft(session, org_id, gate, resp)
    await _enrich_scoped_channel_draft_media(session, org_id, gate, resp)
    await _enrich_linked_evidence(session, org_id, gate, resp)
    await _enrich_deferred_to_gate_id(session, org_id, gate, resp)
    return resp


async def _enrich_deferred_to_gate_id(
    session: AsyncSession, org_id: uuid.UUID, gate: Gate, resp: GateResponse,
) -> None:
    """story #4139 — 좁은 가드가 먼저(비용 0, `_enrich_linked_channel_draft`와 동일 관례):
    draft-scoped(scope_key≠"") pending external_publish 게이트만 대상. 그 밖은 이 함수의
    나머지 줄에 절대 안 들어간다."""
    if gate.gate_type != "external_publish" or (gate.scope_key or "") == "" or gate.status != "pending":
        return

    from app.services.gate_service import (
        find_pending_recipe_external_publish_gate,
        recipe_approval_cascade_target,
    )

    recipe_gate = await find_pending_recipe_external_publish_gate(
        session, org_id=org_id, work_item_id=gate.work_item_id, work_item_type=gate.work_item_type,
    )
    if recipe_gate is None:
        return
    # story #4190 — «대신 결재»는 레시피 승인이 실제로 캐스케이드할 게이트뿐 — 캐스케이드(transition_gate)와 같은 판정
    # 함수. 블로그 초안(승인 화면에 없음)·다른 목적지가 살아 있는 게이트를 숨기면 레시피 승인 뒤에도 사람이 못 찾는다.
    target = await recipe_approval_cascade_target(
        session, org_id=org_id, work_item_id=gate.work_item_id, work_item_type=gate.work_item_type,
    )
    if target is not None and target.id == gate.id:
        resp.deferred_to_gate_id = recipe_gate.id


async def _enrich_linked_channel_draft(
    session: AsyncSession, org_id: uuid.UUID, gate: Gate, resp: GateResponse,
) -> None:
    """story #4098 — `to_gate_response()`의 단일 통로 불변식(위 docstring)을 그대로
    타 create/get/list/transition/void 전부가 이 enrich를 받는다(list_gates도 이미
    gate마다 `to_gate_response()`를 부르므로 배치 전용 재구현 없이 한 곳으로 족하다
    — 대상 자체가 「레시피 unscoped external_publish 게이트」뿐이라 일반 목록에서
    차지하는 비중이 낮다, 페드루 PO 사전 승인 여지 없음 — 필요시 후속 배치 최적화).

    좁은 가드가 먼저라 다른 gate_type·scoped 게이트는 이 함수의 나머지 줄에 절대
    안 들어간다(비용 0).

    ⛔페드루 PO REQUIRED(2026-09-21, PR #4475 리뷰) — `external_publish && scope_key
    ==""`만으로는 여전히 넓다. #4090 AC2 자동발행의 진짜 전제는 그보다 좁은 「레시피
    게이트」(`neutral_facts.triggered_by_event`·`stage`가 실린 게이트,
    `publish_recipe_approved_draft`의 첫 분기와 정확히 같은 조건)뿐이다 — facts가
    없는 옛/비레시피 unscoped external_publish 행(있다면)까지 이 가드를 통과시키면
    "승인해도 발행되지 않아요" 카드가 붙어 그 게이트엔 아예 다른 세계의 문장이
    새고, list_gates에서도 그 행마다 불필요한 쿼리가 샌다. `publish_recipe_
    approved_draft`와 완전히 동형인 가드로 좁힌다(새 조건 발명 0, 그 함수의 첫
    return 문 그대로 복제)."""
    if gate.gate_type != "external_publish" or (gate.scope_key or "") != "":
        return
    facts = gate.neutral_facts or {}
    if not facts.get("triggered_by_event") or not facts.get("stage"):
        return
    # story #4105(#4098 잔여, 페드루 PO 실측 2026-09-21) — find_ready_recipe_channel_
    # drafts는 «scoped 승인 済·미발행» 초안만 담는다(#4090 자동발행 대상 정의) — 이
    # 게이트가 이미 승인(또는 반려/보류 등 비-pending)이면 그 정의상 이 쿼리는 항상
    # 빈 결과만 낸다(발행이 끝났으면 초안은 already_published로 걸러지고, 반려/보류면
    # 애초에 자동발행 대상이 아니다). 쿼리 자체를 skip — FE는 gate.status로 판별해
    # publish_outcome 라벨(또는 무문장)로 갈아 끼운다(gate-evidence.tsx).
    if gate.status != "pending":
        return

    from app.services.gate_service import find_recipe_shown_draft

    # story #4190 — 채널·블로그 중 어느 카드를 그릴지는 봉인·캐스케이드와 같은 판정 하나(`find_recipe_shown_draft`).
    shown, channel_pending, site_pending = await find_recipe_shown_draft(
        session, org_id=org_id, work_item_id=gate.work_item_id, work_item_type=gate.work_item_type,
    )
    if shown is None:
        resp.linked_channel_draft_pending = channel_pending
        resp.linked_site_draft_pending = site_pending
        resp.linked_draft_kind = await _recipe_draft_kind_for_gate(session, org_id, facts.get("triggered_by_event"))
        return
    if shown.kind == "site_post":
        resp.linked_site_draft = await _build_linked_site_draft(
            session, draft=shown.draft, latest=shown.latest,
            scoped_gate_status=shown.scoped_gate.status, sealed_scheduled_at=shown.scoped_gate.sealed_scheduled_at,
        )
        return
    resp.linked_channel_draft = await _build_linked_channel_draft(
        session, draft=shown.draft, latest=shown.latest,
        scoped_gate_status=shown.scoped_gate.status, sealed_scheduled_at=shown.scoped_gate.sealed_scheduled_at,
    )


async def _recipe_draft_kind_for_gate(session: AsyncSession, org_id: uuid.UUID, definition_key) -> str | None:
    """레시피 게이트 `neutral_facts.triggered_by_event`(= 정의 key)로 정의를 찾아 초안 종류를 가른다. 조직 정의가 같은 key의
    플랫폼 정의보다 앞선다. 못 찾으면 None(중립 문구)."""
    if not isinstance(definition_key, str) or not definition_key:
        return None
    from sqlalchemy import or_

    from app.models.event_definition import EventDefinition
    from app.routers.events import recipe_draft_kind

    rows = (await session.execute(
        select(EventDefinition).where(
            EventDefinition.key == definition_key,
            or_(EventDefinition.org_id == org_id, EventDefinition.org_id.is_(None)),
        )
    )).scalars().all()
    if not rows:
        return None
    definition = next((d for d in rows if d.org_id is not None), rows[0])
    return recipe_draft_kind(definition)


async def _build_linked_site_draft(
    session: AsyncSession, *, draft, latest, scoped_gate_status: str, sealed_scheduled_at,
) -> "LinkedSiteDraft":
    from app.models.channel_connection import ChannelConnection
    from app.services.text_preview import SITE_DRAFT_BODY_PREVIEW_MAX, markdown_plain_text_preview

    connection = await session.get(ChannelConnection, draft.connection_id) if draft.connection_id else None
    return LinkedSiteDraft(
        draft_id=draft.id, version=latest.version, title=latest.title,
        body_preview=markdown_plain_text_preview(latest.body_md, SITE_DRAFT_BODY_PREVIEW_MAX),
        channel=connection.channel if connection is not None else None,
        account_id=connection.account_id if connection is not None else None,
        account_label=connection.account_label if connection is not None else None,
        scoped_gate_status=scoped_gate_status, sealed_scheduled_at=sealed_scheduled_at,
    )


async def _build_linked_channel_draft(
    session: AsyncSession, *, draft, latest, scoped_gate_status: str, sealed_scheduled_at,
) -> "LinkedChannelDraft":
    """story #4098이 원래 `_enrich_linked_channel_draft`(레시피 unscoped 게이트) 안에
    인라인으로 갖고 있던 직렬화(draft+version+connection → LinkedChannelDraft) 그대로 —
    story #4143(페드루 PO 確定 2026-09-22, AC1 "단일 경로, 두 번째 직렬화기 0")가
    scoped 게이트 자신의 미디어 표시에도 같은 shape가 필요해지면서 재사용 가능한
    조각으로 뺐다. 두 번째 직렬화기를 새로 짜면 두 표면이 "같은 draft인데 다른 필드
    모양"으로 갈리는 twin-system 갭이 된다(이 코드베이스가 반복 경험한 그 클래스)."""
    from app.models.channel_connection import ChannelConnection
    from app.services.channel_post_images import list_channel_post_images_for_version, public_url_for_object_path
    from app.services.channel_post_videos import get_channel_post_video_for_version

    connection = await session.get(ChannelConnection, draft.connection_id)
    image_rows = await list_channel_post_images_for_version(session, version_id=latest.id)
    image_urls = [
        url for row in image_rows if (url := public_url_for_object_path(row.final_object_path)) is not None
    ]
    video_row = await get_channel_post_video_for_version(session, version_id=latest.id)
    video_url = public_url_for_object_path(video_row.original_object_path) if video_row is not None else None

    return LinkedChannelDraft(
        draft_id=draft.id, version=latest.version, channel=draft.channel,
        account_id=connection.account_id if connection is not None else "",
        account_label=connection.account_label if connection is not None else None,
        text=latest.text, image_urls=image_urls, video_url=video_url,
        scoped_gate_status=scoped_gate_status, sealed_scheduled_at=sealed_scheduled_at,
    )


async def _enrich_scoped_channel_draft_media(
    session: AsyncSession, org_id: uuid.UUID, gate: Gate, resp: GateResponse,
) -> None:
    """story #4143(2호 리허설 실측, 페드루 PO 確定 2026-09-22) — 채널 초안의 scoped
    external_publish 게이트(이 게이트 자신이 그 초안이 쥔 게이트) 상세·인박스 카드가
    초안 실물(영상·이미지·목적지 채널)을 하나도 안 보여주던 결함. `_enrich_linked_
    channel_draft`(레시피 unscoped 게이트 전용, scope_key=="" 가드)와 정확히 대칭인
    scope_key!="" 가드 — 같은 `_build_linked_channel_draft` 직렬화를 재사용해 두 번째
    구현을 안 짠다(AC1).

    좁은 가드가 먼저라 다른 gate_type·unscoped 게이트는 이 함수의 나머지 줄에 절대
    안 들어간다(비용 0, `_enrich_linked_channel_draft`와 동일 관례)."""
    if gate.gate_type != "external_publish" or (gate.scope_key or "") == "":
        return
    draft_id_raw = (gate.neutral_facts or {}).get("draft_id")
    if not draft_id_raw:
        return
    try:
        draft_id = uuid.UUID(str(draft_id_raw))
    except (ValueError, AttributeError, TypeError):
        return

    from app.services.channel_posts import get_channel_post_draft, list_channel_post_draft_versions

    draft = await get_channel_post_draft(session, org_id=org_id, draft_id=draft_id)
    if draft is None:
        return
    versions = await list_channel_post_draft_versions(session, draft_id=draft_id)
    if not versions:
        return
    latest = versions[-1]

    resp.linked_channel_draft = await _build_linked_channel_draft(
        session, draft=draft, latest=latest,
        scoped_gate_status=gate.status, sealed_scheduled_at=gate.sealed_scheduled_at,
    )

    # story #4143 AC1 "기존 게이트(봉인 前 생성분)는 조회 시 초안에서 파생해 같은 모양으로
    # 답한다" — channel_posts.py::submit_channel_post_draft가 이제 gate.sealed_
    # destination_connection_id를 채우지만(신규 게이트), 이 컬럼이 아직 null인(그 write-path
    # 배포 前에 생성된) 옛 게이트는 여기서 draft.connection_id로 파생해 응답 필드를 채운다
    # (DB 컬럼 자체는 안 건드린다 — 응답 직렬화 시점 보정, 소급 UPDATE 0).
    if resp.sealed_destination_connection_id is None:
        resp.sealed_destination_connection_id = draft.connection_id

    # sealed_destination_channel은 write-path(channel_posts.py) 어느 쪽도 채우지 않는
    # Gate 컬럼(site_posts.py도 동형 — connection_id만 봉인)이라 신규/옛 게이트 가리지
    # 않고 여기서 매번 채운다. draft.channel이 이미 그 값(ChannelConnection 재조회
    # 불필요 — create_channel_post_draft_version이 connection.channel을 그대로 돌려준
    # 값이 draft에 실려 있다).
    if resp.sealed_destination_channel is None:
        resp.sealed_destination_channel = draft.channel


async def _enrich_linked_evidence(
    session: AsyncSession, org_id: uuid.UUID, gate: Gate, resp: GateResponse,
) -> None:
    """story #4135(PO 실측 2026-09-22, 2호 게이트 1 실사고) — «확정 대상 실물»이 게이트
    카드에 안 보이던 결함. `neutral_facts.draft_doc_*`은 게이트 *생성* 시점 스냅샷
    (recipe_gate_hooks.py::_build_approval_neutral_facts)이라, 생성 뒤 핀된 evidence는
    거기 절대 안 실린다(댄이 00:39Z에 artifact를 붙였는데 00:37Z에 만들어진 게이트의
    neutral_facts는 그대로였던 실측 그 문제) — 이 함수는 조회 시점마다 다시 계산해 그
    갭을 메운다(`_enrich_linked_channel_draft`와 동일 사상·자리).

    `recipe_gate_hooks._GATE_TYPE_EXPECTED_EVIDENCE_KINDS`에 없는 gate_type(generation_
    budget·external_publish 등)은 즉시 빈 리스트 — 쿼리 자체를 안 돈다(비용 0, 좁은 가드
    선행 선례 동일)."""
    from app.services.recipe_gate_hooks import (
        _GATE_TYPE_EXPECTED_EVIDENCE_KINDS,
        resolve_stage_evidence_entries,
    )

    if gate.gate_type not in _GATE_TYPE_EXPECTED_EVIDENCE_KINDS:
        return

    entries = await resolve_stage_evidence_entries(
        session, org_id=org_id, work_item_type=gate.work_item_type, work_item_id=gate.work_item_id,
        gate_type=gate.gate_type,
    )
    resp.linked_evidence = [
        LinkedEvidenceItem(
            id=e["id"], kind=e["kind"], ref=e["ref"],
            reference_token=(
                build_reference_token(e["entity_type"], e["entity_id"], e["title"])
                if e["entity_type"] is not None else None
            ),
        )
        for e in entries
    ]


@router.post("", response_model=GateResponse, status_code=201)
async def create_gate_endpoint(
    body: GateCreateRequest,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    _auth=Depends(get_current_user),
    locale: str | None = None,
    accept_language: str | None = Header(None, alias="Accept-Language"),
) -> GateResponse:
    """story #3793 — 라우트 진입점, `Header()` DI 마커는 여기서만 받는다(까심 QA CI FAILURE
    원칙, i18n_catalog.py 모듈 docstring 참조). 직접-호출(realdb·유닛) 테스트는
    `_create_gate_endpoint`를 불러야 한다."""
    return await _create_gate_endpoint(
        body, session=session, org_id=org_id, _auth=_auth,
        resolved_locale=resolve_locale_from_request(locale, accept_language),
    )


async def _create_gate_endpoint(
    body: GateCreateRequest,
    *,
    session: AsyncSession,
    org_id: uuid.UUID,
    _auth,
    resolved_locale: str,
) -> GateResponse:
    # ⚠️BLOCKER(codex gpt-5.5): doc_approval 게이트는 **doc 상신 경로(doc.py transition)로만** 생성.
    # 일반 엔드포인트는 client 가 work_item_id=<자기 doc>+forged neutral_facts.requested_by_member_id 로
    # pre-create 가능 → create_gate 멱등 재사용으로 transition self-approval 가드 우회. 직접 생성 거부
    # (방어심층·doc.py 가 caller 로 server-stamp 하는 것과 짝). 비-doc 게이트는 기존대로.
    if body.gate_type == "doc_approval":
        raise HTTPException(
            status_code=403,
            detail=t("gates.create_doc_gate_not_allowed", resolved_locale),
        )
    # story #1968: 제네릭 게이트 생성은 story/doc/task 등 work_item 객체를 로드하지 않으므로
    # (client가 work_item_id/work_item_type만 보냄) resolve_work_item_project_id()로 신규 조회.
    project_id = await resolve_work_item_project_id(
        session, org_id, body.work_item_type, body.work_item_id,
    )
    # #2237: resolve_work_item_project_id는 조회 전용(gate_service.py) — caller 접근권은 여기서
    # 별도 강제해야 한다(형제 get_gate_endpoint와 동일 SSOT·동일 404 관례로 존재 비노출).
    # ⛔project_id가 None인 이유를 가른다(오르테가 PO 판정, 2026-07-27 라이브 실측 발견) —
    # 「project-무관 타입이라 None」과 「project-scoped 타입인데 해소 실패(타 org·부재)라 None」이
    # 같은 값으로 뭉개져 있으면 후자가 검사를 skip해 버린다(실측: 타 org story로 gate 201 생성됨).
    # fail-closed(②): 통과는 KNOWN_PROJECT_AGNOSTIC_WORK_ITEM_TYPES(명시 allowlist)에 있을 때만 —
    # PROJECT_SCOPED_WORK_ITEM_TYPES에도 그 목록에도 없는 미분류 타입은 기본값이 거부다.
    if project_id is not None:
        # story #2697: require_project_access(전 리소스 공용 판정 함수)로 위임(재구현 0).
        await require_project_access(session, uuid.UUID(_auth.user_id), project_id, org_id,
                                      not_found_detail="Project not found")
    elif not is_known_project_agnostic_work_item_type(body.work_item_type):
        raise HTTPException(status_code=404, detail="Project not found")
    gate = await create_gate(
        session=session,
        org_id=org_id,
        work_item_id=body.work_item_id,
        work_item_type=body.work_item_type,
        gate_type=body.gate_type,
        member_id=body.member_id,
        role_id=body.role_id,
        neutral_facts=body.neutral_facts,
        project_id=project_id,
    )
    await session.commit()
    # story #2459 회귀 동형 방어(2026-08-05): commit 後 model_validate 前 명시 refresh —
    # 트리거 미확定인 MissingGreenlet 클래스(unloaded attr sync 직렬화) 전체를 이 자리서 차단.
    await session.refresh(gate)
    return await to_gate_response(session, org_id, gate)


class DecisionRequestCreate(BaseModel):
    question: str
    options: list[str] | None = None
    assumption: str
    related_work_item_type: str | None = None
    related_work_item_id: uuid.UUID | None = None
    # story #2985(PO 설계 확定 2026-08-24)에서 신설, story #3004(선생님 정책 확定)부터 **필수**
    # — create_decision_request가 None을 400으로 거부(doc.py transition_doc과 동형).
    approver_member_id: uuid.UUID | None = None


async def _notify_decision_request_card(
    session: AsyncSession, org_id: uuid.UUID, gate: Gate, *, requester_id: uuid.UUID, project_id: uuid.UUID,
    designated_approver_id: uuid.UUID | None = None,
) -> None:
    """story #8bc11434(2891) — request_decision(agent_decision_request 게이트) 상신 시 결재자
    (org owner/admin) 챗에 원탭 결재 카드 자동 발행. app/services/doc.py의
    _notify_doc_approval_requested()와 동형(approver 해소·best-effort try/except 관용구 그대로
    재사용 — doc steer-event-axis-design-2927 §5 권고) — 이 gate_type의 승인 자격이 정확히
    org owner/admin임은 _non_doc_gate_approvable()(agent_decision은 project-agnostic이라
    project_id=None 분기, is_org_owner_or_admin)로 이미 확定돼 있어 별도 판단 아님. create_gate()
    의 generic 벨(gate.pending_approval)은 그대로 유지(notify=False 안 씀 — doc.py와 달리 이
    gate_type엔 대체할 리치 벨이 없어 끄면 알림 자체가 0이 된다), 이 함수는 챗 카드만 추가.

    story #3044(2026-08-25) — dispatch_approval_request_cards가 이제 conversation.gate_created
    (결재함 목록 실시간 반영)도 같은 자리에서 심는다. after_commit 훅으로 자체 예약하므로
    (approval_delivery.py의 notify_gate_created_to_recipients 문서 참고) 이 함수·호출부
    둘 다 반환값 스레딩·commit 타이밍을 신경 쓸 필요가 없다 — 회귀 0(원래도 -> None)."""
    try:
        from app.models.project import OrgMember
        approver_ids = list((await session.execute(
            select(OrgMember.id).where(
                OrgMember.org_id == org_id,
                OrgMember.role.in_(("owner", "admin")),
                OrgMember.deleted_at.is_(None),
                OrgMember.id != requester_id,
            )
        )).scalars().all())
    except Exception:  # noqa: BLE001 — 조회 실패는 상신 비중단.
        logger.warning("decision-request 결재자 조회 실패 gate=%s", gate.id, exc_info=True)
        return

    if not approver_ids:
        return

    try:
        from app.services.approval_delivery import dispatch_approval_request_cards
        await dispatch_approval_request_cards(
            session, org_id=org_id, work_item_type="agent_decision", work_item_id=gate.id,
            project_id=project_id, title=gate.neutral_facts.get("question", "결정 요청") if gate.neutral_facts else "결정 요청",
            gate_id=gate.id, gate_type=gate.gate_type, requester_id=requester_id, approver_ids=approver_ids,
            designated_approver_id=designated_approver_id,
        )
    except Exception:  # noqa: BLE001 — 카드 배달 실패는 상신 비중단(Gate inbox 폴백 항상 존재).
        logger.warning("decision-request 결재자 카드(챗) 배달 실패 gate=%s", gate.id, exc_info=True)


@router.post("/decisions", response_model=GateResponse, status_code=201)
async def create_decision_request(
    body: DecisionRequestCreate,
    session: AsyncSession = Depends(get_db),
    scope: dict = Depends(get_scope_context),
    auth=Depends(get_current_user),
) -> GateResponse:
    """story #2709(2026-08-17) — 에이전트의 블로킹 질문을 비동기 결정 요청으로 승격.
    AskUserQuestion류 훅 봉인(story #2701 후속)의 dogfood 교체 대상 — 새 게이트 메커니즘
    발명 0(create_gate/gate_type 등재/알림배관 전부 기존 재사용), 이 엔드포인트 자체만
    신규(캐스팅 글루 — 호출자 신원+standalone self-referencing anchor를 서버가 원자적으로
    한 번에 만들어 준다, MCP 클라이언트가 role_id 같은 내부 개념을 몰라도 되게).

    self-referencing anchor(PO 판정, 2026-08-17): work_item_id==gate.id로 클라 uuid4 선생성
    없이 서버가 1 INSERT로 원자 생성(생성 後 UPDATE 2단계 금지). work_item_type=
    "agent_decision"(KNOWN_PROJECT_AGNOSTIC_WORK_ITEM_TYPES 등재 필수 —
    안 하면 GET /gates/{id}가 전수 fail-closed 404, 전수 grep으로 발견)."""
    org_id, project_id = scope["org_id"], scope["project_id"]
    if not org_id or not project_id:
        raise HTTPException(status_code=403, detail="org_id/project_id required")

    gate_id = uuid.uuid4()
    # 카디르 CRITICAL(PR #3435 QA, 2026-08-24) — auth.user_id는 users.id 공간이지
    # org_members.id 공간이 아니다([[feedback_member_bound_resource_resolve_member_axis]]
    # #1728과 동일 클래스). 이 값을 caller_id로 그대로 써 온 것 자체가 #2709 원문의 갭 —
    # 에이전트 호출자는 두 공간이 우연히 일치해 안 걸리다가, 인간 호출자(실측: 본인의
    # approver_member_id=org_members.id를 그대로 지정)로 실제 재현됐다. resolve_member()
    # 로 해소한 org_members.id를 caller_id로 삼아 전체 함수(생성 stamp·self-designation
    # 검증)에 일관 적용한다.
    caller_id = (await resolve_member(auth, org_id, session)).id

    # story #3004(선생님 정책 확定 2026-08-24) — 「받는 사람이 없는 결재」는 생성 자체가 막혀야
    # 한다. doc.py transition_doc()의 동일 검증(필수+self-designation 금지+owner/admin 자격)과
    # 동형 재사용 — 새 판단을 짓지 않는다.
    if body.approver_member_id is None:
        raise HTTPException(status_code=400, detail={"code": "APPROVER_REQUIRED", "message": "결정 요청은 결재자를 지정해야 합니다."})
    if body.approver_member_id == caller_id:
        raise HTTPException(status_code=422, detail={"code": "APPROVER_SELF_NOT_ALLOWED", "message": "본인을 결재자로 지정할 수 없습니다."})
    from app.models.project import OrgMember as _OrgMember

    _eligible = (await session.execute(
        select(_OrgMember.id).where(
            _OrgMember.org_id == org_id,
            _OrgMember.id == body.approver_member_id,
            _OrgMember.role.in_(("owner", "admin")),
            _OrgMember.deleted_at.is_(None),
        )
    )).scalar_one_or_none()
    if _eligible is None:
        raise HTTPException(status_code=400, detail={"code": "APPROVER_INELIGIBLE", "message": "지정한 결재자는 결재 자격(owner/admin)이 없습니다."})

    from app.services.workflow_line_config import _default_role_id
    # doc.py의 동일 관례 재사용(role_id는 _ALWAYS_MANUAL_GATE_TYPES라 disposition 결과에
    # 실제 영향 없음 — 기본 role 없으면 self-referencing anchor 자체를 placeholder로).
    role_id = await _default_role_id(session, org_id) or gate_id

    neutral_facts: dict[str, Any] = {
        "question": body.question,
        "options": body.options,
        "assumption": body.assumption,
        "requested_by_member_id": str(caller_id),
        "project_id": str(project_id),
    }
    if body.related_work_item_type and body.related_work_item_id:
        neutral_facts["related_work_item_type"] = body.related_work_item_type
        neutral_facts["related_work_item_id"] = str(body.related_work_item_id)

    gate = await create_gate(
        session=session,
        org_id=org_id,
        work_item_id=gate_id,
        work_item_type="agent_decision",
        gate_type="agent_decision_request",
        member_id=caller_id,
        role_id=role_id,
        neutral_facts=neutral_facts,
        project_id=project_id,
        gate_id=gate_id,
        designated_approver_id=body.approver_member_id,
    )
    await session.flush()
    await _notify_decision_request_card(
        session, org_id, gate, requester_id=caller_id, project_id=project_id,
        designated_approver_id=body.approver_member_id,
    )
    await session.commit()
    await session.refresh(gate)
    resp = await to_gate_response(session, org_id, gate)
    resp.project_id = project_id
    # story #d9c09f4b(2026-08-27) — 카드 배달(_notify_decision_request_card, best-effort)
    # 성패와 완전히 독립된 별도 조회. 카드가 조용히 성공(엉뚱한 대상)하든 실패하든 이
    # 필드는 "approver_member_id가 실제로 가리키는 사람"을 있는 그대로 보여준다 — 그게 이
    # 필드의 존재 이유(호출자 자가검증)라 조회 결과(미확인 멤버)는 None 폴백, 지어내지
    # 않는다.
    # ⛔카디르 QA(#3550): 위 "None 폴백"은 멤버-미존재만 커버할 의도였는데, try/except가
    # 없어 조회 자체가 예외로 죽으면(레이스·일시적 DB 오류 등) 이미 성공한 게이트 생성이
    # HTTP 500으로 뒤집혔다(강제 raise 재현) — 관측성 필드 하나가 본 기능(게이트 생성 자체는
    # 이미 커밋 완료)을 죽이는 본말전도. 기존 best-effort 관용구(이 파일 전역 다수 — 예:
    # _notify_decision_request_card)와 동형으로 감싼다.
    try:
        from app.services.member_resolver import lookup_members_by_ids
        _designated = (await lookup_members_by_ids({body.approver_member_id}, session)).get(body.approver_member_id)
        resp.designated_approver_name = _designated.name if _designated is not None else None
    except Exception:  # noqa: BLE001 — best-effort, 조회 실패가 이미 성공한 게이트 생성 응답을 깨면 안 됨.
        logger.warning(
            "designated_approver_name 조회 실패(비차단) gate=%s approver=%s",
            gate.id, body.approver_member_id, exc_info=True,
        )
        resp.designated_approver_name = None
    # story #1972 SSOT — risk_grade는 위 to_gate_response()가 이미 채웠다(story #3874 정리
    # 前엔 여기서 직접 재조회+재파생했었다 — 이제 단일 통로 재사용, 중복 0).
    return resp


async def _non_doc_gate_approvable(
    session: AsyncSession,
    user_id: uuid.UUID,
    org_id: uuid.UUID,
    project_id: uuid.UUID | None,
) -> bool:
    """story #1974(P1a-S5): ``assigned_to_me`` 판정 rule B — doc_approval **이 아닌** gate_type
    (pr_review/qa/merge/deploy/workflow_config_publish)의 "caller 가 승인 가능한가" 단일 규칙.

    project_id 가 해소되면(story/task/doc 은 항상 해소) 그 project 의 **effective** 역할
    (``get_project_role`` — project_access ∪ org owner/admin floor, project_auth.py SSOT 재사용·
    재구현 금지)이 owner/admin 이면 승인 가능. project_id 가 구조적으로 None 이면(project-무관
    work_item — 예: workflow_line_config 류) project 경계가 없으므로 **org owner/admin**
    (``is_org_owner_or_admin``)에게만 노출 — doc.py:36 의 org owner/admin 체크와 동일 기준."""
    if project_id is not None:
        role = await get_project_role(session, user_id, project_id)
        return role in ("owner", "admin")
    return await is_org_owner_or_admin(session, user_id, org_id)


# story #2198(까심 QA 적출·오르테가 PO 판정, 2026-07-27): non-doc gate_type 별 승인 자격 규칙 —
# 이 표 하나가 list_gates can_approve·get_gate_endpoint can_approve·transition_gate_endpoint
# 인가 **셋의 유일한 소스**다. 분기를 소비처마다 흩으면 오늘 고치는 그 병("타입마다 제각각
# 규칙이 따로 논다")을 새로 심는 것이라 여기 한 자리로 고정한다. 새 gate_type 추가 시 여기부터
# 볼 것.
#
# ⚠️호출 전제: caller 의 human 여부는 **각 소비처가 먼저 확認**한다(이 함수는 WHO=role/type 축만
# 본다·human 축은 위에 있음) — transition_gate_endpoint 의 not-human 403(위)·list_gates/
# get_gate_endpoint 의 `resolved.type == "human"` 게이트가 그 전제를 이미 보장한다.
async def _non_doc_can_approve(
    session: AsyncSession,
    gate_type: str,
    user_id: uuid.UUID,
    org_id: uuid.UUID,
    project_id: uuid.UUID | None,
    designated_approver_id: uuid.UUID | None = None,
    caller_member_id: uuid.UUID | None = None,
) -> bool:
    """gate_type 별 규칙 dispatch.

    story #3319(2026-09-02, 선생님 처방 확定) — ``designated_approver_id``가 있으면 gate_type을
    안 가리고 그 1인에게만 승인 자격을 좁힌다(최우선 단락 — 아래 gate_type별 규칙보다 먼저
    적용). 실사고: 머지 게이트에 org policy로 지정 승인자를 넣어도(create_gate 호출부만
    고치면) 이 함수가 그 값을 안 봐서 project/org owner 전원이 여전히 승인 가능했다 —
    designated_approver_id 배선과는 **별개**의 인가 로직이 필요했다. 영향 범위는 머지뿐 아니라
    designated_approver_id가 설정된 **모든** gate_type(레시피 external_publish 등)에 미친다 —
    "지정 승인자만 결정"이 gate_type 무관 단일 규칙이 되는 것이 맞는 의미(PO 확定). 미지정
    (None, 기본값)은 아래 기존 규칙 그대로 — 회귀 0.

    ⚠️``user_id``는 이 함수 아래쪽 규칙(``is_org_owner_or_admin``/``get_project_role``)이
    쓰는 **user 축**(org_members.user_id)인 반면, ``Gate.designated_approver_id``는 **member
    축**(org_members.id/team_members.id, story #2985)이다 — 두 공간이 다르므로
    ``user_id == designated_approver_id`` 비교는 항상 거짓(다른 uuid 공간)이 되는 조용한
    버그였다(첫 구현에서 실측으로 발견 — 지정 승인자 본인도 403이 남). 그래서 caller의
    **member id**(호출부가 이미 ``resolve_member()``로 갖고 있는 ``resolved.id``)를 별도
    인자로 받는다 — user_id를 여기서 다시 member_id로 해소하는 신규 쿼리를 만들지 않는다
    (호출부 재사용, N+1 없음).

    - artifact_canonicalize: **휴먼 전용**(추가 role 제약 없음). E-CANVAS C4-S8(story a5118cb0)
      설계 주석(visual_artifacts.py propose_canonical_version 바로 위) — "승인/반려는 기존
      범용 transition 이 처리(human-only authz 이미 강제됨)"이 명시된 전부다. rule B(project
      owner/admin)로 좁히면 인가 갭을 메우는 게 아니라 **승인 가능 인구를 줄이는 기능 축소**다
      (실패 재현 테스트가 승인자를 project_access grant 조차 없는 org 멤버로 seed 해 그 설계를
      그대로 증언하고 있었다 — 픽스처 실수가 아니라 의도).
    - 그 외(merge/pr_review/qa/deploy 등): rule B(``_non_doc_gate_approvable``, story #1974) —
      project owner/admin, project-무관 work_item 은 org owner/admin.
    """
    if designated_approver_id is not None:
        return caller_member_id is not None and caller_member_id == designated_approver_id
    if gate_type == "artifact_canonicalize":
        return True
    return await _non_doc_gate_approvable(session, user_id, org_id, project_id)


async def _authorize_gate_approve_equivalent(
    session: AsyncSession, gate: Gate | None, resolved, auth, org_id: uuid.UUID,
    resolved_locale: str,
) -> None:
    """story #2631 — transition_gate_endpoint 의 인가 블록(휴먼-only + doc/non-doc can_approve)을
    그대로 추출한 것. request_gate_discussion_endpoint(«보류·논의»)는 승인/반려 옆 3번째 버튼이라
    **같은 자격**을 요구한다(PO 판정 — "승인할 수 있는 사람만 논의도 요청할 수 있다", 승인 자격
    없는 제3자가 게이트를 pending에 묶어두는 건 별개 취약이 된다). 로직 자체는 신규가 아니라
    기존 transition 인가 규칙의 재사용 — 새 규칙을 만들지 않는다(DRY, 위 _non_doc_can_approve
    표 주석과 같은 원칙).

    story #3793 — `resolved_locale`은 호출부(라우트 진입점)가 이미
    `resolve_locale_from_request()`로 풀어 넘기는 plain str(Header() DI 마커 없음, 까심 QA CI
    FAILURE 원칙)."""
    if resolved.type != "human":
        raise HTTPException(
            status_code=403,
            detail=t("gates.approve_human_only", resolved_locale),
        )
    if gate is None:
        return
    if gate.gate_type == "doc_approval":  # doc.py DOC_GATE_TYPE
        _reason = await can_approve_doc_gate_reason(
            session, gate, resolved, uuid.UUID(auth.user_id), org_id
        )
        if _reason == "self_or_unverified":
            raise HTTPException(
                status_code=403,
                detail=t("gates.approve_self_not_allowed", resolved_locale),
            )
        if _reason is not None:
            raise HTTPException(
                status_code=403,
                detail=t("gates.approve_no_doc_access", resolved_locale),
            )
    else:
        _project_id = await resolve_work_item_project_id(
            session, org_id, gate.work_item_type, gate.work_item_id,
        )
        if not await _non_doc_can_approve(
            session, gate.gate_type, uuid.UUID(auth.user_id), org_id, _project_id,
            designated_approver_id=gate.designated_approver_id, caller_member_id=resolved.id,
        ):
            raise HTTPException(
                status_code=403,
                detail=t("gates.approve_no_project_admin_access", resolved_locale),
            )


@router.get("", response_model=list[GateResponse])
async def list_gates(
    work_item_id: uuid.UUID | None = Query(default=None),
    work_item_type: str | None = Query(default=None),
    status: str | None = Query(default=None),
    # story #5ace2e84 — 대화 안 결재카드 N+1 처방(PO 실측: 대화 진입당 /api/gates/{id} 최대
    # 51발·p50 894ms·max 7.47s). stories.py `ids` 파라미터(comma-separated 배치 앵커 조회)와
    # 동형 계약 — ORDER BY/limit/기타 필터 전부 무시하는 고정 집합 조회. 단건 GET /{id}와
    # 동일하게 project 접근권을 gate별로 강제한다(아래 gate_ids 분기, #2042와 같은 비대칭
    # 재발 방지 — 목록이라고 단건보다 느슨해지면 안 됨).
    # ⚠️바로 위 #2864 주석과 동일 이유로 Annotated(실 None 기본값) — list_gate_inbox()가 이
    # 파라미터를 안 넘기고 list_gates()를 직접 호출한다(아래) — raw `Query(default=None)`이면
    # 그 직접호출 경로에서 Query 객체 자체가 기본값으로 들어가 `ids is not None`이 항상 참이
    # 되고 `.split(",")`가 Query 객체엔 없어 즉시 TypeError로 터진다.
    ids: Annotated[str | None, Query(description="comma-separated gate ids — 배치 앵커 조회")] = None,
    # story #2864(P0, 침묵 스왈로): gate_type·limit·offset이 시그니처에 아예 없어 FastAPI가
    # 미등재 쿼리 파라미터를 조용히 무시했다(#2863 zod dead-code와 동일 클래스 — 있다≠지금
    # 쓰는 것). ⚠️`= Query(...)`를 직접 기본값으로 쓰지 않고 Annotated로 뺀 이유 — 이
    # 라우터 함수는 HTTP 경유(FastAPI가 Query를 실값으로 해소)뿐 아니라 list_gate_inbox()가
    # **일반 파이썬 함수로 직접 호출**한다(아래) + 테스트 다수가 동일하게 직접 호출한다.
    # `= Query(default=None)`를 그대로 쓰면 그 호출자들이 이 인자를 안 넘겼을 때 실제
    # 파이썬 기본값이 `None`이 아니라 Query 객체 그 자체가 돼(직접 호출은 FastAPI 의존성
    # 해소를 안 거친다) `gate_type is not None`이 항상 참이 되고 `.limit(Query객체)`가
    # SQLAlchemy에 그대로 들어가 런타임 TypeError로 터진다 — Annotated는 실제 파이썬
    # 기본값을 리터럴로 유지하면서 Query 메타데이터(ge/le 등)만 얹는다.
    gate_type: Annotated[str | None, Query()] = None,
    sort: str | None = Query(default=None),
    assigned_to_me: bool = Query(default=False),
    # limit 기본값은 None(무제한) — list_gate_inbox의 「페이지네이션 없음(기존 GET /gates
    # 관례 유지)」계약(미르코 합의, conversation eaa1b6cb)을 그대로 보존한다. 명시적으로
    # 넘긴 경우에만 절단.
    limit: Annotated[int | None, Query(ge=1, le=500)] = None,
    offset: Annotated[int, Query(ge=0)] = 0,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth=Depends(get_current_user),
) -> list[GateResponse]:
    # story #4080(PO 方向정정) — gate_type 조회 필터는 GATE_TYPES(생성 관문 허용 세트,
    # "무엇을 만들 수 있는지")를 조회 값 SSOT로 재사용하지 않는다: create_gate()를 전용
    # 서비스코드가 직접 호출해(generic POST 밖에서) 만드는 gate_type(예: generation_
    # budget)도, org가 recipe stage_metadata에 직접 짓는 완전 개방 gate.type도 실 데이터로
    # 존재해 닫힌 소속 검사로는 원천적으로 못 덮는다(둘 다 실사고/그라운딩으로 확認, 카드
    # 본문 참조). 형식만 검증한다 — 소속 밖 값은 거부가 아니라 빈 결과(정직한 필터,
    # #2864가 막은 "파라미터 자체가 무시됨"과는 다른 결). 형식 위반(패턴 밖·길이초과)만
    # 여전히 422(#2864 원 취지 — 명백한 오입력은 침묵하지 않는다).
    if gate_type is not None and not _GATE_TYPE_FILTER_PATTERN.fullmatch(gate_type):
        raise HTTPException(
            status_code=422,
            detail=(
                "gate_type must match ^[a-z][a-z0-9_]{0,63}$ "
                f"(got {gate_type!r}, length {len(gate_type)})"
            ),
        )

    # story #5ace2e84 — ids 배치 앵커 조회 파싱(stories.py list_stories와 동형: comma-separated·
    # invalid UUID=422·과대 IN 방어). ids가 오면 아래 work_item_id/status/gate_type 등 나머지
    # 필터는 전부 무시하는 고정 집합 조회로 갈린다(stories.py와 동일 계약).
    gate_ids: list[uuid.UUID] | None = None
    if ids is not None:
        try:
            gate_ids = [uuid.UUID(x) for x in ids.split(",") if x.strip()]
        except ValueError:
            raise HTTPException(status_code=422, detail="invalid gate id in ids")
        if not gate_ids:
            return []
        if len(gate_ids) > 200:  # stories.py ids 파라미터와 동형 방어(과대 IN 금지).
            raise HTTPException(status_code=422, detail="too many ids (max 200)")

    # story #2042(P0, 침묵 스왈로 대칭 — 이번엔 authz 방향): work_item_id로 필터할 때 이
    # 라우트는 org_id 스코프만 걸고 project 접근권을 아예 안 물었다(has_project_access 호출
    # 0) — 같은 work_item을 읽는 get_gate_endpoint(단건, :{id})·evidence.py list_evidence는
    # project 인가를 강제하는데 이 목록 경로만 조직 전체에 열려 있어, project 밖 사용자가
    # evidence는 403으로 막히면서 gates는 200으로 새는 비대칭이 실측됐다(PO 그라운딩
    # 2026-07-20). 처방: get_gate_endpoint와 동일 판정(require_project_access, SSOT #2697)을
    # 여기도 물린다 — 존재 비노출 관례를 그대로 따라 거부는 404(evidence의 403과 문구는
    # 다르지만 allow/deny 판정 자체는 동일 has_project_access predicate라 AC2 일치).
    # ⚠️PO 리뷰 지적(2026-08-21): work_item_type 없이 work_item_id만 오는 호출(artifact-
    # section.tsx의 status=pending 병용 경로 등)을 검사 없이 통과시키면 그 필드만 생략해
    # 인가를 우회할 수 있다(반쪽 봉합) — work_item_type을 클라 입력값으로 "추측"하는 대신
    # gate 테이블 자신(SSOT)에서 그 work_item_id가 실제로 쓰는 work_item_type을 먼저
    # 조회해 동일 검사를 무조건 물린다. 게이트가 0건이면(가드가 지킬 대상 자체가 없음)
    # 조회를 스킵 — 정보 누출 없음(빈 결과는 접근거부/무매치 둘 다 동일하게 []).
    if work_item_id is not None:
        if work_item_type is not None:
            resolved_wi_types = [work_item_type]
        else:
            resolved_wi_types = list((await session.execute(
                select(Gate.work_item_type).where(
                    Gate.org_id == org_id, Gate.work_item_id == work_item_id,
                ).distinct()
            )).scalars().all())
        for wi_type in resolved_wi_types:
            project_id_scope = await resolve_work_item_project_id(
                session, org_id, wi_type, work_item_id,
            )
            if project_id_scope is not None:
                await require_project_access(session, uuid.UUID(auth.user_id), project_id_scope, org_id,
                                              not_found_detail="Gate not found")
            elif not is_known_project_agnostic_work_item_type(wi_type):
                raise HTTPException(status_code=404, detail="Gate not found")

    q = select(Gate).where(Gate.org_id == org_id)
    if gate_ids is not None:
        # story #5ace2e84 — ids 배치는 고정 집합 앵커 조회(stories.py list_stories ids 분기와
        # 동형). 나머지 필터/정렬/페이지네이션은 의미가 없어 전부 건너뛴다.
        q = q.where(Gate.id.in_(gate_ids))
    else:
        if work_item_id:
            q = q.where(Gate.work_item_id == work_item_id)
        if work_item_type:
            q = q.where(Gate.work_item_type == work_item_type)
        if status:
            q = q.where(Gate.status == status)
        if gate_type:
            q = q.where(Gate.gate_type == gate_type)
        # story #1973(P1a-S4): ?sort=urgency = SLA overdue 최상위 → age(created_at) 오래된 순 →
        # held(향후 만료) 최하단(gate_service.apply_gate_urgency_sort). 미지정 시(기본) 기존 동작
        # (무정렬/삽입순) 그대로 — 회귀 없음.
        if sort == "urgency":
            q = apply_gate_urgency_sort(q)
        elif limit is not None or offset:
            # story #2864: limit/offset이 결정적이려면 순서가 고정돼야 한다 — 무정렬(삽입순 암묵
            # 의존)이었던 기존 동작을, 페이지네이션을 실제로 쓰는 호출에서만 created_at desc(최신
            # 우선, 다른 목록 API들과 동형)로 명시. limit/offset 둘 다 안 쓰면 기존 무정렬 그대로
            # (list_gate_inbox 등 기존 호출부 회귀 0).
            q = q.order_by(Gate.created_at.desc())
        if limit is not None:
            q = q.limit(limit)
        if offset:
            q = q.offset(offset)
    result = await session.execute(q)
    gates = list(result.scalars().all())

    # story #1972(P1a-S4): 위험도 UX 등급 enrich — org posture는 org_id 단일값(gate당 축 없음)이라
    # 목록 전체에 **1회**만 조회(N+1 0). gate_type은 gate별 값이라 to_gate_response(story #3874
    # 단일 통로)는 gate마다 호출하되 posture는 여기서 미리 조회해 주입(재조회 0).
    _posture = await get_org_posture(session, org_id) if gates else None
    responses = [await to_gate_response(session, org_id, g, posture=_posture) for g in gates]

    # story #3569(Phase2·BE·소형, 페드루 PO 確定 2026-09-06) — concept_approval 게이트의
    # sealed_doc_id가 가리키는 doc의 **지금** 제목(봉인 시점 값이 아니다 — 제목은 봉인
    # 대상이 아니다, 본문 sha만 봉인). work_item_summary/doc_proj(위 doc_approval용
    # 배치)와는 키 축이 다르다(work_item_id가 아니라 sealed_doc_id) — 별도의 독립
    # 1회 배치(N+1 0). 삭제된 doc·sealed_doc_id 자체가 없으면 None(지어내지 않는다).
    sealed_doc_ids = {g.sealed_doc_id for g in gates if g.sealed_doc_id is not None}
    if sealed_doc_ids:
        from app.models.doc import Doc as _SealedDoc
        title_rows = (await session.execute(
            select(_SealedDoc.id, _SealedDoc.title).where(
                _SealedDoc.id.in_(sealed_doc_ids), _SealedDoc.org_id == org_id, _SealedDoc.deleted_at.is_(None),
            )
        )).all()
        sealed_doc_title_by_id = {did: title for did, title in title_rows}
        for resp, g in zip(responses, gates):
            if g.sealed_doc_id is not None:
                resp.sealed_doc_title = sealed_doc_title_by_id.get(g.sealed_doc_id)

    # story #3367(3자기점검, 페드루 지적 2026-09-10) — AC7("마지막 수정 주체")의 입력.
    # sealed_content_body의 작성자(봉인 시점, approved 뒤 편집이면 옛 버전에 묶임)가
    # 아니라 draft의 **지금** 최신 버전 author_kind다 — sealed_doc_ids 배치(위)와 동일
    # 선례(독립 1회 배치·N+1 0). external_publish 게이트만 대상(gate_type 축) — neutral_
    # facts.draft_id는 site_posts.py::submit_site_post_draft/_reseal_gate_on_new_version이
    # 문자열로 심는다(_reseal_gate_on_new_version:509 그라운딩 確認).
    latest_author_draft_ids: dict[uuid.UUID, uuid.UUID] = {}
    for resp, g in zip(responses, gates):
        if g.gate_type != "external_publish":
            continue
        raw_draft_id = (g.neutral_facts or {}).get("draft_id")
        if not raw_draft_id:
            continue
        try:
            latest_author_draft_ids[resp.id] = uuid.UUID(str(raw_draft_id))
        except ValueError:
            continue
    if latest_author_draft_ids:
        from app.models.site_post_version import SitePostVersion

        latest_version_ids = (
            select(
                SitePostVersion.draft_id,
                func.max(SitePostVersion.version).label("max_version"),
            )
            .where(SitePostVersion.draft_id.in_(set(latest_author_draft_ids.values())))
            .group_by(SitePostVersion.draft_id)
            .subquery()
        )
        author_rows = (await session.execute(
            select(SitePostVersion.draft_id, SitePostVersion.author_kind).join(
                latest_version_ids,
                (SitePostVersion.draft_id == latest_version_ids.c.draft_id)
                & (SitePostVersion.version == latest_version_ids.c.max_version),
            )
        )).all()
        latest_author_kind_by_draft_id = {did: kind for did, kind in author_rows}
        for resp in responses:
            draft_id = latest_author_draft_ids.get(resp.id)
            if draft_id is not None:
                resp.latest_author_kind = latest_author_kind_by_draft_id.get(draft_id)

    # story #3367(유나 CHANGES, 페드루 재검토 2026-09-10) — sealed_destination_
    # connection_id(위, Gate 실 컬럼)가 non-null인 행의 실제 channel(예:
    # "wordpress")을 배치 조회(org-scope·N+1 0, sealed_doc_ids와 동일 선례). null인
    # 행(hosted_site)은 조회 대상에서 원천 제외 — 그 자체가 이미 완결된 목적지 신호라
    # 채널 조회가 필요 없다.
    dest_connection_ids = {
        g.sealed_destination_connection_id for g in gates if g.sealed_destination_connection_id is not None
    }
    if dest_connection_ids:
        from app.models.channel_connection import ChannelConnection

        channel_rows = (await session.execute(
            select(ChannelConnection.id, ChannelConnection.channel).where(
                ChannelConnection.id.in_(dest_connection_ids), ChannelConnection.org_id == org_id,
            )
        )).all()
        channel_by_connection_id = {cid: channel for cid, channel in channel_rows}
        for resp, g in zip(responses, gates):
            if g.sealed_destination_connection_id is not None:
                resp.sealed_destination_channel = channel_by_connection_id.get(g.sealed_destination_connection_id)

    # doc-side enrich 2종 Doc 조회를 **한 배치**로(org-scope·soft-delete 가드·N+1 0):
    #  ⓐ work_item_summary(24f5ae18): work_item_type=='doc' gate → title/slug.
    #  ⓑ can_approve(89484c8c): gate_type=='doc_approval' gate → project_id.
    # ⚠️project_id 소스 predicate 는 transition(gate_type=='doc_approval'·work_item_id→Doc)와 **동일**해야
    # DRY 정합 — work_item_type 으로 키잉하면 doc_approval 인데 work_item_type≠doc 인 이상 게이트에서 enrich
    # (can_approve)와 transition 강제가 갈림. 두 predicate 의 work_item_id 합집합으로 조회.
    summary_doc_ids = {g.work_item_id for g in gates if g.work_item_type == "doc"}
    approval_doc_ids = {g.work_item_id for g in gates if g.gate_type == "doc_approval"}
    doc_proj: dict[uuid.UUID, uuid.UUID] = {}
    fetch_ids = summary_doc_ids | approval_doc_ids
    if fetch_ids:
        from app.models.doc import Doc
        rows = (await session.execute(
            select(Doc.id, Doc.title, Doc.slug, Doc.project_id).where(
                Doc.id.in_(fetch_ids), Doc.org_id == org_id, Doc.deleted_at.is_(None),
            )
        )).all()
        summaries = {did: WorkItemSummary(title=title, slug=slug) for did, title, slug, _ in rows}
        doc_proj = {did: pid for did, _, _, pid in rows}
        for resp in responses:
            if resp.work_item_type == "doc":
                resp.work_item_summary = summaries.get(resp.work_item_id)

    # decider 가시성(89484c8c): doc_approval 게이트에 **per-caller** can_approve(rule A) enrich — FE in-doc
    # decider 버튼 게이팅 소스(parallel /approvers 아님·그건 admin-only·plain doc-gate 빈목록=dead-path).
    # transition 강제와 can_approve_doc_gate_reason 단일 규칙 공용(DRY). 배치 project_id 주입(N+1 0)·비-휴먼/
    # 무자격/삭제 doc = False(default·fail-closed). additive — 실 authz 는 transition BE 가 강제(이 필드=가시성뿐).
    doc_gates = [(resp, g) for resp, g in zip(responses, gates) if g.gate_type == "doc_approval"]
    # story #2198(까심 QA 적출·오르테가 PO 판정): non-doc gate(merge/pr_review/qa/deploy/
    # artifact_canonicalize 등)도 doc_approval 과 **동일 골격**으로 can_approve 를 계산한다 —
    # 지금까지 이 목록 응답의 can_approve 필드 자체는 계산되지 않아 Pydantic 기본값 False 가
    # 그대로 나갔다(자격자에게 버튼이 안 뜨는 원 증상). ⚠️규칙은 "하나"가 아니라 gate_type 별
    # 하나(_non_doc_can_approve 표 — artifact_canonicalize 는 rule B 를 씌우면 회귀임이 CI 로
    # 드러나 갈렸다. 자세한 사유는 그 함수 docstring 참조).
    non_doc_gates = [(resp, g) for resp, g in zip(responses, gates) if g.gate_type != "doc_approval"]
    # story #1974(P1a-S5): assigned_to_me 도 doc_approval 경로는 can_approve 와 **동일 계산**이라
    # caller 식별(resolve_member)을 can_approve enrich 와 공유 — 1회만 resolve(중복 계산 0).
    # #2198: non-doc can_approve 도 이제 assigned_to_me 무관 항상 계산하므로 트리거를 gates 존재
    # 여부로 넓힌다(doc_gates or non_doc_gates == gates 존재).
    resolved = None
    _uid: uuid.UUID | None = None
    if doc_gates or non_doc_gates:
        try:
            resolved = await resolve_member(auth, org_id, session)
            _uid = uuid.UUID(auth.user_id)
        except Exception:  # noqa: BLE001 — caller resolve 실패는 목록 비중단(fail-closed).
            logger.warning("list_gates caller resolve 실패(비중단) org=%s", org_id, exc_info=True)
            resolved = None
            _uid = None

    # story #1983(까심 #1960 QA 적출 회귀, story #2259 후속 — non-doc gate 대칭): can_approve_doc_gate_reason
    # 의 반환값(_reason) 자체는 WHO-only(human·project-access·not-author) 판정이라 FSM 을 전혀 안 담고 있다 —
    # 아래 resp.can_approve 계산에서 is_valid_transition(...)을 **별도로 AND** 붙이는 게 그 증거. assigned_to_me
    # 필터링(하단)은 이 WHO-only reason 을 그대로 재사용해야 하므로, doc_gates enrich 루프에서 이미 계산하는
    # _reason 을 {gate_id: reason} dict 로 들고 간다(이중 쿼리·이중 계산 0 — can_approve_doc_gate_reason 재호출 없음).
    doc_gate_who_reason: dict[uuid.UUID, str | None] = {}
    if doc_gates and resolved is not None:
        for resp, g in doc_gates:
            _reason = await can_approve_doc_gate_reason(
                session, g, resolved, _uid, org_id,
                doc_project_id=doc_proj.get(g.work_item_id),
            )
            doc_gate_who_reason[g.id] = _reason
            # 완전 DRY(codex): "지금 승인 가능" = authz(rule A·helper) **AND** FSM 으로 resolvable
            # (pending). transition 도 authz(helper) + transition_gate FSM(is_valid_transition) 이중이므로
            # enrich 도 동일 is_valid_transition 으로 FSM 반영 — terminal/held gate 는 can_approve=False(승인/
            # 반려 둘 다 pending 전제라 "approved" 한 방향 검사로 충분). authz-only 의미 갈림 제거.
            # ⚠️story #1983: 이 필드는 FE "지금 버튼 눌러도 되는가" 게이팅용이라 FSM-aware 가 **정답**
            # (held→approved 직접 전이 불가하니 held 게이트는 can_approve=False 가 맞다) — 건드리지 않는다.
            resp.can_approve = _reason is None and is_valid_transition(g.status, "approved")

    # project_id 배치 해소(story #1968 resolve_work_item_project_id 의 IN-clause 배치 버전 — 개별
    # gate 마다 신규 쿼리 금지). doc 은 위에서 이미 배치 조회한 doc_proj 재사용(중복 쿼리 0).
    # ⚠️2026-07-31 수정(오르테가 라이브 실측 — GET /api/v2/gates pending 37/37 project_id=None):
    # 이 배치는 **caller 타입과 무관하게** 항상 돈다 — project_id 는 응답 데이터 정합성 문제지
    # authz 판정이 아니다. 예전엔 `resolved.type == "human"` 게이트 안에서만 돌아서(can_approve
    # 전용 배치인 줄 알고 얹었던 것) agent 호출은 story/task/artifact 케이스가 통째로 스킵되고,
    # 게다가 human 호출이어도 이 dict 자체를 resp.project_id 에 대입하는 코드가 애초에 없었다
    # (아래 enrich 루프 참조 — 그게 진짜 근본원인. 이 게이트 분리는 caller 의존성 제거용).
    project_id_by_work_item: dict[uuid.UUID, uuid.UUID | None] = dict(doc_proj)
    if non_doc_gates:
        story_ids = {g.work_item_id for _, g in non_doc_gates if g.work_item_type == "story"}
        task_ids = {g.work_item_id for _, g in non_doc_gates if g.work_item_type == "task"}
        # story #3784a8d0(3038, 실사고 — 선생님 제보 2026-08-25) — work_item_summary가 doc만
        # 배치 enrich됐다. merge 게이트(work_item_type=='story', 결재함 대다수)는 항상 None이라
        # FE가 "#해시" 폴백만 그렸다 — `_resolve_work_item_summary`(단건 GET /{id} 경로, story
        # #1970)는 story/task를 이미 커버하는데 이 목록/배치 경로만 doc-only로 남아 있던
        # 드리프트. 새 쿼리를 추가하지 않고 이미 도는 이 project_id 배치 쿼리에 title을
        # 얹는다(N+1 0 유지 — 이 파일이 이미 지켜온 관례 그대로).
        summary_by_work_item: dict[uuid.UUID, WorkItemSummary] = {}
        if story_ids:
            rows = (await session.execute(
                select(Story.id, Story.project_id, Story.title).where(
                    Story.id.in_(story_ids), Story.org_id == org_id,
                )
            )).all()
            project_id_by_work_item.update({sid: pid for sid, pid, _ in rows})
            summary_by_work_item.update({sid: WorkItemSummary(title=title) for sid, _, title in rows})
        if task_ids:
            rows = (await session.execute(
                select(Task.id, Story.project_id, Task.title)
                .join(Story, Task.story_id == Story.id)
                .where(Task.id.in_(task_ids), Task.org_id == org_id)
            )).all()
            project_id_by_work_item.update({tid: pid for tid, pid, _ in rows})
            summary_by_work_item.update({tid: WorkItemSummary(title=title) for tid, _, title in rows})
        # story #4241 → #4244 — 나머지 종류(visual_artifact · loop · hypothesis · epic(=Goal) · sprint · wf_line_version)는 알림 목록과 같은
        # 배치 해소기(gate_service.resolve_work_item_project_ids_batch · 종류당 IN 1개)로. story/task는 위에서 제목과 함께 이미 해소했다.
        _rest = await resolve_work_item_project_ids_batch(session, org_id, (
            (g.work_item_type, g.work_item_id) for _, g in non_doc_gates
            if g.work_item_type not in ("story", "task", "doc")  # doc은 위 doc_proj(제목·slug와 함께)
        ))
        project_id_by_work_item.update({wid: pid for (_t, wid), pid in _rest.items()})
        for resp in responses:
            if resp.work_item_type in ("story", "task"):
                resp.work_item_summary = summary_by_work_item.get(resp.work_item_id)

    # ⭐신규 enrich(원인 수정 본체): 위에서 이미 계산해 둔 project_id_by_work_item 을
    # can_approve 판정뿐 아니라 응답 필드 자체에도 대입한다 — 지금까지 이 값이 어디에도 안
    # 흘러가 GateResponse.project_id 가 Pydantic 기본값 None 그대로 나갔다(get_gate_endpoint
    # 단건 조회만 resp.project_id 를 대입했고 목록은 빠져 있었다). doc/story/task/artifact 전부
    # 이 한 dict 로 커버(project_id_by_work_item 은 dict(doc_proj) 로 시작).
    for resp, g in zip(responses, gates):
        # story #4241 — 자기 참조 앵커(agent_decision · support_escalation)는 neutral_facts.project_id(gate_service.self_anchored_gate_project_id).
        resp.project_id = project_id_by_work_item.get(g.work_item_id) or self_anchored_gate_project_id(g)

    # #2198(PO 판정): 캐시 키가 project_id 단독에서 (gate_type, project_id) 로 바뀌었다 — 승인
    # 자격이 이제 gate_type 에도 의존한다(_non_doc_can_approve 표 참조. artifact_canonicalize
    # 는 project_id 무관 항상 True).
    # story #3319 — designated_approver_id도 키에 편입해야 한다: 같은 (gate_type, project_id)
    # 조합이라도 게이트마다 designated_approver_id가 다를 수 있어(예: 머지 게이트 A는 정책
    # 적용 前 생성=None, B는 적용 後 생성=특정 멤버) 이걸 빼면 먼저 계산된 캐시값을 서로 다른
    # 게이트가 잘못 공유한다(둘 다 project owner인데 A는 승인 가능·B는 designated 아니라
    # 불가여야 하는데, 캐시가 A의 True를 B에도 돌려주는 사고).
    approvable_cache: dict[tuple[str, uuid.UUID | None, uuid.UUID | None], bool] = {}
    eligible_ids: set[uuid.UUID] = set()
    if non_doc_gates and resolved is not None and resolved.type == "human":
        # N+1 방지: gate 여러 건이 같은 (gate_type, project_id, designated_approver_id) 를
        # 가리켜도 _non_doc_can_approve 는 **고유 조합당 1회**만 호출(캐시) — gate 개수와 무관.
        for _resp, g in non_doc_gates:
            pid = project_id_by_work_item.get(g.work_item_id)
            key = (g.gate_type, pid, g.designated_approver_id)
            if key not in approvable_cache:
                approvable_cache[key] = await _non_doc_can_approve(
                    session, g.gate_type, _uid, org_id, pid,
                    designated_approver_id=g.designated_approver_id, caller_member_id=resolved.id,
                )
            if approvable_cache[key]:
                eligible_ids.add(g.id)

    # #2198: non-doc can_approve enrich — doc_gates 루프(위)와 동일하게 FSM(is_valid_transition)
    # AND WHO(eligible_ids). additive·fail-closed default(Pydantic False)는 non-human/미해소
    # caller·project 무권한 전부에서 자연히 유지된다(eligible_ids 에 없으면 False).
    for resp, g in non_doc_gates:
        resp.can_approve = g.id in eligible_ids and is_valid_transition(g.status, "approved")

    # story #3860(customer-zero·BE·게이트 답하기) — 「답하기」 주 액션의 데이터 소스.
    # today_service.py의 needs_me 배치와 동일 SSOT 함수(work_item_conversation.py) —
    # caller가 그 work_item을 태그한 대화의 참여자일 때만 conversation_id 노출(PR #4253
    # 원칙 그대로 — 여기서 재발명 0). resolved가 None이면(caller resolve 실패) 전부 None.
    if resolved is not None and responses:
        from app.services.work_item_conversation import derive_conversation_ids_for_tagged_work_items

        conv_by_work_item = await derive_conversation_ids_for_tagged_work_items(
            session, org_id=org_id, member_id=resolved.id,
            work_item_pairs={(g.work_item_type, g.work_item_id) for g in gates},
        )
        for resp, g in zip(responses, gates):
            resp.conversation_id = conv_by_work_item.get((g.work_item_type, g.work_item_id))

    if gate_ids is not None:
        # story #5ace2e84 — ids 배치는 work_item_id 필터가 물던 project 접근권 검사(#2042)를
        # 안 거친다(work_item_id가 None이라 위 그 블록 자체가 스킵) — 단건 GET /{id}
        # (get_gate_endpoint)와 동일한 강제를 여기서 명시로 건다. project_id는 위에서 이미
        # 배치 해소돼 있어 신규 N+1 없음(1 쿼리로 caller 접근 가능 project 집합만 추가 조회).
        accessible_project_ids = set(await accessible_project_ids_in_org(session, uuid.UUID(auth.user_id), org_id))
        visible: list[GateResponse] = []
        for resp, g in zip(responses, gates):
            pid = project_id_by_work_item.get(g.work_item_id)
            if pid is not None:
                if pid in accessible_project_ids:
                    visible.append(resp)
            elif is_known_project_agnostic_work_item_type(g.work_item_type):
                visible.append(resp)
            # else: project_id 해소 실패(work_item이 이 org에 없음 등) → fail-closed(제외).
        return visible

    if not assigned_to_me:
        return responses

    # story #1974(P1a-S5)/#1983: assigned_to_me=true → "caller 가 승인 자격(WHO)이 있는 게이트만"
    # (대원칙 — STATE(pending/held/terminal) 는 바깥 status 쿼리가 관장, 여기서 재필터 안 함).
    # ⚠️휴먼 전용 불변식: transition_gate_endpoint(위 383~392)는 gate_type 무관
    # resolved.type != "human" 이면 무조건 403("사람 검증 행위는 휴먼 member만" — 웨지 integrity).
    # doc_approval 은 can_approve_doc_gate_reason 이 이미 not_human 을 거부사유로 반환해 자동 배제되지만,
    # rule B(project-role/org-role)는 human 체크가 없어 그대로 두면 "에이전트가 owner/admin project
    # role 을 가진 경우 배지엔 뜨는데 transition 에서 403" 모순이 재발한다 — 여기서 한 번 더 fail-closed.
    if resolved is None or resolved.type != "human":
        return []

    # 오르테가 정정(까심 #1960 QA 적출, story #1974 후속): assigned_to_me 은 게이트가 **누구
    # 것인지(WHO)** 의 문제지 pending/held 등 상태와 무관하다 — held 게이트도 같은 approver가
    # 승인할 대상이고 paused 일 뿐 "내 것"이다. 바깥 `status` 쿼리 필터가 이미 gates 를 원하는
    # 상태로 좁혀놨으니(예: status=held) 여기서 다시 "pending" 으로 하드코딩해 재필터하면 안
    # 된다 — 예전엔 그래서 `status=held&assigned_to_me=true` 가 항상 빈 배열이었다.
    filtered: list[GateResponse] = []
    for resp, g in zip(responses, gates):
        # story #4139 AC1 — 레시피 게이트가 대신 결재하는 scoped external_publish는 사람
        # 결재함(assigned_to_me=true)에 "추가로" 안 뜬다(deferred_to_gate_id는 위 responses
        # 계산 단계에서 이미 채워졌다 — 새 쿼리 0). 그 게이트의 단건 조회(GET /{id})·
        # work_item_id 필터 조회는 이 분기를 안 타 영향 없다(존재 자체가 사라지는 게
        # 아니라 "내가 지금 봐야 할 목록"에서만 빠진다).
        if resp.deferred_to_gate_id is not None:
            continue
        if g.gate_type == "doc_approval":
            # story #1983(까심 #1960 QA 적출 회귀, story #2259 후속): doc_approval assigned_to_me
            # 도 WHO(승인 자격) 판정이지 STATE(pending/held) 판정이 아니다 — story #2259가 non-doc
            # gate 에서 g.status != "pending" 하드코딩 2곳을 제거한 것과 동일 원칙을 여기 대칭
            # 적용한다. 예전엔 resp.can_approve(FSM-aware — is_valid_transition AND)를 그대로
            # 재사용해서 held doc_approval 게이트가 자격자(reviewer·non-author·project-access 有)
            # 여도 사라졌다(held→approved 직접 전이 불가라 FSM 이 항상 False). 여기서는
            # doc_gate_who_reason(WHO-only·FSM 미포함)만 본다 — .get(..., sentinel)로 dict 에
            # 없는 경우도 fail-closed(미enrich=배제). 바깥 status 쿼리 파라미터가 STATE 를 관장.
            if doc_gate_who_reason.get(g.id, "not_enriched") is None:
                filtered.append(resp)
        elif g.id in eligible_ids:
            filtered.append(resp)
    return filtered


class GateDesignatedPendingCountResponse(BaseModel):
    count: int
    # story #4245(까디르 QA P2 · PO 04:12Z) — 이 수를 센 문장의 스냅숏 워터마크 pg_snapshot_xmin(pg_current_snapshot())(xid8 · 문자열).
    # 그보다 작은 xid의 트랜잭션은 그 순간 이미 끝났다 → 그 트랜잭션이 만든 이벤트(events.created_xid)는 커밋됐으면 이 수에 이미 보였다.
    # FE는 SSE 백필 이벤트 중 created_xid < snapshot_xmin인 것만 «반영됨»으로 건너뛴다(시각 판정은 쓰지 않는다). 옛 클라이언트는 무시해도 되는 필드.
    snapshot_xmin: str | None = None


@router.get("/designated-pending-count", response_model=GateDesignatedPendingCountResponse)
async def get_designated_pending_count(
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth=Depends(get_current_user),
) -> GateDesignatedPendingCountResponse:
    """story #3084(2026-08-25, 정렬 v1 층1 — 도달 보장의 불변 바닥) — GNB "미확認" 뱃지 소스.

    `assigned_to_me`(list_gates)는 WHO(승인 자격 — project access+not-author)를 묻는
    넓은 집합이라, 이 스토리의 층1이 필요로 하는 좁은 질문("이 사람이 designated로 지정된
    미해소 건이 몇 개인가")과 다르다 — 카드가 어느 conversation에 심겼든(페어와이즈 DM이든
    토스 사본이든) 이 카운트는 그 방을 전혀 참조하지 않는 순수 Gate.designated_approver_id
    쿼리라, "주 대화 추론"이 틀려도(층2가 best-effort인 이유) 이 뱃지는 항상 정확하다
    (AC1이 이 층에서 닫히는 근거)."""
    resolved = await resolve_member(auth, org_id, session)
    count, snapshot_xmin = (await session.execute(
        select(func.count(), func.pg_snapshot_xmin(func.pg_current_snapshot())).select_from(Gate).where(
            Gate.org_id == org_id,
            Gate.designated_approver_id == resolved.id,
            Gate.status == "pending",
        )
    )).one()
    return GateDesignatedPendingCountResponse(count=count, snapshot_xmin=str(snapshot_xmin) if snapshot_xmin is not None else None)


class HitlInboxItem(BaseModel):
    """story #2054: `agent_hitl_requests`(gate_approval 종류) 결재함 인박스 노출용 최소 스키마.

    Gate와 별도 API로 승인/거부(`PATCH /hitl/requests/{id}`)하므로 GateResponse 필드를 그대로
    빌리지 않는다 — `source` 로 FE가 액션 라우팅. 미르코(FE)와 합의한 계약(conversation
    eaa1b6cb-5d73-4019-bca8-7e320087f827) 그대로: id/request_type/title/prompt/status/
    requires_human/work_item_id/work_type/created_at/expires_at.
    """
    model_config = ConfigDict(from_attributes=True)

    source: Literal["hitl"] = "hitl"
    id: uuid.UUID
    request_type: str
    title: str
    prompt: str
    status: str
    # gate_enforce.py _SAFETY_FLOOR: work_type='merge'는 최소 ask — HitlRequest로 park된 항목은
    # 정의상 항상 사람 승인 대상이라 고정 True(Gate.requires_human과 동형 의미).
    requires_human: bool = True
    work_item_id: uuid.UUID | None = None
    work_type: str | None = None
    created_at: datetime
    expires_at: datetime | None = None
    # story #4241 — 결재함은 조직 전체 목록이라 행 링크가 «현재 프로젝트»가 아니라 이 요청의 프로젝트를 싣게(GateResponse.project_id와 짝).
    project_id: uuid.UUID | None = None


# gate_enforce.py:22/gate_metrics.py:24 선례(cross-module import 대신 로컬 재선언) — HitlRequest 중
# 결재함 인박스가 다루는 부분집합(merge/done 게이트 승인 park)만. 그 외 request_type(예: 수동
# HITL 승인 요청)은 #2054 스코프 밖(별도 화면 유지) — Gate와 동일 병목에서 충돌하는 것만 통합.
_GATE_REQUEST_TYPE = "gate_approval"


async def _list_hitl_inbox_rows(
    session: AsyncSession, org_id: uuid.UUID, status: str | None,
) -> list[HitlRequest]:
    q = select(HitlRequest).where(
        HitlRequest.org_id == org_id,
        HitlRequest.request_type == _GATE_REQUEST_TYPE,
        HitlRequest.deleted_at.is_(None),
    )
    if status:
        q = q.where(HitlRequest.status == status)
    return list((await session.execute(q)).scalars().all())


def _hitl_item_from_row(r: HitlRequest) -> HitlInboxItem:
    meta = r.hitl_metadata or {}
    wi_raw = meta.get("work_item_id")
    try:
        work_item_id = uuid.UUID(wi_raw) if wi_raw else None
    except (ValueError, TypeError, AttributeError):
        work_item_id = None
    return HitlInboxItem(
        id=r.id,
        request_type=r.request_type,
        title=r.title,
        prompt=r.prompt,
        status=r.status,
        work_item_id=work_item_id,
        work_type=meta.get("work_type"),
        created_at=r.created_at,
        expires_at=r.expires_at,
        project_id=r.project_id,
    )


@router.get(
    "/inbox",
    response_model=list[Annotated[GateResponse | HitlInboxItem, Field(discriminator="source")]],
)
async def list_gate_inbox(
    status: str | None = Query(default=None),
    sort: str | None = Query(default=None),
    assigned_to_me: bool = Query(default=False),
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth=Depends(get_current_user),
) -> list[GateResponse | HitlInboxItem]:
    """story #2054: `Gate`(결재함)와 `HitlRequest`(gate_approval park) 통합 조회 — 두 체계가
    같은 승인 병목(merge)에서 서로를 못 보던 결함 해소. 데이터모델은 안 합치고(Gate 미러 생성
    금지 — 오르테가 판정) 이 read-layer에서만 통합. 액션은 각자 native API로
    (`PATCH /gates/{id}/transition` vs `PATCH /hitl/requests/{id}`) — `source` 필드로 라우팅.

    미르코(FE)와 합의한 계약(conversation eaa1b6cb): 페이지네이션 없음(기존 GET /gates 관례 유지)·
    기본 정렬 created_at DESC·`sort=urgency`는 Gate 쪽 기존 SLA 로직 그대로 + HitlRequest는
    age(created_at)만으로 같은 정렬축에 끼워 넣는 best-effort(HitlRequest엔 SLA/held 개념이 없어
    완전 동형 아님 — 이는 미리 합의된 단순화).
    """
    gate_items = await list_gates(
        work_item_id=None, work_item_type=None, status=status, sort=sort,
        assigned_to_me=assigned_to_me, session=session, org_id=org_id, auth=auth,
    )
    hitl_rows = await _list_hitl_inbox_rows(session, org_id, status)

    if assigned_to_me:
        # Gate의 non-doc assigned_to_me(WHO)와 동일 규칙 재사용: gate_approval park 대상
        # work_item_id는 실무상 항상 Story(work_type∈{done,merge}는 story 라이프사이클 단계) —
        # project 해소되면 project owner/admin, 구조적으로 project-무관이면 org owner/admin.
        resolved = None
        _uid: uuid.UUID | None = None
        if hitl_rows:
            try:
                resolved = await resolve_member(auth, org_id, session)
                _uid = uuid.UUID(auth.user_id)
            except Exception:  # noqa: BLE001 — caller resolve 실패는 목록 비중단(fail-closed).
                logger.warning(
                    "list_gate_inbox hitl caller resolve 실패(비중단) org=%s", org_id, exc_info=True,
                )
        if resolved is None or resolved.type != "human":
            hitl_rows = []
        else:
            story_ids = set()
            parsed: dict[uuid.UUID, uuid.UUID | None] = {}
            for r in hitl_rows:
                wi_raw = (r.hitl_metadata or {}).get("work_item_id")
                try:
                    wid = uuid.UUID(wi_raw) if wi_raw else None
                except (ValueError, TypeError, AttributeError):
                    wid = None
                parsed[r.id] = wid
                if wid is not None:
                    story_ids.add(wid)
            project_by_story: dict[uuid.UUID, uuid.UUID] = {}
            if story_ids:
                rows = (await session.execute(
                    select(Story.id, Story.project_id).where(
                        Story.id.in_(story_ids), Story.org_id == org_id,
                    )
                )).all()
                project_by_story = {sid: pid for sid, pid in rows}
            role_cache: dict[uuid.UUID, bool] = {}
            org_admin_cache: bool | None = None
            eligible: list[HitlRequest] = []
            for r in hitl_rows:
                pid = project_by_story.get(parsed.get(r.id))
                if pid is not None:
                    if pid not in role_cache:
                        role_cache[pid] = await _non_doc_gate_approvable(session, _uid, org_id, pid)
                    ok = role_cache[pid]
                else:
                    if org_admin_cache is None:
                        org_admin_cache = await _non_doc_gate_approvable(session, _uid, org_id, None)
                    ok = org_admin_cache
                if ok:
                    eligible.append(r)
            hitl_rows = eligible

    hitl_items = [_hitl_item_from_row(r) for r in hitl_rows]

    if sort == "urgency":
        # Gate 쪽은 이미 (held_rank, overdue_rank, created_at ASC)로 정렬돼 도착 — HitlRequest는
        # SLA/held 개념이 없어 "non-held·non-overdue" 티어(각 rank=0/1 아님 held=0-tier 아님 →
        # overdue_rank=1 동일 티어)로 취급하고 age(created_at ASC)만으로 그 안에 merge. 안정 정렬
        # (Python Timsort)로 gate_items의 기존 상대순서는 보존된다.
        # ⚠️정직한 단순화(미리 합의): gate_items의 overdue 여부는 SQL(apply_gate_urgency_sort의
        # correlated EXISTS)에서만 판정되고 GateResponse엔 그 필드가 노출되지 않는다 — 파이썬
        # 레벨에서 gate/hitl 총정렬을 다시 만드는 이상 overdue 랭크는 재구성 불가하므로 여기선
        # held(가진 필드로 재확인 가능)만 최하단 유지하고, 나머지는 age(created_at ASC) 단일
        # 축으로 합친다. 결과적으로 "overdue gate가 항상 non-overdue보다 위"라는 하드 보장은
        # 없어지고 age로 근사(실무상 overdue는 대개 오래된 항목이라 대체로 유지되나 보장은 아님) —
        # 미르코와 합의한 "HitlRequest는 age 기준으로만 끼워 넣는다"는 문구 그대로의 트레이드오프.
        combined: list[GateResponse | HitlInboxItem] = list(gate_items) + list(hitl_items)
        combined.sort(
            key=lambda it: (
                1 if (isinstance(it, GateResponse) and it.held_until and it.held_until > datetime.now(it.held_until.tzinfo)) else 0,
                it.created_at,
            )
        )
        return combined

    combined = list(gate_items) + list(hitl_items)
    combined.sort(key=lambda it: it.created_at, reverse=True)
    return combined


async def _resolve_work_item_summary(
    session: AsyncSession, org_id: uuid.UUID, work_item_type: str, work_item_id: uuid.UUID,
) -> WorkItemSummary | None:
    """story #1970(P1a-S4): GET /{id} 단건 조회 전용 work_item_summary 조립 — list_gates 의
    doc-only 배치 enrich(24f5ae18)를 story/task 까지 확장한다. 단건 조회라 배치 최적화(N+1 회피)
    필요 없음 — 타입별 단일 쿼리로 충분. doc=title+slug(기존 로직 그대로), story/task=title만
    (slug 개념 자체가 없어 항상 None), 그 외/미인식 타입·미존재 엔티티는 None(list_gates 비-doc
    분기와 동일하게 fail-soft — work_item_summary 는 additive enrich 이지 authz 게이트가 아니다).
    ⚠️list_gates 의 배치 doc 조회와 별도 코드경로 — 강제 공유하면 단건 쿼리가 불필요한 다건
    IN-clause 배치 인프라를 상속해 오히려 복잡해진다(1건 조회에 배치 이점 없음)."""
    if work_item_type == "doc":
        row = (await session.execute(
            select(Doc.title, Doc.slug).where(
                Doc.id == work_item_id, Doc.org_id == org_id, Doc.deleted_at.is_(None),
            )
        )).one_or_none()
        return WorkItemSummary(title=row[0], slug=row[1]) if row is not None else None
    if work_item_type == "story":
        title = (await session.execute(
            select(Story.title).where(
                Story.id == work_item_id, Story.org_id == org_id, Story.deleted_at.is_(None),
            )
        )).scalar_one_or_none()
        return WorkItemSummary(title=title) if title is not None else None
    if work_item_type == "task":
        title = (await session.execute(
            select(Task.title).where(
                Task.id == work_item_id, Task.org_id == org_id, Task.deleted_at.is_(None),
            )
        )).scalar_one_or_none()
        return WorkItemSummary(title=title) if title is not None else None
    return None


@router.get("/{id}", response_model=GateResponse)
async def get_gate_endpoint(
    id: uuid.UUID,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth=Depends(get_current_user),
) -> GateResponse:
    """story #1970(P1a-S4): gate 단건 조회 — 알림 payload 의 reference_id(gate.id, gate_service.py
    :150,774)로 딥링크 콜드 진입(목록 경유 없이 상세 화면 직행)을 지원한다. 응답 shape=list 아이템과
    동일(GateResponse, 단건)·미르코(FE) canonical 게이트 상세 화면이 그대로 소비하는 스레드 합의
    계약(변경 금지). project_id/work_item_summary 만 신규 enrich(risk_grade는 story #1972가 추가).

    authz: gate 의 work_item 실제 project(resolve_work_item_project_id — story #1968 SSOT 재사용)
    에 has_project_access 강제. project_id 가 해소되면(story/task/doc 은 항상 해소) 그 project
    접근권 필수·무권한은 403 이 아닌 404(participation.py `_assert_story_project_access` 와 동일
    SSOT 패턴 — 존재 여부 자체를 비노출). project_id 가 None 이면(구조적으로 project-무관 work_item
    — resolve_work_item_project_id 주석 참고) project 경계가 없으므로 접근 차단 대상이 아니다 —
    get_verified_org_id 가 이미 강제한 org 멤버십으로 충분(gate 조회 자체가 org_id 로 스코프됨).
    미존재 gate 도 동일하게 404 로 흡수(존재 비노출 규율)."""
    gate = (await session.execute(
        select(Gate).where(Gate.id == id, Gate.org_id == org_id)
    )).scalar_one_or_none()
    if gate is None:
        raise HTTPException(status_code=404, detail="Gate not found")

    project_id = await resolve_work_item_project_id(
        session, org_id, gate.work_item_type, gate.work_item_id,
    )
    # #2237: project_id가 None인 이유를 가른다(오르테가 PO 판정, 2026-07-27) — 「project-무관
    # 타입이라 None」과 「project-scoped 타입인데 해소 실패(work_item이 이 org에 없음)라 None」이
    # 같은 값으로 뭉개져 있으면 후자가 검사를 skip해 버린다. gate.work_item_id가 org_id 스코프
    # 안에서 해소 안 되는 것은 이 gate 자체가 가리키는 대상이 이 org에 없다는 뜻이라 거부.
    # fail-closed(②): 통과는 KNOWN_PROJECT_AGNOSTIC_WORK_ITEM_TYPES 명시 allowlist에 있을 때만.
    if project_id is not None:
        # story #2697: require_project_access(전 리소스 공용 판정 함수)로 위임 — 이 파일이
        # goals/stories/sprints/retros가 수렴한 원본 레퍼런스 패턴이었다(재구현 0).
        await require_project_access(session, uuid.UUID(auth.user_id), project_id, org_id,
                                      not_found_detail="Gate not found")
    elif not is_known_project_agnostic_work_item_type(gate.work_item_type):
        raise HTTPException(status_code=404, detail="Gate not found")

    resp = await to_gate_response(session, org_id, gate)
    resp.project_id = project_id
    resp.work_item_summary = await _resolve_work_item_summary(
        session, org_id, gate.work_item_type, gate.work_item_id,
    )
    # story #3569 — list_gates와 동일 축(sealed_doc_id, work_item_id 아님)·동일 규칙
    # (지금 제목·삭제/미존재 doc은 None).
    if gate.sealed_doc_id is not None:
        from app.models.doc import Doc as _SealedDoc
        resp.sealed_doc_title = (await session.execute(
            select(_SealedDoc.title).where(
                _SealedDoc.id == gate.sealed_doc_id, _SealedDoc.org_id == org_id, _SealedDoc.deleted_at.is_(None),
            )
        )).scalar_one_or_none()
    # story #3813(Phase3·3-4 PR4, 페드루 PO 確定 2026-09-12) — newsletter_send 게이트
    # 승인 카드 전용 「예상 수신수」. 사람이 「이 세그먼트 N명에게 발송」을 보고 승인하는
    # 것이 이 카드의 존재 이유라 발송 前(승인 시점) 값이 필요 — 조회 실패가 카드 전체를
    # 죽이면 안 되니 개별 try/except로 격리(fail-closed, None만 두고 계속).
    if gate.gate_type == "newsletter_send":
        try:
            from app.models.channel_connection import ChannelConnection
            from app.models.channel_post_version import ChannelPostVersion
            from app.models.channel_publication import ChannelPublication

            publication = (await session.execute(
                select(ChannelPublication).where(ChannelPublication.id == uuid.UUID(gate.scope_key))
            )).scalar_one_or_none()
            conn = (await session.execute(
                select(ChannelConnection).where(ChannelConnection.id == publication.connection_id)
            )).scalar_one_or_none() if publication is not None else None
            if conn is not None and conn.channel == "stibee_sandbox":
                from app.services.stibee_sandbox_campaign import describe_segment
                resp.estimated_recipient_count = await describe_segment(
                    segment_name=gate.sealed_newsletter_segment_name or "",
                )
            # 실 "stibee"(미구현)·연결/발행물 소실 등은 조용히 None 그대로(위 필드 docstring).
            # 페드루 PO CHANGES(2026-09-12, 라이브 캡처 실측) — 승인 카드에 「무엇을」
            # 보내는지(subject)가 아예 없어 사람이 세그먼트·시각·수신수만 보고 승인하던
            # 결함. subject는 봉인 축이 아니라(PR2 설계 그대로) publication.version_id가
            # 가리키는 ChannelPostVersion.channel_payload에서 「지금」 값을 읽는다
            # (sealed_content_body류와 다른 결 — 뉴스레터 subject는 애초에 gate가
            # 봉인하는 축이 아니었다, channel_posts.py의 draft-list newsletter.subject와
            # 동일 출처).
            if publication is not None:
                version = (await session.execute(
                    select(ChannelPostVersion).where(ChannelPostVersion.id == publication.version_id)
                )).scalar_one_or_none()
                resp.newsletter_subject = (version.channel_payload or {}).get("subject") if version else None
        except Exception:  # noqa: BLE001 — 카드 조회 자체를 이 계산값 실패로 죽이지 않는다.
            logger.warning("newsletter_send estimated_recipient_count/subject 조회 실패(비중단) org=%s gate=%s", org_id, id, exc_info=True)
        # story #4262 — 이 게이트에 묶인 발송 명령 중 가장 최근 1(생성 시각 내림차순 · 같으면 id). 조직 조건 + 이 게이트 id라
        # 다른 조직 · 다른 게이트 명령이 섞이지 않는다. 사람 재시도가 같은 행을 pending으로 되돌리므로 보통 게이트당 1행이다.
        from app.models.publication_command import PublicationCommand

        command = (await session.execute(
            select(PublicationCommand)
            .where(
                PublicationCommand.org_id == org_id,
                PublicationCommand.gate_id == gate.id,
                PublicationCommand.content_kind == "newsletter_send",
            )
            .order_by(PublicationCommand.created_at.desc(), PublicationCommand.id.desc())
            .limit(1)
        )).scalar_one_or_none()
        if command is not None:
            resp.newsletter_send_command = NewsletterSendCommandSummary(
                id=command.id, status=command.status, failure_kind=command.failure_kind, reason_code=command.reason_code,
                next_attempt_at=command.next_attempt_at, reason_reset_at=command.reason_reset_at,
            )
    # story #2815(§5-④): merge 게이트만 의미 있음(다른 gate_type은 PR/repo 개념 자체가 없음).
    if gate.gate_type == MERGE_GATE_TYPE:
        _link = await resolve_pr_link(session, org_id, gate.work_item_id)
        resp.github_check_enforced = await is_repo_check_enforced(
            session, org_id, _link.repo_full_name if _link else None,
        )
    # story #2198(까심 QA 적출·오르테가 확定): can_approve 가 이 엔드포인트에선 **전혀 계산되지
    # 않고** 있었다(docstring 이 enrich 목록에 project_id/work_item_summary/risk_grade 만 적어
    # 뒀던 것 자체가 증거) — doc_approval·non-doc 가릴 것 없이 Pydantic 기본값 False 가 그대로
    # 나갔다. 딥링크 콜드 진입(알림 클릭 → 상세 직행, 위 docstring)이 이 엔드포인트를 쓰므로
    # list_gates 를 먼저 거치지 않은 사용자는 상세 화면에서도 버튼을 영영 못 봤다. list_gates 와
    # **동일 규칙**(can_approve_doc_gate_reason·_non_doc_gate_approvable)을 여기도 물린다 —
    # project_id 는 위에서 이미 resolve_work_item_project_id 로 해소돼 있어 추가 조회 없음.
    try:
        resolved = await resolve_member(auth, org_id, session)
        _uid = uuid.UUID(auth.user_id)
    except Exception:  # noqa: BLE001 — caller resolve 실패는 상세 조회 비중단(fail-closed can_approve=False).
        logger.warning("get_gate_endpoint caller resolve 실패(비중단) org=%s gate=%s", org_id, id, exc_info=True)
        resolved = None
        _uid = None
    if resolved is not None:
        if gate.gate_type == "doc_approval":
            _reason = await can_approve_doc_gate_reason(
                session, gate, resolved, _uid, org_id, doc_project_id=project_id,
            )
            resp.can_approve = _reason is None and is_valid_transition(gate.status, "approved")
        elif resolved.type == "human":  # rule B 는 human 체크가 없어 여기서 fail-closed(list_gates 와 동형).
            _approvable = await _non_doc_can_approve(
                session, gate.gate_type, _uid, org_id, project_id,
                designated_approver_id=gate.designated_approver_id, caller_member_id=resolved.id,
            )
            resp.can_approve = _approvable and is_valid_transition(gate.status, "approved")
    # story #3860 — list_gates와 동일 SSOT(work_item_conversation.py)·동일 caller-scope
    # 원칙(참여자 아니면 None). resolved는 위 can_approve enrich와 1회 공유(재resolve 0).
    if resolved is not None:
        from app.services.work_item_conversation import derive_conversation_ids_for_tagged_work_items

        conv_by_work_item = await derive_conversation_ids_for_tagged_work_items(
            session, org_id=org_id, member_id=resolved.id,
            work_item_pairs={(gate.work_item_type, gate.work_item_id)},
        )
        resp.conversation_id = conv_by_work_item.get((gate.work_item_type, gate.work_item_id))
    return resp


@router.get("/{id}/backlinks")
async def get_gate_backlinks(
    id: uuid.UUID,
    limit: int = Query(default=30, ge=1, le=200),
    before: str | None = Query(default=None),
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth=Depends(get_current_user),
) -> dict:
    """GET /api/v2/gates/{id}/backlinks — story #2889(S2h①) — 이 gate를 언급한 chat_message
    목록(stories.py::get_story_backlinks와 동일 convention — cursor pagination, 응답
    `{"data": [...], "meta": {"next_cursor", "has_more"}}`). 실 쿼리는
    `list_entity_backlinks`(target_type만 다름, 재구현 0).

    TARGET 게이트는 get_gate_endpoint와 동일(resolve_work_item_project_id — story #1968
    SSOT 재사용 — + is_known_project_agnostic_work_item_type fail-closed 분기, 새 인증
    미발명). gate 자체가 org에 없거나(취소·타org) work_item project 접근권이 없으면 404
    (존재 비노출 — get_gate_endpoint와 동형)."""
    gate = (await session.execute(
        select(Gate).where(Gate.id == id, Gate.org_id == org_id)
    )).scalar_one_or_none()
    if gate is None:
        raise HTTPException(status_code=404, detail="Gate not found")

    project_id = await resolve_work_item_project_id(
        session, org_id, gate.work_item_type, gate.work_item_id,
    )
    if project_id is not None:
        await require_project_access(session, uuid.UUID(auth.user_id), project_id, org_id,
                                      not_found_detail="Gate not found")
    elif not is_known_project_agnostic_work_item_type(gate.work_item_type):
        raise HTTPException(status_code=404, detail="Gate not found")

    from app.services.backlinks import list_entity_backlinks
    return await list_entity_backlinks(
        session, org_id=org_id, target_type="gate", target_id=id,
        auth=auth, limit=limit, cursor=before,
    )


class GateGithubCheckEventResponse(BaseModel):
    """story #2815(§5-②, 미르코군 계약 제안) — `gate_github_check_event`(0262) raw 원장 뷰.
    org_id/gate_id/story_id는 생략(이미 URL의 `{id}`가 gate 컨텍스트를 특정 — 중복 노출 불요)."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    repo_full_name: str
    pr_number: int
    head_sha: str
    # story #2819 — re_pending 행 전용(무효화된 승인이 귀속됐던 SHA). published/resolved 행이나
    # 마이그레이션 이전 re_pending 행은 null(소급 불가 — FE는 이미 null 폴백 설계, PR#3246).
    prior_sha: str | None = None
    event_type: str  # published | re_pending | resolved
    check_conclusion: str | None
    created_at: datetime


@router.get("/{id}/github-check-events", response_model=list[GateGithubCheckEventResponse])
async def list_gate_github_check_events_endpoint(
    id: uuid.UUID,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth=Depends(get_current_user),
) -> list[GateGithubCheckEventResponse]:
    """story #2815(§5-②) — GitHub check 발행/재-pending/해소 원장(AC④, story #2813) 조회.
    `GateEvidence`(FE)가 "check 상태·전이 이력" 섹션에서 지연 로드하는 용도 — 소량(gate당
    보통 수 건)이라 페이지네이션 없이 최신순 전체 반환.

    authz는 `get_gate_endpoint`와 **동일 패턴**(존재 비노출 — project 무권한도 404, 403 아님)을
    그대로 재사용한다: 이 원장은 gate의 세부 정보이지 별도 리소스가 아니므로 gate 조회와 같은
    접근권이어야 한다(gate는 보이는데 원장은 막히는 비대칭 방지)."""
    gate = (await session.execute(
        select(Gate).where(Gate.id == id, Gate.org_id == org_id)
    )).scalar_one_or_none()
    if gate is None:
        raise HTTPException(status_code=404, detail="Gate not found")

    project_id = await resolve_work_item_project_id(
        session, org_id, gate.work_item_type, gate.work_item_id,
    )
    if project_id is not None:
        await require_project_access(session, uuid.UUID(auth.user_id), project_id, org_id,
                                      not_found_detail="Gate not found")
    elif not is_known_project_agnostic_work_item_type(gate.work_item_type):
        raise HTTPException(status_code=404, detail="Gate not found")

    # ⛔카디르 QA(PR#3245, 비차단·후속 메모) — created_at 단독 정렬은 같은 밀리초에 여러 행이
    # 찍히면(이론상 가능 — 같은 트랜잭션 내 다중 이벤트) 동순위 tie 순서가 비결정적이다. 이
    # 원장은 이벤트가 gate당 소량·거의 항상 시간差가 있어 실무 영향은 낮다고 판단해 이번엔
    # 그대로 두되, 재발하면 `id`를 2차 정렬키로 추가할 것(UUID는 시간순 아니라 tie-break 용도).
    rows = (await session.execute(
        select(GateGithubCheckEvent)
        .where(GateGithubCheckEvent.gate_id == id, GateGithubCheckEvent.org_id == org_id)
        .order_by(GateGithubCheckEvent.created_at.desc())
    )).scalars().all()
    return [GateGithubCheckEventResponse.model_validate(r) for r in rows]


class GateActivityItem(BaseModel):
    """story #2975 AC4(PO 확定 2026-08-24) — 사람 결재 행위(approve/reject/undo/void/override)
    이력. `ActivityLog`(story #2631이 이미 append-only로 기록해 두고 있던 것)를 gate 스코프로
    투영한다 — 신규 테이블 0."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    action: str
    actor_id: uuid.UUID | None
    actor_name: str | None = None
    context: dict
    created_at: datetime


@router.get("/{id}/activity", response_model=list[GateActivityItem])
async def list_gate_activity_endpoint(
    id: uuid.UUID,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth=Depends(get_current_user),
) -> list[GateActivityItem]:
    """story #2975 AC4 — 「누가·언제·무엇을·어느 SHA에」 결재했는지 조회. 2026-08-23 두 실사고
    (PR#3402 취소 반영 여부 판별 불가·PR#3406 approved의 actor 판별 불가)가 이 표면 부재가
    원인이었다 — `ActivityLog`엔 이미 기록돼 있었고(transition_gate/undo_gate_resolution)
    조회 표면만 없었다. `github-check-events`(위)와 대칭인 gate-scope sub-resource로 신설
    (범용 `/api/v2/activity-logs?entity_type=gate&entity_id=`도 같은 데이터를 반환하지만,
    이 엔드포인트가 이미 하는 project-access 존재비노출 authz를 그쪽은 안 함 — gate 상세와
    같은 접근권 경계가 필요해 이 라우터에 둔다)."""
    from app.models.activity_log import ActivityLog
    from app.services.member_resolver import lookup_members_by_ids

    gate = (await session.execute(
        select(Gate).where(Gate.id == id, Gate.org_id == org_id)
    )).scalar_one_or_none()
    if gate is None:
        raise HTTPException(status_code=404, detail="Gate not found")

    project_id = await resolve_work_item_project_id(
        session, org_id, gate.work_item_type, gate.work_item_id,
    )
    if project_id is not None:
        await require_project_access(session, uuid.UUID(auth.user_id), project_id, org_id,
                                      not_found_detail="Gate not found")
    elif not is_known_project_agnostic_work_item_type(gate.work_item_type):
        raise HTTPException(status_code=404, detail="Gate not found")

    rows = (await session.execute(
        select(ActivityLog)
        .where(
            ActivityLog.entity_type == "gate", ActivityLog.entity_id == id,
            ActivityLog.org_id == org_id,
        )
        .order_by(ActivityLog.created_at.desc())
    )).scalars().all()

    actor_ids = {r.actor_id for r in rows if r.actor_id}
    actor_name_map: dict[uuid.UUID, str] = {}
    if actor_ids:
        resolved = await lookup_members_by_ids(actor_ids, session)
        actor_name_map = {mid: rm.name for mid, rm in resolved.items() if rm and rm.name}

    return [
        GateActivityItem(
            id=r.id, action=r.action, actor_id=r.actor_id,
            actor_name=actor_name_map.get(r.actor_id) if r.actor_id else None,
            context=r.context, created_at=r.created_at,
        )
        for r in rows
    ]


@router.post("/{id}/transition", response_model=GateResponse)
async def transition_gate_endpoint(
    id: uuid.UUID,
    body: GateTransitionRequest,
    background_tasks: BackgroundTasks,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth=Depends(get_current_user),
    locale: str | None = None,
    accept_language: str | None = Header(None, alias="Accept-Language"),
) -> GateResponse:
    """story #3793 — 라우트 진입점, `Header()` DI 마커는 여기서만 받는다(까심 QA CI FAILURE
    원칙). 직접-호출(realdb·유닛) 테스트는 `_transition_gate_endpoint`를 불러야 한다."""
    return await _transition_gate_endpoint(
        id, body, background_tasks, session=session, org_id=org_id, auth=auth,
        resolved_locale=resolve_locale_from_request(locale, accept_language),
    )


async def _transition_gate_endpoint(
    id: uuid.UUID,
    body: GateTransitionRequest,
    background_tasks: BackgroundTasks,
    *,
    session: AsyncSession,
    org_id: uuid.UUID,
    auth,
    resolved_locale: str,
) -> GateResponse:
    # authz(93fc7aeb): 게이트 approve/reject는 **휴먼 member만**. 에이전트(API key)가 사람 검증
    # 게이트를 승인하면 "agent-assisted·human-validated" 웨지 전제가 무너지므로 차단(403).
    # 시스템 auto-resolution(resolve_gate_from_verdict)은 transition_gate 서비스 직호출이라 무영향.
    # ⭐RC#1: status 는 validator 가 approved/rejected 로 제한 → 도달하는 전이는 전부 사람 결재.
    # E-DG 48f064e5 / #2198(까심 QA·오르테가 PO): doc/non-doc 인가 규칙 —
    # story #2631 로 _authorize_gate_approve_equivalent 로 추출(discuss 액션과 공유, 위 정의부 주석 참고).
    resolved = await resolve_member(auth, org_id, session)
    # story #2975 — FOR UPDATE: 이 트랜잭션이 커밋할 때까지 이 gate 행에 대한 concurrent
    # UPDATE(웹훅 구동 publish_gate_check의 github_check_run_sha 갱신 포함, gate_github_check.py)를
    # Postgres 행 잠금으로 블록한다. 아래 reviewed_head_sha 대조가 "읽고 나중에 커밋" 창에서
    # 딴 값으로 덮이지 않고, 대조에 쓴 값 그대로 approved_head_sha에 확정 기록됨을 보장(PO 요구 ②
    # — 대조와 anchor 쓰기가 같은 락 스코프 안에서 원자적).
    _gate = (await session.execute(
        select(Gate).where(Gate.id == id, Gate.org_id == org_id).with_for_update()
    )).scalar_one_or_none()
    await _authorize_gate_approve_equivalent(session, _gate, resolved, auth, org_id, resolved_locale)
    # story #2982(선생님 실사용 리포트, PO 확定 2026-08-24) — 이미 해소된(pending 아닌) 게이트에
    # 승인/반려를 시도하면 여기까지 도달해 transition_gate()의 is_valid_transition이 ValueError를
    # 던졌고, 그게 그대로 "불법 전이: approved → rejected. pending에서만..." 개발자 문구로 화면에
    # 노출됐다. FE가 상태별 버튼을 숨기게 고쳐도(AC1) 클릭~서버 응답 사이 레이스 창은 원리적으로
    # 남는다(#2975의 SHA 레이스와 동형 클래스) — 여기서 machine-readable code로 먼저 걸러야 FE가
    # 사람 문구로 번역할 수 있다(gate_head_changed 선례와 동형). 위 FOR UPDATE로 이미 잠근 행이라
    # 이 판정도 레이스-프리.
    if body.status in ("approved", "rejected") and _gate is not None and _gate.status != "pending":
        raise HTTPException(
            status_code=409,
            detail={
                "code": "gate_already_resolved",
                "message": "이미 처리된 결재입니다. 되돌리려면 PO에게 재검토를 요청해주세요.",
                "current_status": _gate.status,
                "resolver_id": str(_gate.resolver_id) if _gate.resolver_id else None,
                "resolved_at": _gate.resolved_at.isoformat() if _gate.resolved_at else None,
            },
        )
    # story #3365(Phase0 S2, 페드루 PO 재정정 2026-09-03 06:06Z) — external_publish 전용 막다른
    # 길 차단. 승인 뒤 편집으로 pending 재오픈된 게이트는 sealed_content_*가 옛 버전 그대로다
    # (site_posts.py `_reseal_gate_on_new_version` 참고 — 승인 기록을 조용히 덮지 않는다). 이
    # 옛 봉인을 그대로 승인하면 site_posts.py의 409 비교 기준점만 갱신될 뿐 실제로는 아무 새
    # 내용도 승인받지 못한 채 "승인됨"으로 보이는 막다른 길이 열린다 — 재봉인(submit() 재호출)
    # 없이는 approve 전이 자체를 막는다.
    # ⚠️페드루 PO 실측(2026-09-03 07:11Z, CI shard 3 실패) — gate_type 스코프 없이
    # `_gate.reapproval_required`만 보면 bare MagicMock 기반 테스트(예:
    # test_edg_s23_hypothesis_overlay.py — gate_type="merge"만 명시하고 이 필드는 안 건드림)의
    # auto-attribute가 항상 truthy MagicMock이라 site-post와 무관한 gate_type까지 이 가드에
    # 걸린다(#2975/#2982/#3319와 동형 MagicMock 함정 재발). gate_type=="external_publish"로
    # 명시 스코프해 그 클래스의 오탐을 원천 차단한다 — 다른 gate_type은 이 필드를 절대 안 본다.
    if (
        body.status == "approved" and _gate is not None
        and _gate.gate_type == "external_publish" and _gate.reapproval_required
    ):
        raise HTTPException(
            status_code=409,
            detail={
                "code": "SITE_POST_RESUBMIT_REQUIRED",
                "message": "승인 뒤 내용이 바뀌었습니다. 재상신(submit)한 뒤 다시 승인해주세요.",
            },
        )
    # story #2027(까심 QA 적출): 고위험(risk_grade=high) 게이트의 approved 전이는 사유(note) 서버측
    # 강제 — void_gate/override_gate 기존 관례(reason 없으면 ValueError→422, void_gate 참고)에
    # 맞추는 작업이다(신규 규칙 아님). 이전엔 FE 버튼 disable(evidenceViewed && reason.trim())만
    # 있고 서버는 무검증이라 POST /transition 직접 호출 시 사유 없이 통과했다. 저위험은 기존대로
    # note 없이 통과(과도 강제 금지 — PO AC). risk_grade 는 list_gates/get_gate 와 동일 파생 경로
    # (derive_risk_grade+get_org_posture) 재사용(DRY·N+1 0 — org당 posture 1쿼리).
    # story #3874 — 이 값을 함수 끝 to_gate_response()가 재사용한다(posture=_transition_posture
    # 로 주입, approved 경로에서 get_org_posture 재조회 0 — sentinel 기본값이면 그쪽이 직접 1쿼리).
    _transition_posture: Any = _POSTURE_UNSET
    if body.status == "approved" and _gate is not None:
        _transition_posture = await get_org_posture(session, org_id)
        if derive_risk_grade(_transition_posture, _gate.gate_type) == "high":
            if not (body.note or "").strip():
                raise HTTPException(
                    status_code=422,
                    detail=t("gates.transition_high_risk_note_required", resolved_locale),
                )
            # story #2027 AC2: note와 같은 자리 — 근거 열람(evidence_viewed) 확인도 서버가 강제.
            if body.evidence_viewed is not True:
                raise HTTPException(
                    status_code=422,
                    detail=t("gates.transition_high_risk_evidence_required", resolved_locale),
                )
    # story #2975(HIGH, 게이트 신선도 구멍 근본처방·페드루 PO 설계 확定 2026-08-24) — merge 게이트
    # 승인의 anchor SHA 레이스. 위 FOR UPDATE로 이 gate 행을 이미 잠근 상태이므로 여기서 읽는
    # _gate.github_check_run_sha는 이 트랜잭션이 커밋할 때까지 그 누구도 못 바꾸는 값이다(레이스
    # 윈도가 줄어든 게 아니라 없음). PO가 화면에서 review한 SHA(body.reviewed_head_sha)가 이 값과
    # 다르면 — body가 그 필드를 아예 안 보낸 경우(None)도 포함 — 승인을 진행하지 않고 즉시 409로
    # 거부한다. known SHA가 없는 legacy 게이트(github_check_run_sha=None)는 애초에 대조할 review
    # 시점 값이 없으므로 기존 동작(아래 anchor 블록의 PR-link 폴백) 그대로 통과.
    if body.status == "approved" and _gate is not None and _gate.gate_type == MERGE_GATE_TYPE:
        _known_head_sha = _gate.github_check_run_sha
        if _known_head_sha is not None and body.reviewed_head_sha != _known_head_sha:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "gate_head_changed",
                    "message": (
                        "게이트 대상 커밋이 승인 확인 이후 변경되었습니다. "
                        "최신 내용을 다시 확인한 뒤 승인해주세요."
                    ),
                    "current_head_sha": _known_head_sha,
                },
            )
    # story #3516 조각②(페드루 PO 確定 2026-09-05, AC4) — 댓글 답변 게이트(scope_key=
    # "comment:{comment_id}")의 승인은, 대상 댓글이 그새 삭제됐으면 명령을 만들지
    # 않고 즉시 409로 거부한다(위 merge-gate SHA 체크와 동형 위치 — gate_service.py
    # 의 자동 커맨드 생성 훅은 HTTP 에러를 못 내니 승인 요청 자체를 여기서 막는다).
    if body.status == "approved" and _gate is not None and _gate.gate_type == "external_publish":
        from app.services.channel_post_comment_replies import (
            CommentReplyTargetDeletedError, check_target_comment_not_deleted_or_raise,
        )

        try:
            await check_target_comment_not_deleted_or_raise(session, gate=_gate)
        except CommentReplyTargetDeletedError as exc:
            raise HTTPException(
                status_code=409,
                detail=human_error(
                    "COMMENT_REPLY_TARGET_DELETED", "답변 대상 댓글이 삭제되어 승인할 수 없어요.",
                    user_message="답변 대상 댓글이 삭제되어 승인할 수 없어요.",
                ),
            ) from exc
    # ⭐S23 RC① + RC#1(방어심층): resolver_id 를 **전 status 무조건 인증 caller 로 강제**(body 무시).
    # body 조작(타인 UUID)으로 SoD(approver≠owner) 우회·confirmed_by_member_id 위조 차단.
    _resolver_id = resolved.id
    _pending_deliveries: list[dict] = []
    try:
        gate = await transition_gate(
            session, org_id, id, body.status, _resolver_id, body.note,
            pending_deliveries=_pending_deliveries,
            reviewed_draft=(
                (body.reviewed_draft_id, body.reviewed_draft_version)
                if body.reviewed_draft_id is not None and body.reviewed_draft_version is not None else None
            ),
        )
        # ⛔카디르 QA(PR#3243, 2026-08-19) 레이스 fix — anchor(gate.approved_head_sha)를 배경
        # publish 태스크가 뒤늦게 적으면, 승인(SHA A) 직후·태스크 실행 前에 새 커밋(B)의
        # synchronize가 먼저 도착해 link.evidence를 B로 갱신 → 뒤늦은 태스크가 B를 읽어 "A 승인이
        # B를 축복"하는 경로가 열린다. **"승인은 그때의 커밋에" 문자 그대로 — anchor는 이 승인
        # 트랜잭션(commit 前)에서 확정 기록**한다. 배경 태스크(publish_gate_check)는 이 값을
        # 그대로 반영만 한다(gate_github_check.py 참고).
        if body.status == "approved" and gate.gate_type == MERGE_GATE_TYPE:
            # story #2832(CRITICAL, PO 페드루 배정 2026-08-20) — 재-pending 후 재승인이
            # approved_head_sha를 못 찍는 결함의 근본원인: story 하나에 PR 링크 행이 둘 이상이면
            # (예: 이전 PR 머지 후 같은 story에 새 PR — 잔류 흔한 케이스) resolve_pr_link가
            # story_id만으로 "가장 최근 updated_at" 행 하나를 고르는데, explicit-link API가
            # evidence를 **전체 교체**(pr_story_link.py upsert_link)해 head_sha 없는 얕은 evidence로
            # 갱신하면 그 행이 "가장 최근"이 돼 실제 anchor 없는 링크가 뽑힌다(실 사고 재현: gate
            # 38430aa8, PR#3255 — 07:13:59 웹훅이 정상 anchor를 썼는데 07:14:09 explicit-link
            # 호출이 evidence를 {"by":"explicit_api"}로 교체해 head_sha가 사라짐). gate 자신의
            # github_check_run_sha는 이 story-스코프 다중-PR 모호성과 무관하게(publish_gate_check가
            # 이 gate row 자체에 마지막으로 발행한 check-run의 SHA를 직접 기록) 항상 "지금 이
            # gate가 추적 중인 SHA"를 정확히 담고 있으므로 **1순위**로 쓴다 — story 링크 조회는
            # 그 필드가 아예 빈 legacy/이상 상태(#2813 이전 gate 등)에만 폴백으로 남긴다.
            _head_sha = gate.github_check_run_sha
            if not _head_sha:
                _link = await resolve_pr_link(session, org_id, gate.work_item_id)
                _head_sha = (_link.evidence or {}).get("head_sha") if _link else None
            if _head_sha:
                gate.approved_head_sha = _head_sha
                # story #2932 완주조건 HIGH2(5라운드 재설계) — 이전엔(4라운드) 여기서 서버
                # now()로 pr_head_observed_at을 씨딩했으나, 서로 다른 시계(서버시각 vs GitHub
                # 실시각)를 같은 필드에 섞는 결함으로 판명(카디르 5라운드+codex 실물재현) —
                # 삭제했다. 이 필드는 이제 reopen_gate_if_new_sha(gate_github_check.py) 오직
                # 한 곳, 오직 실 webhook payload의 pr_updated_at에서만 채워진다(그 함수가
                # gate.status 무관하게 "관측"은 항상 기록하도록 바뀌어, PR이 opened/
                # synchronize될 때 거의 항상 먼저 오는 실 웹훅이 승인보다 앞서 워터마크를
                # 이미 심어 둔다 — 이 승인 지점은 그 값을 그대로 둔다).
        # story #4069(훅B) — 「승인-뒤-제출」순서 커버 + story #4090 AC2 자동발행 훅은
        # story #4090에서 `gate_service.py::transition_gate`(approved 분기)로 이관됐다
        # (라우터를 안 거치는 승인 호출자도 같은 혜택을 받게, 페드루 PO 確定 2026-09-21
        # — 2026-09-19 원본은 여기 있었다). 위 `transition_gate()` 호출이 이미 처리를
        # 마쳤으므로 이 라우터엔 더 남길 코드가 없다(중복 제거).
        await session.commit()
        # story #2459 회귀 동형 방어(2026-08-05): commit 後 model_validate 前 명시 refresh.
        await session.refresh(gate)
        # ccbcd9da(A-1): doc/epic 자동재개 wake — commit(recipient_seq 확정) 후 발화(이중전달 방지).
        _schedule_pending_deliveries(background_tasks, _pending_deliveries)
        # story #4192(까디르 4583 P1) — 레시피 회차 자사 블로그 초안 게이트면 서버 발행은 **승인 커밋 뒤** 격리 세션에서
        # (발행 실패가 승인을 지우지 않게). 이 세션은 안 쓴다 — 결과(publish_outcome)만 다시 읽어 응답에 싣는다.
        if gate.status == "approved":
            from app.services.site_posts import publish_recipe_approved_hosted_site_draft_after_commit

            await publish_recipe_approved_hosted_site_draft_after_commit(
                session, gate_id=gate.id, resolver_id=gate.resolver_id,
            )
            await session.refresh(gate)
        # story #2813 — 사람 승인/반려를 GitHub check-run(success/failure)으로 반영. commit 後
        # 배경 태스크(fail-closed: 실패해도 이미 commit된 gate 상태엔 영향 없음, GitHub 쪽만 stale).
        # merge 게이트 아니면 publish_gate_check 내부에서 조용히 no-op.
        # story #2835(PO AC 확定 2026-08-20) — #3258은 웹훅 수명주기 경로(인자 보유)만 고쳤고, 이
        # 승인-전이 경로는 인자 없이 호출해 여전히 link row에 의존했다 — row-less 자동 생성 gate
        # (2826 주처방의 기본 케이스, SID 해소는 link row를 안 만든다)는 승인해도 success 발행이
        # 죽었다(실사고: gate dbefee69/story #2834/PR#3259). `gate.neutral_facts`가 이미 SSOT로
        # repo+pr_number를 갖고 있음을 실측(evaluate_merge_gate가 gate 생성/재평가마다 채움,
        # merge_verdict_gate.py facts dict) — 새 컬럼/installation 도출 불요, 있으면 그대로 전달.
        # 없으면(legacy gate 등) publish_gate_check의 기존 link-row 폴백이 그대로 받는다.
        _nf = gate.neutral_facts or {}
        background_tasks.add_task(
            publish_gate_check, org_id, gate.id,
            repo_full_name=_nf.get("repo"), pr_number=_nf.get("pr_number"),
        )
        # story #3874(원인: 이 응답이 늘 risk_grade=None이었다·story #3868 AC0 실측) — 위
        # 고위험 note 검증이 이미 get_org_posture를 한 번 부르지만(_transition_posture) 그
        # 결과를 응답에 안 실었었다. approved 경로면 그 값을 그대로 재사용(재조회 0, story
        # #2027 원래 "N+1 0" 의도 그대로)하고, 그 외 상태(rejected 등, 검증 블록 자체를
        # 안 태움)만 to_gate_response가 자체적으로 1쿼리 한다(AC1이 명시 허용하는 비용).
        return await to_gate_response(session, org_id, gate, posture=_transition_posture)
    except RecipeReviewedDraftChangedError as e:
        # story #4190 — 사람 문구는 카탈로그 키(유나 확정 대기 · PO 11:49Z). 코드·현재 초안 버전은 FE 새로고침 안내용.
        raise HTTPException(
            status_code=409,
            detail=human_error(
                "gate_draft_changed", "The draft changed after this approval screen was opened.",
                user_message=t("gates.draft_changed", resolved_locale),
                current_draft_id=str(e.current_draft_id), current_version=e.current_version,
            ),
        ) from e
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))


@router.post("/{id}/reevaluate", response_model=GateResponse)
async def reevaluate_gate_endpoint(
    id: uuid.UUID,
    background_tasks: BackgroundTasks,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth=Depends(get_current_user),
    locale: str | None = None,
    accept_language: str | None = Header(None, alias="Accept-Language"),
) -> GateResponse:
    """story #3793 — 라우트 진입점, `Header()` DI 마커는 여기서만 받는다(까심 QA CI FAILURE
    원칙). 직접-호출 테스트는 `_reevaluate_gate_endpoint`를 불러야 한다."""
    return await _reevaluate_gate_endpoint(
        id, background_tasks, session=session, org_id=org_id, auth=auth,
        resolved_locale=resolve_locale_from_request(locale, accept_language),
    )


async def _reevaluate_gate_endpoint(
    id: uuid.UUID,
    background_tasks: BackgroundTasks,
    *,
    session: AsyncSession,
    org_id: uuid.UUID,
    auth,
    resolved_locale: str,
) -> GateResponse:
    """story #2893(설계안 §3 B3) — 명시적 재평가 API. reopen(PR을 실제로 close→reopen)이나
    「참여등록 후 빈 커밋 push」 같은 우회(오늘 #3324가 실제로 쓴 수동 경로)를 표준 경로로
    승격한다. reopen과 달리 **GitHub 쪽 리뷰/체크 상태를 전혀 건드리지 않는다** — PR의 현재
    head SHA/merged 상태를 순수 GET으로 읽어와 우리 쪽 게이트 판정만
    `reconcile_merge_gate_with_real_evidence`(웹훅 경로와 동일 chokepoint)로 재실행한다.

    authz: get_gate_endpoint과 동일(project_id 해소+has_project_access, 무권한은 404 —
    존재 비노출 규율) — 승인/거부(_authorize_gate_approve_equivalent)보다 낮은 문턱이다.
    「재평가를 트리거」는 결정이 아니라 「지금 상태를 정직하게 반영해 달라」는 요청이라
    approver가 아닌 PR 관련자(오늘까지 close/reopen을 직접 하던 사람들)도 할 수 있어야
    이 API가 그 우회를 실제로 대체한다.

    scope: merge 게이트·status가 pending/auto_passed일 때만(reconcile_merge_gate_with_
    real_evidence의 기존 자격조건과 동일 — approved는 landed 작업이라 재평가 대상이 아니고,
    rejected/voided/held는 사람이 이미 명시 결정한 상태라 재평가로 우회하면 안 된다)."""
    gate = (await session.execute(
        select(Gate).where(Gate.id == id, Gate.org_id == org_id)
    )).scalar_one_or_none()
    if gate is None:
        raise HTTPException(status_code=404, detail="Gate not found")

    project_id = await resolve_work_item_project_id(
        session, org_id, gate.work_item_type, gate.work_item_id,
    )
    if project_id is not None:
        await require_project_access(session, uuid.UUID(auth.user_id), project_id, org_id,
                                      not_found_detail="Gate not found")
    elif not is_known_project_agnostic_work_item_type(gate.work_item_type):
        raise HTTPException(status_code=404, detail="Gate not found")

    if gate.gate_type != MERGE_GATE_TYPE:
        raise HTTPException(status_code=422, detail=t("gates.reevaluate_merge_only", resolved_locale))
    if gate.status not in ("pending", "auto_passed"):
        raise HTTPException(
            status_code=422,
            detail=f"게이트 상태({gate.status})는 재평가 대상이 아닙니다(pending/auto_passed만 가능).",
        )

    # gate.pr_number(story #2893 A1, 0271)가 이 게이트가 귀속된 PR의 1차 SSOT.
    # gate.repo_full_name(story #2932 HIGH1, 0272)이 repo의 1차 SSOT — neutral_facts.repo는
    # 그 컬럼이 아직 없던 legacy gate만을 위한 2차 폴백.
    pr_number = gate.pr_number
    repo = gate.repo_full_name or (gate.neutral_facts or {}).get("repo")
    if not repo or not pr_number:
        # 카디르 QA(story #2932 HIGH3) — pr_number가 이미 알려진 상태에서 repo만 없으면
        # (구 컬럼 미백필 등) "이 스토리의 가장 최근 링크"를 무조건 빌려오면 안 된다 —
        # 그 링크가 **다른 PR**의 것이면 (그 repo, 이 pr_number) 조합은 실존한 적 없는
        # 합성(fictitious) 튜플이 되고, 그 조합으로 GitHub GET을 날리게 된다(실사고). PR
        # 컨텍스트가 이미 있으면(pr_number 있음) 반드시 그 PR과 일치하는 링크로만 repo를
        # 보강한다 — pr_number 자체가 없을 때만(둘 다 미상) story 최신 링크를 신뢰한다.
        _link = await resolve_pr_link(session, org_id, gate.work_item_id)
        if pr_number and _link is not None and _link.pr_number != pr_number:
            _link = None  # 다른 PR의 링크 — 지어내지 않는다.
        repo = repo or (_link.repo_full_name if _link else None)
        pr_number = pr_number or (_link.pr_number if _link else None)
    if not repo or not pr_number:
        raise HTTPException(
            status_code=422, detail=t("gates.reevaluate_no_pr_info", resolved_locale),
        )

    installation = (
        await session.execute(
            select(GithubInstallation).where(
                GithubInstallation.org_id == org_id, GithubInstallation.suspended_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if installation is None:
        raise HTTPException(status_code=422, detail=t("gates.reevaluate_no_github_app", resolved_locale))
    token = await get_installation_token(installation.installation_id)
    if not token:
        raise HTTPException(status_code=502, detail=t("gates.reevaluate_token_fetch_failed", resolved_locale))

    pr = await get_pull_request(installation.installation_id, repo, pr_number)
    if pr is None:
        raise HTTPException(status_code=502, detail=t("gates.reevaluate_pr_fetch_failed", resolved_locale))
    head_sha = (pr.get("head") or {}).get("sha")
    if not head_sha:
        raise HTTPException(status_code=502, detail=t("gates.reevaluate_head_sha_unavailable", resolved_locale))
    merged = bool(pr.get("merged"))
    ci_result, _ci_reason = await fetch_status_check_rollup(repo, head_sha, token)

    await reconcile_merge_gate_with_real_evidence(
        session, org_id, gate.work_item_id,
        pr_number=pr_number, repo=repo, ci_result=ci_result, merged=merged, head_sha=head_sha,
    )
    await session.commit()
    # story #2459 회귀 동형 방어(2026-08-05): commit 後 model_validate 前 명시 refresh.
    await session.refresh(gate)
    background_tasks.add_task(
        publish_gate_check, org_id, gate.id,
        repo_full_name=repo, pr_number=pr_number, head_sha=head_sha,
    )
    return await to_gate_response(session, org_id, gate)


class GateVoidRequest(BaseModel):
    reason: str  # 사유 필수(audit·파괴적 액션). 빈 사유는 서비스서 422.


@router.post("/{id}/withdraw", response_model=GateResponse)
async def withdraw_gate_endpoint(
    id: uuid.UUID,
    body: GateVoidRequest,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth=Depends(get_current_user),
) -> GateResponse:
    """story #2789(2026-08-24, PO 판정) — 갭③: 요청자(에이전트 포함) 자기 결정 카드 철회.

    `/void`(위)는 admin-only 복구 액션(잘못 생성된 게이트를 관리자가 무효화) — 그와는
    **다른 인가 축**이다: 여기는 "이 게이트를 만든 사람 본인이 자기 질문을 철회"하는
    것이라, admin 자격이 아니라 **본인이 원 요청자인가**만 검사한다(neutral_facts.
    requested_by_member_id — /decisions 생성 시점에 caller_id로 stamp됨, gates.py:418).
    admin이 아닌 에이전트가 자기 질문을 낸 뒤 스스로 취소할 방법이 지금까지 전무했다
    (2026-08-19 실증: DELETE 405·withdraw/resolve/agent-decisions/* 전부 404) — 무효화된
    질문 카드가 결재함에 영구 잔존하던 그 갭.

    상태 전이·audit는 `void_gate()`(SSOT, admin `/void`와 동일 로직) 그대로 재사용 — 새
    상태기계 발명 0. actor_type만 실 caller 신원(agent_gateway.py 등과 동형 api_key_id
    판별)으로 정직하게 넘긴다(#2789 이전엔 이 함수의 유일한 호출자가 항상 사람이라
    "human" 하드코딩이 참이었다 — 더는 아니다).

    철회는 결재함(gate.status≠pending이 되는 순간 그 목록에서 자연히 빠짐, 별도 배선
    불요)과 채팅(designated_approver에게 "철회" 결과 회신 — dispatch_approval_result_reply
    재사용, approved/rejected와 동형의 반대방향 알림) 양쪽에 반영된다."""
    resolved = await resolve_member(auth, org_id, session)

    gate = (await session.execute(
        select(Gate).where(Gate.id == id, Gate.org_id == org_id)
    )).scalar_one_or_none()
    if gate is None:
        raise HTTPException(status_code=404, detail="Gate not found")

    # 카디르 QA(#3462, 2026-08-25 probe 실측): neutral_facts는 외부 JSONB라 requested_by_
    # member_id가 손상된/비-UUID 문자열일 수 있다 — uuid.UUID(...) 파싱은 그 경우 uncaught
    # ValueError로 500을 낸다(다른 gate 라우트가 쓰는 문자열비교 패턴을 그대로 재사용해
    # 파싱 자체를 없앤다 — 손상값은 어차피 어떤 유효 uuid 문자열과도 안 같으므로 결과는
    # 동일하게 404, 크래시만 사라진다).
    requester_raw = (gate.neutral_facts or {}).get("requested_by_member_id")
    if not requester_raw or str(requester_raw) != str(resolved.id):
        # 존재 비노출 관례(다른 gate 라우트와 동형) — 남의 게이트 존재 여부를 403으로
        # 흘리지 않는다. 본인 요청이 아니면 404(admin은 /void를 쓸 것).
        raise HTTPException(status_code=404, detail="Gate not found")

    is_api_key = bool(auth.claims.get("app_metadata", {}).get("api_key_id"))
    actor_type = "agent" if is_api_key else "human"

    try:
        gate = await void_gate(
            session, org_id, id, resolved.id, body.reason,
            actor_type=actor_type, void_reason_label="requester",
        )
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))

    designated_approver_id = gate.designated_approver_id
    if designated_approver_id is not None:
        try:
            from app.services.approval_delivery import dispatch_approval_result_reply
            project_id_raw = (gate.neutral_facts or {}).get("project_id")
            # dispatch_approval_result_reply 자체가 project_id falsy면 no-op(그 함수 첫 줄
            # 가드) — 없으면 지어내지 않고 None 그대로 넘긴다.
            await dispatch_approval_result_reply(
                session, org_id=org_id, work_item_type=gate.work_item_type,
                work_item_id=gate.work_item_id,
                project_id=uuid.UUID(str(project_id_raw)) if project_id_raw else None,
                title=(gate.neutral_facts or {}).get("question", "결정 요청"),
                gate_id=gate.id, requester_id=designated_approver_id, resolver_id=resolved.id,
                decision="withdrawn", resolution_note=body.reason,
                event_type="agent_decision_withdrawn",
            )
        except Exception:  # noqa: BLE001 — 회신 실패가 철회 자체를 막지 않는다(결재함 반영은 이미 완료).
            logger.warning("decision-request 철회 회신 실패 gate=%s", gate.id, exc_info=True)

    await session.commit()
    # story #2459 회귀 동형 방어(2026-08-05): commit 後 model_validate 前 명시 refresh.
    await session.refresh(gate)
    return await to_gate_response(session, org_id, gate)


@router.post("/{id}/void", response_model=GateResponse)
async def void_gate_endpoint(
    id: uuid.UUID,
    body: GateVoidRequest,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth=Depends(get_current_user),
    locale: str | None = None,
    accept_language: str | None = Header(None, alias="Accept-Language"),
) -> GateResponse:
    """story #3793 — 라우트 진입점, `Header()` DI 마커는 여기서만 받는다(까심 QA CI FAILURE
    원칙). 직접-호출 테스트는 `_void_gate_endpoint`를 불러야 한다."""
    return await _void_gate_endpoint(
        id, body, session=session, org_id=org_id, auth=auth,
        resolved_locale=resolve_locale_from_request(locale, accept_language),
    )


async def _void_gate_endpoint(
    id: uuid.UUID,
    body: GateVoidRequest,
    *,
    session: AsyncSession,
    org_id: uuid.UUID,
    auth,
    resolved_locale: str,
) -> GateResponse:
    """⭐S30 admin recovery: 잘못 생성된 pending gate 무효화(void). admin-only(project_auth canonical).

    voider 는 **인증 caller 강제**(body 신뢰 0·S23 RC① 패턴). void≠approval — 묶인 step_run 해소로
    엔티티 unblock(re-route 가능)되되 전이 미적용. transition 단일경로(void 는 void_gate SSOT)."""
    resolved = await resolve_member(auth, org_id, session)
    # Q4: canonical project_auth admin 게이팅(ad-hoc role 금지·S27/S29 교훈). org owner/admin 만.
    if not await is_org_owner_or_admin(session, uuid.UUID(auth.user_id), org_id):
        raise HTTPException(status_code=403, detail=t("gates.void_owner_admin_only", resolved_locale))
    try:
        gate = await void_gate(session, org_id, id, resolved.id, body.reason)
        await session.commit()
        # story #2459 회귀 동형 방어(2026-08-05): commit 後 model_validate 前 명시 refresh.
        await session.refresh(gate)
        return await to_gate_response(session, org_id, gate)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))


class GateHoldRequest(BaseModel):
    reason: str | None = None       # S31: 보류 사유(선택·가역적 일시정지라 마찰↓)
    held_until: datetime | None = None  # 시한부 만료(무기한이면 None)


async def _require_gate_admin(session, auth, org_id, resolved_locale: str):
    """⭐S31/S30 공통: gate 파괴적/관리 액션 admin 게이팅(canonical project_auth·ad-hoc role 금지).
    반환 resolved member(holder/voider=인증 caller 강제용·body 신뢰 0).

    story #3793 — `resolved_locale`은 호출부(라우트 진입점)가 이미 `resolve_locale_from_request()`
    로 풀어 넘기는 plain str(Header() DI 마커 없음, 까심 QA CI FAILURE 원칙)."""
    resolved = await resolve_member(auth, org_id, session)
    if not await is_org_owner_or_admin(session, uuid.UUID(auth.user_id), org_id):
        raise HTTPException(status_code=403, detail=t("gates.require_admin_generic", resolved_locale))
    return resolved


@router.post("/{id}/hold", response_model=GateResponse)
async def hold_gate_endpoint(
    id: uuid.UUID,
    body: GateHoldRequest,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth=Depends(get_current_user),
    locale: str | None = None,
    accept_language: str | None = Header(None, alias="Accept-Language"),
) -> GateResponse:
    """story #3793 — 라우트 진입점, `Header()` DI 마커는 여기서만 받는다(까심 QA CI FAILURE
    원칙). 직접-호출 테스트는 `_hold_gate_endpoint`를 불러야 한다."""
    return await _hold_gate_endpoint(
        id, body, session=session, org_id=org_id, auth=auth,
        resolved_locale=resolve_locale_from_request(locale, accept_language),
    )


async def _hold_gate_endpoint(
    id: uuid.UUID,
    body: GateHoldRequest,
    *,
    session: AsyncSession,
    org_id: uuid.UUID,
    auth,
    resolved_locale: str,
) -> GateResponse:
    """⭐S31 admin hold: pending gate 일시 보류(held·SLA pause). admin-only·holder=인증 caller 강제."""
    resolved = await _require_gate_admin(session, auth, org_id, resolved_locale)
    try:
        gate = await hold_gate(session, org_id, id, resolved.id, body.reason, body.held_until)
        await session.commit()
        # story #2459 회귀 동형 방어(2026-08-05): commit 後 model_validate 前 명시 refresh.
        await session.refresh(gate)
        return await to_gate_response(session, org_id, gate)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))


@router.post("/{id}/unhold", response_model=GateResponse)
async def unhold_gate_endpoint(
    id: uuid.UUID,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth=Depends(get_current_user),
    locale: str | None = None,
    accept_language: str | None = Header(None, alias="Accept-Language"),
) -> GateResponse:
    """story #3793 — 라우트 진입점, `Header()` DI 마커는 여기서만 받는다(까심 QA CI FAILURE
    원칙). 직접-호출 테스트는 `_unhold_gate_endpoint`를 불러야 한다."""
    return await _unhold_gate_endpoint(
        id, session=session, org_id=org_id, auth=auth,
        resolved_locale=resolve_locale_from_request(locale, accept_language),
    )


async def _unhold_gate_endpoint(
    id: uuid.UUID,
    *,
    session: AsyncSession,
    org_id: uuid.UUID,
    auth,
    resolved_locale: str,
) -> GateResponse:
    """⭐S31 admin unhold: held gate 재개(→pending·SLA resume). admin-only·actor=인증 caller."""
    resolved = await _require_gate_admin(session, auth, org_id, resolved_locale)
    try:
        gate = await unhold_gate(session, org_id, id, resolved.id)
        await session.commit()
        # story #2459 회귀 동형 방어(2026-08-05): commit 後 model_validate 前 명시 refresh.
        await session.refresh(gate)
        return await to_gate_response(session, org_id, gate)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))


@router.post("/{id}/undo", response_model=GateResponse)
async def undo_gate_resolution_endpoint(
    id: uuid.UUID,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth=Depends(get_current_user),
) -> GateResponse:
    """story #2631 AC1/AC3 — 오클릭 정정. 해소(approved/rejected) 직후 짧은 창 안에서
    **해소자 본인만** 취소해 pending으로 되돌린다. 별도 role 게이팅 없음 — 본인 해소를
    본인이 되돌린다는 사실 하나로 인가가 성립(void/hold 류 admin 액션과 다른 축, 서비스
    docstring 참고). body 는 인증 caller 강제(S23 RC① 패턴 재사용) — actor_id 를 body 로
    받지 않는다."""
    resolved = await resolve_member(auth, org_id, session)
    try:
        gate = await undo_gate_resolution(session, org_id, id, resolved.id)
        await session.commit()
        # story #2459 회귀 동형 방어(2026-08-05): commit 後 model_validate 前 명시 refresh.
        await session.refresh(gate)
        return await to_gate_response(session, org_id, gate)
    except GateUndoNotSelfError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except GateUndoWindowExpiredError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))


class GateDiscussionRequest(BaseModel):
    reason: str


@router.post("/{id}/discuss", response_model=GateResponse)
async def request_gate_discussion_endpoint(
    id: uuid.UUID,
    body: GateDiscussionRequest,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth=Depends(get_current_user),
    locale: str | None = None,
    accept_language: str | None = Header(None, alias="Accept-Language"),
) -> GateResponse:
    """story #2631 AC2 — 승인/거부 옆 3번째 응답: 「보류(논의 필요)」. 게이트는 pending
    그대로(전이 없음) — 순수 회신+감사 기록. 인가는 승인/거부와 **동일 자격**
    (_authorize_gate_approve_equivalent — 승인 못 하는 제3자가 게이트를 논의-보류로
    묶어두는 것도 막아야 하므로).

    story #3793 — `Header()` DI 마커는 여기서만 받는다(까심 QA CI FAILURE 원칙). 직접-호출
    테스트는 `_request_gate_discussion_endpoint`를 불러야 한다."""
    return await _request_gate_discussion_endpoint(
        id, body, session=session, org_id=org_id, auth=auth,
        resolved_locale=resolve_locale_from_request(locale, accept_language),
    )


async def _request_gate_discussion_endpoint(
    id: uuid.UUID,
    body: GateDiscussionRequest,
    *,
    session: AsyncSession,
    org_id: uuid.UUID,
    auth,
    resolved_locale: str,
) -> GateResponse:
    resolved = await resolve_member(auth, org_id, session)
    _gate = (await session.execute(
        select(Gate).where(Gate.id == id, Gate.org_id == org_id)
    )).scalar_one_or_none()
    await _authorize_gate_approve_equivalent(session, _gate, resolved, auth, org_id, resolved_locale)
    try:
        gate = await request_gate_discussion(session, org_id, id, resolved.id, body.reason)
        await session.commit()
        # story #2459 회귀 동형 방어(2026-08-05): commit 後 model_validate 前 명시 refresh.
        await session.refresh(gate)
        return await to_gate_response(session, org_id, gate)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))


class GateDelegateRequest(BaseModel):
    new_approver_member_id: uuid.UUID


@router.post("/{id}/delegate", response_model=GateResponse)
async def delegate_gate_endpoint(
    id: uuid.UUID,
    body: GateDelegateRequest,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth=Depends(get_current_user),
    locale: str | None = None,
    accept_language: str | None = Header(None, alias="Accept-Language"),
) -> GateResponse:
    """story #3793 — 라우트 진입점, `Header()` DI 마커는 여기서만 받는다(까심 QA CI FAILURE
    원칙). 직접-호출 테스트는 `_delegate_gate_endpoint`를 불러야 한다."""
    return await _delegate_gate_endpoint(
        id, body, session=session, org_id=org_id, auth=auth,
        resolved_locale=resolve_locale_from_request(locale, accept_language),
    )


async def _delegate_gate_endpoint(
    id: uuid.UUID,
    body: GateDelegateRequest,
    *,
    session: AsyncSession,
    org_id: uuid.UUID,
    auth,
    resolved_locale: str,
) -> GateResponse:
    """story #3001(선생님 정책 확定 2026-08-24) — 지정 결재자 본인이 다른 결재자에게
    「튕겨낸다」(위임). #2985가 만들었던 "대신 처리" 폴드의 대체 정책 — 「감사는 읽기만
    있으면 되고, 승계는 결재를 받는 사람이 튕겨내게 하는 게 올바른 방법」(선생님 원문,
    결정권이 라인을 떠나지 않는 위임 모델). 인가는 좁다: 호출자가 이 게이트의 **현재**
    designated_approver_id 본인이어야만(SoD와 동일 축 — 다른 사람이 남의 결재를 대신
    튕길 수 없음). #3002(지정자 완전 부재 시 admin 강제 재지정)와는 별개 축이라 이
    엔드포인트는 admin bypass가 없다(의도적 — 그 스코프는 후속 스토리)."""
    resolved = await resolve_member(auth, org_id, session)
    # transition_gate_endpoint와 동일 이유(#2975) — FOR UPDATE로 이 gate 행에 대한 concurrent
    # 재지정(다른 위임 요청 등)을 블록, 대조와 갱신이 같은 락 스코프 안에서 원자적.
    _gate = (await session.execute(
        select(Gate).where(Gate.id == id, Gate.org_id == org_id).with_for_update()
    )).scalar_one_or_none()
    if _gate is None:
        raise HTTPException(status_code=404, detail="Gate not found")
    if _gate.status != "pending":
        raise HTTPException(
            status_code=409,
            detail={"code": "gate_already_resolved", "message": "이미 처리된 결재는 위임할 수 없습니다."},
        )
    if _gate.designated_approver_id is None or _gate.designated_approver_id != resolved.id:
        raise HTTPException(status_code=403, detail=t("gates.delegate_designated_only", resolved_locale))
    if body.new_approver_member_id == resolved.id:
        raise HTTPException(status_code=422, detail=t("gates.delegate_self_not_allowed", resolved_locale))

    # story #2985와 동일 fail-safe 축(approval_delivery.dispatch_approval_request_cards의
    # designated_approver_id 밖 값 처리와 동형) — 여기선 서버가 400으로 명시 거부한다(라우터
    # 경계 검증, PO 보강① — 권한 없는 이에게 튕기면 결재 불능 카드가 되는 것을 사전 차단).
    from app.models.project import OrgMember
    eligible_ids = set((await session.execute(
        select(OrgMember.id).where(
            OrgMember.org_id == org_id,
            OrgMember.role.in_(("owner", "admin")),
            OrgMember.deleted_at.is_(None),
        )
    )).scalars().all())
    if body.new_approver_member_id not in eligible_ids:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "ineligible_delegate_target",
                "message": "위임 대상이 이 조직의 결재 권한자(owner/admin)가 아닙니다.",
            },
        )

    old_approver_id = _gate.designated_approver_id
    _gate.designated_approver_id = body.new_approver_member_id

    from app.services.activity_log import ActivityLogService
    await ActivityLogService(session).record(
        org_id=org_id, action="gate_delegated", actor_id=resolved.id, actor_type="human",
        entity_type="gate", entity_id=_gate.id,
        context={
            "from_member_id": str(old_approver_id),
            "to_member_id": str(body.new_approver_member_id),
        },
    )
    await session.commit()
    await session.refresh(_gate)

    # best-effort — 신규 카드 배달+원 카드 실시간 반영 실패가 위임 자체(위 commit으로 이미
    # 확정된 designated_approver_id 갱신+감사기록)를 막지 않는다.
    from app.services.gate_service import dispatch_gate_delegation
    await dispatch_gate_delegation(
        session, _gate, old_approver_id=old_approver_id, new_approver_id=body.new_approver_member_id,
    )

    return await to_gate_response(session, org_id, _gate)


class GateTossRequest(BaseModel):
    target_conversation_id: uuid.UUID


class GateTossResponse(GateResponse):
    # story #3094(2026-08-26, #3492 리뷰 "알려진 축소" 잔여분) — dispatch_approval_card_toss가
    # 이미 신규삽입/멱등no-op을 bool로 구분해 반환하는데(#3488 PO 비차단 관찰 — False는 오직
    # 멱등만 의미) 이 값이 HTTP 응답까지 안 올라와 FE가 "이미 있음" 여부를 알 방법이 없었다.
    # additive(GateResponse 상속, 기존 필드 비파괴) — 게이트 멱등 시맨틱스·단일 처리는 불변.
    inserted: bool


@router.post("/{id}/toss", response_model=GateTossResponse)
async def toss_gate_endpoint(
    id: uuid.UUID,
    body: GateTossRequest,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth=Depends(get_current_user),
    locale: str | None = None,
    accept_language: str | None = Header(None, alias="Accept-Language"),
) -> GateTossResponse:
    """story #3793 — 라우트 진입점, `Header()` DI 마커는 여기서만 받는다(까심 QA CI FAILURE
    원칙). 직접-호출 테스트는 `_toss_gate_endpoint`를 불러야 한다."""
    return await _toss_gate_endpoint(
        id, body, session=session, org_id=org_id, auth=auth,
        resolved_locale=resolve_locale_from_request(locale, accept_language),
    )


async def _toss_gate_endpoint(
    id: uuid.UUID,
    body: GateTossRequest,
    *,
    session: AsyncSession,
    org_id: uuid.UUID,
    auth,
    resolved_locale: str,
) -> GateTossResponse:
    """story #3084(2026-08-25, 선생님 지시 — 결재 카드 «토스») — 상신자 또는 designated
    결재자 본인이, designated 본인이 참여한 다른 conversation에 카드 **사본**을 심는다
    (원 카드 잔존). #3001 delegate("사람" 축 — 정체성 재지정)와 다른 "방" 축(같은
    designated에게로 가는 도달 경로를 하나 더 여는 것) — 페드루 PO 정렬 확定(2026-08-25):
    과거 기각된 "여러 사람으로의 카드 확산" 정책과는 축이 달라 상충하지 않는다. 권한 범위도
    delegate와 달리 admin 확장 없이 requester+designated 본인 한정(PO 판정, 실사고 근거
    없어 admin 확장 기각).

    target_conversation_id 검증(designated 본인이 참여자인지)이 «카드=지정 라인 전용»
    정책(#3001)의 집행 지점 — 임의 방으로 결재 액션 링크가 새는 것을 여기서 막는다."""
    resolved = await resolve_member(auth, org_id, session)
    _gate = (await session.execute(
        select(Gate).where(Gate.id == id, Gate.org_id == org_id).with_for_update()
    )).scalar_one_or_none()
    if _gate is None:
        raise HTTPException(status_code=404, detail="Gate not found")
    if _gate.status != "pending":
        raise HTTPException(
            status_code=409,
            detail={
                "code": "gate_already_resolved",
                "message": t("gates.toss_gate_already_resolved", resolved_locale),
            },
        )
    if _gate.designated_approver_id is None:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "no_designated_approver",
                "message": t("gates.toss_no_designated_approver", resolved_locale),
            },
        )

    from app.services.gate_service import resolve_designatable_gate_context
    ctx = await resolve_designatable_gate_context(session, _gate)
    if ctx is None:
        raise HTTPException(status_code=422, detail=t("gates.toss_unsupported_gate_type", resolved_locale))
    title, project_id, requester_id = ctx

    if resolved.id not in (requester_id, _gate.designated_approver_id):
        raise HTTPException(status_code=403, detail=t("gates.toss_requester_or_designated_only", resolved_locale))

    # story #3001 정책 집행 — 대상 conversation에 designated 본인이 참여자여야 한다(카드=
    # 지정 라인 전용, 임의 방으로 액션 링크가 새는 것 방지). org 스코프도 함께 강제.
    from app.models.conversation import Conversation, ConversationParticipant
    target_conv = (await session.execute(
        select(Conversation).where(Conversation.id == body.target_conversation_id, Conversation.org_id == org_id)
    )).scalar_one_or_none()
    if target_conv is None:
        raise HTTPException(status_code=404, detail="Target conversation not found")
    participant = (await session.execute(
        select(ConversationParticipant.conversation_id).where(
            ConversationParticipant.conversation_id == body.target_conversation_id,
            ConversationParticipant.member_id == _gate.designated_approver_id,
        ).limit(1)
    )).first()
    if participant is None:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "target_approver_not_participant",
                "message": "대상 대화에 지정 결재자가 참여하고 있지 않습니다.",
            },
        )

    from app.services.approval_delivery import dispatch_approval_card_toss
    inserted = await dispatch_approval_card_toss(
        session, org_id=org_id, work_item_type=_gate.work_item_type, work_item_id=_gate.work_item_id,
        title=title, gate_id=_gate.id, designated_approver_id=_gate.designated_approver_id,
        target_conversation_id=body.target_conversation_id, tossed_by_id=resolved.id,
    )
    if inserted:
        from app.services.activity_log import ActivityLogService
        await ActivityLogService(session).record(
            org_id=org_id, action="gate_tossed", actor_id=resolved.id, actor_type="human",
            entity_type="gate", entity_id=_gate.id,
            context={"target_conversation_id": str(body.target_conversation_id)},
        )
    await session.commit()
    await session.refresh(_gate)

    if inserted:
        # best-effort — 기존 사본 보유자 전체에 다방 동기 반영(브로드캐스트 실패가 토스
        # 자체 — 위 commit으로 이미 확정된 카드 삽입+감사기록 — 를 막지 않는다).
        from app.services.gate_service import dispatch_gate_toss
        await dispatch_gate_toss(
            session, _gate, target_conversation_id=body.target_conversation_id, tossed_by_id=resolved.id,
        )

    return GateTossResponse(**(await to_gate_response(session, org_id, _gate)).model_dump(), inserted=inserted)


class GateReassignRequest(BaseModel):
    new_approver_id: uuid.UUID
    old_approver_id: uuid.UUID | None = None  # approver row 여러 개면 지정(1개면 생략)
    reason: str | None = None


class GateApproverResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    approver_member_id: uuid.UUID
    approver_member_type: str
    status: str
    kind: str
    blocking: bool
    reassigned_from_member_id: uuid.UUID | None = None
    original_approver_member_id: uuid.UUID | None = None
    # ⭐S32: "재지정됨 · {admin} · {시각}" 출처(마이그0·신규 컬럼 아님). reassign 이벤트
    # (WorkflowLineStepRunEvent approver_reassigned)서 최신 actor/time enrich. 재지정 안 됐으면 None.
    reassigned_by_member_id: uuid.UUID | None = None
    reassigned_at: datetime | None = None


async def _enrich_approvers(session, org_id, rows) -> list[GateApproverResponse]:
    """approver row → response. 재지정된 row 는 최신 approver_reassigned 이벤트서 reassigned_by/at enrich
    (FE "재지정됨 · admin · 시각" 렌더용·마이그0·이벤트가 메타 SSOT)."""
    from app.models.workflow_line import WorkflowLineStepRunEvent
    out = []
    for r in rows:
        resp = GateApproverResponse.model_validate(r)
        if r.reassigned_from_member_id is not None:
            ev = (await session.execute(
                select(WorkflowLineStepRunEvent).where(
                    WorkflowLineStepRunEvent.org_id == org_id,
                    WorkflowLineStepRunEvent.step_run_id == r.step_run_id,
                    WorkflowLineStepRunEvent.event_type == "approver_reassigned",
                    WorkflowLineStepRunEvent.target_member_id == r.approver_member_id,
                ).order_by(WorkflowLineStepRunEvent.created_at.desc()).limit(1)
            )).scalar_one_or_none()
            if ev is not None:
                resp.reassigned_by_member_id = ev.actor_member_id
                resp.reassigned_at = ev.created_at
        out.append(resp)
    return out


@router.get("/{id}/approvers", response_model=list[GateApproverResponse])
async def list_gate_approvers_endpoint(
    id: uuid.UUID,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth=Depends(get_current_user),
    locale: str | None = None,
    accept_language: str | None = Header(None, alias="Accept-Language"),
) -> list[GateApproverResponse]:
    """story #3793 — 라우트 진입점, `Header()` DI 마커는 여기서만 받는다(까심 QA CI FAILURE
    원칙). 직접-호출 테스트는 `_list_gate_approvers_endpoint`를 불러야 한다."""
    return await _list_gate_approvers_endpoint(
        id, session=session, org_id=org_id, auth=auth,
        resolved_locale=resolve_locale_from_request(locale, accept_language),
    )


async def _list_gate_approvers_endpoint(
    id: uuid.UUID,
    *,
    session: AsyncSession,
    org_id: uuid.UUID,
    auth,
    resolved_locale: str,
) -> list[GateApproverResponse]:
    """⭐S32 FE conditional-display: gate approver row 목록(있으면 parallel gate→reassign 노출·없으면
    단일/merge gate→reassign 미노출로 422 원천차단). admin-only. 재지정 메타(누가/언제) enrich."""
    await _require_gate_admin(session, auth, org_id, resolved_locale)
    from app.services.workflow_parallel_approval import list_gate_approvers
    rows = await list_gate_approvers(session, org_id, id)
    return await _enrich_approvers(session, org_id, rows)


@router.post("/{id}/reassign", response_model=list[GateApproverResponse])
async def reassign_gate_approver_endpoint(
    id: uuid.UUID,
    body: GateReassignRequest,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth=Depends(get_current_user),
    locale: str | None = None,
    accept_language: str | None = Header(None, alias="Accept-Language"),
) -> list[GateApproverResponse]:
    """story #3793 — 라우트 진입점, `Header()` DI 마커는 여기서만 받는다(까심 QA CI FAILURE
    원칙). 직접-호출 테스트는 `_reassign_gate_approver_endpoint`를 불러야 한다."""
    return await _reassign_gate_approver_endpoint(
        id, body, session=session, org_id=org_id, auth=auth,
        resolved_locale=resolve_locale_from_request(locale, accept_language),
    )


async def _reassign_gate_approver_endpoint(
    id: uuid.UUID,
    body: GateReassignRequest,
    *,
    session: AsyncSession,
    org_id: uuid.UUID,
    auth,
    resolved_locale: str,
) -> list[GateApproverResponse]:
    """⭐S32 admin reassign: parallel gate 의 pending 결재자 교체. admin-only·reassigner=인증 caller 강제
    (body 신뢰 0·S23 RC①). gate.status 불변(pending 유지·재결정 대상). 단일 gate=422(parallel 전용)."""
    resolved = await _require_gate_admin(session, auth, org_id, resolved_locale)
    from app.services.workflow_parallel_approval import list_gate_approvers, reassign_approver
    try:
        await reassign_approver(
            session, org_id, id, body.new_approver_id, resolved.id,
            old_approver_id=body.old_approver_id, reason=body.reason,
        )
        rows = await list_gate_approvers(session, org_id, id)  # 갱신된 approver 목록 반환
        result = await _enrich_approvers(session, org_id, rows)  # reassigned_by/at enrich(이벤트서)
        await session.commit()
        return result
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))


class WorkflowStepApprovalDecisionRequest(BaseModel):
    decision: Literal["approved", "rejected", "abstained"]
    note: str | None = None

    @model_validator(mode="after")
    def _note_required_for_reject(self) -> "WorkflowStepApprovalDecisionRequest":
        # pydantic v2는 필드가 기본값(None)을 쓴 경우 field_validator를 건너뛴다
        # (validate_default=False가 기본) — model_validator(mode="after")는 기본값
        # 사용 여부와 무관하게 항상 실행돼 이 필수-사유 계약을 확실히 강제한다.
        if self.decision == "rejected" and not (self.note and self.note.strip()):
            raise ValueError("note is required when decision is 'rejected'")
        return self


class WorkflowStepApprovalDecisionResponse(BaseModel):
    approver: GateApproverResponse
    outcome: str
    skipped: bool
    approved: int
    rejected: int
    total_blocking: int


@router.post(
    "/{id}/approvers/{approval_id}/decision",
    response_model=WorkflowStepApprovalDecisionResponse,
)
async def decide_gate_approval_endpoint(
    id: uuid.UUID,
    approval_id: uuid.UUID,
    body: WorkflowStepApprovalDecisionRequest,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth=Depends(get_current_user),
    locale: str | None = None,
    accept_language: str | None = Header(None, alias="Accept-Language"),
) -> WorkflowStepApprovalDecisionResponse:
    """story #3793 — 라우트 진입점, `Header()` DI 마커는 여기서만 받는다(까심 QA CI FAILURE
    원칙). 직접-호출 테스트는 `_decide_gate_approval_endpoint`를 불러야 한다."""
    return await _decide_gate_approval_endpoint(
        id, approval_id, body, session=session, org_id=org_id, auth=auth,
        resolved_locale=resolve_locale_from_request(locale, accept_language),
    )


async def _decide_gate_approval_endpoint(
    id: uuid.UUID,
    approval_id: uuid.UUID,
    body: WorkflowStepApprovalDecisionRequest,
    *,
    session: AsyncSession,
    org_id: uuid.UUID,
    auth,
    resolved_locale: str,
) -> WorkflowStepApprovalDecisionResponse:
    """story #3965 — 「오늘」 needs_me의 ``workflow_step`` 소스(today_service.py::
    _needs_me_from_workflow_steps)가 이미 노출 중인 ``actions: ["approve","request_changes","hold"]``
    가운데 approve/request_changes(reject)를 실제로 처리하는 첫 HTTP 엔드포인트 — story #3334가
    미리 심어둔 ``record_parallel_decision``(그때까지 라우터 미배선·자기 테스트만 호출자였음)을
    처음 배선한다. hold는 기존 gate-level ``/{id}/hold``(admin 전용)가 그대로 담당해 이 카드
    범위 밖(approver row 단위가 아니라 gate 단위 동작이라 다른 축).

    resolver=인증 caller 본인 강제(body 신뢰 0 — 대리결정 없음). ``record_parallel_decision``
    자체가 resolver_id != approver_member_id 면 SelfApprovalError(SoD)를 던져 "본인 row만
    해소"를 서비스층에서 이미 강제하지만, 그 함수는 org_id 스코프를 받지 않아(PK 단독 조회) 이
    라우트가 org/gate 스코프 404 가드를 앞단에 추가로 건다(cross-org IDOR 차단)."""
    resolved = await resolve_member(auth, org_id, session)
    appr = (await session.execute(
        select(WorkflowLineStepApproval).where(
            WorkflowLineStepApproval.id == approval_id,
            WorkflowLineStepApproval.org_id == org_id,
            WorkflowLineStepApproval.gate_id == id,
        )
    )).scalar_one_or_none()
    if appr is None:
        raise HTTPException(status_code=404, detail=t("gates.approval_not_found", resolved_locale))

    from app.services.workflow_parallel_approval import SelfApprovalError, record_parallel_decision
    try:
        result = await record_parallel_decision(
            session, approval_id, body.decision, resolver_id=resolved.id, note=body.note,
        )
    except SelfApprovalError:
        raise HTTPException(status_code=403, detail=t("gates.approval_self_or_foreign", resolved_locale))
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))

    await session.commit()
    await session.refresh(appr)
    enriched = await _enrich_approvers(session, org_id, [appr])
    return WorkflowStepApprovalDecisionResponse(
        approver=enriched[0],
        outcome=result["outcome"],
        skipped=result["skipped"],
        approved=result["approved"],
        rejected=result["rejected"],
        total_blocking=result["total_blocking"],
    )


class GateOverrideRequest(BaseModel):
    decision: str  # "approved" | "rejected" (owner 강제 결정)
    reason: str    # 필수 — 가장 민감한 액션이라 사유 의무


async def _require_gate_owner(session, auth, org_id, resolved_locale: str):
    """⭐S33 owner-only 게이팅 — override 는 SoD 우회=가장 강력이라 admin(void/hold/reassign)보다 좁게
    owner 만. is_org_owner(role='owner') canonical. 반환 resolved(owner_id=인증 caller 강제·body 신뢰 0).

    story #3793 — `resolved_locale`은 호출부(라우트 진입점)가 이미 `resolve_locale_from_request()`
    로 풀어 넘기는 plain str(Header() DI 마커 없음, 까심 QA CI FAILURE 원칙)."""
    resolved = await resolve_member(auth, org_id, session)
    if not await is_org_owner(session, uuid.UUID(auth.user_id), org_id):
        raise HTTPException(status_code=403, detail=t("gates.require_owner_generic", resolved_locale))
    return resolved


@router.post("/{id}/override", response_model=GateResponse)
async def override_gate_endpoint(
    id: uuid.UUID,
    body: GateOverrideRequest,
    background_tasks: BackgroundTasks,
    session: AsyncSession = Depends(get_db),
    org_id: uuid.UUID = Depends(get_verified_org_id),
    auth=Depends(get_current_user),
    locale: str | None = None,
    accept_language: str | None = Header(None, alias="Accept-Language"),
) -> GateResponse:
    """story #3793 — 라우트 진입점, `Header()` DI 마커는 여기서만 받는다(까심 QA CI FAILURE
    원칙). 직접-호출 테스트는 `_override_gate_endpoint`를 불러야 한다."""
    return await _override_gate_endpoint(
        id, body, background_tasks, session=session, org_id=org_id, auth=auth,
        resolved_locale=resolve_locale_from_request(locale, accept_language),
    )


async def _override_gate_endpoint(
    id: uuid.UUID,
    body: GateOverrideRequest,
    background_tasks: BackgroundTasks,
    *,
    session: AsyncSession,
    org_id: uuid.UUID,
    auth,
    resolved_locale: str,
) -> GateResponse:
    """⭐S33 owner force-resolve: owner 가 막힌/긴급 gate 를 강제 결정(approved|rejected). owner-only·
    reason 필수·owner_id=인증 caller 강제(S23 RC①)·정상 결재(quorum/SoD) 우회. 가장 민감한 액션."""
    from app.services.gate_service import override_gate
    resolved = await _require_gate_owner(session, auth, org_id, resolved_locale)
    _pending_deliveries: list[dict] = []
    try:
        gate = await override_gate(
            session, org_id, id, resolved.id, body.decision, body.reason,
            pending_deliveries=_pending_deliveries,
        )
        await session.commit()
        # story #2459 회귀 동형 방어(2026-08-05): commit 後 model_validate 前 명시 refresh.
        await session.refresh(gate)
        # ccbcd9da(A-1): override 도 transition_gate 재사용 경로라 동일하게 doc/epic wake 대상.
        _schedule_pending_deliveries(background_tasks, _pending_deliveries)
        # story #4192(까디르 4583 P1) — 레시피 회차 자사 블로그 초안 게이트면 서버 발행은 **승인 커밋 뒤** 격리 세션에서
        # (발행 실패가 승인을 지우지 않게). 이 세션은 안 쓴다 — 결과(publish_outcome)만 다시 읽어 응답에 싣는다.
        if gate.status == "approved":
            from app.services.site_posts import publish_recipe_approved_hosted_site_draft_after_commit

            await publish_recipe_approved_hosted_site_draft_after_commit(
                session, gate_id=gate.id, resolver_id=gate.resolver_id,
            )
            await session.refresh(gate)
        return await to_gate_response(session, org_id, gate)
    except RecipeReviewedDraftChangedError as e:
        # story #4190 — override는 «본 초안 버전»을 싣지 않는다(UI 호출처 없음). 승인 화면에 초안이 있는 레시피 발행
        # 게이트를 override로 승인하면 fail-closed 409(예전 그대로면 새 예외가 ValueError 밖이라 500이었다).
        raise HTTPException(
            status_code=409,
            detail=human_error(
                "gate_draft_changed", "Recipe publish approval must carry the reviewed draft — use the approval screen.",
                user_message=t("gates.draft_changed", resolved_locale),
                current_draft_id=str(e.current_draft_id), current_version=e.current_version,
            ),
        ) from e
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
