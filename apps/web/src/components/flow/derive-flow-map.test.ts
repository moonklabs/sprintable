import { describe, expect, it } from 'vitest';
import {
  computeNodeDepth, deriveFlowMapLane, computeLaneHeight, shouldShowNoDeeperReason, computeNodePositions,
  parseDependencyGraphEdges, FLOW_MAP_TOP_N, FLOW_MAP_FOLD_THRESHOLD, FLOW_MAP_DEPTH0_X, FLOW_MAP_GRID_STEP,
  type FlowMapEdge, type FlowMapLane,
} from './derive-flow-map';
import type { EpicFlowNodeItem } from './derive-flow';

function makeItem(overrides: Partial<EpicFlowNodeItem> = {}): EpicFlowNodeItem {
  return { id: 's1', story_number: 1, title: 'Story', status: 'backlog', assignee_id: null, updated_at: '2026-07-30T00:00:00Z', ...overrides };
}

// kind/confirmed는 대부분의 computeNodeDepth/deriveFlowMapLane 테스트에 무관(그 로직은
// fromNodeId/toNodeId만 본다) — 기본값(종 미정·확定)으로 채워 매 호출부의 소음을 줄인다.
function edge(fromNodeId: string, toNodeId: string, overrides: Partial<FlowMapEdge> = {}): FlowMapEdge {
  return { fromNodeId, toNodeId, kind: null, confirmed: true, ...overrides };
}

describe('computeNodeDepth', () => {
  it('returns 0 when there are no edges at all (today\'s reality — #2221 미착지, not a special case)', () => {
    expect(computeNodeDepth('a', [])).toBe(0);
  });

  it('returns 0 for a node with no incoming edges even when other edges exist', () => {
    const edges: FlowMapEdge[] = [edge('x', 'y')];
    expect(computeNodeDepth('a', edges)).toBe(0);
  });

  it('computes depth via the longest incoming chain (a→b→c ⇒ c has depth 2)', () => {
    const edges: FlowMapEdge[] = [
      edge('a', 'b'),
      edge('b', 'c'),
    ];
    expect(computeNodeDepth('a', edges)).toBe(0);
    expect(computeNodeDepth('b', edges)).toBe(1);
    expect(computeNodeDepth('c', edges)).toBe(2);
  });

  it('takes the max depth among multiple incoming edges', () => {
    const edges: FlowMapEdge[] = [
      edge('a', 'c'), // a is depth 0 → c via a = 1
      edge('b', 'x'),
      edge('x', 'c'), // x is depth 1 → c via x = 2
    ];
    expect(computeNodeDepth('c', edges)).toBe(2);
  });

  it('does not infinite-loop on a cycle (defensive — breaks at 0 on revisit)', () => {
    const edges: FlowMapEdge[] = [
      edge('a', 'b'),
      edge('b', 'a'),
    ];
    expect(() => computeNodeDepth('a', edges)).not.toThrow();
  });
});

