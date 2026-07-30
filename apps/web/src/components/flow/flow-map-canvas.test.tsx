// @vitest-environment jsdom
//
// story #2224 후속(2026-07-30, 선생님 지시) — 양성대조: "edges=[]를 항상 넘긴다"와
// "받았는데 화면에 못 그린다"는 다른 병이다. edges=[]일 때 SVG 자체가 없는 것과, 실제
// 간선이 하나 있을 때 <line>이 실제로 그려지는 것을 왕복 확認한다 — DB에 아무것도 쓰지
// 않는 순수 컴포넌트 렌더 테스트("로컬에서만" 지시 그대로).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { FlowMapCanvas } from './flow-map-canvas';
import type { FlowMapLane, FlowMapNode } from './derive-flow-map';
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

function makeLane(overrides: Partial<FlowMapLane> = {}): FlowMapLane {
  return {
    epicId: 'e1', title: 'Epic 1', pastTotal: 0,
    nowNodes: [], queueNodesByDepth: new Map(), overflows: [], edges: [],
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
    await act(async () => { root.render(wrap(<FlowMapCanvas lanes={[lane]} />)); });
    expect(container.querySelector('svg')).toBeNull();
  });

  it('draws a visible <line> connecting two real node positions when the lane has one edge (양성대조 — 가짜 간선 하나)', async () => {
    const nowNode = makeNode({ id: 'n1', kind: 'now' });
    const queueNode = makeNode({ id: 'u1', kind: 'queue', depth: 0 });
    const lane = makeLane({
      nowNodes: [nowNode],
      queueNodesByDepth: new Map([[0, [queueNode]]]),
      edges: [{ fromNodeId: 'n1', toNodeId: 'u1' }],
    });
    await act(async () => { root.render(wrap(<FlowMapCanvas lanes={[lane]} />)); });
    const line = container.querySelector('svg line');
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
      edges: [{ fromNodeId: 'n1', toNodeId: 'ghost-not-rendered' }],
    });
    await act(async () => { root.render(wrap(<FlowMapCanvas lanes={[lane]} />)); });
    expect(container.querySelector('svg line')).toBeNull();
  });
});
