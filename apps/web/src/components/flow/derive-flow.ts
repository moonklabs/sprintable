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

// story #4062 후속(2026-09-09, 페드루 PO 決) — deriveFlowLaneRows·FLOW_LANE_CAP·
// EpicLaneCounts·EpicZoneCounts·EpicsProgressLaneResponse를 여기서 걷어냈다. 유일
// 소비처(FlowLane, flow-lane.tsx)가 #3710에서 삭제됐다 — 방금 소비처 0이 된 것을 남기면
// "살아 있는 추상"이 된다. FlowLaneRow는 flow-canvas.tsx(별도 은퇴 스윕 #3715 대상)가
// 여전히 타입으로 참조해 남긴다.

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
  // story #2224 후속(문 두 층, 2026-08-27) — BE FlowNode(analytics.py)가 이미 보내고 있었으나
  // 이 타입에 필드가 없어 그라운드에서 죽어 있었다(grep 무결과로 확認). gate_pending=false면
  // gate_reason은 항상 null(BE 불변식) — FE가 그 불변식을 다시 검증하지 않는다.
  gate_pending: boolean;
  gate_reason: string | null;
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