describe('deriveFlowMapLane', () => {
  it('maps now items with kind=now and depth=0', () => {
    const lane = deriveFlowMapLane('e1', 'Epic 1', 10, [makeItem({ id: 'n1', status: 'in-progress' })], []);
    expect(lane.nowNodes).toEqual([{ id: 'n1', storyNumber: 1, title: 'Story', status: 'in-progress', kind: 'now', depth: 0 }]);
  });

  it('computes queue node depth from edges (no special-casing empty edges)', () => {
    const lane = deriveFlowMapLane('e1', 'Epic 1', 0, [], [makeItem({ id: 'u1' })], []);
    expect(lane.queueNodesByDepth.get(0)).toEqual([
      { id: 'u1', storyNumber: 1, title: 'Story', status: 'backlog', kind: 'queue', depth: 0 },
    ]);
  });

  it('places queue nodes into different depth buckets when edges create a chain', () => {
    const items = [makeItem({ id: 'u1' }), makeItem({ id: 'u2' })];
    const edges: FlowMapEdge[] = [edge('u1', 'u2')];
    const lane = deriveFlowMapLane('e1', 'Epic 1', 0, [], items, edges);
    expect(lane.queueNodesByDepth.get(0)?.map((n) => n.id)).toEqual(['u1']);
    expect(lane.queueNodesByDepth.get(1)?.map((n) => n.id)).toEqual(['u2']);
  });

  // PO 판정(2026-07-30, 실측 후속) — 목표당 스토리 중앙값 7(대부분 접기 불요)·최대 141(그
  // 하나는 반드시 접혀야)을 재고, "3개 넘으면 무조건 접기"에서 "FLOW_MAP_FOLD_THRESHOLD(5)를
  // «넘을 때만» 접기"로 바뀌었다 — 대부분 열이 다 보여야 한다는 것이 핵심.
  it('caps a depth column at FLOW_MAP_TOP_N and reports the rest as overflow — only once it exceeds FLOW_MAP_FOLD_THRESHOLD (판C — 잘린 수를 정직하게)', () => {
    const items = Array.from({ length: FLOW_MAP_FOLD_THRESHOLD + 2 }, (_, i) => makeItem({ id: `u${i}`, story_number: i }));
    const lane = deriveFlowMapLane('e1', 'Epic 1', 0, [], items, []);
    expect(lane.queueNodesByDepth.get(0)).toHaveLength(FLOW_MAP_TOP_N);
    expect(lane.overflows).toEqual([{ depth: 0, hiddenCount: FLOW_MAP_FOLD_THRESHOLD + 2 - FLOW_MAP_TOP_N }]);
  });

  it('shows ALL items with no overflow when a depth column is at or under FLOW_MAP_FOLD_THRESHOLD, even if it exceeds FLOW_MAP_TOP_N (대부분 열은 다 보여야 한다)', () => {
    const items = Array.from({ length: FLOW_MAP_FOLD_THRESHOLD }, (_, i) => makeItem({ id: `u${i}` }));
    const lane = deriveFlowMapLane('e1', 'Epic 1', 0, [], items, []);
    expect(lane.queueNodesByDepth.get(0)).toHaveLength(FLOW_MAP_FOLD_THRESHOLD);
    expect(lane.overflows).toEqual([]);
  });

  it('sorts blocked nodes first within a depth column ("다음 지정됨" tier deferred — no field yet)', () => {
    const items = [
      makeItem({ id: 'u1', status: 'backlog' }),
      makeItem({ id: 'u2', status: 'blocked' }),
      makeItem({ id: 'u3', status: 'backlog' }),
    ];
    const lane = deriveFlowMapLane('e1', 'Epic 1', 0, [], items, []);
    expect(lane.queueNodesByDepth.get(0)?.map((n) => n.id)).toEqual(['u2', 'u1', 'u3']);
  });

  it('keeps a blocked node visible ahead of the cutoff even when it would otherwise be truncated', () => {
    const items = [
      ...Array.from({ length: FLOW_MAP_FOLD_THRESHOLD }, (_, i) => makeItem({ id: `u${i}`, status: 'backlog' })),
      makeItem({ id: 'blocked1', status: 'blocked' }),
    ];
    const lane = deriveFlowMapLane('e1', 'Epic 1', 0, [], items, []);
    expect(lane.queueNodesByDepth.get(0)?.map((n) => n.id)).toContain('blocked1');
    expect(lane.overflows).toEqual([{ depth: 0, hiddenCount: FLOW_MAP_FOLD_THRESHOLD + 1 - FLOW_MAP_TOP_N }]);
  });

  // 선생님 지적(2026-07-30) — "edges=[]를 항상 넘긴다"와 "받았는데 화면에 못 그린다"는
  // 다른 병이다. 렌더 가능한(카드로 실제로 그려지는) 노드끼리의 간선만 보존해야 SVG
  // 레이어가 유령 선(안 보이는 노드로 가는 선)을 안 그린다.
  it('keeps an edge whose both endpoints are actually rendered (now→queue)', () => {
    const edges: FlowMapEdge[] = [edge('n1', 'u1')];
    const lane = deriveFlowMapLane('e1', 'Epic 1', 0, [makeItem({ id: 'n1' })], [makeItem({ id: 'u1' })], edges);
    expect(lane.edges).toEqual([edge('n1', 'u1')]);
  });

  it('drops an edge whose target was truncated by TOP_N overflow — no line to a card that is not drawn', () => {
    // r(뿌리, depth 0) → u0..u5(전부 depth 1, r→ui 간선으로 밀림 — FOLD_THRESHOLD(5)를
    // 넘겨야 접힌다). depth 1 열이 TOP_N=3에 잘리고(정렬 키가 전부 같아 stable sort로
    // 입력 순서 보존) u3부터 overflow로 빠진다 — u3로 가는 간선(r→u3)도 함께 사라져야 한다.
    const items = [
      makeItem({ id: 'r' }),
      ...Array.from({ length: FLOW_MAP_FOLD_THRESHOLD + 1 }, (_, i) => makeItem({ id: `u${i}`, story_number: i })),
    ];
    const edges: FlowMapEdge[] = Array.from({ length: FLOW_MAP_FOLD_THRESHOLD + 1 }, (_, i) => edge('r', `u${i}`));
    const lane = deriveFlowMapLane('e1', 'Epic 1', 0, [], items, edges);
    expect(lane.queueNodesByDepth.get(1)?.map((n) => n.id)).toEqual(['u0', 'u1', 'u2']);
    expect(lane.overflows).toEqual([{ depth: 1, hiddenCount: FLOW_MAP_FOLD_THRESHOLD + 1 - FLOW_MAP_TOP_N }]);
    expect(lane.edges).toEqual(
      expect.arrayContaining([edge('r', 'u0'), edge('r', 'u1'), edge('r', 'u2')]),
    );
    expect(lane.edges).not.toContainEqual(edge('r', 'u3'));
  });

  it('drops an edge referencing a node id that does not exist in this lane at all', () => {
    const edges: FlowMapEdge[] = [edge('ghost', 'n1')];
    const lane = deriveFlowMapLane('e1', 'Epic 1', 0, [makeItem({ id: 'n1' })], [], edges);
    expect(lane.edges).toEqual([]);
  });
});

