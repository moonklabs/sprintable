import type { RoadmapEpic } from '@/services/glance';

// story #2224(IA v2.2 §2·§3) — 좌 레인 표시 상한. OverviewZone(overview-zone.tsx)의 `epics.slice(0,6)`
// 관례와 일관되게 6으로 맞춘다(§7-1 노드 밀도 상한은 아직 미확定 — 이 값은 그 확定 전 임시 방어값).
export const FLOW_LANE_CAP = 6;

export interface FlowLaneRow {
  id: string;
  title: string;
  done: number;
  total: number;
  completionPct: number;
}

/** 로드맵 에픽 → 좌 레인 행. RoadmapEpic(services/glance.ts)이 EpicProgress 병합 결과라
 * done/total/completionPct 3개만 실재 — 진행 중·대기·막힘/멈춤 건수는 그 타입 자체에 필드가
 * 없어 파생 불가(화면이 "모름"으로 정직하게 말해야 하는 이유, IA §H-2). */
export function deriveFlowLaneRows(roadmap: RoadmapEpic[]): FlowLaneRow[] {
  return roadmap.slice(0, FLOW_LANE_CAP).map((e) => ({
    id: e.id,
    title: e.title,
    done: e.done,
    total: e.total,
    completionPct: e.completionPct,
  }));
}

/** done/total → "지나온 것" 폭 비율(0~100). total=0이면 0(시작 전 — 결핍 아님). */
export function derivePastRatio(done: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
}

export interface EdgeSummary {
  count: number;
  /** count=0일 때만 참 — "연결 0건"과 "아직 하나도 안 이어졌다"를 구분하는 문구 트리거. */
  isEmpty: boolean;
}

/** 간선 개수 → 요약. count는 항상 호출부가 실제 배열 길이로 넘긴다(리터럴 하드코딩 금지 —
 * PO 지시 2026-07-30: #2221 간선 데이터가 착지하면 이 값이 그 즉시 바뀌어야 한다). */
export function deriveEdgeSummary(count: number): EdgeSummary {
  return { count, isEmpty: count === 0 };
}

// 노드 틀(2026-07-30, PO 판정 — 계약 착지 前에도 틀은 세운다) — GET
// /api/v2/analytics/epic-flow-nodes?project_id=&epic_id=&upcoming_limit= 계약(까심 PR#2679)
// 그대로 반영. "지금" = in-progress+in-review(ready-for-dev 안 섞임, BE가 보장). "이어질" 정렬 =
// 막힘>ready-for-dev>나머지(그 안에서 최근순, BE 테스트로 고정 — FE가 재정렬하지 않는다).
// "지나온"은 스키마에 items 필드가 아예 없어(past: {total}만) 노드로 못 그린다 — "지나온 것을
// 노드로 안 그린다"가 타입이 강제하는 것이라 FE가 실수로 어길 수 없다.
export const UPCOMING_LIMIT = 15;

export interface EpicFlowNodeItem {
  id: string;
  story_number: number;
  title: string;
  status: string;
  assignee_id: string | null;
  updated_at: string;
}

export interface EpicFlowNodesResponse {
  epic_id: string;
  now: { total: number; items: EpicFlowNodeItem[] };
  upcoming: { total: number; items: EpicFlowNodeItem[] };
  past: { total: number };
}

export interface FlowNodeZones {
  nowItems: EpicFlowNodeItem[];
  nowTotal: number;
  upcomingItems: EpicFlowNodeItem[];
  upcomingTotal: number;
  upcomingShown: number;
  pastTotal: number;
}

/** BE 응답 → 화면이 쓰는 형태. 순수 매핑(정렬·필터 재적용 없음 — BE 계약이 이미 순서를 확定했다). */
export function deriveFlowNodeZones(response: EpicFlowNodesResponse): FlowNodeZones {
  return {
    nowItems: response.now.items,
    nowTotal: response.now.total,
    upcomingItems: response.upcoming.items,
    upcomingTotal: response.upcoming.total,
    upcomingShown: response.upcoming.items.length,
    pastTotal: response.past.total,
  };
}
