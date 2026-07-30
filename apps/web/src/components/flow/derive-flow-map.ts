import type { EpicFlowNodeItem } from './derive-flow';

// L3 갈래 지도 — 유나 목업(`be8709a4`, "갈래 L3 — 좌표 규칙 판A/판B/판C") 실측 그대로.
// 좌표 상수(아티팩트 CSS 그대로, 2026-07-30 확認 — "그림이 정본", 채팅으로 옮긴 숫자는 안 씀):
export const FLOW_MAP_GRID_STEP = 110; // 세로 그리드 간격(px) = 깊이 한 칸
export const FLOW_MAP_NOW_LINE_X = 292; // "지금" 세로선 left(px)
export const FLOW_MAP_DEPTH0_X = FLOW_MAP_NOW_LINE_X + FLOW_MAP_GRID_STEP; // 깊이 0 열 시작(402px)

// ⛔오늘 범위(PO 판정 2026-07-30) — ⑤레인 높이 가변 + ①깊이 좌표 + ②「지금」 세로선, 한
// 레인 안에서. 판C(열마다 상위3+「+N건」 · 과거 묶음카드 · 포트·슬롯)는 레인 6개를 한 판에
// 얹는 멀티레인 BE 계약이 착지한 다음 단계 — 여기서 미리 짓지 않는다("각각 서는 대로
// 라이브에서 보시는" 규율).

export interface FlowMapEdge {
  fromNodeId: string;
  toNodeId: string;
}

/** 노드 하나의 «의존 깊이» — 들어오는 간선이 없으면 0(시작점), 있으면 «선행 노드 깊이 중
 * 최댓값+1». edges가 항상 빈 배열인 오늘(#2221 미착지)은 이 재귀가 «자연히» 전부 0을 내는
 * 것이라 — `if (edges.length === 0) return 0` 같은 특수분기를 두지 않는다(PO 지시
 * 2026-07-30, "판B는 판A 규칙의 퇴화된 특수 경우이지 다른 그림이 아니다"). 간선이 생기는 날
 * 이 함수는 코드 변경 없이 여러 열을 만들어낸다. */
export function computeNodeDepth(nodeId: string, edges: FlowMapEdge[], seen: Set<string> = new Set()): number {
  if (seen.has(nodeId)) return 0; // 순환 방어(그래프가 순환이면 더 못 감 — 0으로 끊는다)
  const incoming = edges.filter((e) => e.toNodeId === nodeId);
  if (incoming.length === 0) return 0;
  const nextSeen = new Set(seen).add(nodeId);
  return 1 + Math.max(...incoming.map((e) => computeNodeDepth(e.fromNodeId, edges, nextSeen)));
}

export type FlowMapNodeKind = 'now' | 'queue';

export interface FlowMapNode {
  id: string;
  storyNumber: number;
  title: string;
  status: string;
  kind: FlowMapNodeKind;
  /** queue 노드만 유의미(now는 지금선 바로 옆 고정 열). */
  depth: number;
}

export interface FlowMapLane {
  epicId: string;
  title: string;
  pastTotal: number;
  nowNodes: FlowMapNode[];
  /** depth별 큐 노드 — 오늘은 잘림 없이 전량(top-N 잘림은 ④단계, 멀티레인 계약 이후). */
  queueNodesByDepth: Map<number, FlowMapNode[]>;
}

/** BE epic-flow-nodes 응답(한 에픽) → L3 지도 레인 하나. edges는 항상 호출부가 실제 배열로
 * 넘긴다(#2221 미착지인 오늘은 빈 배열 — 하드코딩 아니라 "아직 그 계약이 없다"는 사실). */
export function deriveFlowMapLane(
  epicId: string,
  title: string,
  pastTotal: number,
  nowItems: EpicFlowNodeItem[],
  upcomingItems: EpicFlowNodeItem[],
  edges: FlowMapEdge[] = [],
): FlowMapLane {
  const nowNodes: FlowMapNode[] = nowItems.map((item) => ({
    id: item.id,
    storyNumber: item.story_number,
    title: item.title,
    status: item.status,
    kind: 'now',
    depth: 0,
  }));

  const queueNodesByDepth = new Map<number, FlowMapNode[]>();
  for (const item of upcomingItems) {
    const depth = computeNodeDepth(item.id, edges);
    const node: FlowMapNode = {
      id: item.id,
      storyNumber: item.story_number,
      title: item.title,
      status: item.status,
      kind: 'queue',
      depth,
    };
    const list = queueNodesByDepth.get(depth) ?? [];
    list.push(node);
    queueNodesByDepth.set(depth, list);
  }

  return { epicId, title, pastTotal, nowNodes, queueNodesByDepth };
}

/** 레인 하나의 높이(px) — 고정값이 아니라 «내용»에서 계산한다(판C ⑤, "고정이면 어느 레인은
 * 비고 어느 레인은 넘친다"). 열마다 카드 스택 높이 중 최댓값을 열 높이로 삼는다 — "지금"
 * 열도 같은 방식으로 하나의 열로 취급한다. */
export function computeLaneHeight(lane: FlowMapLane, nodeRowHeight: number, minHeight: number): number {
  const nowColumnCount = lane.nowNodes.length;
  const queueColumnCounts = Array.from(lane.queueNodesByDepth.values()).map((nodes) => nodes.length);
  const maxColumnCount = Math.max(1, nowColumnCount, ...queueColumnCounts);
  return Math.max(minHeight, maxColumnCount * nodeRowHeight);
}