describe('parseDependencyGraphEdges', () => {
  it('keeps blocks(A→B) direction as-is — A(blocker) is fromNodeId, B is toNodeId', () => {
    const edges = parseDependencyGraphEdges([{ id: 'd1', from_id: 'a', to_id: 'b', dep_type: 'blocks' }]);
    expect(edges).toEqual([edge('a', 'b')]);
  });

  it('flips depends_on(A→B) — A depends on B means B comes first, so fromNodeId=B, toNodeId=A', () => {
    const edges = parseDependencyGraphEdges([{ id: 'd1', from_id: 'a', to_id: 'b', dep_type: 'depends_on' }]);
    expect(edges).toEqual([edge('b', 'a')]);
  });

  it('normalizes a mix of both dep_types to the same causal direction convention', () => {
    const edges = parseDependencyGraphEdges([
      { id: 'd1', from_id: 'x', to_id: 'y', dep_type: 'blocks' }, // x first
      { id: 'd2', from_id: 'p', to_id: 'q', dep_type: 'depends_on' }, // q first
    ]);
    expect(edges).toEqual([
      edge('x', 'y'),
      edge('q', 'p'),
    ]);
  });

  it('returns an empty array for an empty response (org has 0 rows today — honest empty, not a crash)', () => {
    expect(parseDependencyGraphEdges([])).toEqual([]);
  });
});

describe('computeNodePositions', () => {
  it('places now nodes at the fixed now-cluster column, stacked by row index', () => {
    const lane = deriveFlowMapLane('e1', 'Epic 1', 0, [makeItem({ id: 'n1' }), makeItem({ id: 'n2' })], []);
    const positions = computeNodePositions(lane, 28, 252);
    expect(positions.get('n1')).toEqual({ left: 252, top: 4 });
    expect(positions.get('n2')).toEqual({ left: 252, top: 32 });
  });

  it('places queue nodes at depth × grid-step, stacked by row index within that depth', () => {
    const items = [makeItem({ id: 'u1' }), makeItem({ id: 'u2' })];
    const edges: FlowMapEdge[] = [edge('u1', 'u2')];
    const lane = deriveFlowMapLane('e1', 'Epic 1', 0, [], items, edges);
    const positions = computeNodePositions(lane, 28, 252);
    expect(positions.get('u1')).toEqual({ left: FLOW_MAP_DEPTH0_X, top: 4 });
    expect(positions.get('u2')).toEqual({ left: FLOW_MAP_DEPTH0_X + FLOW_MAP_GRID_STEP, top: 4 });
  });

  it('has no entry for a node truncated by TOP_N overflow (nothing to draw a line to)', () => {
    const items = Array.from({ length: FLOW_MAP_FOLD_THRESHOLD + 1 }, (_, i) => makeItem({ id: `u${i}` }));
    const lane = deriveFlowMapLane('e1', 'Epic 1', 0, [], items, []);
    const positions = computeNodePositions(lane, 28, 252);
    expect(positions.has(`u${FLOW_MAP_TOP_N}`)).toBe(false);
  });
});

