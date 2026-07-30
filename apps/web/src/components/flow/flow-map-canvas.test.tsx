// @vitest-environment jsdom
//
// story #2224 후속(2026-07-30, 선생님 지시 + 유나양 4×2 규격, PO 전달) — 양성대조: "edges=[]를
// 항상 넘긴다"와 "받았는데 화면에 못 그린다"는 다른 병이다. edges=[]일 때 SVG 자체가 없는
// 것과, 실제 간선이 하나 있을 때 <line>이 실제로 그려지는 것을 왕복 확認한다 — DB에 아무것도
// 쓰지 않는 순수 컴포넌트 렌더 테스트("로컬에서만" 지시 그대로).
//
// 8종 양성대조(유나양 청구, PO 전달) — 축1(관계종류: 낳음/잇따름/대체/종미정) × 축2(확認
// 상태: 확定/제안) = 8. 하나만 찍으면 "갈리는지"를 못 보므로 여덟을 나란히 찍어 서로 다른
// marker-end/stroke-dasharray/색을 갖는지 값으로 확認한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { FlowMapCanvas } from './flow-map-canvas';
import type { FlowMapLane, FlowMapNode, FlowMapEdge, FlowMapEdgeKind } from './derive-flow-map';
import koMessages from '../../../messages/ko.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

function makeNode(overrides: Partial<FlowMapNode> = {}): FlowMapNode {
  return { id: 'n1', storyNumber: 1, title: 'Story', status: 'backlog', kind: 'now', depth: 0, ...overrides };
}

function makeEdge(overrides: Partial<FlowMapEdge> = {}): FlowMapEdge {
  return { fromNodeId: 'n1', toNodeId: 'u1', kind: null, confirmed: true, ...overrides };
}

