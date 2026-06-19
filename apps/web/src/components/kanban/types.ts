import type { MetricDefinition, OutcomeResult } from '@sprintable/core-storage';
import type { SendAttachment } from '@/hooks/use-chat-sse';

export interface KanbanStory {
  id: string;
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
}

export interface GateItem {
  id: string;
  work_item_id: string;
  work_item_type: string;
  gate_type: string;
  status: string;
  resolver_id: string | null;
  resolved_at: string | null;
  resolution_note: string | null;
  neutral_facts: Record<string, unknown> | null;
  // H1-S3 머지 verdict 게이트 evidence(GateResponse·additive·하위호환 default). null≠0(AC③).
  requires_human?: boolean;
  evidence_status?: string | null; // sufficient | blocked | insufficient
  decision_basis?: string | null; // 사람 reason
  auto_decision_reason?: string | null; // auto_merge | ask_human | block (raw decision)
  created_at: string;
  updated_at: string;
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

// done→in-review는 admin만 허용 (백엔드 검증) — 프론트엔드에서는 done 드래그 허용 안 함
export const VALID_TRANSITIONS: Record<string, string[]> = {
  ...VALID_STORY_TRANSITIONS,
  done: [],
};

export const COLUMNS = [
  { id: 'backlog', i18nKey: 'backlog' },
  { id: 'ready-for-dev', i18nKey: 'readyForDev' },
  { id: 'in-progress', i18nKey: 'inProgress' },
  { id: 'in-review', i18nKey: 'inReview' },
  { id: 'done', i18nKey: 'done' },
] as const;

export type ColumnId = (typeof COLUMNS)[number]['id'];
