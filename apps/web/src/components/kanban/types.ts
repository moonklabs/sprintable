import type { MetricDefinition, OutcomeResult } from '@sprintable/core-storage';
import type { SendAttachment } from '@/hooks/use-chat-sse';

export interface KanbanStory {
  id: string;
  // story 9ac9b80f: 프로젝트 내 사람-읽는 순차 #N. 서버 채번, 백필 전 구스토리는 null 가능.
  story_number?: number | null;
  title: string;
  status: string;
  priority: string;
  story_points: number | null;
  assignee_id: string | null;
  assignee_ids?: string[];
  epic_id: string | null;
  sprint_id: string | null;
  description: string | null;
  acceptance_criteria: string | null;
  attachments: SendAttachment[] | null;
  position: number | null;
  success_hypothesis: string | null;
  metric_definition: MetricDefinition | null;
  measure_after: string | null;
  outcome_status: 'n_a' | 'pending' | 'hit' | 'miss' | null;
  outcome_result: OutcomeResult | null;
  blocked_by?: string[];
  labels?: { id: string; name: string; color: string | null }[];
  gates?: { id: string; gate_type: string; status: string }[];
  // E-VERIFY V0-S1/S2: 실증-done 신뢰 신호. true면 근거 有, null이면 완전 무표시.
  // has_evidence는 BE 하위호환용으로 유지(self_reported와 동일 값) — 신규 소비처는 아래 2신호 사용.
  has_evidence?: boolean | null;
  // E-VERIFY P0-04(claimed-vs-verified-spec-handoff §3, PR #2069) — has_evidence를 대체하는
  // 2신호. self_reported=agent 자가보고(증거 첨부)·human_verified=책임자 gate 승인(who/when 동봉).
  self_reported?: boolean | null;
  human_verified?: boolean | null;
  human_verified_by?: string | null;
  human_verified_at?: string | null;
}

export interface GateItem {
  id: string;
  // story #1960(P2-S4): 결재함 통합 큐가 org 이름 표시에 사용(BE GateResponse엔 항상 존재하는
  // 필드인데 이 타입에 이제껏 누락돼 있었음 — additive, 기존 소비부 무영향).
  org_id?: string;
  work_item_id: string;
  work_item_type: string;
  gate_type: string;
  status: string;
  resolver_id: string | null;
  resolved_at: string | null;
  resolution_note: string | null;
  held_until?: string | null; // E-DG S31: 보류(hold) 만료(무기한=null·시한부=ISO). 디디 BE 병렬·additive.
  // E-DG S33: owner 결재 강제(override) 메타(gate_overridden 이벤트 enrich·S32 reassign 패턴 동형). 디디 BE #1645 design-first·additive·머지 후 정합.
  overridden_by_member_id?: string | null;
  overridden_at?: string | null;
  bypassed_sod?: boolean | null;
  neutral_facts: Record<string, unknown> | null;
  // doc-side 결재(24f5ea18): doc gate(work_item_type='doc' / gate_type='doc_approval')일 때 BE가
  // 대상 문서 요약을 동봉(디디 BE PR #1742·additive). non-doc/삭제된 문서 gate는 null → `?.` 가드 폴백.
  // story #1970(P1a-S4): GET /{id} 단건 조회에서 story/task 타입까지 확장 — 그 타입들은 slug
  // 개념 자체가 없어 항상 null(BE WorkItemSummary.slug: str | None 그대로 반영).
  work_item_summary?: { title: string; slug: string | null } | null;
  // doc-gate in-doc 결재 자격(89484c8c): doc_approval gate 한정·per-caller·rule A(human+has_project_access+not-author).
  // BE가 gates 리스트 응답 각 gate에 동봉(additive). undefined/false → in-doc 승인/반려 버튼 미노출(fail-closed). 실 authz=BE 403.
  can_approve?: boolean;
  // story #1972(P1a-S4): 위험도 UX 등급 파생 결과("low"|"high") — BE gate_service.derive_risk_grade()
  // 가 OrgGatePolicy.posture+gate_type에서 순수 파생해 list/단건 조회 둘 다 동봉(additive). null/undefined는
  // BE가 아직 못 보낸 구버전 응답 대비 방어적 폴백일 뿐 — 정상 응답은 항상 "low"|"high" 둘 중 하나.
  risk_grade?: 'low' | 'high' | null;
  // H1-S3 머지 verdict 게이트 evidence(GateResponse·additive·하위호환 default). null≠0(AC③).
  requires_human?: boolean;
  evidence_status?: string | null; // sufficient | blocked | insufficient
  decision_basis?: string | null; // 사람 reason
  auto_decision_reason?: string | null; // auto_merge | ask_human | block (raw decision)
  created_at: string;
  updated_at: string;
  // story #2054: 결재함 통합 인박스(`/api/gates/inbox`)에서 Gate/HitlRequest 두 출처를 구분하는
  // discriminator(BE GateResponse.source, additive). 단독 엔드포인트(`/api/gates` 등)는 이 필드가
  // 응답에 없을 수 있어 optional — 그 경로 소비부는 항상 gate이므로 값이 없으면 'gate'로 취급한다.
  source?: 'gate';
}

