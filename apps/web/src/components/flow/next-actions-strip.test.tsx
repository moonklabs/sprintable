// @vitest-environment jsdom
//
// story #2224 AC1 후속(2026-07-31, PO 되돌림 — 「«수단»(픽 패널)을 빼면 그 위에 탄 «다른
// 목적»(승격·전환)이 같이 죽는다」) — 이 컴포넌트가 그 «동사 둘»을 실어 나른다. 접힌 채
// 기본이고, 펼쳐야 그 목표의 승격/전환 UI가 실제 fetch 왕복까지 뜨는 것을 확認한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { NextActionsStrip } from './next-actions-strip';
import type { GoalStem, NextMakerStory } from './derive-next-maker';
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

function stem(overrides: Partial<GoalStem> = {}): GoalStem {
  return {
    epicId: 'e1', title: 'Epic 1', totalStories: 3, doneStories: 0,
    inProgressCount: 0, waitingCount: 1, readyForDevCount: 0, hasNext: false,
    recentlyClosed: false, priority: 'about-to-stall', ...overrides,
  };
}

function backlogStory(overrides: Partial<NextMakerStory> = {}): NextMakerStory {
  return {
    id: 'b1', storyNumber: 101, title: 'Backlog Story', status: 'backlog',
    assigneeId: null, updatedAt: '2026-07-01T00:00:00Z', epicId: 'e1', ...overrides,
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
  vi.unstubAllGlobals();
});

describe('NextActionsStrip — 접힌 채 기본, 펼치면 승격/전환 동사가 실제 fetch로 뜬다', () => {
  it('renders nothing when needsNextStems is empty', async () => {
    await act(async () => {
      root.render(wrap(
        <NextActionsStrip
          needsNextStems={[]} quietCount={0} projectId="p1"
          backlogByEpic={new Map()} recentlyClosedTargetIds={new Set()} memberMap={{}}
          onSelectStory={() => {}} onStoryPromoted={() => {}} onPromoteFailed={() => {}} onGoalTransitioned={() => {}}
        />,
      ));
    });
    expect(container.textContent).toBe('');
  });

  it('is collapsed by default — no reference-candidates fetch until a row is expanded', async () => {
    const fetchMock = vi.fn(async () => { throw new Error('should not fetch while collapsed'); });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(wrap(
        <NextActionsStrip
          needsNextStems={[stem()]} quietCount={0} projectId="p1"
          backlogByEpic={new Map([['e1', [backlogStory()]]])} recentlyClosedTargetIds={new Set()} memberMap={{}}
          onSelectStory={() => {}} onStoryPromoted={() => {}} onPromoteFailed={() => {}} onGoalTransitioned={() => {}}
        />,
      ));
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Epic 1');
    expect(container.querySelector('button[aria-expanded="false"]')).not.toBeNull();
  });

  it('expanding a row fetches reference-candidates and clicking promote PATCHes /api/stories/[id]/status', async () => {
    const calledUrls: string[] = [];
    const patchBodies: unknown[] = [];
    const onStoryPromoted = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calledUrls.push(url);
      if (init?.method === 'PATCH' && init.body) patchBodies.push(JSON.parse(String(init.body)));
      if (url === '/api/goals/e1/reference-candidates') return jsonResponse([]);
      if (url === '/api/stories/b1/status' && init?.method === 'PATCH') return jsonResponse({ data: { id: 'b1', status: 'ready-for-dev' } });
      throw new Error(`unexpected fetch: ${url}`);
    }));

    await act(async () => {
      root.render(wrap(
        <NextActionsStrip
          needsNextStems={[stem()]} quietCount={0} projectId="p1"
          backlogByEpic={new Map([['e1', [backlogStory()]]])} recentlyClosedTargetIds={new Set()} memberMap={{}}
          onSelectStory={() => {}} onStoryPromoted={onStoryPromoted} onPromoteFailed={() => {}} onGoalTransitioned={() => {}}
        />,
      ));
    });

    const toggleButton = container.querySelector('button[aria-expanded="false"]') as HTMLElement;
    await act(async () => {
      toggleButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(calledUrls).toContain('/api/goals/e1/reference-candidates');
    // showCanvas=false — 이 컴포넌트가 캔버스(epic-flow-nodes)까지 다시 fetch하면 몸통을
    // 두 번 그리는 회귀다.
    expect(calledUrls.some((u) => u.includes('/api/analytics/epic-flow-nodes'))).toBe(false);

    const promoteButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '다음으로');
    expect(promoteButton).toBeTruthy();
    await act(async () => {
      promoteButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(calledUrls).toContain('/api/stories/b1/status');
    expect(patchBodies).toContainEqual({ status: 'ready-for-dev' });
    expect(onStoryPromoted).toHaveBeenCalledWith('b1', 'e1');
  });

  it('a quiet goal shows the 닫는다/보관 prompt, and 닫는다 POSTs /api/goals/[id]/transition', async () => {
    const onGoalTransitioned = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/goals/e1/reference-candidates') return jsonResponse([]);
      if (url === '/api/goals/e1/transition' && init?.method === 'POST') {
        expect(JSON.parse(String(init.body))).toEqual({ status: 'done' });
        return jsonResponse({ data: { id: 'e1', status: 'done' } });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }));

    await act(async () => {
      root.render(wrap(
        <NextActionsStrip
          needsNextStems={[stem({ priority: 'quiet' })]} quietCount={1} projectId="p1"
          backlogByEpic={new Map()} recentlyClosedTargetIds={new Set()} memberMap={{}}
          onSelectStory={() => {}} onStoryPromoted={() => {}} onPromoteFailed={() => {}} onGoalTransitioned={onGoalTransitioned}
        />,
      ));
    });

    const toggleButton = container.querySelector('button[aria-expanded="false"]') as HTMLElement;
    await act(async () => {
      toggleButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(container.textContent).toContain('아직 하는 중입니까?');
    const closeButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '닫는다');
    expect(closeButton).toBeTruthy();
    await act(async () => {
      closeButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(onGoalTransitioned).toHaveBeenCalledWith('e1');
  });

  it('clicking the row again collapses it (toggle back)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/goals/e1/reference-candidates') return jsonResponse([]);
      throw new Error(`unexpected fetch: ${url}`);
    }));

    await act(async () => {
      root.render(wrap(
        <NextActionsStrip
          needsNextStems={[stem()]} quietCount={0} projectId="p1"
          backlogByEpic={new Map()} recentlyClosedTargetIds={new Set()} memberMap={{}}
          onSelectStory={() => {}} onStoryPromoted={() => {}} onPromoteFailed={() => {}} onGoalTransitioned={() => {}}
        />,
      ));
    });

    const toggle = () => container.querySelector('button[aria-expanded]') as HTMLElement;
    await act(async () => { toggle().dispatchEvent(new MouseEvent('click', { bubbles: true })); await new Promise((r) => setTimeout(r, 0)); });
    expect(toggle().getAttribute('aria-expanded')).toBe('true');

    await act(async () => { toggle().dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
  });
});
