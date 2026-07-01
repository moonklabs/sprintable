export type StandupReviewType = 'comment' | 'approve' | 'request_changes';

export interface StandupMemberSummary {
  id: string;
  name: string;
  type: 'human' | 'agent';
}

// a9e67531: BE org-scope resolve된 plan story 요약(StandupEntryResponse.plan_stories·cross-board 포함).
export interface PlanStorySummary {
  id: string;
  title: string;
  status: string;
  priority?: string | null;
  project_id?: string | null;
  sprint_id?: string | null;
}

export interface StandupEntrySummary {
  id: string;
  author_id: string;
  date: string;
  done: string | null;
  plan: string | null;
  blockers: string | null;
  plan_story_ids: string[];
  // a9e67531: plan_story_ids의 org-scope resolve(cross-board 미노출 버그 근본 fix). 우선 렌더·legacy 미존재 시 id fallback.
  plan_stories?: PlanStorySummary[];
  updated_at?: string;
}

// 링크 스토리 표시 뷰: title/status 필수 + (scoped stories에 있으면) assignee/task 진척 enrich.
export type LinkedStoryView = { id: string; title: string; status: string; assignee_id?: string | null; assignee_name?: string | null; task_count?: number; done_task_count?: number };

export interface StandupStorySummary {
  id: string;
  title: string;
  status: string;
  assignee_id: string | null;
  assignee_name: string | null;
  task_count: number;
  done_task_count: number;
}

export interface StandupFeedbackSummary {
  id: string;
  standup_entry_id: string;
  feedback_by_id: string;
  review_type: StandupReviewType;
  feedback_text: string;
  created_at: string;
  updated_at: string;
}
