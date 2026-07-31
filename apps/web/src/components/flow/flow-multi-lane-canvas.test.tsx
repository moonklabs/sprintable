// @vitest-environment jsdom
//
// story #2224 AC1(멀티레인, 2026-07-31) — N개 목표를 병렬로 fetch해 하나의 캔버스에 레인으로
// 쌓는 것과, dependencies/graph가 «레인마다 다시»가 아니라 «한 번만» 불리는 것, 그리고
// 접힘 줄(foldedCount)이 정직하게 뜨는 것을 왕복 확認한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { FlowMultiLaneCanvas } from './flow-multi-lane-canvas';
import type { NextMakerGoal } from './derive-next-maker';
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

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response;
}

function goal(overrides: Partial<NextMakerGoal> = {}): NextMakerGoal {
  return { id: 'e1', title: 'Epic 1', status: 'active', totalStories: 5, doneStories: 1, ...overrides };
}

function emptyFlowNodes(epicId: string) {
  return { data: { epic_id: epicId, now: { total: 0, items: [] }, upcoming: { total: 0, shown: 0, items: [] }, past: { total: 0 }, blocked_count: 0, last_changed_at: null } };
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

describe('FlowMultiLaneCanvas — N개 레인 병렬 fetch', () => {
  it('fetches each expandGoal epic-flow-nodes/reference-candidates in parallel, and dependencies/graph exactly ONCE (not once per lane)', async () => {
    const calledUrls: string[] = [];
    let graphCallCount = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calledUrls.push(url);
      if (url.includes('/api/dependencies/graph')) {
        graphCallCount += 1;
        return jsonResponse({ item_type: 'story', nodes: [], edges: [] });
      }
      if (url.includes('/api/analytics/epic-flow-nodes')) {
        const epicId = new URL(url, 'http://x').searchParams.get('epic_id')!;
        return jsonResponse(emptyFlowNodes(epicId));
      }
      if (url.includes('/api/goals/') && url.includes('/reference-candidates')) {
        return jsonResponse([]);
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(wrap(
        <FlowMultiLaneCanvas
          projectId="p1"
          expandGoals={[goal({ id: 'e1', title: 'Epic 1' }), goal({ id: 'e2', title: 'Epic 2' })]}
          foldedCount={0}
          onSelectStory={() => {}}
        />,
      ));
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(calledUrls.some((u) => u.includes('epic_id=e1'))).toBe(true);
    expect(calledUrls.some((u) => u.includes('epic_id=e2'))).toBe(true);
    expect(calledUrls.some((u) => u.includes('/api/goals/e1/reference-candidates'))).toBe(true);
    expect(calledUrls.some((u) => u.includes('/api/goals/e2/reference-candidates'))).toBe(true);
    // §I-6 "두 벌 서지 않는다" — 프로젝트 전체 그래프는 레인 수와 무관하게 한 번만.
    expect(graphCallCount).toBe(1);

    expect(container.textContent).toContain('Epic 1');
    expect(container.textContent).toContain('Epic 2');
  });

  it('renders the folded-count row with the "숨긴 것이 아니라 접은 것" reason when foldedCount > 0', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/dependencies/graph')) return jsonResponse({ item_type: 'story', nodes: [], edges: [] });
      if (url.includes('/api/analytics/epic-flow-nodes')) return jsonResponse(emptyFlowNodes('e1'));
      if (url.includes('/reference-candidates')) return jsonResponse([]);
      throw new Error(`unexpected fetch: ${url}`);
    }));

    await act(async () => {
      root.render(wrap(
        <FlowMultiLaneCanvas projectId="p1" expandGoals={[goal({ id: 'e1' })]} foldedCount={23} onSelectStory={() => {}} />,
      ));
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(container.textContent).toContain('움직임 없는 목표 23개');
    expect(container.textContent).toContain('숨긴 것이 아니라 접은 것입니다');
  });

  it('does NOT render the folded-count row when foldedCount is 0 (nothing to explain)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/dependencies/graph')) return jsonResponse({ item_type: 'story', nodes: [], edges: [] });
      if (url.includes('/api/analytics/epic-flow-nodes')) return jsonResponse(emptyFlowNodes('e1'));
      if (url.includes('/reference-candidates')) return jsonResponse([]);
      throw new Error(`unexpected fetch: ${url}`);
    }));

    await act(async () => {
      root.render(wrap(
        <FlowMultiLaneCanvas projectId="p1" expandGoals={[goal({ id: 'e1' })]} foldedCount={0} onSelectStory={() => {}} />,
      ));
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(container.textContent).not.toContain('움직임 없는 목표');
  });

  it('renders nothing but the (empty) folded row when expandGoals is empty — no crash, no phantom lane', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/dependencies/graph')) return jsonResponse({ item_type: 'story', nodes: [], edges: [] });
      throw new Error(`unexpected fetch: ${url}`);
    }));

    await act(async () => {
      root.render(wrap(
        <FlowMultiLaneCanvas projectId="p1" expandGoals={[]} foldedCount={5} onSelectStory={() => {}} />,
      ));
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(container.querySelector('line[data-edge-kind]')).toBeNull();
    expect(container.textContent).toContain('움직임 없는 목표 5개');
  });

  it('clicking a node calls onSelectStory with that node id (delegates straight to FlowMapCanvas)', async () => {
    const onSelectStory = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/dependencies/graph')) return jsonResponse({ item_type: 'story', nodes: [], edges: [] });
      if (url.includes('/api/analytics/epic-flow-nodes')) {
        return jsonResponse({
          data: {
            epic_id: 'e1',
            now: { total: 1, items: [{ id: 'n1', story_number: 1, title: 'Now Story', status: 'in-progress', assignee_id: null, updated_at: '2026-07-30T00:00:00Z' }] },
            upcoming: { total: 0, shown: 0, items: [] }, past: { total: 0 }, blocked_count: 0, last_changed_at: null,
          },
        });
      }
      if (url.includes('/reference-candidates')) return jsonResponse([]);
      throw new Error(`unexpected fetch: ${url}`);
    }));

    await act(async () => {
      root.render(wrap(
        <FlowMultiLaneCanvas projectId="p1" expandGoals={[goal({ id: 'e1' })]} foldedCount={0} onSelectStory={onSelectStory} />,
      ));
      await new Promise((r) => setTimeout(r, 0));
    });

    // story #2353(포트) 후속 — data-node-id는 카드 wrapper(div)에 있고, 클릭 핸들러는 그
    // 안의 「카드 열기」button에 있다(포트 버튼과 형제로 서는 구조, flow-map-canvas.tsx 참고).
    const button = container.querySelector('[data-node-id="n1"] button') as HTMLElement;
    expect(button).not.toBeNull();
    await act(async () => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onSelectStory).toHaveBeenCalledWith('n1');
  });

  it('a lane that fails to fetch (epic-flow-nodes error) is silently dropped — one bad lane does not kill the whole canvas', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/dependencies/graph')) return jsonResponse({ item_type: 'story', nodes: [], edges: [] });
      if (url.includes('/api/analytics/epic-flow-nodes')) {
        const epicId = new URL(url, 'http://x').searchParams.get('epic_id')!;
        if (epicId === 'e-bad') return { ok: false, json: async () => null } as Response;
        return jsonResponse(emptyFlowNodes(epicId));
      }
      if (url.includes('/reference-candidates')) return jsonResponse([]);
      throw new Error(`unexpected fetch: ${url}`);
    }));

    await act(async () => {
      root.render(wrap(
        <FlowMultiLaneCanvas
          projectId="p1"
          expandGoals={[goal({ id: 'e-bad', title: 'Bad Epic' }), goal({ id: 'e-good', title: 'Good Epic' })]}
          foldedCount={0}
          onSelectStory={() => {}}
        />,
      ));
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(container.textContent).not.toContain('Bad Epic');
    expect(container.textContent).toContain('Good Epic');
  });

  // 유나+까심 가디언 리뷰(2026-07-31, PR#2737) 회귀 가드 — "레인 간 연결은 오늘 안 다룬다"고
  // 문서에만 적고 실제로는 안 막던 결함의 정확한 재현. 레인 A의 포트를 레인 B의 노드로 끌면
  // POST가 실제로 나가 서버에 candidate가 생기는데(ok:true), deriveFlowMapLane이 다른 레인
  // 좌표계의 선을 못 그려 "성공했는데 화면은 조용한" 상태가 됐다 — 이젠 놓기 자체가 막힌다.
  it('dragging a port from lane e1 to a node in lane e2 does NOT fire the create-link POST (cross-lane guard)', async () => {
    const calledUrls: string[] = [];
    const createLinkCalls: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calledUrls.push(url);
      if (init?.method === 'POST' && url.includes('/reference-candidates')) {
        createLinkCalls.push({ url, body: init.body });
        return jsonResponse({ id: 'new-candidate', target_id: 'n2', relation_kind: null, status: 'declared', declared_by: 'm1', declared_at: '2026-07-31T00:00:00Z' });
      }
      if (url.includes('/api/dependencies/graph')) return jsonResponse({ item_type: 'story', nodes: [], edges: [] });
      if (url.includes('/api/analytics/epic-flow-nodes')) {
        const epicId = new URL(url, 'http://x').searchParams.get('epic_id')!;
        if (epicId === 'e1') {
          return jsonResponse({ data: { epic_id: 'e1', now: { total: 1, items: [{ id: 'n1', story_number: 1, title: 'Lane1 Story', status: 'in-progress', assignee_id: null, updated_at: '2026-07-30T00:00:00Z' }] }, upcoming: { total: 0, shown: 0, items: [] }, past: { total: 0 }, blocked_count: 0, last_changed_at: null } });
        }
        return jsonResponse({ data: { epic_id: 'e2', now: { total: 1, items: [{ id: 'n2', story_number: 2, title: 'Lane2 Story', status: 'in-progress', assignee_id: null, updated_at: '2026-07-30T00:00:00Z' }] }, upcoming: { total: 0, shown: 0, items: [] }, past: { total: 0 }, blocked_count: 0, last_changed_at: null } });
      }
      if (url.includes('/reference-candidates')) return jsonResponse([]);
      throw new Error(`unexpected fetch: ${url}`);
    }));

    await act(async () => {
      root.render(wrap(
        <FlowMultiLaneCanvas
          projectId="p1"
          expandGoals={[goal({ id: 'e1', title: 'Epic 1' }), goal({ id: 'e2', title: 'Epic 2' })]}
          foldedCount={0}
          onSelectStory={() => {}}
        />,
      ));
      await new Promise((r) => setTimeout(r, 0));
    });

    const port = container.querySelector('[data-node-id="n1"] button[aria-label]') as HTMLElement;
    expect(port).not.toBeNull();
    const targetWrapper = container.querySelector('[data-node-id="n2"]')!;
    document.elementFromPoint = vi.fn(() => targetWrapper);

    await act(async () => {
      const down = new Event('pointerdown', { bubbles: true, cancelable: true }) as PointerEvent;
      Object.assign(down, { clientX: 10, clientY: 10, pointerId: 1 });
      port.dispatchEvent(down);
    });
    await act(async () => {
      const up = new Event('pointerup', { bubbles: true, cancelable: true }) as PointerEvent;
      Object.assign(up, { clientX: 200, clientY: 10, pointerId: 1 });
      window.dispatchEvent(up);
    });

    expect(document.body.querySelector('[data-slot="dialog-title"]')).toBeNull();
    expect(createLinkCalls).toHaveLength(0);
  });
});

