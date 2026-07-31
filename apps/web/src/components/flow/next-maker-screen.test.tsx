// @vitest-environment jsdom
//
// story #2224 후속(2026-07-31) — "다음을 만드는 화면"의 실제 배선 왕복 시험. 오늘 하루
// 반복 확定된 교훈(PR#2700/#2710 — "단위 시험은 통과해도 실제 배선 앞의 필터/누락이 죽일 수
// 있다") 그대로: derive-next-maker.test.ts는 순수 계산만 검증하므로, 여기서는 실제
// `NextMakerScreen` 컴포넌트를 렌더해 fetch 오케스트레이션→파생→렌더까지 실제 경로를 태운다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { NextMakerScreen } from './next-maker-screen';
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

const GOALS = [
  { id: 'e-stall', title: 'E-Stall', status: 'active', total_stories: 10, done_stories: 2 },
  { id: 'e-quiet', title: 'E-Quiet', status: 'active', total_stories: 5, done_stories: 5 },
  { id: 'e-ready', title: 'E-Ready', status: 'active', total_stories: 8, done_stories: 3 },
  // 라이브 결함 fix(2026-07-31) 회귀 가드 — 이미 닫힌 목표가 "다음이 없는" 목표로 잘못
  // 세지 않는지를 이 fixture가 지킨다. E-Closed는 next-up으로 표시하지 않는다.
  { id: 'e-closed', title: 'E-Closed', status: 'done', total_stories: 3, done_stories: 3 },
  { id: 'e-archived', title: 'E-Archived', status: 'archived', total_stories: 4, done_stories: 4 },
];

function makeStory(overrides: Partial<{
  id: string; story_number: number; title: string; status: string;
  assignee_id: string | null; updated_at: string; epic_id: string | null;
}> = {}) {
  return {
    id: 's1', story_number: 1, title: 'Story', status: 'backlog',
    assignee_id: null, updated_at: '2026-07-01T00:00:00Z', epic_id: 'e-stall',
    ...overrides,
  };
}

