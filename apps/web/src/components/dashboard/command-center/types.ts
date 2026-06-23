// E-MODERN CC-FE — 커맨드 센터 BE 계약 타입(CC-BE.1 PR #1675 router shape 1:1·Bot-L.2 link_source 교훈).

export type Priority = 'danger' | 'warn' | 'info';

export interface QueueItem {
  type: 'gate_approval' | 'review_merge';
  priority: Priority;
  title?: string | null; // review_merge만 top-level title(story 제목)
  context: Record<string, unknown>; // gate_approval:{gate_id,approval_group_id,kind} / review_merge:{story_id,status}
  created_at: string | null;
}

export interface AttentionItem {
  type: 'agent_stuck';
  severity: string; // 'warn' 등
  auto_detected: boolean;
  entity_type: string;
  entity_id: string;
  gate_type: string | null;
  stuck_since: string | null;
}

export interface MyActions {
  action_queue: { scope: string; items: QueueItem[] }; // BE가 danger>warn>info 정렬 — FE 재정렬 X
  attention: { scope: string; items: AttentionItem[]; pending: string[] };
  is_clear: boolean;
}

/** pending_data 슬롯(CC-BE.2 채우면 자동 라이브). mock/0 절대 금지 — "준비중" 또는 omit. */
export interface PendingData { status: 'pending_data' }

export interface EpicProgress {
  epic_id: string;
  title: string;
  status: string;
  total: number;
  done: number;
  completion_pct: number;
}

export interface RecentChange {
  verb: string;
  object_type: string;
  object_id: string | null;
  occurred_at: string | null;
}

export interface Overview {
  scope: string;
  fleet: { total_agents: number; status_breakdown: PendingData | Record<string, unknown> };
  project_status: {
    epics: EpicProgress[];
    outcome: { hit: number; total: number };
    recent_changes: RecentChange[];
    risk: PendingData | Record<string, unknown>;
    cycle_time: PendingData | Record<string, unknown>;
    contribution: PendingData | Record<string, unknown>;
    cost_trend: PendingData | Record<string, unknown>;
  };
}

/** pending_data 판정(CC-BE.2 도착 시 shape 그대로 채워져 자동 라이브). */
export function isPending(x: unknown): x is PendingData {
  return !!x && typeof x === 'object' && (x as { status?: unknown }).status === 'pending_data';
}

/** 정체/경과 분(stuck_since·created_at 기준). 음수/무효는 0. */
export function minutesSince(iso: string | null): number {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.round((Date.now() - t) / 60000));
}