function makeLane(overrides: Partial<FlowMapLane> = {}): FlowMapLane {
  return {
    epicId: 'e1', title: 'Epic 1', pastTotal: 0,
    nowNodes: [], queueNodesByDepth: new Map(), overflows: [], edges: [],
    ...overrides,
  };
}

describe('computeLaneHeight', () => {
  it('returns minHeight when the lane has no nodes at all', () => {
    expect(computeLaneHeight(makeLane(), 28, 70)).toBe(70);
  });

  it('grows past minHeight when a column has more nodes than minHeight/rowHeight allows', () => {
    const lane = makeLane({ nowNodes: [
      { id: 'n1', storyNumber: 1, title: 't', status: 'in-progress', kind: 'now', depth: 0 },
      { id: 'n2', storyNumber: 2, title: 't', status: 'in-progress', kind: 'now', depth: 0 },
      { id: 'n3', storyNumber: 3, title: 't', status: 'in-progress', kind: 'now', depth: 0 },
    ] });
    expect(computeLaneHeight(lane, 28, 70)).toBe(84); // 3 * 28 = 84 > 70
  });

  it('uses the tallest queue column when it exceeds the now column', () => {
    const lane = makeLane({
      nowNodes: [{ id: 'n1', storyNumber: 1, title: 't', status: 'in-progress', kind: 'now', depth: 0 }],
      queueNodesByDepth: new Map([[0, [
        { id: 'q1', storyNumber: 1, title: 't', status: 'backlog', kind: 'queue', depth: 0 },
        { id: 'q2', storyNumber: 2, title: 't', status: 'backlog', kind: 'queue', depth: 0 },
      ]]]),
    });
    expect(computeLaneHeight(lane, 28, 0)).toBe(56); // 2 queue nodes * 28 > 1 now node * 28
  });

  it('adds one extra row for a depth column that has an overflow card (판C — 더보기 카드도 한 행)', () => {
    const lane = makeLane({
      queueNodesByDepth: new Map([[0, [{ id: 'q1', storyNumber: 1, title: 't', status: 'backlog', kind: 'queue', depth: 0 }]]]),
      overflows: [{ depth: 0, hiddenCount: 5 }],
    });
    expect(computeLaneHeight(lane, 28, 0)).toBe(56); // (1 card + 1 overflow card) * 28
  });
});

describe('shouldShowNoDeeperReason', () => {
  it('is true when depth-0 has nodes and no depth>=1 exists (org has 0 edges today)', () => {
    const lane = makeLane({ queueNodesByDepth: new Map([[0, [
      { id: 'q1', storyNumber: 1, title: 't', status: 'backlog', kind: 'queue', depth: 0 },
    ]]]) });
    expect(shouldShowNoDeeperReason(lane)).toBe(true);
  });

  it('is false once a depth>=1 node exists (edges landed — message must self-disappear)', () => {
    const lane = makeLane({ queueNodesByDepth: new Map([
      [0, [{ id: 'q1', storyNumber: 1, title: 't', status: 'backlog', kind: 'queue', depth: 0 }]],
      [1, [{ id: 'q2', storyNumber: 2, title: 't', status: 'backlog', kind: 'queue', depth: 1 }]],
    ]) });
    expect(shouldShowNoDeeperReason(lane)).toBe(false);
  });

  it('is false when the lane has no queue nodes at all (nothing to anchor the message to)', () => {
    expect(shouldShowNoDeeperReason(makeLane())).toBe(false);
  });
});