function buildFetchMock(calledUrls: string[], patchBodies: unknown[] = []) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calledUrls.push(url);
    if (init?.method === 'PATCH' && init.body) patchBodies.push(JSON.parse(String(init.body)));

    if (url.startsWith('/api/goals?')) {
      return jsonResponse({ data: GOALS, meta: { hasMore: false, nextCursor: null, limit: 100 } });
    }
    if (url.startsWith('/api/stories?')) {
      if (url.includes('status=backlog')) {
        return jsonResponse({
          data: [
            makeStory({ id: 'b1', story_number: 101, epic_id: 'e-stall', updated_at: '2026-06-01T00:00:00Z' }),
            makeStory({ id: 'b2', story_number: 102, epic_id: 'e-quiet' }),
            // 목표(epic) 없는 orphan — 「목표 정하기」패널의 대상(PO 판정 2026-07-31).
            makeStory({ id: 'o1', story_number: 401, epic_id: null, title: 'Orphan Story' }),
          ],
          meta: { hasMore: false, nextCursor: null, limit: 100 },
        });
      }
      if (url.includes('status=ready-for-dev')) {
        return jsonResponse({
          data: [makeStory({ id: 'r1', story_number: 201, status: 'ready-for-dev', epic_id: 'e-ready', assignee_id: 'u1' })],
          meta: { hasMore: false, nextCursor: null, limit: 100 },
        });
      }
      if (url.includes('status=in-progress')) {
        return jsonResponse({
          data: [makeStory({ id: 'p1', story_number: 301, status: 'in-progress', epic_id: 'e-stall' })],
          meta: { hasMore: false, nextCursor: null, limit: 100 },
        });
      }
      if (url.includes('status=in-review')) {
        return jsonResponse({ data: [], meta: { hasMore: false, nextCursor: null, limit: 100 } });
      }
    }
    if (url.startsWith('/api/reference-candidates/next-up')) {
      return jsonResponse([]);
    }
    if (url.startsWith('/api/analytics/epics-progress-lane')) {
      return jsonResponse({ data: { epics: { 'e-stall': { in_progress: 1, waiting: 1, blocked: 2, stalled: 0, other: 0 } }, zones: {}, stall_threshold_hours: 168, stories_without_epic: 0 } });
    }
    if (url.startsWith('/api/goals/') && url.includes('/reference-candidates')) {
      return jsonResponse([]);
    }
    if (url.startsWith('/api/analytics/epic-flow-nodes')) {
      return jsonResponse({ data: { epic_id: 'e-stall', now: { total: 0, items: [] }, upcoming: { total: 0, items: [] }, past: { total: 0 } } });
    }
    if (url.startsWith('/api/dependencies/graph')) {
      return jsonResponse({ item_type: 'story', nodes: [], edges: [] });
    }
    if (url.includes('/status') && init?.method === 'PATCH') {
      return jsonResponse({ data: { id: 'b1', status: 'ready-for-dev' } });
    }
    if (url.includes('/transition') && init?.method === 'POST') {
      return jsonResponse({ data: { id: 'e-quiet', status: 'done' } });
    }
    if (/^\/api\/stories\/[^/]+$/.test(url) && init?.method === 'PATCH') {
      return jsonResponse({ data: { id: 'o1', epic_id: 'e-stall' } });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
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

describe('NextMakerScreen — real fetch orchestration', () => {
  it('fetches goals + 4 active-status story pages + next-up + lane data, and computes the headline from them', async () => {
    const calledUrls: string[] = [];
    vi.stubGlobal('fetch', buildFetchMock(calledUrls));

    await act(async () => {
      root.render(wrap(<NextMakerScreen projectId="p1" memberMap={{}} onSelectStory={() => {}} />));
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(calledUrls.some((u) => u.startsWith('/api/goals?'))).toBe(true);
    expect(calledUrls.some((u) => u.includes('status=backlog'))).toBe(true);
    expect(calledUrls.some((u) => u.includes('status=ready-for-dev'))).toBe(true);
    expect(calledUrls.some((u) => u.startsWith('/api/reference-candidates/next-up'))).toBe(true);
    expect(calledUrls.some((u) => u.startsWith('/api/analytics/epics-progress-lane'))).toBe(true);

    // e-stall: in-progress(p1) + no ready-for-dev → about-to-stall. e-quiet: neither → quiet.
    // e-ready: has ready-for-dev(r1) → excluded from "다음이 비어 있는" count.
    // e-closed(done)/e-archived(archived) must never enter the count — totalGoals stays 3, not 5.
    expect(container.textContent).toContain('목표 3개 중 2개에');
    expect(container.textContent).toContain('E-Stall');
    expect(container.textContent).toContain('E-Quiet');
    expect(container.textContent).not.toContain('E-Closed');
    expect(container.textContent).not.toContain('E-Archived');

    // 결함 fix(2026-07-31, 선생님 "이게 뭔지.." 지적 후속) 회귀 가드 — backlogTotal은
    // 카드가 아니라 목표 목록 위 한 줄로만 뜬다. 그리고 orphan 패널은 「목표 목록 맨 끝」
    // (0단계와 목표 목록 «사이»가 아니다) — 텍스트 순서로 위치를 고정한다.
    expect(container.textContent).toContain('아직 준비 안 된 일 3건 — 이 중 0건은 주인이 있습니다');
    const fullText = container.textContent ?? '';
    const lastGoalIdx = fullText.lastIndexOf('E-Ready'); // 목표 목록의 마지막 항목
    const orphanIdx = fullText.indexOf('목표에 안 붙은 일이');
    expect(lastGoalIdx).toBeGreaterThan(-1);
    expect(orphanIdx).toBeGreaterThan(lastGoalIdx);
  });

  it('the default-focused stem (most urgent) shows its reference-candidates fetch and pick panel with no click needed', async () => {
    // 결함 fix(2026-07-31, PO 판정 — "갈래가 화면의 몸통") 후속 — 가장 급한 줄기(about-to-stall
    // 인 e-stall)가 첫 렌더에서 바로 오른쪽 넓은 본문에 선다. 「다음 고르기」 클릭이 더 이상
    // 필요 없다(그 버튼 자체가 없어졌다 — 줄기 «선택»과 «펼침»이 하나였던 게 갈렸다).
    const calledUrls: string[] = [];
    vi.stubGlobal('fetch', buildFetchMock(calledUrls));

    await act(async () => {
      root.render(wrap(<NextMakerScreen projectId="p1" memberMap={{}} onSelectStory={() => {}} />));
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(calledUrls.some((u) => u === '/api/goals/e-stall/reference-candidates')).toBe(true);
    expect(container.textContent).toContain('#101');
    // 캔버스도 같이 뜬다 — FlowEpicNodes가 부르는 세 엔드포인트.
    expect(calledUrls.some((u) => u.startsWith('/api/analytics/epic-flow-nodes'))).toBe(true);
  });

  it('promoting a candidate PATCHes /api/stories/[id]/status with ready-for-dev and the goal moves out of the needs-next list', async () => {
    const calledUrls: string[] = [];
    const patchBodies: unknown[] = [];
    vi.stubGlobal('fetch', buildFetchMock(calledUrls, patchBodies));

    await act(async () => {
      root.render(wrap(<NextMakerScreen projectId="p1" memberMap={{}} onSelectStory={() => {}} />));
      await new Promise((r) => setTimeout(r, 0));
    });

    // e-stall is the default-focused stem — its pick panel (with b1) is already visible.
    const promoteButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '다음으로');
    expect(promoteButton).toBeTruthy();
    await act(async () => {
      promoteButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(calledUrls.some((u) => u === '/api/stories/b1/status')).toBe(true);
    expect(patchBodies).toContainEqual({ status: 'ready-for-dev' });
    // e-stall now has a ready-for-dev story locally → moves to "다음이 정해진" section, headline drops to 1.
    expect(container.textContent).toContain('목표 3개 중 1개에');
  });

  it('quiet goal: clicking its row focuses it, then 닫는다 POSTs /api/goals/[id]/transition with status=done and the goal disappears', async () => {
    const calledUrls: string[] = [];
    vi.stubGlobal('fetch', buildFetchMock(calledUrls));

    await act(async () => {
      root.render(wrap(<NextMakerScreen projectId="p1" memberMap={{}} onSelectStory={() => {}} />));
      await new Promise((r) => setTimeout(r, 0));
    });

    // e-quiet isn't the default focus (e-stall, about-to-stall, is) — click its row to focus it.
    const quietRow = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('E-Quiet'));
    expect(quietRow).toBeTruthy();
    await act(async () => {
      quietRow!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(container.textContent).toContain('아직 하는 중입니까?');
    const closeButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '닫는다');
    expect(closeButton).toBeTruthy();
    await act(async () => {
      closeButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(calledUrls.some((u) => u === '/api/goals/e-quiet/transition')).toBe(true);
    expect(container.textContent).not.toContain('E-Quiet');
    // 3 goals total, e-quiet removed entirely → totalGoals in the headline drops to 2.
    expect(container.textContent).toContain('목표 2개 중 1개에');
  });

  it('orphan panel: assigning a goal PATCHes /api/stories/[id] with epic_id and the story disappears from the orphan list', async () => {
    const calledUrls: string[] = [];
    const patchBodies: unknown[] = [];
    vi.stubGlobal('fetch', buildFetchMock(calledUrls, patchBodies));

    await act(async () => {
      root.render(wrap(<NextMakerScreen projectId="p1" memberMap={{}} onSelectStory={() => {}} />));
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(container.textContent).toContain('목표에 안 붙은 일이 1건 있습니다');

    const summaryButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('목표에 안 붙은 일이'));
    await act(async () => {
      summaryButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(container.textContent).toContain('Orphan Story');
    const pickButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '목표 정하기');
    expect(pickButton).toBeTruthy();
    await act(async () => {
      pickButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });

    const select = container.querySelector('select')!;
    expect(select).toBeTruthy();
    await act(async () => {
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!;
      nativeSetter.call(select, 'e-stall');
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });

    const confirmButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '배정');
    expect(confirmButton).toBeTruthy();
    await act(async () => {
      confirmButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(calledUrls.some((u) => u === '/api/stories/o1')).toBe(true);
    expect(patchBodies).toContainEqual({ epic_id: 'e-stall' });
    expect(container.textContent).not.toContain('목표에 안 붙은 일이');
    expect(container.textContent).not.toContain('Orphan Story');
  });
});
