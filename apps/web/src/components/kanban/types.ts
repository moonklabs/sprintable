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