// story #2054: 결재함 통합 인박스에서 HitlRequest(gate_approval park) 항목 최소 스키마(BE
// HitlInboxItem 미러) — Gate와 다른 API로 승인/거부(`PATCH /api/v1/hitl-requests/{id}`)하므로
// GateItem을 재사용하지 않고 별도 타입으로 둔다. `source`로 FE가 렌더/액션을 분기한다.
export interface HitlInboxItem {
  source: 'hitl';
  id: string;
  request_type: string;
  title: string;
  prompt: string;
  status: string;
  requires_human: boolean;
  work_item_id: string | null;
  work_type: string | null;
  created_at: string;
  expires_at: string | null;
}

export type GateInboxItem = GateItem | HitlInboxItem;

// E-DG S32: gate approver row(GateApproverResponse 미러). reassign 재지정 메타 enrich(이벤트서·null=미재지정).
export interface GateApproverItem {
  id: string;
  approver_member_id: string;
  approver_member_type: string;
  status: string;
  kind: string;
  blocking: boolean;
  reassigned_from_member_id?: string | null;
  original_approver_member_id?: string | null;
  reassigned_by_member_id?: string | null;
  reassigned_at?: string | null;
}

// E-DG S11: workflow-line status read model — BE services/workflow_line_status.py 미러(read-only).
// 데이터소스 GET /api/v2/stories/{id}/workflow-line/status. 필드명·optionality는 BE StepRunView/ApproverView/LastEventView와 1:1.
// datetime은 BE에서 ISO 문자열로 직렬화 → string | null.
export interface WorkflowLineH1Evidence {
  requires_human: boolean;
  evidence_status: string | null; // sufficient | blocked | insufficient
  decision_basis: string | null; // 사람 reason
  auto_decision_reason: string | null; // auto_merge | ask_human | block
  gate_status: string;
}

export interface WorkflowLineApprover {
  member_id: string;
  member_type: string;
  kind: string; // approver | consult | ... (blocking 만 quorum 계산에 듦)
  blocking: boolean;
  status: string; // approved | pending | rejected ...
  role_key: string | null;
  resolved_at: string | null;
}

export interface WorkflowLineLastEvent {
  id: string;
  event_type: string;
  recipient_seq: number | null;
  status: string;
  created_at: string | null;
}

