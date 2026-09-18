// story #3715(2026-09-09, 페드루 PO 決) — FlowCanvas(flow-canvas.tsx) 은퇴 스윕. `FlowLaneRow`
// (#4062 후속에서 이미 flow-canvas.tsx만 남기고 나머지 4조각을 걷어냈던 그 타입)·
// `derivePastRatio`·`EdgeSummary`·`deriveEdgeSummary`는 유일 소비처였던 flow-canvas.tsx가
// 삭제되며 소비처 0이 됐다.

// L3(시간축 캔버스) 재작업은 별도 PR — 유나 치수(L3-1~L3-6, 절대 px 좌표+110px 그리드) 전량
// 수신 후 착수한다(PO 지시 2026-07-30, "절반만 보고 짓지 마시는").

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
