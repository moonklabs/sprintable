import type { PaginationOptions } from '../types';
import type { RepositoryScopeContext } from './IEpicRepository';

export interface Memo {
  id: string;
  org_id: string;
  project_id: string;
  title: string | null;
  content: string;
  status: string;
  memo_type: string;
  assigned_to: string | null;
  supersedes_id: string | null;
  created_by: string;
  resolved_by: string | null;
  resolved_at: string | null;
  archived_at: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface CreateMemoInput {
  project_id: string;
  org_id: string;
  title?: string | null;
  content: string;
  memo_type?: string;
  assigned_to?: string | null;
  supersedes_id?: string | null;
  created_by: string;
  metadata?: Record<string, unknown>;
}

export interface UpdateMemoInput {
  title?: string | null;
  content?: string;
  status?: string;
  assigned_to?: string | null;
  metadata?: Record<string, unknown>;
}

export interface MemoReply {
  id: string;
  memo_id: string;
  content: string;
  created_by: string;
  review_type: string;
  created_at: string;
}

export interface MemoListFilters extends PaginationOptions {
  org_id?: string;
  project_id?: string;
  assigned_to?: string;
  created_by?: string;
  status?: string;
  q?: string;
  include_archived?: boolean;
}

// Memo has no generic delete; lifecycle is resolve/archive handled by MemoService
export interface IMemoRepository {
  create(input: CreateMemoInput): Promise<Memo>;
  list(filters: MemoListFilters): Promise<Memo[]>;
  getById(id: string, scope?: RepositoryScopeContext): Promise<Memo>;
  update(id: string, input: UpdateMemoInput): Promise<Memo>;
  resolve(id: string, resolvedBy: string): Promise<Memo>;
  archive(id: string, archivedAt: string | null): Promise<Memo>;
  addReply(input: { memo_id: string; content: string; created_by: string; review_type?: string }): Promise<MemoReply>;
  getReplies(memoId: string): Promise<MemoReply[]>;
}
