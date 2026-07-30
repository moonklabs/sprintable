import { describe, expect, it } from 'vitest';
import {
  computeNodeDepth, deriveFlowMapLane, computeLaneHeight, shouldShowNoDeeperReason, computeNodePositions,
  computeNodeLogicalPositions, computeEdgeLineEndpoints, groupEdgesByEndpoints, edgeGroupStrokeWidth,
  parseDependencyGraphEdges, parseReferenceCandidateEdges, FLOW_MAP_TOP_N, FLOW_MAP_FOLD_THRESHOLD,
  FLOW_MAP_DEPTH0_X, FLOW_MAP_GRID_STEP, PAST_BUNDLE_NODE_ID,
  type FlowMapEdge, type FlowMapLane, type RawReferenceCandidate,
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

  // 유나양 규격(아티팩트 a125909a, "묶음이 선을 통과시킨다") — 89%(147건 중 131건)가 과거에
  // 닿아 안 그려지던 것의 답. pastTotal>0(묶음 카드가 실재)일 때만 aliveIds 밖 id를 "과거"로
  // 해석해 PAST_BUNDLE_NODE_ID로 해소한다.
  describe('past-bundle edge resolution (묶음이 선을 통과시킨다)', () => {
    it('resolves an edge FROM a past story TO a rendered node as outgoing (fromNodeId → PAST_BUNDLE_NODE_ID)', () => {
      const edges: FlowMapEdge[] = [edge('past-story', 'n1')];
      const lane = deriveFlowMapLane('e1', 'Epic 1', 5, [makeItem({ id: 'n1' })], [], edges);
      expect(lane.edges).toEqual([{ fromNodeId: PAST_BUNDLE_NODE_ID, toNodeId: 'n1', kind: null, confirmed: true }]);
      expect(lane.pastBundle.outgoingCount).toBe(1);
      expect(lane.pastBundle.internalCount).toBe(0);
    });

    it('resolves an edge FROM a rendered node TO a past story as incoming (toNodeId → PAST_BUNDLE_NODE_ID) — not counted as outgoing', () => {
      const edges: FlowMapEdge[] = [edge('n1', 'past-story')];
      const lane = deriveFlowMapLane('e1', 'Epic 1', 5, [makeItem({ id: 'n1' })], [], edges);
      expect(lane.edges).toEqual([{ fromNodeId: 'n1', toNodeId: PAST_BUNDLE_NODE_ID, kind: null, confirmed: true }]);
      expect(lane.pastBundle.outgoingCount).toBe(0); // "여기서 나온 다음"이 아니다(과거가 source가 아님).
    });

    it('counts (but does not draw) an edge where BOTH endpoints are past — a loop the bundle card cannot draw to itself', () => {
      const edges: FlowMapEdge[] = [edge('past-a', 'past-b')];
      const lane = deriveFlowMapLane('e1', 'Epic 1', 10, [makeItem({ id: 'n1' })], [], edges);
      expect(lane.edges).toEqual([]); // 그릴 수 없다 — 그러나 안 잃는다(아래).
      expect(lane.pastBundle.internalCount).toBe(1);
    });

    it('exposes pastBundle.total equal to pastTotal (1줄 "완료 N·묶음"의 재료)', () => {
      const lane = deriveFlowMapLane('e1', 'Epic 1', 46, [], [], []);
      expect(lane.pastBundle.total).toBe(46);
    });

    it('does NOT resolve to the bundle when pastTotal is 0 (no bundle card exists to attach to)', () => {
      const edges: FlowMapEdge[] = [edge('unknown', 'n1')];
      const lane = deriveFlowMapLane('e1', 'Epic 1', 0, [makeItem({ id: 'n1' })], [], edges);
      expect(lane.edges).toEqual([]);
      expect(lane.pastBundle.outgoingCount).toBe(0);
      expect(lane.pastBundle.internalCount).toBe(0);
    });
  });

  // 유나양 규격(아티팩트 a125909a, "펼친 상태") — 묶음 카드를 누르면(pastItems가 채워지면)
  // 과거 스토리도 개별 좌표를 갖고, 이전엔 안 그려지던(internalCount) 양끝-다-과거 간선도
  // 이제 실제로 그려진다("안에서 이어진 것도 그 틀 안에서 보입니다").
  describe('past-bundle expansion (묶음을 누르면 펼쳐진다 — 이것이 곧 줌인)', () => {
    it('populates pastNodes from pastItems, kind="past"', () => {
      const pastItems = [makeItem({ id: 'p1', story_number: 10, title: 'Old story' })];
      const lane = deriveFlowMapLane('e1', 'Epic 1', 1, [], [], [], pastItems);
      expect(lane.pastNodes).toEqual([{ id: 'p1', storyNumber: 10, title: 'Old story', status: 'backlog', kind: 'past', depth: 0 }]);
    });

    it('draws a direct edge between two past nodes once both are expanded (no longer counted in internalCount)', () => {
      const pastItems = [makeItem({ id: 'past-a' }), makeItem({ id: 'past-b', story_number: 2 })];
      const edges: FlowMapEdge[] = [edge('past-a', 'past-b')];
      const lane = deriveFlowMapLane('e1', 'Epic 1', 2, [], [], edges, pastItems);
      expect(lane.edges).toEqual([edge('past-a', 'past-b')]);
      expect(lane.pastBundle.internalCount).toBe(0); // 접힌 상태였다면 1이었을 것.
    });

    it('draws a direct edge from a past node to an alive node once expanded (no bundle resolution needed)', () => {
      const pastItems = [makeItem({ id: 'past-a' })];
      const edges: FlowMapEdge[] = [edge('past-a', 'n1')];
      const lane = deriveFlowMapLane('e1', 'Epic 1', 1, [makeItem({ id: 'n1' })], [], edges, pastItems);
      expect(lane.edges).toEqual([edge('past-a', 'n1')]); // PAST_BUNDLE_NODE_ID로 안 바뀐다.
      expect(lane.pastBundle.outgoingCount).toBe(0); // 집계는 접힌 상태에서만 의미가 있다.
    });

    it('drops an edge whose past endpoint is NOT among the fetched pastItems (partial/unexpanded reference)', () => {
      const pastItems = [makeItem({ id: 'past-a' })]; // 'past-ghost'는 안 옴
      const edges: FlowMapEdge[] = [edge('past-ghost', 'n1')];
      const lane = deriveFlowMapLane('e1', 'Epic 1', 5, [makeItem({ id: 'n1' })], [], edges, pastItems);
      expect(lane.edges).toEqual([]); // 묶음도 이미 사라졌고 개별 좌표도 없다 — 유령 선 방지.
    });
  });
});

