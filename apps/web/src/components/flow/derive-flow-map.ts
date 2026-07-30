import type { EpicFlowNodeItem } from './derive-flow';

// L3 갈래 지도 — 유나 목업(`be8709a4`, "갈래 L3 — 좌표 규칙 판A/판B/판C") 실측 그대로.
// 좌표 상수(아티팩트 CSS 그대로, 2026-07-30 확認 — "그림이 정본", 채팅으로 옮긴 숫자는 안 씀):
export const FLOW_MAP_GRID_STEP = 110; // 세로 그리드 간격(px) = 깊이 한 칸
export const FLOW_MAP_NOW_LINE_X = 292; // "지금" 세로선 left(px)
export const FLOW_MAP_DEPTH0_X = FLOW_MAP_NOW_LINE_X + FLOW_MAP_GRID_STEP; // 깊이 0 열 시작(402px)

// ③④ 판C(2026-07-30) — 열마다 상위 3 + 「+N건」 점선 카드, 과거 묶음 카드. ⑥(포트·슬롯의
// 실제 저장 배선)은 #2221(부산물형 3종 간선 — 낳음/잇따름/대체) 착수 전까지 보류한다(PO
// 정정 2026-07-30 — 기존 `dependencies`(blocks/depends_on, 계획형)에 쓰면 "사람이 미리
// 선언해야" 하는 그 성질을 그대로 물려받아 org 6주 0건이 재현된다). 포트 «그림» 자체는
// #2221이 착지하면 그대로 재사용한다 — 저장 배선만 그때 바뀐다.
export const FLOW_MAP_TOP_N = 3; // 열마다 카드로 그리는 상위 건수 — 나머지는 "+N건" 카드

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

export interface FlowMapOverflow {
  /** 판C — 열 하나(같은 depth)에 TOP_N을 넘는 카드가 있을 때 나머지 건수. */
  depth: number;
  hiddenCount: number;
}

export interface FlowMapLane {
  epicId: string;
  title: string;
  pastTotal: number;
  nowNodes: FlowMapNode[];
  /** depth별로 상위 FLOW_MAP_TOP_N만 담은 큐 노드 — 나머지는 overflows에 건수로 잡힌다
   * (판C, 카드 없이 사라지지 않고 "+N건"으로 보이는 것이 핵심 — 눈에 안 보이는 결핍 금지). */
  queueNodesByDepth: Map<number, FlowMapNode[]>;
  overflows: FlowMapOverflow[];
}

/** 정렬 규칙(판C) — "막힘 › 다음 지정됨 › 나머지". "다음 지정됨"에 대응하는 실 데이터
 * 필드가 아직 없어(#2221 미착지·다음-지정 mutation 자체 미확認) 오늘은 "막힘 › 나머지"
 * 2단만 실제로 갈린다 — 3단 전부를 구현한 척하지 않는다(정직). */
function queueSortKey(node: FlowMapNode): number {
  return node.status === 'blocked' ? 0 : 1;
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

  const byDepth = new Map<number, FlowMapNode[]>();
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
    const list = byDepth.get(depth) ?? [];
    list.push(node);
    byDepth.set(depth, list);
  }

  const queueNodesByDepth = new Map<number, FlowMapNode[]>();
  const overflows: FlowMapOverflow[] = [];
  for (const [depth, nodes] of byDepth) {
    const sorted = [...nodes].sort((a, b) => queueSortKey(a) - queueSortKey(b));
    queueNodesByDepth.set(depth, sorted.slice(0, FLOW_MAP_TOP_N));
    const hiddenCount = sorted.length - FLOW_MAP_TOP_N;
    if (hiddenCount > 0) overflows.push({ depth, hiddenCount });
  }

  return { epicId, title, pastTotal, nowNodes, queueNodesByDepth, overflows };
}

/** 레인 하나의 높이(px) — 고정값이 아니라 «내용»에서 계산한다(판C ⑤, "고정이면 어느 레인은
 * 비고 어느 레인은 넘친다"). 열마다 카드 스택 높이 중 최댓값을 열 높이로 삼는다 — "지금"
 * 열도 같은 방식으로 하나의 열로 취급한다. */
export function computeLaneHeight(lane: FlowMapLane, nodeRowHeight: number, minHeight: number): number {
  const nowColumnCount = lane.nowNodes.length;
  const queueColumnCounts = Array.from(lane.queueNodesByDepth.entries()).map(([depth, nodes]) => {
    const hasOverflow = lane.overflows.some((o) => o.depth === depth);
    return nodes.length + (hasOverflow ? 1 : 0); // 더보기 카드도 한 행을 차지한다
  });
  const maxColumnCount = Math.max(1, nowColumnCount, ...queueColumnCounts);
  return Math.max(minHeight, maxColumnCount * nodeRowHeight);
}

/** ⑥ 조건부 문구(PO 판정 2026-07-30) 트리거 — depth 0 열은 있는데 depth 1 이상이 «전혀»
 * 없을 때만 참. 하드코딩된 상수가 아니라 실제 맵 상태에서 계산하므로, 간선이 착지해
 * depth≥1 노드가 생기는 날 이 함수가 스스로 false를 내 문구가 사라진다(거짓말 될 위험 없음). */
export function shouldShowNoDeeperReason(lane: FlowMapLane): boolean {
  if (!lane.queueNodesByDepth.has(0)) return false;
  return !Array.from(lane.queueNodesByDepth.keys()).some((d) => d >= 1);
}
