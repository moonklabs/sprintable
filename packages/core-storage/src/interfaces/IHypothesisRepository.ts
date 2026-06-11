import type { PaginationOptions } from '../types';
import type { RepositoryScopeContext } from './IEpicRepository';
import type { MetricDefinition } from './outcome';

// §2.5 상태 7종 (BE HYPOTHESIS_STATUSES와 동기).
export const HYPOTHESIS_STATUSES = [
  'proposed', 'active', 'measuring', 'verified', 'falsified', 'killed', 'archived',
] as const;
export type HypothesisStatus = (typeof HYPOTHESIS_STATUSES)[number];

export interface Hypothesis {
  id: string;
  org_id: string;
  project_id: string;
  owner_member_id: string;
  created_by_member_id: string | null;
  confirmed_by_member_id: string | null;
  statement: string;
  metric_definition: MetricDefinition;
  measure_after: string;
  status: HypothesisStatus;
  outcome_result: Record<string, unknown> | null;
  confidence: number | null;
  source_type: string | null;
  source_id: string | null;
  human_accounting: Record<string, unknown>;
  gate_contract: Record<string, unknown>;
  epic_ids: string[];
  story_ids: string[];
  created_at: string;
  updated_at: string;
}

export interface CreateHypothesisInput {
  project_id: string;
  statement: string;
  metric_definition: MetricDefinition;
  measure_after: string;
  owner_member_id?: string | null;
  status?: HypothesisStatus;
  epic_ids?: string[];
  story_ids?: string[];
  source_type?: string | null;
  source_id?: string | null;
  draft_metadata?: Record<string, unknown> | null;
}

/**
 * §3.5 update allowlist — `status`/`outcome_result`는 transition endpoint 전용이라
 * 절대 포함하지 않는다. 이 타입·shared `updateHypothesisSchema`·`HypothesisService`의
 * ALLOWED_FIELDS 세 곳이 1:1로 동기화되어야 silent strip 함정이 없다 (E1-S7 AC①).
 */
export interface UpdateHypothesisInput {
  statement?: string;
  metric_definition?: MetricDefinition;
  measure_after?: string;
  owner_member_id?: string | null;
  confidence?: number | null;
  draft_metadata?: Record<string, unknown> | null;
  human_accounting?: Record<string, unknown> | null;
}

export interface HypothesisTransitionInput {
  status: HypothesisStatus;
  note?: string | null;
  outcome_result?: Record<string, unknown> | null;
}

export interface HypothesisLinkInput {
  epic_ids?: string[];
  story_ids?: string[];
  link_type?: string | null;
}

export interface HypothesisUnlinkInput {
  epic_ids?: string[];
  story_ids?: string[];
}

export interface HypothesisDraftInput {
  project_id: string;
  source_type: string;
  source_id: string;
  context?: Record<string, unknown> | null;
}

export interface HypothesisDraft {
  statement: string;
  metric_definition: MetricDefinition;
  measure_after: string;
  source_snapshot: Record<string, unknown>;
  confidence: number | null;
  requires_confirmation: boolean;
  /** persist=true(=hypothesis row 생성)일 때만 채워진다. */
  hypothesis: Hypothesis | null;
}

export interface HypothesisListFilters extends PaginationOptions {
  project_id: string;
  epic_id?: string | null;
  story_id?: string | null;
  status?: HypothesisStatus | null;
  owner_member_id?: string | null;
}

export interface IHypothesisRepository {
  list(filters: HypothesisListFilters): Promise<Hypothesis[]>;
  create(input: CreateHypothesisInput): Promise<Hypothesis>;
  getById(id: string, scope?: RepositoryScopeContext): Promise<Hypothesis>;
  update(id: string, input: UpdateHypothesisInput): Promise<Hypothesis>;
  transition(id: string, input: HypothesisTransitionInput): Promise<Hypothesis>;
  link(id: string, input: HypothesisLinkInput): Promise<Hypothesis>;
  unlink(id: string, input: HypothesisUnlinkInput): Promise<Hypothesis>;
  archive(id: string): Promise<void>;
  draft(input: HypothesisDraftInput): Promise<HypothesisDraft>;
}