describe('computeNodeLogicalPositions — past-bundle anchor', () => {
  it('gives PAST_BUNDLE_NODE_ID a fixed position when pastTotal > 0', () => {
    const lane = deriveFlowMapLane('e1', 'Epic 1', 5, [], [], []);
    const positions = computeNodeLogicalPositions(lane);
    expect(positions.get(PAST_BUNDLE_NODE_ID)).toEqual({ column: 'past-bundle', row: 0 });
  });

  it('has no entry for PAST_BUNDLE_NODE_ID when pastTotal is 0 (no card to point to)', () => {
    const lane = deriveFlowMapLane('e1', 'Epic 1', 0, [], [], []);
    const positions = computeNodeLogicalPositions(lane);
    expect(positions.has(PAST_BUNDLE_NODE_ID)).toBe(false);
  });

  it('positions each pastNode at column "past-expanded" stacked by row index, and drops the bundle anchor (펼치면 집계 카드가 사라진다)', () => {
    const pastItems = [makeItem({ id: 'p1' }), makeItem({ id: 'p2', story_number: 2 })];
    const lane = deriveFlowMapLane('e1', 'Epic 1', 2, [], [], [], pastItems);
    const positions = computeNodeLogicalPositions(lane);
    expect(positions.get('p1')).toEqual({ column: 'past-expanded', row: 0 });
    expect(positions.get('p2')).toEqual({ column: 'past-expanded', row: 1 });
    expect(positions.has(PAST_BUNDLE_NODE_ID)).toBe(false);
  });
});