function makeLane(overrides: Partial<FlowMapLane> = {}): FlowMapLane {
  return {
    epicId: 'e1', title: 'Epic 1', pastTotal: 0,
    nowNodes: [], queueNodesByDepth: new Map(), overflows: [], edges: [],
    pastBundle: { total: 0, internalCount: 0, outgoingCount: 0 }, pastNodes: [],
    ...overrides,
  };
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

describe('FlowMapCanvas — edge line rendering (양성대조)', () => {
  it('renders no <svg> at all when the lane has no edges (오늘 org 0행 상태와 동형)', async () => {
    const lane = makeLane({ nowNodes: [makeNode({ id: 'n1' })] });
    await act(async () => { root.render(wrap(<FlowMapCanvas lanes={[lane]} onSelectStory={() => {}} onTogglePastBundle={() => {}} isPastBundleLoading={false} />)); });
    expect(container.querySelector('svg')).toBeNull();
  });

  it('draws a visible <line> connecting two real node positions when the lane has one edge (양성대조 — 가짜 간선 하나)', async () => {
    const nowNode = makeNode({ id: 'n1', kind: 'now' });
    const queueNode = makeNode({ id: 'u1', kind: 'queue', depth: 0 });
    const lane = makeLane({
      nowNodes: [nowNode],
      queueNodesByDepth: new Map([[0, [queueNode]]]),
      edges: [makeEdge({ fromNodeId: 'n1', toNodeId: 'u1' })],
    });
    await act(async () => { root.render(wrap(<FlowMapCanvas lanes={[lane]} onSelectStory={() => {}} onTogglePastBundle={() => {}} isPastBundleLoading={false} />)); });
    const line = container.querySelector('line[data-edge-kind]');
    expect(line).not.toBeNull();
    // 좌표가 실제로 계산돼 들어갔는지(값으로 닫는다 — "보인다"와 "계산됐다"가 다르다는
    // 오늘의 규율 그대로) — now 노드 오른쪽 가장자리에서 queue 노드 왼쪽 가장자리로.
    expect(line?.getAttribute('x1')).not.toBe('0');
    expect(line?.getAttribute('x2')).not.toBe('0');
    expect(Number(line?.getAttribute('x2'))).toBeGreaterThan(Number(line?.getAttribute('x1')));
  });

  it('silently skips an edge whose endpoint position is unknown (defensive — does not crash)', async () => {
    const lane = makeLane({
      nowNodes: [makeNode({ id: 'n1' })],
      edges: [makeEdge({ fromNodeId: 'n1', toNodeId: 'ghost-not-rendered' })],
    });
    await act(async () => { root.render(wrap(<FlowMapCanvas lanes={[lane]} onSelectStory={() => {}} onTogglePastBundle={() => {}} isPastBundleLoading={false} />)); });
    expect(container.querySelector('line[data-edge-kind]')).toBeNull();
  });
});

describe('FlowMapCanvas — node click → open story panel (선생님 지적 2026-07-30, 동사 0개였다)', () => {
  it('clicking a node card calls onSelectStory with that node id', async () => {
    const onSelectStory = vi.fn();
    const lane = makeLane({ nowNodes: [makeNode({ id: 's-123' })] });
    await act(async () => { root.render(wrap(<FlowMapCanvas lanes={[lane]} onSelectStory={onSelectStory} onTogglePastBundle={() => {}} isPastBundleLoading={false} />)); });
    const button = container.querySelector('button');
    expect(button).not.toBeNull();
    await act(async () => { button?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onSelectStory).toHaveBeenCalledWith('s-123');
  });
});

// 8종 조합 — u0..u7을 큐 depth 0에 나란히 두고, n1(now)에서 각각으로 간선 하나씩.
const KIND_COMBOS: { kind: FlowMapEdgeKind; confirmed: boolean; label: string }[] = [
  { kind: 'spawn', confirmed: true, label: '낳음-확定' },
  { kind: 'spawn', confirmed: false, label: '낳음-제안' },
  { kind: 'then', confirmed: true, label: '잇따름-확定' },
  { kind: 'then', confirmed: false, label: '잇따름-제안' },
  { kind: 'supersede', confirmed: true, label: '대체-확定' },
  { kind: 'supersede', confirmed: false, label: '대체-제안' },
  { kind: null, confirmed: true, label: '종미정-확定' },
  { kind: null, confirmed: false, label: '종미정-제안' },
];

describe('FlowMapCanvas — 8종 양성대조(유나양 4×2 규격)', () => {
  it('draws all 8 kind×confirmed combinations as distinguishable lines (marker/dasharray/color 중 최소 하나는 서로 달라야 한다)', async () => {
    const nowNode = makeNode({ id: 'n1', kind: 'now' });
    const queueNodes = KIND_COMBOS.map((_, i) => makeNode({ id: `u${i}`, kind: 'queue', depth: 0 }));
    const edges = KIND_COMBOS.map((c, i) => makeEdge({ fromNodeId: 'n1', toNodeId: `u${i}`, kind: c.kind, confirmed: c.confirmed }));
    const lane = makeLane({
      nowNodes: [nowNode],
      queueNodesByDepth: new Map([[0, queueNodes]]),
      edges,
    });
    await act(async () => { root.render(wrap(<FlowMapCanvas lanes={[lane]} onSelectStory={() => {}} onTogglePastBundle={() => {}} isPastBundleLoading={false} />)); });
    const lines = Array.from(container.querySelectorAll('line[data-edge-kind]'));
    expect(lines).toHaveLength(8);

    const signatures = lines.map((line) => JSON.stringify({
      kind: line.getAttribute('data-edge-kind'),
      confirmed: line.getAttribute('data-edge-confirmed'),
      stroke: line.getAttribute('stroke'),
      dash: line.getAttribute('stroke-dasharray'),
      markerEnd: line.getAttribute('marker-end'),
      markerStart: line.getAttribute('marker-start'),
    }));
    // 8개 전부 서로 다른 시각 조합이어야 한다 — 하나라도 겹치면 "갈리지 않는" 것.
    expect(new Set(signatures).size).toBe(8);

    // 확認 여부 채널(축2)이 종류(축1)와 무관하게 항상 실선/점선을 가른다는 것도 값으로 닫는다.
    for (const line of lines) {
      const confirmed = line.getAttribute('data-edge-confirmed') === 'true';
      const dash = line.getAttribute('stroke-dasharray');
      if (confirmed) expect(dash).toBeNull();
      else expect(dash).not.toBeNull();
    }

    // 종 미정(kind=null)은 화살촉이 없어야 한다(유나양 지적 — 모르면 그 채널을 비운다).
    const unknownKindLines = lines.filter((l) => l.getAttribute('data-edge-kind') === 'unknown');
    expect(unknownKindLines).toHaveLength(2);
    for (const line of unknownKindLines) {
      expect(line.getAttribute('marker-end')).not.toContain('arrow');
    }

    // 대체(supersede)는 화살촉이 없고(막대 끝) 잇따름(then)만 시작점 마커(marker-start)를 갖는다.
    const supersedeLines = lines.filter((l) => l.getAttribute('data-edge-kind') === 'supersede');
    for (const line of supersedeLines) expect(line.getAttribute('marker-end')).toContain('bar');
    const thenLines = lines.filter((l) => l.getAttribute('data-edge-kind') === 'then');
    for (const line of thenLines) expect(line.getAttribute('marker-start')).not.toBeNull();
  });

  it('dims and strikes through the OLD node when a supersede edge is CONFIRMED', async () => {
    const nowNode = makeNode({ id: 'old', kind: 'now', title: '옛 스토리' });
    const queueNode = makeNode({ id: 'new', kind: 'queue', depth: 0, title: '새 스토리' });
    const lane = makeLane({
      nowNodes: [nowNode],
      queueNodesByDepth: new Map([[0, [queueNode]]]),
      edges: [makeEdge({ fromNodeId: 'old', toNodeId: 'new', kind: 'supersede', confirmed: true })],
    });
    await act(async () => { root.render(wrap(<FlowMapCanvas lanes={[lane]} onSelectStory={() => {}} onTogglePastBundle={() => {}} isPastBundleLoading={false} />)); });
    const oldTitle = Array.from(container.querySelectorAll('div')).find((d) => d.textContent === '옛 스토리');
    expect(oldTitle?.className).toContain('line-through');
  });

  it('does NOT dim the old node when a supersede edge is only PROPOSED (유나양 지적 — 확認 안 된 판정을 화면이 대신 안 낸다)', async () => {
    const nowNode = makeNode({ id: 'old', kind: 'now', title: '옛 스토리' });
    const queueNode = makeNode({ id: 'new', kind: 'queue', depth: 0, title: '새 스토리' });
    const lane = makeLane({
      nowNodes: [nowNode],
      queueNodesByDepth: new Map([[0, [queueNode]]]),
      edges: [makeEdge({ fromNodeId: 'old', toNodeId: 'new', kind: 'supersede', confirmed: false })],
    });
    await act(async () => { root.render(wrap(<FlowMapCanvas lanes={[lane]} onSelectStory={() => {}} onTogglePastBundle={() => {}} isPastBundleLoading={false} />)); });
    const oldTitle = Array.from(container.querySelectorAll('div')).find((d) => d.textContent === '옛 스토리');
    expect(oldTitle?.className).not.toContain('line-through');
  });

  it('shows the legend row only when at least one edge is actually drawn (빈 기능을 위한 상시 chrome을 만들지 않는다)', async () => {
    const withEdges = makeLane({
      nowNodes: [makeNode({ id: 'n1' })],
      queueNodesByDepth: new Map([[0, [makeNode({ id: 'u1', kind: 'queue' })]]]),
      edges: [makeEdge({ fromNodeId: 'n1', toNodeId: 'u1', kind: 'spawn', confirmed: true })],
    });
    await act(async () => { root.render(wrap(<FlowMapCanvas lanes={[withEdges]} onSelectStory={() => {}} onTogglePastBundle={() => {}} isPastBundleLoading={false} />)); });
    expect(container.textContent).toContain('낳음');

    const noEdges = makeLane({ nowNodes: [makeNode({ id: 'n1' })] });
    await act(async () => { root.render(wrap(<FlowMapCanvas lanes={[noEdges]} onSelectStory={() => {}} onTogglePastBundle={() => {}} isPastBundleLoading={false} />)); });
    expect(container.textContent).not.toContain('낳음');
  });
});

// 유나양 규격(아티팩트 a125909a, "묶음이 선을 통과시킨다") — 89%가 안 보이던 것의 답.
describe('FlowMapCanvas — past-bundle card (묶음이 선을 통과시킨다)', () => {
  it('renders all 3 lines of the bundle card (완료 N·묶음 / 안에서 이어진 것 M / 여기서 나온 다음 K건)', async () => {
    const lane = makeLane({
      pastTotal: 46,
      nowNodes: [makeNode({ id: 'n1' })],
      pastBundle: { total: 46, internalCount: 73, outgoingCount: 3 },
    });
    await act(async () => { root.render(wrap(<FlowMapCanvas lanes={[lane]} onSelectStory={() => {}} onTogglePastBundle={() => {}} isPastBundleLoading={false} />)); });
    expect(container.textContent).toContain('완료 46');
    expect(container.textContent).toContain('안에서 이어진 것 73');
    expect(container.textContent).toContain('여기서 나온 다음 3건');
  });

  it('draws a line from the bundle card to a rendered node when an edge resolves to PAST_BUNDLE_NODE_ID (기존 5개→더 그려짐)', async () => {
    const nowNode = makeNode({ id: 'n1', kind: 'now' });
    const lane = makeLane({
      pastTotal: 18,
      nowNodes: [nowNode],
      pastBundle: { total: 18, internalCount: 73, outgoingCount: 1 },
      edges: [makeEdge({ fromNodeId: '__past-bundle__', toNodeId: 'n1', kind: 'spawn', confirmed: false })],
    });
    await act(async () => { root.render(wrap(<FlowMapCanvas lanes={[lane]} onSelectStory={() => {}} onTogglePastBundle={() => {}} isPastBundleLoading={false} />)); });
    const line = container.querySelector('line[data-edge-kind="spawn"]');
    expect(line).not.toBeNull();
    // 묶음 카드는 폭이 다르다(110px) — 좌표가 실제로 그 카드 좌상단(left:20)에서 시작해야 한다.
    expect(Number(line?.getAttribute('x1'))).toBeGreaterThanOrEqual(20);
  });
});

describe('FlowMapCanvas — grouped edges (여러 선이 한 점에 모이면 굵기+수)', () => {
  it('draws ONE line (not N overlapping lines) when multiple edges share the same endpoints, with a count label', async () => {
    const nowNode = makeNode({ id: 'n1', kind: 'now' });
    const lane = makeLane({
      nowNodes: [nowNode],
      pastTotal: 5,
      pastBundle: { total: 5, internalCount: 0, outgoingCount: 3 },
      edges: [
        makeEdge({ fromNodeId: '__past-bundle__', toNodeId: 'n1', kind: 'spawn', confirmed: true }),
        makeEdge({ fromNodeId: '__past-bundle__', toNodeId: 'n1', kind: 'spawn', confirmed: true }),
        makeEdge({ fromNodeId: '__past-bundle__', toNodeId: 'n1', kind: 'spawn', confirmed: true }),
      ],
    });
    await act(async () => { root.render(wrap(<FlowMapCanvas lanes={[lane]} onSelectStory={() => {}} onTogglePastBundle={() => {}} isPastBundleLoading={false} />)); });
    const lines = container.querySelectorAll('line[data-edge-kind]');
    expect(lines).toHaveLength(1); // 3건이 겹쳐 하나로
    expect(lines[0]?.getAttribute('data-edge-count')).toBe('3');
    expect(lines[0]?.getAttribute('stroke-width')).toBe('2'); // 2~3건 = 2px
    expect(container.querySelector('text')?.textContent).toBe('3'); // 수를 선 위에
  });

  it('renders the line achromatic (no kind-specific color) when a group mixes different kinds (한 색으로 단정하지 않는다)', async () => {
    const nowNode = makeNode({ id: 'n1', kind: 'now' });
    const lane = makeLane({
      nowNodes: [nowNode],
      pastTotal: 5,
      pastBundle: { total: 5, internalCount: 0, outgoingCount: 2 },
      edges: [
        makeEdge({ fromNodeId: '__past-bundle__', toNodeId: 'n1', kind: 'spawn', confirmed: true }),
        makeEdge({ fromNodeId: '__past-bundle__', toNodeId: 'n1', kind: 'then', confirmed: true }),
      ],
    });
    await act(async () => { root.render(wrap(<FlowMapCanvas lanes={[lane]} onSelectStory={() => {}} onTogglePastBundle={() => {}} isPastBundleLoading={false} />)); });
    const line = container.querySelector('line[data-edge-kind="mixed"]');
    expect(line).not.toBeNull();
    expect(line?.getAttribute('stroke')).toBe('var(--muted-foreground)');
  });

  it('does not show a count label for a group of exactly 1 edge', async () => {
    const nowNode = makeNode({ id: 'n1', kind: 'now' });
    const lane = makeLane({
      nowNodes: [nowNode],
      pastTotal: 5,
      pastBundle: { total: 5, internalCount: 0, outgoingCount: 1 },
      edges: [makeEdge({ fromNodeId: '__past-bundle__', toNodeId: 'n1', kind: 'spawn', confirmed: true })],
    });
    await act(async () => { root.render(wrap(<FlowMapCanvas lanes={[lane]} onSelectStory={() => {}} onTogglePastBundle={() => {}} isPastBundleLoading={false} />)); });
    expect(container.querySelector('text')).toBeNull();
  });
});
