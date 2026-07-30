import { describe, expect, it } from 'vitest';
import {
  computeNodeDepth, deriveFlowMapLane, computeLaneHeight, shouldShowNoDeeperReason, FLOW_MAP_TOP_N,
  type FlowMapEdge, type FlowMapLane,
} from './derive-flow-map';
import type { EpicFlowNodeItem } from './derive-flow';

function makeItem(overrides: Partial<EpicFlowNodeItem> = {}): EpicFlowNodeItem {
  return { id: 's1', story_number: 1, title: 'Story', status: 'backlog', assignee_id: null, updated_at: '2026-07-30T00:00:00Z', ...overrides };
}

describe('computeNodeDepth', () => {
  it('returns 0 when there are no edges at all (today\'s reality — #2221 미착지, not a special case)', () => {
    expect(computeNodeDepth('a', [])).toBe(0);
  });

  it('returns 0 for a node with no incoming edges even when other edges exist', () => {
    const edges: FlowMapEdge[] = [{ fromNodeId: 'x', toNodeId: 'y' }];
    expect(computeNodeDepth('a', edges)).toBe(0);
  });

  it('computes depth via the longest incoming chain (a→b→c ⇒ c has depth 2)', () => {
    const edges: FlowMapEdge[] = [
      { fromNodeId: 'a', toNodeId: 'b' },
      { fromNodeId: 'b', toNodeId: 'c' },
    ];
    expect(computeNodeDepth('a', edges)).toBe(0);
    expect(computeNodeDepth('b', edges)).toBe(1);
    expect(computeNodeDepth('c', edges)).toBe(2);
  });

  it('takes the max depth among multiple incoming edges', () => {
    const edges: FlowMapEdge[] = [
      { fromNodeId: 'a', toNodeId: 'c' }, // a is depth 0 → c via a = 1
      { fromNodeId: 'b', toNodeId: 'x' },
      { fromNodeId: 'x', toNodeId: 'c' }, // x is depth 1 → c via x = 2
    ];
    expect(computeNodeDepth('c', edges)).toBe(2);
  });

  it('does not infinite-loop on a cycle (defensive — breaks at 0 on revisit)', () => {
    const edges: FlowMapEdge[] = [
      { fromNodeId: 'a', toNodeId: 'b' },
      { fromNodeId: 'b', toNodeId: 'a' },
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
    const edges: FlowMapEdge[] = [{ fromNodeId: 'u1', toNodeId: 'u2' }];
    const lane = deriveFlowMapLane('e1', 'Epic 1', 0, [], items, edges);
    expect(lane.queueNodesByDepth.get(0)?.map((n) => n.id)).toEqual(['u1']);
    expect(lane.queueNodesByDepth.get(1)?.map((n) => n.id)).toEqual(['u2']);
  });

  it('caps a depth column at FLOW_MAP_TOP_N and reports the rest as overflow (판C — 잘린 수를 정직하게)', () => {
    const items = Array.from({ length: FLOW_MAP_TOP_N + 2 }, (_, i) => makeItem({ id: `u${i}`, story_number: i }));
    const lane = deriveFlowMapLane('e1', 'Epic 1', 0, [], items, []);
    expect(lane.queueNodesByDepth.get(0)).toHaveLength(FLOW_MAP_TOP_N);
    expect(lane.overflows).toEqual([{ depth: 0, hiddenCount: 2 }]);
  });

  it('reports no overflow when a depth column has exactly TOP_N or fewer', () => {
    const items = Array.from({ length: FLOW_MAP_TOP_N }, (_, i) => makeItem({ id: `u${i}` }));
    const lane = deriveFlowMapLane('e1', 'Epic 1', 0, [], items, []);
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
      ...Array.from({ length: FLOW_MAP_TOP_N }, (_, i) => makeItem({ id: `u${i}`, status: 'backlog' })),
      makeItem({ id: 'blocked1', status: 'blocked' }),
    ];
    const lane = deriveFlowMapLane('e1', 'Epic 1', 0, [], items, []);
    expect(lane.queueNodesByDepth.get(0)?.map((n) => n.id)).toContain('blocked1');
    expect(lane.overflows).toEqual([{ depth: 0, hiddenCount: 1 }]);
  });
});

function makeLane(overrides: Partial<FlowMapLane> = {}): FlowMapLane {
  return {
    epicId: 'e1', title: 'Epic 1', pastTotal: 0,
    nowNodes: [], queueNodesByDepth: new Map(), overflows: [],
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
