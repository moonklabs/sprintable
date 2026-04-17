/**
 * API response types
 */

export interface ApiResponse<T> {
  data: T;
  error: null;
  meta: ApiMeta | null;
}

export interface ApiErrorResponse {
  data: null;
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
  meta: null;
}

export interface ApiMeta {
  total?: number;
  page?: number;
  limit?: number;
  hasMore?: boolean;
  nextCursor?: string;
  [key: string]: unknown;
}

/**
 * Story types
 */

export type StoryStatus =
  | 'backlog'
  | 'ready-for-dev'
  | 'in-progress'
  | 'in-review'
  | 'done';

export interface Task {
  id: string;
  story_id: string;
  title: string;
  status?: string;
  assignee_id?: string | null;
  story_points?: number | null;
  created_at: string;
  updated_at: string;
}

export interface Story {
  id: string;
  org_id: string;
  title: string;
  description?: string;
  status: StoryStatus;
  project_id: string;
  epic_id?: string;
  sprint_id?: string;
  assignee_id?: string | null;
  story_points?: number;
  priority: string;
  meeting_id?: string | null;
  created_at: string;
  updated_at: string;
  tasks: Task[];
}

/**
 * Memo types
 */

export type MemoStatus = 'open' | 'resolved';

export interface Memo {
  id: string;
  title?: string | null;
  content: string;
  status: MemoStatus;
  memo_type: string;
  project_id: string;
  created_by: string;
  assigned_to?: string | null;
  created_at: string;
  updated_at: string;
  replies?: MemoReply[];
  reply_count: number;
  latest_reply_at: string | null;
  project_name: string | null;
  timeline: Array<{ label: string; at: string; by?: string }>;
  linked_docs: Array<{ id: string; title: string; slug?: string }>;
  readers: Array<{ id: string; name: string; read_at: string }>;
  supersedes_chain: unknown[];
}

export interface MemoSummary {
  id: string;
  project_id: string;
  title: string | null;
  content: string;
  status: MemoStatus;
  memo_type: string;
  created_by: string;
  assigned_to: string | null;
  created_at: string;
  reply_count: number;
  latest_reply_at: string | null;
  project_name: string | null;
  readers: Array<{ id: string; name: string; read_at: string }>;
}

export interface MemoReply {
  id: string;
  memo_id: string;
  content: string;
  created_by: string;
  review_type?: 'comment' | 'approve' | 'request_changes';
  created_at: string;
}

/**
 * Request types
 */

export interface MemoListFilters {
  project_id?: string;
  assigned_to?: string;
  status?: MemoStatus;
  q?: string;
  limit?: number;
  cursor?: string;
}

export interface CreateMemoReplyInput {
  content: string;
}
