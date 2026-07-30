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

// PO 판정(2026-07-30, 실측 후속) — 목표(에픽)당 스토리 «중앙값 7»(대부분 접을 필요가
// 없다)· «최대 141»(그 하나는 반드시 접혀야 한다)을 재고 나온 조건. 이전엔 3개 넘으면
// 무조건 접었는데 그러면 "4개짜리 열"도 "+1건"으로 접혀 사람이 볼 수 있는 것까지 숨긴다
// (대부분 열이 이 크기라 무조건 접기는 실질적으로 늘 접는 것과 같았다). 이 임계값을
// 넘을 때만 접는다 — 넘지 않으면 전부(FLOW_MAP_TOP_N보다 많아도) 그대로 보인다.
export const FLOW_MAP_FOLD_THRESHOLD = 5;

/** 유나양 규격(2026-07-30, PO 전달) — 관계 종류 4종(축1). `null` = "종 미정"(아직 종이
 * 안 지정된 «제안» 간선 — #2223 산문 추출은 항상 이 상태로 들어온다). 종 미정은 별도
 * 넷째 «모양»을 갖지 않는다(화살촉 자체를 없앰) — 모르는 것을 아는 척 그리지 않는다는
 * 원칙(유나양 지적: 넷째 모양을 주면 「미정」이 하나의 확定된 종류처럼 보인다). */
export type FlowMapEdgeKind = 'spawn' | 'then' | 'supersede' | null;

export interface FlowMapEdge {
  fromNodeId: string;
  toNodeId: string;
  /** 종(낳음/잇따름/대체/미정) — 축1. */
  kind: FlowMapEdgeKind;
  /** 확認 상태(축2, 축1과 직교) — true=사람이 1클릭으로 확定, false=산문에서 뽑힌 제안
   * (#2223 본문 "자동 확定 금지" 원칙). 확認 여부와 무관하게 종은 가질 수 있다(예: 확認된
   * "낳음"도 있고 제안 상태의 "낳음"도 있다) — 두 축은 서로를 제약하지 않는다. */
  confirmed: boolean;
}

/** `GET /api/dependencies/graph` 원시 응답 엣지 하나 — `backend/app/services/dependency_graph.py
 * get_graph()`가 내는 그대로({id, from_id, to_id, dep_type}). */
export interface RawDependencyEdge {
  id: string;
  from_id: string;
  to_id: string;
  dep_type: string;
}

/** 선생님 지시(2026-07-30, P0) — "edges=[]를 항상 넘긴다"(하드코딩)와 "실제로 받았는데
 * 0건"(정직한 빈 값)은 다른 사실이다. 이 함수가 그 구분을 만드는 자리 — 기존 계획형
 * `dependencies`(blocks/depends_on)를 실제로 fetch해 FlowMapEdge로 정규화한다.
 *
 * 방향 규칙(PO 확定 2026-07-30, computeNodeDepth와 동일 방향): `blocks(A→B)`="A가 B를
 * 막는다"=A가 먼저 → fromNodeId=A·toNodeId=B(그대로). `depends_on(A→B)`="A가 B에 의존"=B가
 * 먼저 → «뒤집어» fromNodeId=B·toNodeId=A. 이 뒤집기는 이 함수 «한 곳»에서만 한다(여러 곳에
 * 흩으면 언젠가 한쪽이 그 정규화를 빠뜨린다).
 *
 * ⛔#2223(부산물형 3종 간선 — 낳음/잇따름/대체)은 아직 실 엔드포인트가 없다(디디 실측은
 * "산문에서 뽑히는 제안선" 단계, 2026-07-30) — 이 함수는 오늘 실존하는 «계획형»만 다룬다.
 * #2223이 착지하면 별도 파서가 추가되는 것이지 이 함수를 확장하는 게 아니다(계획형·부산물형은
 * 서로 다른 의미 축이라 한 함수에서 섞으면 방향 규칙이 꼬인다).
 *
 * kind/confirmed(2026-07-30, 유나양 4×2 규격 후속): 계획형 `dependencies`는 사람이 UI로
 * 직접 만든 선언이라 confirmed=true가 항상 맞다(제안 단계가 없는 시스템) — 다만
 * 낳음/잇따름/대체 «어느 것도 아니라» kind=null(종 미정)로 둔다. */
