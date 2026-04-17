export interface MemoReply {
  id: string;
  content: string;
  created_by: string | null;
  review_type: string;
  created_at: string;
}

export interface MemoLinkedDoc {
  id: string;
  title: string;
  slug?: string;
}

export interface MemoReader {
  id: string;
  name: string;
  read_at?: string;
}

export interface MemoTimelineItem {
  label: string;
  at: string;
  by?: string | null;
}

export interface MemoDetailState {
  id: string;
  project_id?: string;
  title: string | null;
  content: string;
  status: string;
  memo_type: string;
  created_at: string;
  updated_at?: string;
  assigned_to?: string | null;
  created_by?: string;
  resolved_by?: string | null;
  resolved_at?: string | null;
  reply_count?: number;
  latest_reply_at?: string | null;
  project_name?: string | null;
  replies?: MemoReply[];
  timeline?: MemoTimelineItem[];
  linked_docs?: MemoLinkedDoc[];
  readers?: MemoReader[];
  supersedes_chain?: unknown[];
}

export interface MemoSummaryState {
  id: string;
  title: string | null;
  content: string;
  status: string;
  memo_type: string;
  created_by: string;
  assigned_to: string | null;
  created_at: string;
  reply_count?: number;
  latest_reply_at?: string | null;
  project_name?: string | null;
  readers?: MemoReader[];
  unread_count?: number;
}

export function summarizeMemo(memo: MemoDetailState): MemoSummaryState {
  return {
    id: memo.id,
    title: memo.title,
    content: memo.content,
    status: memo.status,
    memo_type: memo.memo_type,
    created_by: memo.created_by ?? '',
    assigned_to: memo.assigned_to ?? null,
    created_at: memo.created_at,
    reply_count: memo.reply_count,
    latest_reply_at: memo.latest_reply_at,
    project_name: memo.project_name ?? null,
    readers: memo.readers,
  };
}

export function mergeMemoDetailIntoList<T extends MemoSummaryState>(memos: T[], memo: MemoDetailState): T[] {
  return memos.map((item) => {
    if (item.id !== memo.id) return item;
    const next = summarizeMemo(memo);
    return { ...item, ...next };
  });
}