// story #2369 QA 후속(2026-07-31, 라이브 실측 — dev-app 1440×900) — merged PR#2753가 AC를
// 못 채웠다: 오프스크린(가로 잘림) 힌트가 `FlowMapCanvas`(세로 클리핑되는 쪽) 자신의
// `absolute bottom-1`로 붙어 있어, 그 조상 `FlowCanvasResizePane`(`overflow-y-auto`로
// 실제 세로 클리핑하는 «보이는 창»)의 전체 콘텐츠 맨 아래(스크롤 1814px 아래)로 가버려
// 기본 상태에서 화면에 0%였다. 이 테스트는 힌트가 실제 클리핑 컨테이너
// (`[data-testid="flow-canvas-resize-pane"]`)의 «직계 자식»으로 붙어(그 자신은 클리핑
// «대상»이 아니라 클리핑하는 쪽이므로 세로 스크롤과 무관하게 항상 보인다) 정확히 하나만
// 존재하는지 확認한다 — FlowMapCanvas 안에서 또 그려 중복되는 것도 여기서 잡힌다.
describe('FlowMultiLaneCanvas — story #2369 QA 후속: 오프스크린 힌트가 실제 클리핑 창 기준으로 뜬다', () => {
  let originalClientWidth: PropertyDescriptor | undefined;
  let originalScrollWidth: PropertyDescriptor | undefined;

  beforeEach(() => {
    originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
    originalScrollWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth');
    // depth 0 열의 기본 화면 좌표(FLOW_MAP_DEPTH0_X=402 + LANE_LABEL_WIDTH=150 = 552)보다
    // 좁은 500으로 둬 depth-0 카드 하나만으로도(멀티 depth·edges 없이) 곧바로 offscreen이
    // 되도록 한다 — LANE_LABEL_WIDTH 보정이 실제로 적용됐는지까지 같이 잡는 값.
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 500; } });
    Object.defineProperty(HTMLElement.prototype, 'scrollWidth', { configurable: true, get() { return 1000; } });
  });

  afterEach(() => {
    if (originalClientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth);
    if (originalScrollWidth) Object.defineProperty(HTMLElement.prototype, 'scrollWidth', originalScrollWidth);
  });

  it('renders exactly one offscreen-hint, as a direct child of the resize-pane (the actual vertically-clipping ancestor) — not inside FlowMapCanvas', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/dependencies/graph')) return jsonResponse({ item_type: 'story', nodes: [], edges: [] });
      if (url.includes('/api/analytics/epic-flow-nodes')) {
        return jsonResponse({
          data: {
            epic_id: 'e1',
            now: { total: 0, items: [] },
            upcoming: { total: 1, shown: 1, items: [{ id: 'q1', story_number: 9, title: 'Queued Story', status: 'backlog', assignee_id: null, updated_at: '2026-07-31T00:00:00Z' }] },
            past: { total: 0 }, blocked_count: 0, last_changed_at: null,
          },
        });
      }
      if (url.includes('/reference-candidates')) return jsonResponse([]);
      throw new Error(`unexpected fetch: ${url}`);
    }));

    await act(async () => {
      root.render(wrap(
        <FlowMultiLaneCanvas projectId="p1" expandGoals={[goal({ id: 'e1' })]} foldedCount={0} onSelectStory={() => {}} />,
      ));
      await new Promise((r) => setTimeout(r, 0));
    });

    const hints = container.querySelectorAll('[data-testid="flow-canvas-offscreen-hint"]');
    expect(hints).toHaveLength(1);
    expect(hints[0]?.textContent).toContain('카드 1장이 화면 밖');

    const resizePane = container.querySelector('[data-testid="flow-canvas-resize-pane"]');
    expect(resizePane).not.toBeNull();
    // 직계 자식이어야 한다 — FlowMapCanvas(자식의 자식들) 안이 아니라 클리핑 컨테이너
    // «자신»의 보이는 창 기준으로 붙어야 세로 스크롤과 무관하게 항상 보인다.
    expect(Array.from(resizePane!.children)).toContain(hints[0]);
  });
});
