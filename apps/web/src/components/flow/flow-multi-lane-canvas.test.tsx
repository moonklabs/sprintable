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

    const button = container.querySelector('[data-node-id="n1"]') as HTMLElement;
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
});
