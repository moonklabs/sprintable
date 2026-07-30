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