describe('groupEdgesByEndpoints', () => {
  it('groups multiple edges sharing the same (from,to) pair into one group with the right count', () => {
    const edges: FlowMapEdge[] = [
      edge('a', 'b', { kind: 'spawn' }),
      edge('a', 'b', { kind: 'spawn' }),
      edge('a', 'b', { kind: 'spawn' }),
    ];
    const groups = groupEdgesByEndpoints(edges);
    expect(groups).toEqual([{ fromNodeId: 'a', toNodeId: 'b', count: 3, uniformKind: 'spawn', allConfirmed: true }]);
  });

  it('keeps distinct (from,to) pairs as separate groups', () => {
    const edges: FlowMapEdge[] = [edge('a', 'b'), edge('a', 'c')];
    const groups = groupEdgesByEndpoints(edges);
    expect(groups).toHaveLength(2);
  });

  it('marks uniformKind as "mixed" when a group contains different kinds (색을 한 종으로 단정하지 않는다)', () => {
    const edges: FlowMapEdge[] = [edge('a', 'b', { kind: 'spawn' }), edge('a', 'b', { kind: 'then' })];
    const [group] = groupEdgesByEndpoints(edges);
    expect(group!.uniformKind).toBe('mixed');
  });

  it('marks allConfirmed false when any edge in the group is proposed (제안 하나를 확定인 척 그리지 않는다)', () => {
    const edges: FlowMapEdge[] = [edge('a', 'b', { confirmed: true }), edge('a', 'b', { confirmed: false })];
    const [group] = groupEdgesByEndpoints(edges);
    expect(group!.allConfirmed).toBe(false);
  });
});

