// E-MODERN CC-FE — 커맨드 센터 BE 계약 타입(CC-BE.1 PR #1675 router shape 1:1·Bot-L.2 link_source 교훈).

export type Priority = 'danger' | 'warn' | 'info';

export interface QueueItem {
  // ⛔⛔ 세 목록이 항상 같이 움직여야 한다(PO 지적 2026-07-29 — my_blockers 누락 버그의
  // 근본): ①여기(BE `command_center.py`가 실제로 내보내는 `type` 값 전수) ②action-zone.tsx
  // `RENDERABLE_TYPES` ③action-zone.tsx `QueueRow`의 렌더 분기. 하나를 늘리면 셋 다 고친다
  // — 안 그러면 splitRenderableQueue가 새 타입을 "표시할 수 없음"으로 조용히 떨어뜨린다.
  // (진짜 재발 방지는 BE↔FE 타입 집합 parity 테스트 — PO가 별도 스토리로 세움. 이 코멘트는
  // 그 전까지의 "적어 둔 것" 역할.)
  //
  // story #2288: 'my_blockers' 추가 — BE가 이미 내보내는데 타입에 없어 QueueRow가
  // review_merge로 오인 렌더하던 것을 바로잡는다.
  // 'waiting_on_others'(#2650, BE 명세4): 「내 것인데 남이 잡음」— priority 항상 'info',
  // action-zone.tsx에서 행동 큐와 별도 구역("기다리는 것")으로 렌더(버튼 없음).
  type: 'gate_approval' | 'review_merge' | 'my_blockers' | 'waiting_on_others';
  priority: Priority;
  title?: string | null; // review_merge만 top-level title(story 제목)
  // gate_approval:{gate_id,approval_group_id,kind,gate_type} / review_merge:{story_id,status} /
  // my_blockers:{blocker_story_id,blocked_story_id} /
  // waiting_on_others:{story_id,gate_type,approver_member_id} — BE가 story_id로 이미 dedupe.
  context: Record<string, unknown>;
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

// ⛔story #2338(2026-07-30) — 아래 다섯 shape은 command_center.py가 «이미» 실 객체로
// 보내고 있다(더 이상 PendingData 통짜 센티널이 아니다). risk.overdue만 여전히 BE가
// 리터럴 PendingData를 심어 보낸다(그 필드만 진짜 미구현) — 나머지는 전부 실측값이다.
// `isPending(ps.risk)`처럼 필드 «전체»에 옛 통짜-센티널 검사를 걸면 이 실 객체들과
// 절대 매치 안 돼 렌더 코드에 영원히 도달하지 못한다(이 스토리가 잡은 사고 그 자체).
export interface RiskMetrics {
  blocked: number; // ⛔#2224 판정: 되살리지 않는다(item_dependency 엣지 org 전체 0 — 상시 0).
  failed_runs: number; // ✅실측값 — 최근 7일 실패 agent_run 수.
  overdue: PendingData; // ⛔BE도 미구현(command_center.py가 리터럴 _PENDING을 심음) — FE로 못 고침.
}

export interface CycleTimeMetrics {
  avg_days: number | null; // 표본 0건이면 null(지어내지 않음).
  sample: number; // 최근 30일 done 전이 표본 수.
}

export interface ContributionMetrics {
  agent: number;
  human: number;
  unassigned: number;
}

export interface CostTrendPoint { date: string; cost_usd: number; tokens: number }

export interface CostTrendMetrics {
  points: CostTrendPoint[];
  total_cost_usd: number;
  delta_pct: number | null;
}

export interface FleetStatusBreakdown {
  online: number;
  offline: number;
  working: number;
}

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
  fleet: { total_agents: number; status_breakdown: PendingData | FleetStatusBreakdown };
  project_status: {
    epics: EpicProgress[];
    outcome: { hit: number; total: number };
    recent_changes: RecentChange[];
    risk: PendingData | RiskMetrics;
    cycle_time: PendingData | CycleTimeMetrics;
    contribution: PendingData | ContributionMetrics;
    cost_trend: PendingData | CostTrendMetrics;
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