// 활성 step_run(StepRunView). engine_degraded/grandfathered 는 boolean flag로 배지 분기,
// 사용자 문구는 BE 제공 observability_note 사용(하드코딩 금지·null/빈값 시 FE 중립 폴백). [S11 갭1]
export interface WorkflowLineStepRun {
  id: string;
  status: string;
  from_status: string | null;
  to_status: string;
  mode: string;
  routing_decision: string | null;
  routing_reason: string | null;
  blocking_reason: string | null;
  gate_id: string | null;
  delivery_status: string;
  delivery_error: string | null;
  correlation_id: string;
  sla_due_at: string | null;
  started_at: string | null;
  engine_degraded: boolean;
  grandfathered: boolean;
  observability_note: string | null;
  h1_evidence: WorkflowLineH1Evidence | null;
  approvers: WorkflowLineApprover[];
  last_event: WorkflowLineLastEvent | null;
  // E-DG S12 갭1: 막힌 recipient agent(id/name). 디디 BE status 노출 시 채워짐(additive·forward-compat).
  // ⚠️ 정확 필드명은 디디 BE 계약 확정 후 정합 필요(provisional). 미노출 시 FE "에이전트" 폴백.
  recipient_agent?: { id: string; name: string } | null;
}

export interface WorkflowLineHistoryItem {
  id: string;
  status: string;
  from_status: string | null;
  to_status: string;
  mode: string;
  routing_decision: string | null;
  resolved_at: string | null;
  correlation_id: string;
}

export interface WorkflowLineStatus {
  story_id: string;
  has_active: boolean;
  active: WorkflowLineStepRun | null;
  history: WorkflowLineHistoryItem[];
}

// E-DG S11 ① — 보드 카드 badge용 경량 요약(BE LineStatusSummary·배치 `?ids=` 1쿼리·N+1 0).
// StepRunView 아님(observability_note·approvers 등 미포함 — 카드 badge는 flag+status만 필요).
export interface LineStatusSummary {
  story_id: string;
  has_active: boolean;
  mode: string | null;
  status: string | null;
  engine_degraded: boolean;
  grandfathered: boolean;
  handoff_stuck: boolean; // = delivery_status === 'timed_out'(S8 watchdog)
  delivery_status: string | null;
}

export interface DependencyEdge {
  id: string;
  from_id: string;
  to_id: string;
  dep_type: 'blocks' | 'depends_on';
}

export interface KanbanEpic {
  id: string;
  title: string;
}

export interface KanbanSprint {
  id: string;
  title: string;
  status: string;
}

export interface KanbanMember {
  id: string;
  name: string;
  type: string;
}

import { VALID_STORY_TRANSITIONS } from '@sprintable/shared';

// 정공법 A(c1cd484b): done 포함 전 전이 허용 — shared SSOT 그대로 사용.
// 비정상 점프는 FE 하드블록 아닌 BE 위반(warn) 기록·표시로 처리(애자일 가치 보존·done reopen 허용).
export const VALID_TRANSITIONS: Record<string, string[]> = {
  ...VALID_STORY_TRANSITIONS,
};

export const COLUMNS = [
  { id: 'backlog', i18nKey: 'backlog' },
  { id: 'ready-for-dev', i18nKey: 'readyForDev' },
  { id: 'in-progress', i18nKey: 'inProgress' },
  { id: 'in-review', i18nKey: 'inReview' },
  { id: 'done', i18nKey: 'done' },
] as const;

export type ColumnId = (typeof COLUMNS)[number]['id'];

// story #2133: assignee_id(단일)/assignee_ids(배열) 이중표현이 생산처마다 손으로
// 맞춰지다 하루 2회(#2384·#2130) 동일 클래스로 어긋났다. assignee_ids를 단일 SSOT로 두고
// assignee_id는 항상 그 파생값으로만 존재하게 해 "한쪽만 갱신" 자체를 불가능하게 만든다.
export interface AssigneePatchInput {
  assignee_id?: string | null;
  assignee_ids?: string[] | null;
}

export interface AssigneePatch {
  assignee_id: string | null;
  assignee_ids: string[];
}

export function normalizeAssigneePatch(payload: AssigneePatchInput): AssigneePatch {
  if (payload.assignee_ids !== undefined && payload.assignee_ids !== null) {
    const ids = payload.assignee_ids.filter((id): id is string => Boolean(id));
    return { assignee_ids: ids, assignee_id: ids[0] ?? null };
  }
  const id = payload.assignee_id ?? null;
  return { assignee_id: id, assignee_ids: id ? [id] : [] };
}