describe('edgeGroupStrokeWidth', () => {
  it('returns the thin width for exactly 1 edge', () => {
    expect(edgeGroupStrokeWidth(1)).toBe(1.4);
  });
  it('returns the medium width for 2~3 edges', () => {
    expect(edgeGroupStrokeWidth(2)).toBe(2);
    expect(edgeGroupStrokeWidth(3)).toBe(2);
  });
  it('returns the thick width for 4+ edges', () => {
    expect(edgeGroupStrokeWidth(4)).toBe(2.6);
    expect(edgeGroupStrokeWidth(10)).toBe(2.6);
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

function makeCandidate(overrides: Partial<RawReferenceCandidate> = {}): RawReferenceCandidate {
  return { id: 'c1', source_id: 's1', target_id: 't1', relation_kind: null, status: 'estimated', ...overrides };
}

describe('parseReferenceCandidateEdges', () => {
  it('keeps spawned(source→target) direction as-is — source spawned target, source is first', () => {
    const edges = parseReferenceCandidateEdges([makeCandidate({ source_id: 'a', target_id: 'b', relation_kind: 'spawned' })]);
    expect(edges).toEqual([{ fromNodeId: 'a', toNodeId: 'b', kind: 'spawn', confirmed: false }]);
  });

  it('flips followed(source→target) — source follows target, so target is first', () => {
    const edges = parseReferenceCandidateEdges([makeCandidate({ source_id: 'a', target_id: 'b', relation_kind: 'followed' })]);
    expect(edges).toEqual([{ fromNodeId: 'b', toNodeId: 'a', kind: 'then', confirmed: false }]);
  });

  it('flips superseded(source→target) — source supersedes target, so target is the OLD one, first', () => {
    const edges = parseReferenceCandidateEdges([makeCandidate({ source_id: 'a', target_id: 'b', relation_kind: 'superseded' })]);
    expect(edges).toEqual([{ fromNodeId: 'b', toNodeId: 'a', kind: 'supersede', confirmed: false }]);
  });

  it('keeps NULL(종 미정) direction as source→target — kind unknown but direction (who mentioned whom) is still known', () => {
    const edges = parseReferenceCandidateEdges([makeCandidate({ source_id: 'a', target_id: 'b', relation_kind: null })]);
    expect(edges).toEqual([{ fromNodeId: 'a', toNodeId: 'b', kind: null, confirmed: false }]);
  });

  it('maps status=declared to confirmed=true and status=estimated to confirmed=false', () => {
    const declared = parseReferenceCandidateEdges([makeCandidate({ relation_kind: 'spawned', status: 'declared' })]);
    expect(declared[0]?.confirmed).toBe(true);
    const estimated = parseReferenceCandidateEdges([makeCandidate({ relation_kind: 'spawned', status: 'estimated' })]);
    expect(estimated[0]?.confirmed).toBe(false);
  });

  // 오르테가군 확定(2026-07-30) — 이 셋은 "다음 흐름" 화살표가 아니라 노드 상세의 참조
  // 목록으로 가는 별도 재료다. 버리는 게 아니라 "이 함수의 반환값에는 안 실린다"는 뜻.
  it('drops cited_as_evidence, similar_case, and explicitly_unrelated — not directional, not drawn as flow-map edges', () => {
    const edges = parseReferenceCandidateEdges([
      makeCandidate({ relation_kind: 'cited_as_evidence' }),
      makeCandidate({ relation_kind: 'similar_case' }),
      makeCandidate({ relation_kind: 'explicitly_unrelated' }),
    ]);
    expect(edges).toEqual([]);
  });

  it('returns an empty array for an empty response', () => {
    expect(parseReferenceCandidateEdges([])).toEqual([]);
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

// 라이브 실측 자가발견(2026-07-30, PR#2706 배포 후) — 실제로 x1===x2===732, y1===y2===16으로
// 완전히 겹친 선(0길이, 화면에 안 보임)이 라이브에서 나왔다. 카드 너비(110)와 그리드 간격(110)이
// 같아 인접 depth·같은 행 사이 간격이 0인 게 원인 — 재현 케이스를 그대로 고정한다.
describe('computeEdgeLineEndpoints', () => {
  it('returns null when either endpoint has no position (truncated node)', () => {
    const positions = new Map([['a', { left: 0, top: 0 }]]);
    expect(computeEdgeLineEndpoints(positions, edge('a', 'ghost'), { width: 110, height: 24 })).toBeNull();
  });

  it('connects a card\'s right edge to the target card\'s left edge for a normal (non-adjacent) gap', () => {
    const positions = new Map([
      ['a', { left: 100, top: 0 }],
      ['b', { left: 300, top: 0 }],
    ]);
    const coords = computeEdgeLineEndpoints(positions, edge('a', 'b'), { width: 110, height: 24 });
    expect(coords).toEqual({ x1: 210, y1: 12, x2: 300, y2: 12 });
  });

  // 라이브 재현 — depth2(left=622)→depth3(left=732), 같은 행(top=4): 카드너비(110)=
  // 그리드간격(110)이라 x1(622+110=732)===x2(732), y1===y2 ⇒ 고침 전엔 0길이였다.
  it('nudges endpoints apart when they would otherwise collapse to the same point (실 재현)', () => {
    const positions = new Map([
      ['from', { left: 622, top: 4 }],
      ['to', { left: 732, top: 4 }],
    ]);
    const coords = computeEdgeLineEndpoints(positions, edge('from', 'to'), { width: 110, height: 24 });
    expect(coords).not.toBeNull();
    const dx = coords!.x2 - coords!.x1;
    const dy = coords!.y2 - coords!.y1;
    expect(Math.sqrt(dx * dx + dy * dy)).toBeGreaterThanOrEqual(6);
    expect(coords!.x1).not.toBe(coords!.x2); // 고침 전엔 여기서 732===732로 실패했다.
  });
});

function makeLane(overrides: Partial<FlowMapLane> = {}): FlowMapLane {
  return {
    epicId: 'e1', title: 'Epic 1', pastTotal: 0,
    nowNodes: [], queueNodesByDepth: new Map(), overflows: [], edges: [],
    pastBundle: { total: 0, internalCount: 0, outgoingCount: 0 }, pastNodes: [],
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