export function parseDependencyGraphEdges(raw: RawDependencyEdge[]): FlowMapEdge[] {
  return raw.map((e) => (
    e.dep_type === 'depends_on'
      ? { fromNodeId: e.to_id, toNodeId: e.from_id, kind: null, confirmed: true }
      : { fromNodeId: e.from_id, toNodeId: e.to_id, kind: null, confirmed: true }
  ));
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
  /** 선생님 지적(2026-07-30) — "edges=[]를 항상 넘기는" 하드코딩과 "실제로 받았는데 0건"은
   * 다른 사실이다. 렌더 레이어(FlowMapCanvas)가 실제로 선을 그릴 수 있도록, «양쪽 끝이 모두
   * 화면에 그려지는 노드인» 간선만 여기 보존한다(TOP_N에 잘려 안 보이는 노드로 가는 선은
   * 그릴 좌표가 없어 제외 — "숨은 노드로 가는 유령 선"을 만들지 않는다). */
  edges: FlowMapEdge[];
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
    if (sorted.length > FLOW_MAP_FOLD_THRESHOLD) {
      queueNodesByDepth.set(depth, sorted.slice(0, FLOW_MAP_TOP_N));
      overflows.push({ depth, hiddenCount: sorted.length - FLOW_MAP_TOP_N });
    } else {
      queueNodesByDepth.set(depth, sorted); // 임계값 이하 — 전부 보인다, 접지 않는다.
    }
  }

  const renderedIds = new Set<string>(nowNodes.map((n) => n.id));
  for (const nodes of queueNodesByDepth.values()) {
    for (const n of nodes) renderedIds.add(n.id);
  }
  const renderableEdges = edges.filter((e) => renderedIds.has(e.fromNodeId) && renderedIds.has(e.toNodeId));

  return { epicId, title, pastTotal, nowNodes, queueNodesByDepth, overflows, edges: renderableEdges };
}

/** 노드 하나가 화면에 그려질 {left, top}(카드 좌상단) — FlowMapCanvas의 카드 렌더링과
 * «같은 공식»을 간선 SVG 렌더링도 써야 선이 카드 위치와 어긋나지 않는다(위치 계산을 두 곳에
 * 따로 두면 언젠가 하나만 바뀌어 어긋난다 — 단일 소스). now 노드는 nowClusterX 고정열,
 * queue 노드는 depth × gridStep 열 — 카드 렌더링(flow-map-canvas.tsx)과 동일 순서로 순회해
 * 같은 top(= 4 + i × nodeRowHeight)을 낸다. */
export function computeNodePositions(
  lane: FlowMapLane,
  nodeRowHeight: number,
  nowClusterX: number,
): Map<string, { left: number; top: number }> {
  const positions = new Map<string, { left: number; top: number }>();
  lane.nowNodes.forEach((node, i) => {
    positions.set(node.id, { left: nowClusterX, top: 4 + i * nodeRowHeight });
  });
  for (const [depth, nodes] of lane.queueNodesByDepth) {
    const x = FLOW_MAP_DEPTH0_X + depth * FLOW_MAP_GRID_STEP;
    nodes.forEach((node, i) => {
      positions.set(node.id, { left: x, top: 4 + i * nodeRowHeight });
    });
  }
  return positions;
}

/** 유나양 지적(2026-07-30, PO 전달) — "대체"(supersede)만 유일하게 «간선이 노드 렌더에
 * 영향을 주는» 종류다(낳음·잇따름은 둘 다 살아있는 관계라 선만 그으면 되지만, 대체는 한쪽이
 * 죽는 관계라 «옛 노드»의 표시가 같이 바뀌어야 — 안 그러면 "대체됐는데 옛 것이 멀쩡히 살아
 * 보이는" 화면이 된다). ⛔단 «확認된» 대체만 — «제안» 상태의 대체까지 옛 노드를 흐리면
 * 확認 안 된 것을 화면이 대신 판정하는 것이 된다(유나양 지적, 사람이 안 한 판정을 화면이
 * 대신 내면 안 된다). 방향 규칙(이 세션 확定): fromNodeId=옛 노드(대체당함), toNodeId=새
 * 노드(대체함) — "이전→이후" 시간 방향은 낳음·잇따름과 동일하게 유지한다. */
export function computeSupersededNodeIds(edges: FlowMapEdge[]): Set<string> {
  return new Set(
    edges.filter((e) => e.kind === 'supersede' && e.confirmed).map((e) => e.fromNodeId),
  );
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
