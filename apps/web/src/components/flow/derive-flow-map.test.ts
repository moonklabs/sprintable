import { describe, expect, it } from 'vitest';
import {
  computeNodeDepth, deriveFlowMapLane, computeLaneHeight,
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

  it('does not truncate a depth column (top-N truncation is a later stage, not built yet)', () => {
    const items = Array.from({ length: 20 }, (_, i) => makeItem({ id: `u${i}`, story_number: i }));
    const lane = deriveFlowMapLane('e1', 'Epic 1', 0, [], items, []);
    expect(lane.queueNodesByDepth.get(0)).toHaveLength(20);
  });
});

function makeLane(overrides: Partial<FlowMapLane> = {}): FlowMapLane {
  return {
    epicId: 'e1', title: 'Epic 1', pastTotal: 0,
    nowNodes: [], queueNodesByDepth: new Map(),
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
});
