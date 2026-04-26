import type { PaginationOptions } from '../types';

// Operator Cockpit Phase A — inbox_items repository interface
// See packages/db/supabase/migrations/20260426170000_inbox_items.sql
// See packages/shared/src/schemas/inbox.ts for Zod validation

export type InboxKind = 'approval' | 'decision' | 'blocker' | 'mention';
export type InboxPriority = 'high' | 'normal';
export type InboxState = 'pending' | 'resolved' | 'dismissed';
export type InboxSourceType = 'agent_run' | 'memo_mention' | 'webhook' | 'manual';
export type OutboxEventType = 'resolved' | 'dismissed' | 'reassigned';

export interface OriginNode {
  type: 'memo' | 'story' | 'run' | 'initiative';
  id: string;
}

export interface InboxOption {
  id: string; // uuid — stable reference for resolved_option_id
  label: string;
  kind: 'approve' | 'approve-alt' | 'reassign' | 'changes';
  consequence: string;
}

export interface InboxItem {
  id: string;
  org_id: string;
  project_id: string;
  assignee_member_id: string;
  kind: InboxKind;
  title: string;
  context: string | null;
  agent_summary: string | null;
  origin_chain: OriginNode[];
  options: InboxOption[];
  after_decision: string | null;
  from_agent_id: string | null;
  story_id: string | null;
  memo_id: string | null;
  priority: InboxPriority;
  state: InboxState;
  resolved_by: string | null;
  resolved_option_id: string | null;
  resolved_note: string | null;
  source_type: InboxSourceType;
  source_id: string;
  waiting_since: string;
  created_at: string;
  resolved_at: string | null;
}

export interface CreateInboxItemInput {
  org_id: string;
  project_id: string;
  assignee_member_id: string;
  kind: InboxKind;
  title: string;
  context?: string | null;
  agent_summary?: string | null;
  origin_chain?: OriginNode[];
  options?: InboxOption[];
  after_decision?: string | null;
  from_agent_id?: string | null;
  story_id?: string | null;
  memo_id?: string | null;
  priority?: InboxPriority;
  source_type: InboxSourceType;
  source_id: string;
}

export interface InboxListFilters extends PaginationOptions {
  org_id: string;
  project_id?: string;
  assignee_member_id?: string;
  kind?: InboxKind;
  state?: InboxState;
}

export interface ResolveInboxItemInput {
  resolved_by: string; // team_member id
  resolved_option_id: string;
  resolved_note?: string | null;
}

export interface DismissInboxItemInput {
  resolved_by: string;
  resolved_note?: string | null;
}

export interface ReassignInboxItemInput {
  new_assignee_member_id: string;
  reassigned_by: string;
}

export interface InboxItemCount {
  total: number;
  byKind: Record<InboxKind, number>;
}

export interface IInboxItemRepository {
  create(input: CreateInboxItemInput): Promise<InboxItem>;
  list(filters: InboxListFilters): Promise<InboxItem[]>;
  get(id: string, orgId: string): Promise<InboxItem | null>;
  count(filters: Omit<InboxListFilters, 'limit' | 'cursor'>): Promise<InboxItemCount>;
  resolve(id: string, orgId: string, input: ResolveInboxItemInput): Promise<InboxItem>;
  dismiss(id: string, orgId: string, input: DismissInboxItemInput): Promise<InboxItem>;
  reassign(id: string, orgId: string, input: ReassignInboxItemInput): Promise<InboxItem>;
}
