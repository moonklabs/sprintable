import type { RoadmapEpic } from '@/services/glance';

// story #2224(IA v2.2 §2·§3) — 좌 레인 표시 상한. OverviewZone(overview-zone.tsx)의 `epics.slice(0,6)`
// 관례와 일관되게 6으로 맞춘다(§7-1 노드 밀도 상한은 아직 미확定 — 이 값은 그 확定 전 임시 방어값).
export const FLOW_LANE_CAP = 6;

// GET /api/v2/analytics/epics-progress-lane?project_id= 계약(#2672+#2686). `epics`=5분류
// (막힘·대기·진행·멈춤·그외) — #2672로 이미 착지했으나 오늘까지 FE 미배선이었다(유나 지적
// 2026-07-30, "퍼센트가 틀린 말을 하고 있다"). `zones`=시간축 3분류(past/now/upcoming) — #2686
// 급추가, epic-flow-nodes와 동일 정의 재사용. 두 맵 다 "story가 하나라도 있는 에픽"만 키를
// 갖는다(에픽 없음은 결함이 아니라 사실 — 0-스토리 에픽은 응답에 없는 게 정직한 것).
export interface EpicLaneCounts {
  in_progress: number;
  waiting: number;
  blocked: number;
  stalled: number;
  other: number;
}

export interface EpicZoneCounts {
  title: string | null;
  total: number;
  done: number;
  pct: number;
  past_cnt: number;
  now_cnt: number;
  upcoming_cnt: number;
}

export interface EpicsProgressLaneResponse {
  epics: Record<string, EpicLaneCounts>;
  zones: Record<string, EpicZoneCounts>;
  stall_threshold_hours: number;
  stories_without_epic: number;
}

export interface FlowLaneRow {
  id: string;
  title: string;
  done: number;
  total: number;
  completionPct: number;
  inProgress: number;
  waiting: number;
  blocked: number;
  stalled: number;
  pastCnt: number;
  nowCnt: number;
  upcomingCnt: number;
  /** epics-progress-lane 응답에 이 에픽 키가 아예 없을 때(스토리 0건인 에픽) 참 —
   * 플래그바 대신 "모름"을 정직하게 그리라는 신호(§H-2, 없는 것을 0으로 지어내지 않는다). */
  hasLaneData: boolean;
}

/** 로드맵 에픽 + epics-progress-lane 응답 → 좌 레인 행. laneData가 없으면(아직 fetch 전/실패)
 * 모든 분류 칸이 0·hasLaneData=false로 정직하게 빈다 — done/total/completionPct는 항상
 * epics-progress-lane의 zones가 있으면 그것을 우선한다(#2686이 title까지 한 곳에 실어 오는
 * 소스라 roadmap과 "두 벌 서지" 않는다, PO 판정 2026-07-30). */
export function deriveFlowLaneRows(
  roadmap: RoadmapEpic[],
  laneData: EpicsProgressLaneResponse | null,
): FlowLaneRow[] {
  return roadmap.slice(0, FLOW_LANE_CAP).map((e) => {
    const lane = laneData?.epics[e.id];
    const zone = laneData?.zones[e.id];
    return {
      id: e.id,
      title: e.title,
      done: zone?.done ?? e.done,
      total: zone?.total ?? e.total,
      completionPct: zone?.pct ?? e.completionPct,
      inProgress: lane?.in_progress ?? 0,
      waiting: lane?.waiting ?? 0,
      blocked: lane?.blocked ?? 0,
      stalled: lane?.stalled ?? 0,
      pastCnt: zone?.past_cnt ?? 0,
      nowCnt: zone?.now_cnt ?? 0,
      upcomingCnt: zone?.upcoming_cnt ?? 0,
      hasLaneData: lane !== undefined,
    };
  });
}

// L3(시간축 캔버스) 재작업은 별도 PR — 유나 치수(L3-1~L3-6, 절대 px 좌표+110px 그리드) 전량
// 수신 후 착수한다(PO 지시 2026-07-30, "절반만 보고 짓지 마시는"). 이 PR은 L2(좌 레인 플래그바)
// 만 다룬다 — derivePastRatio(기존 단일 진행률 막대)는 flow-canvas.tsx가 그대로 쓰므로 무변경.

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

// deriveFlowNodeZones/FlowNodeZones(구 평면목록 렌더링용) 제거(2026-07-30) — L3 지도
// (derive-flow-map.ts의 deriveFlowMapLane)로 렌더링 자체가 바뀌어 더 이상 아무도 안 부르는
// 죽은 코드가 됐다(grep 확認). EpicFlowNodesResponse/EpicFlowNodeItem은 fetch 응답 타입으로
// 계속 필요해 남긴다.
